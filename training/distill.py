"""
Policy Distillation: Extract Neural Policy -> Linear Weight Tables

Generates learned_weights.json by analyzing the trained policy's preferences
across diverse game states. The weights map directly to the existing
score += weight * feature format in targeting.js / vote.js.

Usage:
    python training/distill.py
    python training/distill.py --checkpoint training/checkpoints/policy_final.pt
    python training/distill.py --samples 10000
"""

import argparse
import json
import sys
import time
import numpy as np
import torch
from pathlib import Path
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).parent))
from model import MafiaPolicy, NUM_PLAYERS, OBS_DIM, NUM_ACTIONS
from env import MafiaEnv

# Feature indices within per-player observation (offset from per-player start)
# Must match state_encoder.js layout
PER_PLAYER_DIM = 27
GLOBAL_DIM = 30

# Role IDs matching state_encoder.js
ROLE_IDS = [
    "POLICE", "KILLER", "DOCTOR", "SNIPER", "AGENT", "TERRORIST", "COWBOY",
    "KIDNAPPER", "ZOMBIE", "RIOT_POLICE", "ARSONIST", "HEAVENLY_FIEND",
    "VINE_DEMON", "BRAT", "NIGHTMARE_DEMON", "EXORCIST", "NECROMANCER",
    "PURIFIER", "GRUDGE_BEAST", "CIVILIAN",
]

# Feature names for each per-player dimension
PLAYER_FEATURES = (
    ["is_self", "is_alive", "is_known_ally"]
    + [f"roleProb_{r}" for r in ROLE_IDS]
    + ["suspicion", "vote_pressure", "speak_ratio", "mention_ratio"]
)

assert len(PLAYER_FEATURES) == PER_PLAYER_DIM, f"Expected {PER_PLAYER_DIM}, got {len(PLAYER_FEATURES)}"


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--checkpoint", type=str, default="training/checkpoints/policy_final.pt")
    p.add_argument("--samples", type=int, default=5000, help="Game states to sample")
    p.add_argument("--output", type=str, default="training/learned_weights.json")
    p.add_argument("--theme", type=str, default="GOOD_VS_EVIL")
    p.add_argument("--difficulty", type=str, default="hard")
    return p.parse_args()


def collect_states(env, num_samples):
    """
    Run games with heuristic AI and collect diverse game states.
    Returns list of (obs_all[18, 541], masks_all[18, 19], roles[18], phase).
    """
    states = []
    obs, masks, info = env.reset()
    roles = info["roles"]
    done = False

    while len(states) < num_samples:
        # Save current state
        states.append({
            "obs": obs.copy(),
            "masks": masks.copy(),
            "roles": list(roles),
            "phase": info.get("phase", "NIGHT"),
            "day": info.get("day", 1),
        })

        # Step with heuristic
        actions = np.full(NUM_PLAYERS, -1, dtype=np.int32)
        obs, masks, rewards, done, info = env.step(actions)

        if done:
            obs, masks, info = env.reset()
            roles = info["roles"]
            done = False

        if len(states) % 1000 == 0:
            print(f"  Collected {len(states)}/{num_samples} states...")

    return states


def extract_weights(policy, states, device):
    """
    For each role, analyze policy preferences and extract linear weights.

    Method: For each game state where a player has role R:
      1. Get policy action probabilities for that player
      2. For each candidate target, extract pairwise features
      3. Fit: target_selection_prob ~ weighted_sum(features)
    """
    # Collect (features, prob) pairs per role per decision type
    role_data = defaultdict(lambda: {"features": [], "probs": []})

    print(f"  Extracting preferences from {len(states)} states...")

    for si, state in enumerate(states):
        obs_all = state["obs"]      # [18, 541]
        masks_all = state["masks"]  # [18, 19]
        roles = state["roles"]

        # Get policy probs for all players
        obs_t = torch.tensor(obs_all, device=device)
        masks_t = torch.tensor(masks_all, device=device)

        with torch.no_grad():
            action_probs, _ = policy(obs_t, masks_t)  # [18, 19]

        probs_np = action_probs.cpu().numpy()  # [18, 19]

        for actor_id in range(NUM_PLAYERS):
            role = roles[actor_id]
            actor_probs = probs_np[actor_id]  # [19]

            # Skip if player only has no_action available
            if masks_all[actor_id, :18].sum() == 0:
                continue

            # Extract pairwise features for each target
            actor_obs = obs_all[actor_id]  # [541]

            for target_id in range(NUM_PLAYERS):
                if target_id == actor_id:
                    continue
                if masks_all[actor_id, target_id] == 0:
                    continue

                prob = actor_probs[target_id]

                # Extract target's per-player features from actor's observation
                target_offset = GLOBAL_DIM + target_id * PER_PLAYER_DIM
                target_feats = actor_obs[target_offset:target_offset + PER_PLAYER_DIM]

                role_data[role]["features"].append(target_feats.copy())
                role_data[role]["probs"].append(prob)

        if (si + 1) % 1000 == 0:
            print(f"    Processed {si+1}/{len(states)} states")

    return role_data


def fit_linear_weights(role_data):
    """
    Fit linear regression: target_prob ~ sum(w_i * feature_i) for each role.
    Returns dict of role -> {feature_name: weight}.
    """
    weights = {}

    for role, data in role_data.items():
        if len(data["features"]) < 100:
            print(f"  {role}: too few samples ({len(data['features'])}), skipping")
            continue

        X = np.array(data["features"], dtype=np.float32)  # [N, 27]
        y = np.array(data["probs"], dtype=np.float32)      # [N]

        # Normalize y to [0, 1] range for stability
        y_min, y_max = y.min(), y.max()
        if y_max - y_min < 1e-8:
            print(f"  {role}: constant probs, skipping")
            continue
        y_norm = (y - y_min) / (y_max - y_min)

        # Ridge regression: w = (X^T X + λI)^-1 X^T y
        lam = 0.01
        XtX = X.T @ X + lam * np.eye(X.shape[1])
        Xty = X.T @ y_norm
        try:
            w = np.linalg.solve(XtX, Xty)
        except np.linalg.LinAlgError:
            print(f"  {role}: singular matrix, using pseudoinverse")
            w = np.linalg.lstsq(X, y_norm, rcond=None)[0]

        # Scale weights back
        w_scaled = w * (y_max - y_min)

        # Build named weight dict
        role_weights = {}
        for i, feat_name in enumerate(PLAYER_FEATURES):
            role_weights[feat_name] = round(float(w_scaled[i]), 6)

        weights[role] = role_weights

        # Print top features
        sorted_feats = sorted(role_weights.items(), key=lambda x: abs(x[1]), reverse=True)
        top5 = sorted_feats[:5]
        r2 = 1 - np.sum((y_norm - X @ w) ** 2) / np.sum((y_norm - y_norm.mean()) ** 2)
        print(f"  {role:20s} | R2={r2:.3f} | samples={len(y):>6} | "
              f"top: {', '.join(f'{f}={v:+.3f}' for f, v in top5)}")

    return weights


def generate_js_weights(weights, output_path):
    """Generate learned_weights.json."""
    with open(output_path, "w") as f:
        json.dump(weights, f, indent=2)
    print(f"\n  Saved: {output_path} ({len(weights)} roles)")


def map_to_targeting_weights(raw_weights):
    """
    Map raw distilled feature weights to the named weights used in
    src/ai/targeting.js and src/ai/learned_weights.js.

    Raw features from state_encoder.js (per-player):
      roleProb_POLICE, roleProb_KILLER, roleProb_DOCTOR, etc.
      suspicion, vote_pressure, speak_ratio, mention_ratio
      is_self, is_alive, is_known_ally

    Targeting function weights (per role, per phase):
      KILLER.night: policeProb, doctorProb, speakRatio, etc.
      POLICE.night: killerProb, redProb, sniperProb, etc.
    """
    # Feature name mapping: raw -> targeting weight name
    ROLE_FEATURE_MAP = {
        "KILLER": {
            "night": {
                "roleProb_POLICE": "policeProb",
                "roleProb_DOCTOR": "doctorProb",
                "roleProb_AGENT": "agentProb",
                "speak_ratio": "speakRatio",
                "suspicion": "suspicion",
                "is_alive": "blueProb",  # proxy
            },
        },
        "POLICE": {
            "night": {
                "roleProb_KILLER": "killerProb",
                "roleProb_SNIPER": "sniperProb",
                "roleProb_KIDNAPPER": "kidnapProb",
                "suspicion": "redProb",
                "speak_ratio": "silentRedLean",
            },
        },
        "SNIPER": {
            "night": {
                "suspicion": "inverseSusp",
                "roleProb_POLICE": "policeProb",
                "speak_ratio": "speakRatio",
                "roleProb_DOCTOR": "protectedPenalty",
            },
        },
        "DOCTOR": {
            "night": {
                "roleProb_POLICE": "policeProb",
                "suspicion": "blueProb",
                "speak_ratio": "speakRatio",
            },
        },
        "TERRORIST": {
            "night": {
                "roleProb_POLICE": "policeProb",
                "roleProb_DOCTOR": "doctorProb",
                "roleProb_AGENT": "agentProb",
                "speak_ratio": "speakRatio",
            },
        },
        "COWBOY": {
            "night": {
                "suspicion": "redProb",
                "roleProb_KILLER": "killerProb",
                "roleProb_SNIPER": "sniperProb",
                "speak_ratio": "silentRedLean",
            },
        },
    }

    mapped = {}
    for role, raw in raw_weights.items():
        role_map = ROLE_FEATURE_MAP.get(role, {})
        mapped[role] = {"night": {}, "vote": {}}

        # Map known features
        for phase, feat_map in role_map.items():
            for raw_feat, target_name in feat_map.items():
                if raw_feat in raw:
                    mapped[role][phase][target_name] = raw[raw_feat]

        # Also store raw weights for reference
        mapped[role]["_raw"] = raw

    return mapped


def generate_js_module(weights, output_path):
    """Generate src/ai/learned_weights.js as importable ES module."""
    js_path = Path(output_path).parent.parent / "src" / "ai" / "learned_weights.js"

    # Map raw weights to targeting function names
    mapped = map_to_targeting_weights(weights)

    # Build the JS-compatible weight structure (night phase only, null = use hand-tuned)
    js_weights = {}
    for role, data in mapped.items():
        js_weights[role] = {}
        for phase in ["night", "vote"]:
            if phase in data and data[phase]:
                js_weights[role][phase] = data[phase]

    lines = [
        "// Auto-generated by training/distill.py",
        "// Do not edit manually -- re-run distillation to update.",
        "//",
        f"// Distilled from checkpoint, {len(weights)} roles",
        "// When a weight is null, the original hand-tuned value is used (fallback).",
        "",
        "export const LEARNED_WEIGHTS = " + json.dumps(js_weights, indent=2) + ";",
        "",
        "/**",
        " * Get a learned weight, falling back to the hand-tuned default if missing.",
        " */",
        "export function getWeight(role, phase, feature, handTunedDefault) {",
        "  const rw = LEARNED_WEIGHTS[role];",
        "  if (!rw) return handTunedDefault;",
        "  const pw = rw[phase];",
        "  if (!pw) return handTunedDefault;",
        "  const val = pw[feature];",
        "  return val !== null && val !== undefined ? val : handTunedDefault;",
        "}",
        "",
    ]

    with open(js_path, "w") as f:
        f.write("\n".join(lines))
    print(f"  Saved: {js_path}")


def main():
    args = parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")

    # Load policy
    ckpt = torch.load(args.checkpoint, map_location=device, weights_only=False)
    hidden = ckpt.get("args", {}).get("hidden", 128)
    policy = MafiaPolicy(hidden=hidden).to(device)
    policy.load_state_dict(ckpt["policy_state_dict"])
    policy.eval()
    print(f"Loaded: {args.checkpoint} ({ckpt.get('total_steps', '?'):,} steps)")

    # Collect diverse game states
    print(f"\nPhase 1: Collecting {args.samples} game states...")
    env = MafiaEnv(theme=args.theme, difficulty=args.difficulty)
    t0 = time.time()
    states = collect_states(env, args.samples)
    env.close()
    print(f"  Collected {len(states)} states in {time.time()-t0:.1f}s")

    # Extract policy preferences
    print(f"\nPhase 2: Extracting policy preferences...")
    t0 = time.time()
    role_data = extract_weights(policy, states, device)
    print(f"  Extracted in {time.time()-t0:.1f}s")

    # Fit linear weights
    print(f"\nPhase 3: Fitting linear weights...")
    weights = fit_linear_weights(role_data)

    # Save outputs
    print(f"\nPhase 4: Saving outputs...")
    generate_js_weights(weights, args.output)
    generate_js_module(weights, args.output)

    print(f"\n{'='*60}")
    print(f"  Distillation complete!")
    print(f"  Roles extracted: {len(weights)}")
    print(f"  Features per role: {PER_PLAYER_DIM}")
    print(f"  Output: {args.output}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
