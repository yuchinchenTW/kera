"""
Mafia Policy Network (MAPPO)

Shared policy for all 18 agents with role conditioning.
Uses attention over player embeddings for target selection.

Architecture:
  - Global encoder: game-level features -> 64d
  - Player encoder: per-player features -> 64d x 18
  - Role encoder: own role/faction/resources -> 64d
  - Attention: role queries player embeddings ("who to target?")
  - Policy head: masked softmax over 19 actions
  - Value head: centralized critic (sees ground truth roles during training)
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.distributions import Categorical
import numpy as np

# Must match state_encoder.js
NUM_PLAYERS = 18
OBS_DIM = 1135
NUM_ACTIONS = 19
GLOBAL_DIM = 30
PER_PLAYER_DIM = 35
OWN_ROLE_DIM = 25
NUM_ROLES = 20
GROUND_TRUTH_DIM = NUM_PLAYERS * NUM_ROLES  # 360


class MafiaPolicy(nn.Module):
    """
    Shared actor-critic network for all 18 agents.

    Input:  observation [batch, 541] + action_mask [batch, 19]
    Output: action_probs [batch, 19], value [batch, 1]

    During training, the critic also receives ground_truth [batch, 360]
    for centralized value estimation (CTDE).
    """

    def __init__(self, hidden=128, num_heads=4):
        super().__init__()

        # ── Global encoder ──
        self.global_enc = nn.Sequential(
            nn.Linear(GLOBAL_DIM, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
        )

        # ── Per-player encoder ──
        self.player_enc = nn.Sequential(
            nn.Linear(PER_PLAYER_DIM, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
        )

        # ── Own role encoder ──
        self.role_enc = nn.Sequential(
            nn.Linear(OWN_ROLE_DIM, hidden),
            nn.ReLU(),
        )

        # ── Social context encoder (vote graph + chat matrix + last words) ──
        VOTE_GRAPH_DIM = NUM_PLAYERS * NUM_PLAYERS  # 324
        CHAT_MATRIX_DIM = NUM_PLAYERS * 4           # 72
        LAST_WORDS_DIM = NUM_PLAYERS * 3            # 54
        social_dim = VOTE_GRAPH_DIM + CHAT_MATRIX_DIM + LAST_WORDS_DIM  # 450
        self.social_norm = nn.LayerNorm(social_dim)
        self.social_enc = nn.Sequential(
            nn.Linear(social_dim, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
        )
        self._social_start = GLOBAL_DIM + NUM_PLAYERS * PER_PLAYER_DIM  # where social section starts
        self._social_end = self._social_start + social_dim
        self._role_start = self._social_end  # where own-role section starts

        # ── Attention: "given my role, who should I target?" ──
        self.attention = nn.MultiheadAttention(
            embed_dim=hidden,
            num_heads=num_heads,
            batch_first=True,
        )
        self.attn_norm = nn.LayerNorm(hidden)

        # ── Policy head ──
        combined_dim = hidden * 4  # global + attended + role + social
        self.policy_head = nn.Sequential(
            nn.Linear(combined_dim, hidden),
            nn.ReLU(),
            nn.Linear(hidden, NUM_ACTIONS),
        )

        # ── Value head (centralized: +ground_truth during training) ──
        self.value_head = nn.Sequential(
            nn.Linear(combined_dim + GROUND_TRUTH_DIM, hidden * 2),
            nn.ReLU(),
            nn.Linear(hidden * 2, hidden),
            nn.ReLU(),
            nn.Linear(hidden, 1),
        )

        # ── Value head (decentralized: no ground truth, for inference) ──
        self.value_head_dec = nn.Sequential(
            nn.Linear(combined_dim, hidden),
            nn.ReLU(),
            nn.Linear(hidden, 1),
        )

        self._init_weights()

    def _init_weights(self):
        """Orthogonal initialization for stability."""
        for m in self.modules():
            if isinstance(m, nn.Linear):
                nn.init.orthogonal_(m.weight, gain=np.sqrt(2))
                nn.init.zeros_(m.bias)
        # Smaller init for output heads
        for head in [self.policy_head[-1], self.value_head[-1], self.value_head_dec[-1]]:
            nn.init.orthogonal_(head.weight, gain=0.01)

    def _encode(self, obs):
        """
        Parse observation and encode each component.

        Args:
            obs: [batch, 1135]

        Returns:
            global_feat:  [batch, hidden]
            attended:     [batch, hidden]
            role_feat:    [batch, hidden]
            social_feat:  [batch, hidden]
        """
        batch = obs.shape[0]

        # Split observation into components
        global_raw = obs[:, :GLOBAL_DIM]                                         # [B, 30]
        players_raw = obs[:, GLOBAL_DIM:GLOBAL_DIM + NUM_PLAYERS * PER_PLAYER_DIM]  # [B, 630]
        social_raw = obs[:, self._social_start:self._social_end]                 # [B, 450]
        role_raw = obs[:, self._role_start:]                                     # [B, 25]

        # Encode
        global_feat = self.global_enc(global_raw)                    # [B, H]
        players_feat = self.player_enc(
            players_raw.reshape(batch, NUM_PLAYERS, PER_PLAYER_DIM)  # [B, 18, 35]
        )                                                            # [B, 18, H]
        role_feat = self.role_enc(role_raw)                          # [B, H]
        social_feat = self.social_enc(self.social_norm(social_raw))   # [B, H]

        # Attention: role as query, players as key/value
        query = role_feat.unsqueeze(1)                               # [B, 1, H]
        attended, _ = self.attention(query, players_feat, players_feat)  # [B, 1, H]
        attended = self.attn_norm(attended.squeeze(1) + role_feat)   # [B, H] (residual)

        return global_feat, attended, role_feat, social_feat

    def forward(self, obs, action_mask, ground_truth=None):
        """
        Forward pass.

        Args:
            obs:          [batch, 541]
            action_mask:  [batch, 19] — 1 for legal, 0 for illegal
            ground_truth: [batch, 360] — true role one-hots (training only)

        Returns:
            action_probs: [batch, 19]
            value:        [batch, 1]
        """
        global_feat, attended, role_feat, social_feat = self._encode(obs)

        # Combine features
        combined = torch.cat([global_feat, attended, role_feat, social_feat], dim=-1)  # [B, H*4]

        # Policy
        logits = self.policy_head(combined)                              # [B, 19]
        logits = logits.masked_fill(action_mask == 0, -1e8)
        logits = torch.clamp(logits, -50, 50)  # prevent overflow
        action_probs = F.softmax(logits, dim=-1)
        action_probs = action_probs.clamp(min=1e-8)  # prevent NaN

        # Value
        if ground_truth is not None:
            value_input = torch.cat([combined, ground_truth], dim=-1)
            value = self.value_head(value_input)
        else:
            value = self.value_head_dec(combined)

        return action_probs, value

    def get_action(self, obs, action_mask, ground_truth=None, deterministic=False):
        """
        Sample an action from the policy.

        Returns:
            action:   [batch] int tensor
            log_prob: [batch] float tensor
            value:    [batch] float tensor
            entropy:  [batch] float tensor
        """
        action_probs, value = self.forward(obs, action_mask, ground_truth)

        dist = Categorical(probs=action_probs)

        if deterministic:
            action = action_probs.argmax(dim=-1)
        else:
            action = dist.sample()

        log_prob = dist.log_prob(action)
        entropy = dist.entropy()

        return action, log_prob, value.squeeze(-1), entropy

    def evaluate_actions(self, obs, action_mask, actions, ground_truth=None):
        """
        Evaluate given actions under current policy.
        Used during PPO update.

        Args:
            obs:          [batch, 541]
            action_mask:  [batch, 19]
            actions:      [batch] int tensor
            ground_truth: [batch, 360]

        Returns:
            log_probs: [batch]
            values:    [batch]
            entropy:   [batch]
        """
        action_probs, value = self.forward(obs, action_mask, ground_truth)
        dist = Categorical(probs=action_probs)

        log_probs = dist.log_prob(actions)
        entropy = dist.entropy()

        return log_probs, value.squeeze(-1), entropy


class RolloutBuffer:
    """Storage for PPO rollout data across all agents and environments."""

    def __init__(self, num_steps, num_envs, num_agents=NUM_PLAYERS):
        self.num_steps = num_steps
        self.num_envs = num_envs
        self.num_agents = num_agents

        self.obs = np.zeros((num_steps, num_envs, num_agents, OBS_DIM), dtype=np.float32)
        self.masks = np.zeros((num_steps, num_envs, num_agents, NUM_ACTIONS), dtype=np.float32)
        self.actions = np.zeros((num_steps, num_envs, num_agents), dtype=np.int64)
        self.log_probs = np.zeros((num_steps, num_envs, num_agents), dtype=np.float32)
        self.rewards = np.zeros((num_steps, num_envs, num_agents), dtype=np.float32)
        self.values = np.zeros((num_steps, num_envs, num_agents), dtype=np.float32)
        self.dones = np.zeros((num_steps, num_envs), dtype=np.float32)
        self.ground_truths = np.zeros((num_steps, num_envs, GROUND_TRUTH_DIM), dtype=np.float32)

        self.step = 0

    def insert(self, obs, masks, actions, log_probs, rewards, values, dones, ground_truths):
        """Insert one step of experience."""
        self.obs[self.step] = obs
        self.masks[self.step] = masks
        self.actions[self.step] = actions
        self.log_probs[self.step] = log_probs
        self.rewards[self.step] = rewards
        self.values[self.step] = values
        self.dones[self.step] = dones
        self.ground_truths[self.step] = ground_truths
        self.step += 1

    def compute_returns(self, last_values, gamma=0.99, gae_lambda=0.95):
        """
        Compute GAE advantages and returns.

        Args:
            last_values: [num_envs, num_agents] — bootstrap values
        """
        advantages = np.zeros_like(self.rewards)
        last_gae = np.zeros((self.num_envs, self.num_agents), dtype=np.float32)

        for t in reversed(range(self.num_steps)):
            if t == self.num_steps - 1:
                next_values = last_values
            else:
                next_values = self.values[t + 1]

            # Expand dones to match agent dim
            done_mask = self.dones[t][:, np.newaxis]  # [envs, 1]

            delta = self.rewards[t] + gamma * next_values * (1 - done_mask) - self.values[t]
            last_gae = delta + gamma * gae_lambda * (1 - done_mask) * last_gae
            advantages[t] = last_gae

        self.advantages = advantages
        self.returns = advantages + self.values

    def flatten(self):
        """
        Flatten [steps, envs, agents, ...] into [total, ...] for minibatch sampling.

        Returns dict of flattened tensors.
        """
        total = self.num_steps * self.num_envs * self.num_agents
        return {
            "obs": torch.tensor(self.obs.reshape(total, OBS_DIM)),
            "masks": torch.tensor(self.masks.reshape(total, NUM_ACTIONS)),
            "actions": torch.tensor(self.actions.reshape(total)),
            "log_probs": torch.tensor(self.log_probs.reshape(total)),
            "returns": torch.tensor(self.returns.reshape(total)),
            "advantages": torch.tensor(self.advantages.reshape(total)),
            "ground_truths": torch.tensor(
                # Broadcast ground_truth from [steps, envs, 360] to [steps, envs, agents, 360]
                np.broadcast_to(
                    self.ground_truths[:, :, np.newaxis, :],
                    (self.num_steps, self.num_envs, self.num_agents, GROUND_TRUTH_DIM)
                ).reshape(total, GROUND_TRUTH_DIM)
            ),
        }

    def reset(self):
        self.step = 0


# ─── Quick Test ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=== MafiaPolicy Test ===")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")

    policy = MafiaPolicy(hidden=128, num_heads=4).to(device)
    param_count = sum(p.numel() for p in policy.parameters())
    print(f"Parameters: {param_count:,}")

    # Test forward pass
    batch = 32
    obs = torch.randn(batch, OBS_DIM, device=device)
    mask = torch.ones(batch, NUM_ACTIONS, device=device)
    mask[:, 0] = 0  # mask out target 0
    gt = torch.randn(batch, GROUND_TRUTH_DIM, device=device)

    probs, value = policy(obs, mask, ground_truth=gt)
    print(f"Action probs: {probs.shape}, Value: {value.shape}")
    print(f"Probs sum: {probs.sum(dim=-1).mean():.4f} (should be ~1.0)")
    print(f"Masked action 0 prob: {probs[:, 0].max():.6f} (should be ~0)")

    # Test action sampling
    action, log_prob, val, entropy = policy.get_action(obs, mask, ground_truth=gt)
    print(f"Sampled actions: {action.shape}, Log probs: {log_prob.shape}")
    print(f"Mean entropy: {entropy.mean():.4f}")

    # Test evaluate
    lp, v, ent = policy.evaluate_actions(obs, mask, action, ground_truth=gt)
    print(f"Evaluated log_probs: {lp.shape}, Values: {v.shape}")

    # Test without ground truth (inference mode)
    probs_dec, value_dec = policy(obs, mask, ground_truth=None)
    print(f"Decentralized value: {value_dec.shape}")

    # Test RolloutBuffer
    buf = RolloutBuffer(num_steps=4, num_envs=2, num_agents=18)
    for i in range(4):
        buf.insert(
            obs=np.random.randn(2, 18, OBS_DIM).astype(np.float32),
            masks=np.ones((2, 18, NUM_ACTIONS), dtype=np.float32),
            actions=np.random.randint(0, 19, (2, 18)),
            log_probs=np.random.randn(2, 18).astype(np.float32),
            rewards=np.zeros((2, 18), dtype=np.float32),
            values=np.random.randn(2, 18).astype(np.float32),
            dones=np.zeros(2, dtype=np.float32),
            ground_truths=np.random.randn(2, GROUND_TRUTH_DIM).astype(np.float32),
        )
    buf.compute_returns(last_values=np.zeros((2, 18), dtype=np.float32))
    flat = buf.flatten()
    print(f"Flattened buffer — obs: {flat['obs'].shape}, total: {flat['obs'].shape[0]}")
    print(f"  (expected: 4 steps x 2 envs x 18 agents = {4*2*18})")

    print("=== Test Complete ===")
