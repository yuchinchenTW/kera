"""
MAPPO Training Loop for Mafia AI

Multi-Agent PPO with Centralized Training, Decentralized Execution (CTDE).

Usage:
    python training/train.py                          # default: 4 envs, 1M steps
    python training/train.py --num_envs 16 --steps 5000000
    python training/train.py --theme GOOD_VS_EVIL --difficulty hard
"""

import argparse
import os
import sys
import time
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from pathlib import Path
from torch.utils.tensorboard import SummaryWriter

# Add training dir to path
sys.path.insert(0, str(Path(__file__).parent))

from model import MafiaPolicy, RolloutBuffer, NUM_PLAYERS, OBS_DIM, NUM_ACTIONS, GROUND_TRUTH_DIM
from vec_env import VecMafiaEnv


def parse_args():
    p = argparse.ArgumentParser(description="MAPPO training for Mafia AI")
    p.add_argument("--num_envs", type=int, default=4, help="Parallel environments")
    p.add_argument("--steps", type=int, default=500_000, help="Total environment steps")
    p.add_argument("--rollout_steps", type=int, default=32, help="Steps per rollout before update")
    p.add_argument("--epochs", type=int, default=4, help="PPO epochs per update")
    p.add_argument("--batch_size", type=int, default=512, help="Minibatch size")
    p.add_argument("--lr", type=float, default=3e-4, help="Learning rate")
    p.add_argument("--gamma", type=float, default=0.99, help="Discount factor")
    p.add_argument("--gae_lambda", type=float, default=0.95, help="GAE lambda")
    p.add_argument("--clip_eps", type=float, default=0.2, help="PPO clip epsilon")
    p.add_argument("--vf_coef", type=float, default=0.5, help="Value loss coefficient")
    p.add_argument("--ent_coef", type=float, default=0.01, help="Entropy bonus coefficient")
    p.add_argument("--max_grad_norm", type=float, default=0.5, help="Gradient clipping")
    p.add_argument("--theme", type=str, default="GOOD_VS_EVIL")
    p.add_argument("--difficulty", type=str, default="hard")
    p.add_argument("--hidden", type=int, default=128, help="Hidden layer size")
    p.add_argument("--save_dir", type=str, default="training/checkpoints")
    p.add_argument("--log_dir", type=str, default="training/logs")
    p.add_argument("--save_interval", type=int, default=50, help="Save every N updates")
    p.add_argument("--eval_interval", type=int, default=20, help="Evaluate every N updates")
    p.add_argument("--resume", type=str, default=None, help="Resume from checkpoint path")
    return p.parse_args()


class MAPPOTrainer:
    def __init__(self, args):
        self.args = args
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        print(f"Device: {self.device}")

        # Environment
        self.env = VecMafiaEnv(
            num_envs=args.num_envs,
            theme=args.theme,
            difficulty=args.difficulty,
            seed_start=42,
        )

        # Policy
        self.policy = MafiaPolicy(hidden=args.hidden).to(self.device)
        self.optimizer = torch.optim.Adam(self.policy.parameters(), lr=args.lr, eps=1e-5)

        param_count = sum(p.numel() for p in self.policy.parameters())
        print(f"Policy parameters: {param_count:,}")

        # Rollout buffer
        self.buffer = RolloutBuffer(
            num_steps=args.rollout_steps,
            num_envs=args.num_envs,
            num_agents=NUM_PLAYERS,
        )

        # Logging
        os.makedirs(args.save_dir, exist_ok=True)
        os.makedirs(args.log_dir, exist_ok=True)
        self.writer = SummaryWriter(args.log_dir)

        # Stats (initialize BEFORE resume so resume can override)
        self.total_steps = 0
        self.total_updates = 0
        self.total_games = 0
        self.recent_wins = {"BLUE": 0, "RED": 0, "ZOMBIE": 0, "GRUDGE": 0, "NONE": 0}
        self.recent_game_count = 0
        self.recent_game_lengths = []
        self.recent_usage = {
            "doctorInjections": 0, "doctorSaves": 0, "doctorOverdoses": 0,
            "sniperShots": 0, "riotGrenades": 0,
            "arsonMarks": 0, "agentBlocks": 0,
            "cowboyShots": 0, "cowboyHits": 0,
            "cowboyMisses": 0, "cowboyBackfires": 0,
            "zombieConversions": 0, "zombieKills": 0,
            "policeFoundRed": 0, "terrorBombs": 0,
            "exorcistPetrifies": 0,
            "nightKills": 0, "voteKills": 0,
        }

        # Resume from checkpoint if specified (AFTER stats init so it overrides)
        if args.resume:
            self._load_checkpoint(args.resume)

    @torch.no_grad()
    def collect_rollout(self):
        """Collect experience from vectorized environments."""
        obs, masks, infos = self.env.reset() if self.total_steps == 0 else (self._last_obs, self._last_masks, self._last_infos)

        self.buffer.reset()

        for step in range(self.args.rollout_steps):
            # Flatten [envs, agents, ...] to [envs*agents, ...] for batch forward
            flat_obs = torch.tensor(obs.reshape(-1, OBS_DIM), device=self.device)
            flat_masks = torch.tensor(masks.reshape(-1, NUM_ACTIONS), device=self.device)

            # Ground truth for centralized critic
            gt = np.zeros((self.args.num_envs, GROUND_TRUTH_DIM), dtype=np.float32)
            for i, info in enumerate(infos):
                if info and "ground_truth" in info:
                    gt[i] = info["ground_truth"]
            flat_gt = torch.tensor(
                np.broadcast_to(gt[:, np.newaxis, :], (self.args.num_envs, NUM_PLAYERS, GROUND_TRUTH_DIM)).reshape(-1, GROUND_TRUTH_DIM),
                device=self.device,
            )

            # Get actions from policy
            actions, log_probs, values, entropy = self.policy.get_action(
                flat_obs, flat_masks, ground_truth=flat_gt
            )

            # Reshape back to [envs, agents]
            actions_np = actions.cpu().numpy().reshape(self.args.num_envs, NUM_PLAYERS)
            log_probs_np = log_probs.cpu().numpy().reshape(self.args.num_envs, NUM_PLAYERS)
            values_np = values.cpu().numpy().reshape(self.args.num_envs, NUM_PLAYERS)

            # Step environments
            next_obs, next_masks, rewards, dones, next_infos = self.env.step(actions_np)

            # Track game completions
            for i, done in enumerate(dones):
                if done:
                    self.total_games += 1
                    self.recent_game_count += 1
                    v = next_infos[i].get("victory")
                    if v:
                        winner = v.get("winner", "NONE")
                        self.recent_wins[winner] = self.recent_wins.get(winner, 0) + 1
                    day = next_infos[i].get("day", 0)
                    self.recent_game_lengths.append(day)
                    # Accumulate usage stats (use terminal_usage which has end-of-game values)
                    usage = next_infos[i].get("terminal_usage") or next_infos[i].get("usage")
                    if usage:
                        for k in self.recent_usage:
                            self.recent_usage[k] += usage.get(k, 0)

            # Store in buffer
            self.buffer.insert(
                obs=obs,
                masks=masks,
                actions=actions_np,
                log_probs=log_probs_np,
                rewards=rewards,
                values=values_np,
                dones=dones.astype(np.float32),
                ground_truths=gt,
            )

            obs = next_obs
            masks = next_masks
            infos = next_infos
            self.total_steps += self.args.num_envs

        # Bootstrap value for last observation
        flat_obs = torch.tensor(obs.reshape(-1, OBS_DIM), device=self.device)
        flat_masks = torch.tensor(masks.reshape(-1, NUM_ACTIONS), device=self.device)
        gt = np.zeros((self.args.num_envs, GROUND_TRUTH_DIM), dtype=np.float32)
        for i, info in enumerate(infos):
            if info and "ground_truth" in info:
                gt[i] = info["ground_truth"]
        flat_gt = torch.tensor(
            np.broadcast_to(gt[:, np.newaxis, :], (self.args.num_envs, NUM_PLAYERS, GROUND_TRUTH_DIM)).reshape(-1, GROUND_TRUTH_DIM),
            device=self.device,
        )
        _, _, last_values, _ = self.policy.get_action(flat_obs, flat_masks, ground_truth=flat_gt)
        last_values_np = last_values.cpu().numpy().reshape(self.args.num_envs, NUM_PLAYERS)

        # Compute GAE
        self.buffer.compute_returns(last_values_np, self.args.gamma, self.args.gae_lambda)

        # Save for next rollout
        self._last_obs = obs
        self._last_masks = masks
        self._last_infos = infos

    def update(self):
        """PPO update using collected rollout."""
        data = self.buffer.flatten()
        total = data["obs"].shape[0]

        # Normalize advantages
        adv = data["advantages"]
        adv = (adv - adv.mean()) / (adv.std() + 1e-8)
        data["advantages"] = adv

        total_policy_loss = 0
        total_value_loss = 0
        total_entropy = 0
        num_updates = 0

        for epoch in range(self.args.epochs):
            # Shuffle indices
            indices = np.random.permutation(total)

            for start in range(0, total, self.args.batch_size):
                end = min(start + self.args.batch_size, total)
                idx = indices[start:end]

                mb_obs = data["obs"][idx].to(self.device)
                mb_masks = data["masks"][idx].to(self.device)
                mb_actions = data["actions"][idx].to(self.device)
                mb_old_log_probs = data["log_probs"][idx].to(self.device)
                mb_returns = data["returns"][idx].to(self.device)
                mb_advantages = data["advantages"][idx].to(self.device)
                mb_gt = data["ground_truths"][idx].to(self.device)

                # Evaluate actions under current policy
                new_log_probs, new_values, entropy = self.policy.evaluate_actions(
                    mb_obs, mb_masks, mb_actions, ground_truth=mb_gt
                )

                # PPO clipped objective
                ratio = torch.exp(new_log_probs - mb_old_log_probs)
                surr1 = ratio * mb_advantages
                surr2 = torch.clamp(ratio, 1 - self.args.clip_eps, 1 + self.args.clip_eps) * mb_advantages
                policy_loss = -torch.min(surr1, surr2).mean()

                # Value loss (clipped)
                value_loss = F.mse_loss(new_values, mb_returns)

                # Entropy bonus
                entropy_loss = -entropy.mean()

                # Total loss
                loss = (
                    policy_loss
                    + self.args.vf_coef * value_loss
                    + self.args.ent_coef * entropy_loss
                )

                self.optimizer.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(self.policy.parameters(), self.args.max_grad_norm)
                self.optimizer.step()

                total_policy_loss += policy_loss.item()
                total_value_loss += value_loss.item()
                total_entropy += entropy.mean().item()
                num_updates += 1

        self.total_updates += 1

        # Log
        if num_updates > 0:
            avg_pl = total_policy_loss / num_updates
            avg_vl = total_value_loss / num_updates
            avg_ent = total_entropy / num_updates

            self.writer.add_scalar("loss/policy", avg_pl, self.total_steps)
            self.writer.add_scalar("loss/value", avg_vl, self.total_steps)
            self.writer.add_scalar("loss/entropy", avg_ent, self.total_steps)

        return {
            "policy_loss": total_policy_loss / max(num_updates, 1),
            "value_loss": total_value_loss / max(num_updates, 1),
            "entropy": total_entropy / max(num_updates, 1),
        }

    def log_game_stats(self):
        """Log recent game statistics."""
        if self.recent_game_count == 0:
            return

        total = self.recent_game_count
        for faction, count in self.recent_wins.items():
            rate = count / total if total > 0 else 0
            self.writer.add_scalar(f"winrate/{faction}", rate, self.total_steps)

        if self.recent_game_lengths:
            avg_len = np.mean(self.recent_game_lengths)
            self.writer.add_scalar("game/avg_length", avg_len, self.total_steps)

        self.writer.add_scalar("game/total_games", self.total_games, self.total_steps)

        # Usage stats (per game averages)
        for key, val in self.recent_usage.items():
            avg_val = val / total if total > 0 else 0
            self.writer.add_scalar(f"usage/{key}", avg_val, self.total_steps)

        # Print summary
        win_str = " | ".join(f"{k}:{v}" for k, v in self.recent_wins.items() if v > 0)
        avg_len = np.mean(self.recent_game_lengths) if self.recent_game_lengths else 0
        def avg(k): return self.recent_usage.get(k, 0) / total if total > 0 else 0
        print(f"    Games: {total} | Wins: {win_str} | Avg length: {avg_len:.1f}")
        print(f"    Doc: inj={avg('doctorInjections'):.1f} saves={avg('doctorSaves'):.1f} OD={avg('doctorOverdoses'):.2f} | "
              f"Sniper={avg('sniperShots'):.1f} | Police found red={avg('policeFoundRed'):.1f}")
        print(f"    Kills: night={avg('nightKills'):.1f} vote={avg('voteKills'):.1f} | "
              f"Zombie conv={avg('zombieConversions'):.2f} | Bombs={avg('terrorBombs'):.2f}")

        # Reset
        self.recent_wins = {"BLUE": 0, "RED": 0, "ZOMBIE": 0, "GRUDGE": 0, "NONE": 0}
        self.recent_game_count = 0
        self.recent_game_lengths = []
        for k in self.recent_usage:
            self.recent_usage[k] = 0

    def _load_checkpoint(self, path):
        """Resume training from a saved checkpoint."""
        ckpt = torch.load(path, map_location=self.device, weights_only=False)
        self.policy.load_state_dict(ckpt["policy_state_dict"])
        self.optimizer.load_state_dict(ckpt["optimizer_state_dict"])
        self.total_steps = ckpt.get("total_steps", 0)
        self.total_updates = ckpt.get("total_updates", 0)
        self.total_games = ckpt.get("total_games", 0)
        print(f"Resumed from: {path}")
        print(f"  Steps: {self.total_steps:,} | Updates: {self.total_updates} | Games: {self.total_games:,}")

    def save(self, path=None):
        """Save model checkpoint."""
        if path is None:
            path = os.path.join(self.args.save_dir, f"policy_{self.total_steps}.pt")
        torch.save({
            "policy_state_dict": self.policy.state_dict(),
            "optimizer_state_dict": self.optimizer.state_dict(),
            "total_steps": self.total_steps,
            "total_updates": self.total_updates,
            "total_games": self.total_games,
            "args": vars(self.args),
        }, path)
        print(f"  Saved checkpoint: {path}")

    def train(self):
        """Main training loop."""
        args = self.args
        total_updates_needed = args.steps // (args.rollout_steps * args.num_envs)

        print(f"\n{'='*60}")
        print(f"  MAPPO Training")
        print(f"  Theme: {args.theme} | Difficulty: {args.difficulty}")
        print(f"  Envs: {args.num_envs} | Rollout: {args.rollout_steps} steps")
        print(f"  Total steps: {args.steps:,} | Updates: ~{total_updates_needed}")
        print(f"  Batch: {args.batch_size} | Epochs: {args.epochs} | LR: {args.lr}")
        print(f"{'='*60}\n")

        # Initial reset
        self._last_obs, self._last_masks, self._last_infos = self.env.reset()

        t_start = time.time()

        while self.total_steps < args.steps:
            t0 = time.time()

            # Collect rollout
            self.collect_rollout()

            # PPO update
            stats = self.update()

            elapsed = time.time() - t0
            sps = (args.rollout_steps * args.num_envs) / elapsed

            # Print progress
            pct = self.total_steps / args.steps * 100
            print(
                f"[{pct:5.1f}%] Step {self.total_steps:>8,} | "
                f"PL: {stats['policy_loss']:.4f} | VL: {stats['value_loss']:.4f} | "
                f"Ent: {stats['entropy']:.3f} | {sps:.0f} sps | {elapsed:.1f}s"
            )

            # Log game stats
            if self.total_updates % args.eval_interval == 0:
                self.log_game_stats()

            # Save checkpoint
            if self.total_updates % args.save_interval == 0:
                self.save()

            self.writer.add_scalar("perf/steps_per_sec", sps, self.total_steps)

        # Final save
        self.save(os.path.join(args.save_dir, "policy_final.pt"))

        total_time = time.time() - t_start
        print(f"\n{'='*60}")
        print(f"  Training complete!")
        print(f"  Total steps: {self.total_steps:,}")
        print(f"  Total games: {self.total_games}")
        print(f"  Total time: {total_time:.0f}s ({total_time/60:.1f}m)")
        print(f"  Avg speed: {self.total_steps/total_time:.0f} steps/sec")
        print(f"{'='*60}")

        self.env.close()
        self.writer.close()


if __name__ == "__main__":
    args = parse_args()
    trainer = MAPPOTrainer(args)
    trainer.train()
