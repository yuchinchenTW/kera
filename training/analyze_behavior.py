"""
Analyze trained RL model's chat behavior.

Checks:
1. How often do killers claim police?
2. Do killers accuse blue or red?
3. Do blue players follow suspicious claims?

Usage:
    python training/analyze_behavior.py --checkpoint training/checkpoints/policy_final.pt --games 500
"""

import argparse
import sys
import time
import numpy as np
import torch
from pathlib import Path
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).parent))

from model import MafiaPolicy, NUM_PLAYERS, OBS_DIM, TOTAL_MASK_DIM
from fast_engine import (
    FastGame, FastBatchEnv, encode_all_fast, encode_ground_truth_fast,
    compute_rewards_fast, R_POLICE, R_KILLER, R_DOCTOR, R_SNIPER, R_CIVILIAN,
    F_BLUE, F_RED, CHAT_SILENCE, CHAT_ACCUSE, CHAT_DEFEND, CHAT_CLAIM, CHAT_DEFLECT,
    NUM_ROLES_FULL, ROLE_NAMES,
)

try:
    from fast_encode_jit import encode_game_jit
    USE_JIT = True
except ImportError:
    USE_JIT = False

CHAT_TYPE_NAMES = ["silence", "accuse", "defend", "claim_role", "deflect"]
FULL_ROLE_IDS = [
    "POLICE", "KILLER", "DOCTOR", "SNIPER", "AGENT", "TERRORIST", "COWBOY",
    "KIDNAPPER", "ZOMBIE", "RIOT_POLICE", "ARSONIST", "HEAVENLY_FIEND",
    "VINE_DEMON", "BRAT", "NIGHTMARE_DEMON", "EXORCIST", "NECROMANCER",
    "PURIFIER", "GRUDGE_BEAST", "CIVILIAN",
]


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--checkpoint", type=str, default="training/checkpoints/policy_final.pt")
    p.add_argument("--games", type=int, default=500)
    return p.parse_args()


def run_analysis(policy, device, num_games=500):
    """Run games with RL policy and analyze chat behavior."""

    # Counters
    stats = {
        # Killer chat behavior
        "killer_total_chat_opportunities": 0,
        "killer_silence": 0,
        "killer_accuse": 0,
        "killer_defend": 0,
        "killer_claim_role": 0,
        "killer_deflect": 0,
        # Killer claim details
        "killer_claim_police": 0,
        "killer_claim_doctor": 0,
        "killer_claim_civilian": 0,
        "killer_claim_other": 0,
        # Killer accuse targets
        "killer_accuse_blue": 0,
        "killer_accuse_red": 0,
        # Killer defend targets
        "killer_defend_blue": 0,
        "killer_defend_red": 0,
        # Blue (non-police) voting behavior
        "blue_vote_total": 0,
        "blue_vote_correct_red": 0,
        "blue_vote_wrong_blue": 0,
        # Blue following revealed target
        "blue_follow_reveal": 0,
        "blue_ignore_reveal": 0,
        "blue_follow_fake_reveal": 0,
        "blue_ignore_fake_reveal": 0,
        # Police chat behavior
        "police_total_chat": 0,
        "police_silence": 0,
        "police_accuse": 0,
        "police_claim_police": 0,
        # Game outcomes
        "games": 0,
        "blue_wins": 0,
        "red_wins": 0,
    }

    env = FastBatchEnv(num_envs=1)
    games_done = 0
    t0 = time.time()

    while games_done < num_games:
        obs_np, masks_np, infos = env.reset()
        game = env.games[0]
        done = False

        # Track killer fake claims: killer_id -> latest accused target (None if not yet accused)
        killer_has_claimed_police = set()  # killers who claimed police this game
        current_fake_reveal_target = None  # most recent killer accusation after claiming police

        while not done:
            obs_t = torch.tensor(obs_np.reshape(-1, OBS_DIM), device=device)
            masks_t = torch.tensor(masks_np.reshape(-1, TOTAL_MASK_DIM), device=device)

            with torch.no_grad():
                actions_t, _, _, _ = policy.get_action(obs_t, masks_t, deterministic=True)

            actions_np = actions_t.cpu().numpy().reshape(1, NUM_PLAYERS, 4)
            act = actions_np[0]  # [18, 4]

            # ── Chat analysis: during NIGHT phase (when chat is actually executed) ──
            # In fast_engine, NIGHT step processes night actions + chat, then flips to VOTE.
            # So the chat heads from the NIGHT action are the ones that actually get used.
            if game.phase == "NIGHT":
                for pid in range(NUM_PLAYERS):
                    p = game.players[pid]
                    if not p.alive:
                        continue

                    chat_type = int(act[pid, 1])
                    chat_target = int(act[pid, 2])
                    claim_role = int(act[pid, 3])

                    target_faction = None
                    if 0 <= chat_target < NUM_PLAYERS:
                        target_faction = game.players[chat_target].faction

                    # ── Killer chat analysis ──
                    if p.role == R_KILLER:
                        stats["killer_total_chat_opportunities"] += 1

                        if chat_type == CHAT_SILENCE:
                            stats["killer_silence"] += 1
                        elif chat_type == CHAT_ACCUSE:
                            stats["killer_accuse"] += 1
                            if target_faction == F_BLUE:
                                stats["killer_accuse_blue"] += 1
                            elif target_faction == F_RED:
                                stats["killer_accuse_red"] += 1
                            # Track if this killer already claimed police and is now accusing
                            if pid in killer_has_claimed_police and 0 <= chat_target < NUM_PLAYERS:
                                current_fake_reveal_target = chat_target
                        elif chat_type == CHAT_DEFEND:
                            stats["killer_defend"] += 1
                            if target_faction == F_BLUE:
                                stats["killer_defend_blue"] += 1
                            elif target_faction == F_RED:
                                stats["killer_defend_red"] += 1
                        elif chat_type == CHAT_CLAIM:
                            stats["killer_claim_role"] += 1
                            if 0 <= claim_role < len(FULL_ROLE_IDS):
                                claimed = FULL_ROLE_IDS[claim_role]
                                if claimed == "POLICE":
                                    stats["killer_claim_police"] += 1
                                    killer_has_claimed_police.add(pid)
                                elif claimed == "DOCTOR":
                                    stats["killer_claim_doctor"] += 1
                                elif claimed == "CIVILIAN":
                                    stats["killer_claim_civilian"] += 1
                                else:
                                    stats["killer_claim_other"] += 1
                        elif chat_type == CHAT_DEFLECT:
                            stats["killer_deflect"] += 1

                    # ── Police chat analysis ──
                    if p.role == R_POLICE:
                        stats["police_total_chat"] += 1
                        if chat_type == CHAT_SILENCE:
                            stats["police_silence"] += 1
                        elif chat_type == CHAT_ACCUSE:
                            stats["police_accuse"] += 1
                        elif chat_type == CHAT_CLAIM:
                            if 0 <= claim_role < len(FULL_ROLE_IDS) and FULL_ROLE_IDS[claim_role] == "POLICE":
                                stats["police_claim_police"] += 1

            # ── Blue voting analysis: during VOTE phase (when votes are executed) ──
            if game.phase == "VOTE":
                # Real police reveal: only counts if target is still alive
                real_reveal_target = game.police_public_red
                if real_reveal_target is not None:
                    if not game.players[real_reveal_target].alive:
                        real_reveal_target = None  # target already dead, no longer relevant

                # Fake reveal: current_fake_reveal_target (set this round by killer accuse after claiming police)
                # Only valid if target is alive
                fake_target = current_fake_reveal_target
                if fake_target is not None:
                    if not game.players[fake_target].alive:
                        fake_target = None

                for pid in range(NUM_PLAYERS):
                    p = game.players[pid]
                    if not p.alive or p.faction != F_BLUE or p.role == R_POLICE:
                        continue

                    vote_target = int(act[pid, 0])
                    if vote_target < 0 or vote_target >= NUM_PLAYERS:
                        continue

                    stats["blue_vote_total"] += 1
                    target_p = game.players[vote_target]

                    if target_p.faction == F_RED:
                        stats["blue_vote_correct_red"] += 1
                    elif target_p.faction == F_BLUE:
                        stats["blue_vote_wrong_blue"] += 1

                    # Check follow/ignore REAL police reveal (only when alive target exists)
                    if real_reveal_target is not None:
                        if vote_target == real_reveal_target:
                            stats["blue_follow_reveal"] += 1
                        else:
                            stats["blue_ignore_reveal"] += 1

                    # Check follow/ignore FAKE reveal (only when alive target exists)
                    if fake_target is not None:
                        if vote_target == fake_target:
                            stats["blue_follow_fake_reveal"] += 1
                        else:
                            stats["blue_ignore_fake_reveal"] += 1

                # Reset fake reveal after this vote round (don't carry over to next round)
                current_fake_reveal_target = None

            # Step
            obs_np, masks_np, rewards, dones, infos = env.step(actions_np)

            if dones[0]:
                done = True
                games_done += 1
                victory = infos[0].get("victory")
                stats["games"] += 1
                if victory and victory.get("winner") == "BLUE":
                    stats["blue_wins"] += 1
                elif victory and victory.get("winner") == "RED":
                    stats["red_wins"] += 1

                if games_done % 100 == 0:
                    elapsed = time.time() - t0
                    print(f"  [{games_done}/{num_games}] {games_done/elapsed:.1f} games/sec")

    env.close()
    return stats


def print_report(stats):
    n = stats["games"]
    if n == 0:
        print("No games played.")
        return
    print(f"\n{'='*70}")
    print(f"  BEHAVIOR ANALYSIS — {n} games")
    print(f"  BLUE wins: {stats['blue_wins']} ({stats['blue_wins']/n*100:.1f}%)")
    print(f"  RED wins:  {stats['red_wins']} ({stats['red_wins']/n*100:.1f}%)")
    print(f"{'='*70}")

    # ── Killer Chat ──
    kt = stats["killer_total_chat_opportunities"]
    print(f"\n  KILLER CHAT BEHAVIOR ({kt} opportunities)")
    print(f"  {'─'*50}")
    if kt > 0:
        for action in ["silence", "accuse", "defend", "claim_role", "deflect"]:
            count = stats[f"killer_{action}"]
            pct = count / kt * 100
            bar = "#" * int(pct / 2)
            print(f"  {action:12s} {bar:25s} {pct:5.1f}% ({count})")

    # ── Killer Claims ──
    kc = stats["killer_claim_role"]
    print(f"\n  KILLER ROLE CLAIMS ({kc} total)")
    print(f"  {'─'*50}")
    if kc > 0:
        for role in ["police", "doctor", "civilian", "other"]:
            count = stats[f"killer_claim_{role}"]
            pct = count / kc * 100
            print(f"  claim {role:10s}  {pct:5.1f}% ({count})")

    # ── Killer Accuse Targets ──
    ka = stats["killer_accuse"]
    print(f"\n  KILLER ACCUSATION TARGETS ({ka} total)")
    print(f"  {'─'*50}")
    if ka > 0:
        ab = stats["killer_accuse_blue"]
        ar = stats["killer_accuse_red"]
        print(f"  accuse BLUE (enemies):  {ab/ka*100:5.1f}% ({ab})  {'<-- DECEPTION' if ab > ar else ''}")
        print(f"  accuse RED  (allies):   {ar/ka*100:5.1f}% ({ar})")

    # ── Killer Defend Targets ──
    kd = stats["killer_defend"]
    print(f"\n  KILLER DEFENSE TARGETS ({kd} total)")
    print(f"  {'─'*50}")
    if kd > 0:
        db = stats["killer_defend_blue"]
        dr = stats["killer_defend_red"]
        print(f"  defend BLUE:  {db/kd*100:5.1f}% ({db})")
        print(f"  defend RED:   {dr/kd*100:5.1f}% ({dr})  {'<-- PROTECTING ALLIES' if dr > db else ''}")

    # ── Police Chat ──
    pt = stats["police_total_chat"]
    print(f"\n  POLICE CHAT BEHAVIOR ({pt} opportunities)")
    print(f"  {'─'*50}")
    if pt > 0:
        print(f"  silence:       {stats['police_silence']/pt*100:5.1f}% ({stats['police_silence']})")
        print(f"  accuse:        {stats['police_accuse']/pt*100:5.1f}% ({stats['police_accuse']})")
        print(f"  claim police:  {stats['police_claim_police']/pt*100:5.1f}% ({stats['police_claim_police']})")

    # ── Blue Voting ──
    bv = stats["blue_vote_total"]
    print(f"\n  BLUE (NON-POLICE) VOTING ({bv} votes)")
    print(f"  {'─'*50}")
    if bv > 0:
        print(f"  vote RED  (correct):  {stats['blue_vote_correct_red']/bv*100:5.1f}% ({stats['blue_vote_correct_red']})")
        print(f"  vote BLUE (wrong):    {stats['blue_vote_wrong_blue']/bv*100:5.1f}% ({stats['blue_vote_wrong_blue']})")

    # ── Follow Reveal ──
    fr = stats["blue_follow_reveal"] + stats["blue_ignore_reveal"]
    ff = stats["blue_follow_fake_reveal"] + stats["blue_ignore_fake_reveal"]
    print(f"\n  BLUE RESPONSE TO POLICE REVEALS")
    print(f"  {'─'*50}")
    if fr > 0:
        print(f"  REAL reveal:  follow {stats['blue_follow_reveal']/fr*100:5.1f}%  |  ignore {stats['blue_ignore_reveal']/fr*100:5.1f}%  (n={fr})")
    else:
        print(f"  REAL reveal:  no data")
    if ff > 0:
        print(f"  FAKE reveal:  follow {stats['blue_follow_fake_reveal']/ff*100:5.1f}%  |  ignore {stats['blue_ignore_fake_reveal']/ff*100:5.1f}%  (n={ff})  {'<-- SKEPTICISM' if stats['blue_ignore_fake_reveal'] > stats['blue_follow_fake_reveal'] else '<-- GETTING TRICKED'}")
    else:
        print(f"  FAKE reveal:  no data")

    print(f"\n{'='*70}")


if __name__ == "__main__":
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

    stats = run_analysis(policy, device, num_games=args.games)
    print_report(stats)
