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
from model import MafiaPolicy, NUM_PLAYERS, OBS_DIM, TOTAL_MASK_DIM
from env import MafiaEnv

# Must match model.py / state_encoder.js
GLOBAL_DIM = 30
PER_PLAYER_DIM = 35

# Role IDs matching state_encoder.js
ROLE_IDS = [
    "POLICE", "KILLER", "DOCTOR", "SNIPER", "AGENT", "TERRORIST", "COWBOY",
    "KIDNAPPER", "ZOMBIE", "RIOT_POLICE", "ARSONIST", "HEAVENLY_FIEND",
    "VINE_DEMON", "BRAT", "NIGHTMARE_DEMON", "EXORCIST", "NECROMANCER",
    "PURIFIER", "GRUDGE_BEAST", "CIVILIAN",
]

# Feature names for each per-player dimension (35 total)
PLAYER_FEATURES = (
    ["is_self", "is_alive", "is_known_ally"]
    + [f"roleProb_{r}" for r in ROLE_IDS]  # 20
    + ["suspicion", "vote_pressure", "speak_ratio", "mention_ratio"]
    + ["i_accused_them", "i_defended_them", "they_accused_me", "they_defended_me",
       "vote_together", "lw_accused", "lw_defended", "lw_claimed_role"]
)

assert len(PLAYER_FEATURES) == PER_PLAYER_DIM, f"Expected {PER_PLAYER_DIM}, got {len(PLAYER_FEATURES)}"


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--checkpoint", type=str, default="training/checkpoints/policy_final.pt")
    p.add_argument("--samples", type=int, default=5000, help="Game states to sample")
    p.add_argument("--output_json", type=str, default="training/learned_weights.json")
    p.add_argument("--output_js", type=str, default="src/ai/learned_weights.js")
    p.add_argument("--theme", type=str, default="GOOD_VS_EVIL")
    p.add_argument("--difficulty", type=str, default="hard")
    return p.parse_args()


def collect_states(num_games, num_samples, theme, difficulty):
    """
    Run games with heuristic AI and collect diverse game states.
    Uses single-phase steps (night, then vote) to capture both phases.
    Returns list of dicts with obs[18,1135], masks[18,63], roles, phase.
    """
    env = MafiaEnv(num_games=num_games, theme=theme, difficulty=difficulty)
    states = []
    obs, masks, infos = env.reset()

    # Track roles and phases per game
    game_roles = [None] * num_games
    game_phases = ["NIGHT"] * num_games
    for g in range(num_games):
        if infos[g]:
            game_roles[g] = infos[g].get("roles")
            game_phases[g] = infos[g].get("phase", "NIGHT")

    while len(states) < num_samples:
        # Save current state for each game
        for g in range(num_games):
            if len(states) >= num_samples:
                break
            if game_roles[g] is None:
                continue
            states.append({
                "obs": obs[g].copy(),       # [18, 1135]
                "masks": masks[g].copy(),    # [18, 63]
                "roles": game_roles[g],
                "phase": game_phases[g],
            })

        # Single-phase step with heuristic (-1 = let heuristic decide)
        actions = np.full((num_games, NUM_PLAYERS, 4), -1, dtype=np.int32)
        obs, masks, rewards, dones, infos = env.step(actions)

        # Update roles and phases from infos
        for g in range(num_games):
            if infos[g]:
                # Use env's tracked phase (updated by _parse_batch_response)
                game_phases[g] = env._phases[g]
                # Update roles for games that were auto-reset
                if infos[g].get("reset_roles"):
                    game_roles[g] = infos[g]["reset_roles"]
                    game_phases[g] = env._phases[g]

        if len(states) % 1000 < num_games:
            print(f"  Collected {len(states)}/{num_samples} states...")

    env.close()
    return states[:num_samples]


def extract_weights(policy, states, device):
    """
    For each role, analyze policy preferences and extract linear weights.

    Method: For each game state where a player has role R:
      1. Get policy target action probabilities for that player
      2. For each candidate target, extract pairwise features
      3. Fit: target_selection_prob ~ weighted_sum(features)
    """
    # Separate night vs day data per role
    role_data = defaultdict(lambda: {
        "night": {"features": [], "probs": []},
        "day": {"features": [], "probs": []},
    })

    print(f"  Extracting preferences from {len(states)} states...")

    for si, state in enumerate(states):
        obs_all = state["obs"]      # [18, 1135]
        masks_all = state["masks"]  # [18, 63]
        roles = state["roles"]
        phase = state.get("phase", "NIGHT")

        if roles is None:
            continue

        phase_key = "night" if phase == "NIGHT" else "day"

        # Get policy probs for all players
        obs_t = torch.tensor(obs_all, dtype=torch.float32, device=device)
        masks_t = torch.tensor(masks_all, dtype=torch.float32, device=device)

        with torch.no_grad():
            probs_dict, _ = policy(obs_t, masks_t)
            target_probs = probs_dict["target"]  # [18, 19]

        probs_np = target_probs.cpu().numpy()  # [18, 19]

        for actor_id in range(NUM_PLAYERS):
            role = roles[actor_id] if actor_id < len(roles) else None
            if role is None:
                continue

            actor_probs = probs_np[actor_id]  # [19]

            # Skip if player only has no_action available (target mask is [0:19])
            target_mask = masks_all[actor_id, :19]
            if target_mask[:18].sum() == 0:
                continue

            actor_obs = obs_all[actor_id]  # [1135]

            for target_id in range(NUM_PLAYERS):
                if target_id == actor_id:
                    continue
                if target_mask[target_id] == 0:
                    continue

                prob = actor_probs[target_id]

                # Extract target's per-player features from actor's observation
                target_offset = GLOBAL_DIM + target_id * PER_PLAYER_DIM
                target_feats = actor_obs[target_offset:target_offset + PER_PLAYER_DIM]

                role_data[role][phase_key]["features"].append(target_feats.copy())
                role_data[role][phase_key]["probs"].append(prob)

        if (si + 1) % 1000 == 0:
            print(f"    Processed {si+1}/{len(states)} states")

    return role_data


def _fit_one(X, y):
    """Ridge regression on one (features, probs) dataset. Returns (weights, r2)."""
    y_min, y_max = y.min(), y.max()
    if y_max - y_min < 1e-8:
        return None, None
    y_norm = (y - y_min) / (y_max - y_min)

    lam = 0.01
    XtX = X.T @ X + lam * np.eye(X.shape[1])
    Xty = X.T @ y_norm
    try:
        w = np.linalg.solve(XtX, Xty)
    except np.linalg.LinAlgError:
        w = np.linalg.lstsq(X, y_norm, rcond=None)[0]

    w_scaled = w * (y_max - y_min)
    r2 = 1 - np.sum((y_norm - X @ w) ** 2) / np.sum((y_norm - y_norm.mean()) ** 2)
    return w_scaled, r2


def fit_linear_weights(role_data):
    """
    Fit linear regression per role per phase: target_prob ~ sum(w_i * feature_i).
    Returns dict of role -> {phase -> {feature_name: weight}}.
    """
    weights = {}

    for role, phase_data in role_data.items():
        role_weights = {}

        for phase_key in ["night", "day"]:
            data = phase_data[phase_key]
            if len(data["features"]) < 100:
                continue

            X = np.array(data["features"], dtype=np.float32)
            y = np.array(data["probs"], dtype=np.float32)

            w_scaled, r2 = _fit_one(X, y)
            if w_scaled is None:
                print(f"  {role:20s} {phase_key:5s} | constant probs, skipping")
                continue

            phase_weights = {}
            for i, feat_name in enumerate(PLAYER_FEATURES):
                phase_weights[feat_name] = round(float(w_scaled[i]), 6)

            role_weights[phase_key] = phase_weights

            sorted_feats = sorted(phase_weights.items(), key=lambda x: abs(x[1]), reverse=True)
            top5 = sorted_feats[:5]
            print(f"  {role:20s} {phase_key:5s} | R2={r2:.3f} | samples={len(y):>6} | "
                  f"top: {', '.join(f'{f}={v:+.3f}' for f, v in top5)}")

        if role_weights:
            weights[role] = role_weights

    return weights


def generate_js_weights(weights, output_path):
    """Generate learned_weights.json (raw per-role per-phase weights)."""
    with open(output_path, "w") as f:
        json.dump(weights, f, indent=2)
    phases = set()
    for role_data in weights.values():
        phases.update(k for k in role_data if k != "_raw")
    print(f"\n  Saved: {output_path} ({len(weights)} roles, phases: {sorted(phases)})")


def map_to_targeting_weights(raw_weights):
    """
    Map raw distilled feature weights to the named weights used in
    src/ai/targeting.js and src/ai/learned_weights.js.

    Raw features from state_encoder.js (per-player, 35 dims):
      is_self, is_alive, is_known_ally,
      roleProb_{POLICE..CIVILIAN} (20),
      suspicion, vote_pressure, speak_ratio, mention_ratio,
      i_accused_them, i_defended_them, they_accused_me, they_defended_me,
      vote_together, lw_accused, lw_defended, lw_claimed_role
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
                "vote_pressure": "votePressure",
                "they_accused_me": "theyAccusedMe",
                "vote_together": "voteTogether",
            },
        },
        "POLICE": {
            "night": {
                "roleProb_KILLER": "killerProb",
                "roleProb_SNIPER": "sniperProb",
                "roleProb_KIDNAPPER": "kidnapProb",
                "suspicion": "redProb",
                "speak_ratio": "silentRedLean",
                "vote_pressure": "votePressure",
                "vote_together": "voteTogether",
            },
        },
        "SNIPER": {
            "night": {
                "suspicion": "inverseSusp",
                "roleProb_POLICE": "policeProb",
                "speak_ratio": "speakRatio",
                "roleProb_DOCTOR": "protectedPenalty",
                "roleProb_GRUDGE_BEAST": "grudgeAvoid",
            },
        },
        "DOCTOR": {
            "night": {
                "roleProb_POLICE": "policeProb",
                "suspicion": "blueProb",
                "speak_ratio": "speakRatio",
                "vote_pressure": "votePressure",
            },
        },
        "TERRORIST": {
            "night": {
                "roleProb_POLICE": "policeProb",
                "roleProb_DOCTOR": "doctorProb",
                "roleProb_AGENT": "agentProb",
                "speak_ratio": "speakRatio",
                "suspicion": "suspicion",
            },
        },
        "COWBOY": {
            "night": {
                "suspicion": "redProb",
                "roleProb_KILLER": "killerProb",
                "roleProb_SNIPER": "sniperProb",
                "speak_ratio": "silentRedLean",
                "vote_together": "voteTogether",
            },
        },
    }

    mapped = {}
    for role, phase_data in raw_weights.items():
        role_map = ROLE_FEATURE_MAP.get(role, {})
        mapped[role] = {}

        # Map known features per phase
        for phase, feat_map in role_map.items():
            raw = phase_data.get(phase, {})
            if not raw:
                continue
            phase_weights = {}
            for raw_feat, target_name in feat_map.items():
                if raw_feat in raw:
                    phase_weights[target_name] = raw[raw_feat]
            if phase_weights:
                mapped[role][phase] = phase_weights

        # Store raw weights for reference
        mapped[role]["_raw"] = phase_data

    return mapped


def generate_js_module(weights, js_path):
    """Generate src/ai/learned_weights.js as importable ES module."""
    js_path = Path(js_path)

    # Map raw weights to targeting function names
    mapped = map_to_targeting_weights(weights)

    # Build the JS-compatible weight structure (only phases with actual weights)
    js_weights = {}
    for role, data in mapped.items():
        role_entry = {}
        for phase in ["night", "vote"]:
            if phase in data and data[phase]:
                role_entry[phase] = data[phase]
        if role_entry:
            js_weights[role] = role_entry

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

    # Collect diverse game states (1 game at a time to avoid phase desync)
    num_games = 1
    print(f"\nPhase 1: Collecting {args.samples} game states...")
    t0 = time.time()
    states = collect_states(num_games, args.samples, args.theme, args.difficulty)
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
    generate_js_weights(weights, args.output_json)
    generate_js_module(weights, args.output_js)

    print(f"\n{'='*60}")
    print(f"  Distillation complete!")
    print(f"  Roles extracted: {len(weights)}")
    print(f"  Features per role: {PER_PLAYER_DIM}")
    print(f"  JSON: {args.output_json}")
    print(f"  JS:   {args.output_js}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
