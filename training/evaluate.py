"""
Evaluation: Trained RL Policy vs Heuristic Baseline

Runs games where RL policy controls some players and heuristic AI controls others.
Measures per-faction win rates to determine if RL policy is stronger.

Usage:
    python training/evaluate.py                                    # eval latest checkpoint
    python training/evaluate.py --checkpoint training/checkpoints/policy_final.pt
    python training/evaluate.py --games 200 --mode rl_vs_heuristic
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


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--checkpoint", type=str, default="training/checkpoints/policy_final.pt")
    p.add_argument("--games", type=int, default=200)
    p.add_argument("--theme", type=str, default="GOOD_VS_EVIL")
    p.add_argument("--difficulty", type=str, default="hard")
    p.add_argument("--mode", type=str, default="all_rl",
                   choices=["all_rl", "all_heuristic", "rl_vs_heuristic"])
    p.add_argument("--deterministic", action="store_true", help="Use greedy actions")
    return p.parse_args()


def load_policy(checkpoint_path, device):
    """Load trained policy from checkpoint."""
    ckpt = torch.load(checkpoint_path, map_location=device, weights_only=False)
    hidden = ckpt.get("args", {}).get("hidden", 128)
    policy = MafiaPolicy(hidden=hidden).to(device)
    policy.load_state_dict(ckpt["policy_state_dict"])
    policy.eval()
    print(f"Loaded checkpoint: {checkpoint_path}")
    print(f"  Trained steps: {ckpt.get('total_steps', '?'):,}")
    print(f"  Trained games: {ckpt.get('total_games', '?'):,}")
    return policy


def run_game(env, policy, device, mode="all_rl", deterministic=False):
    """
    Run a single game and return results.

    Modes:
      - all_rl:          RL controls all 18 players
      - all_heuristic:   Heuristic AI controls all (actions = -1)
      - rl_vs_heuristic: RL controls even-indexed players, heuristic controls odd
    """
    obs, masks, info = env.reset()
    roles = info["roles"]
    factions = info.get("factions", [])
    done = False
    steps = 0

    while not done and steps < 50:
        if mode == "all_heuristic":
            actions = np.full(NUM_PLAYERS, -1, dtype=np.int32)
        elif mode == "all_rl":
            obs_t = torch.tensor(obs, device=device)
            masks_t = torch.tensor(masks, device=device)
            with torch.no_grad():
                action_t, _, _, _ = policy.get_action(obs_t, masks_t, deterministic=deterministic)
            actions = action_t.cpu().numpy()
        elif mode == "rl_vs_heuristic":
            # RL controls even-indexed, heuristic controls odd
            obs_t = torch.tensor(obs, device=device)
            masks_t = torch.tensor(masks, device=device)
            with torch.no_grad():
                action_t, _, _, _ = policy.get_action(obs_t, masks_t, deterministic=deterministic)
            rl_actions = action_t.cpu().numpy()
            actions = np.full(NUM_PLAYERS, -1, dtype=np.int32)
            for i in range(0, NUM_PLAYERS, 2):  # even = RL
                actions[i] = rl_actions[i]

        obs, masks, rewards, done, info = env.step(actions)
        steps += 1

    victory = info.get("victory", {})
    winner = victory.get("winner", "NONE") if victory else "NONE"
    reason = victory.get("reason", "") if victory else "timeout"

    return {
        "winner": winner,
        "reason": reason,
        "steps": steps,
        "day": info.get("day", 0),
        "roles": roles,
        "factions": factions,
        "rewards": rewards.tolist() if isinstance(rewards, np.ndarray) else rewards,
    }


def evaluate(args):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")

    # Load policy (skip for all_heuristic mode)
    policy = None
    if args.mode != "all_heuristic":
        policy = load_policy(args.checkpoint, device)

    env = MafiaEnv(theme=args.theme, difficulty=args.difficulty)

    # Run games
    wins = defaultdict(int)
    game_lengths = []
    results = []

    print(f"\nRunning {args.games} games | Mode: {args.mode} | Theme: {args.theme}")
    print("-" * 60)

    t0 = time.time()
    for g in range(args.games):
        seed = 10000 + g
        env.seed = seed
        result = run_game(env, policy, device, mode=args.mode, deterministic=args.deterministic)
        results.append(result)
        wins[result["winner"]] += 1
        game_lengths.append(result["day"])

        if (g + 1) % 50 == 0:
            elapsed = time.time() - t0
            gps = (g + 1) / elapsed
            print(f"  [{g+1}/{args.games}] {gps:.1f} games/sec | "
                  f"BLUE:{wins['BLUE']} RED:{wins['RED']} "
                  f"ZOMBIE:{wins.get('ZOMBIE',0)} GRUDGE:{wins.get('GRUDGE',0)}")

    elapsed = time.time() - t0
    env.close()

    # ─── Results ──────────────────────────────────────────────────────────

    total = args.games
    print(f"\n{'='*60}")
    print(f"  EVALUATION RESULTS ({args.mode})")
    print(f"  {total} games | {elapsed:.1f}s | {total/elapsed:.1f} games/sec")
    print(f"{'='*60}")

    print(f"\n  FACTION WIN RATES")
    print(f"  {'─'*40}")
    for faction in ["BLUE", "RED", "ZOMBIE", "GRUDGE", "NONE"]:
        count = wins.get(faction, 0)
        pct = count / total * 100 if total > 0 else 0
        bar = "█" * int(pct / 5)
        print(f"  {faction:<8} {bar:<20} {pct:5.1f}% ({count})")

    avg_len = np.mean(game_lengths) if game_lengths else 0
    med_len = np.median(game_lengths) if game_lengths else 0
    print(f"\n  GAME LENGTH")
    print(f"  {'─'*40}")
    print(f"  Average: {avg_len:.1f} | Median: {med_len:.0f} | "
          f"Min: {min(game_lengths) if game_lengths else 0} | "
          f"Max: {max(game_lengths) if game_lengths else 0}")

    # Wilson confidence interval
    for faction in ["BLUE", "RED"]:
        p = wins.get(faction, 0) / total if total > 0 else 0
        z = 1.96
        n = total
        denom = 1 + z * z / n
        center = (p + z * z / (2 * n)) / denom
        spread = z * np.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denom
        lo, hi = max(0, center - spread), min(1, center + spread)
        print(f"  {faction} 95% CI: [{lo*100:.1f}%, {hi*100:.1f}%]")

    print(f"\n{'='*60}")

    return wins, results


# ─── Compare RL vs Heuristic ──────────────────────────────────────────────────

def compare(args):
    """Run both all_rl and all_heuristic, then compare."""
    print("=" * 60)
    print("  COMPARISON: RL Policy vs Heuristic Baseline")
    print("=" * 60)

    # Run heuristic baseline
    print("\n>>> Heuristic Baseline <<<")
    args_h = argparse.Namespace(**vars(args))
    args_h.mode = "all_heuristic"
    wins_h, _ = evaluate(args_h)

    # Run RL policy
    print("\n>>> RL Policy <<<")
    args_r = argparse.Namespace(**vars(args))
    args_r.mode = "all_rl"
    wins_r, _ = evaluate(args_r)

    # Compare
    print("\n" + "=" * 60)
    print("  HEAD-TO-HEAD COMPARISON")
    print("=" * 60)
    total = args.games
    for faction in ["BLUE", "RED"]:
        h_pct = wins_h.get(faction, 0) / total * 100
        r_pct = wins_r.get(faction, 0) / total * 100
        diff = r_pct - h_pct
        arrow = "↑" if diff > 0 else "↓" if diff < 0 else "="
        print(f"  {faction:<8} Heuristic: {h_pct:5.1f}%  |  RL: {r_pct:5.1f}%  |  {arrow} {abs(diff):.1f}%")


if __name__ == "__main__":
    args = parse_args()
    if args.mode == "compare":
        compare(args)
    else:
        evaluate(args)
