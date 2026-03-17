"""
Mafia Game Environment for RL Training

Wraps the JS game engine via subprocess, exposing a Gymnasium-compatible interface.
Each environment runs a single 18-player game.

Usage:
    env = MafiaEnv()
    obs, masks, info = env.reset()
    while not done:
        actions = policy(obs, masks)
        obs, masks, rewards, done, info = env.step(actions)
"""

import json
import subprocess
import os
import sys
import numpy as np
from pathlib import Path

# Path to the JS game server
PROJECT_ROOT = Path(__file__).parent.parent
GAME_SERVER_PATH = PROJECT_ROOT / "training" / "game_server.js"
NODE_CMD = "node"

NUM_PLAYERS = 18
OBS_DIM = 1135      # Must match state_encoder.js
NUM_ACTIONS = 19     # 0-17 = target, 18 = no_action/abstain


class MafiaEnv:
    """Single-game Mafia environment wrapping JS game server via subprocess."""

    def __init__(self, theme="GOOD_VS_EVIL", difficulty="hard", seed=None):
        self.theme = theme
        self.difficulty = difficulty
        self.seed = seed
        self._proc = None
        self._start_server()

    def _start_server(self):
        """Spawn a JS game server subprocess."""
        if self._proc is not None:
            self._proc.kill()
            self._proc.wait()

        self._proc = subprocess.Popen(
            [NODE_CMD, str(GAME_SERVER_PATH)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(PROJECT_ROOT),
            text=True,
            bufsize=1,  # line-buffered
        )

    def _send(self, cmd: dict) -> dict:
        """Send a JSON command and receive a JSON response."""
        line = json.dumps(cmd) + "\n"
        try:
            self._proc.stdin.write(line)
            self._proc.stdin.flush()
            response_line = self._proc.stdout.readline()
            if not response_line:
                raise RuntimeError("Game server closed unexpectedly")
            return json.loads(response_line.strip())
        except (BrokenPipeError, OSError) as e:
            raise RuntimeError(f"Game server communication failed: {e}")

    def reset(self, seed=None):
        """
        Reset the environment to a new game.

        Returns:
            obs:   np.ndarray [18, 541] — observations per player
            masks: np.ndarray [18, 19]  — action masks per player
            info:  dict with roles, factions, ground_truth, etc.
        """
        cmd = {
            "cmd": "reset",
            "theme": self.theme,
            "difficulty": self.difficulty,
        }
        if seed is not None:
            cmd["seed"] = seed
        elif self.seed is not None:
            cmd["seed"] = self.seed

        resp = self._send(cmd)
        if not resp.get("ok"):
            raise RuntimeError(f"Reset failed: {resp.get('error')}")

        obs = np.array(resp["obs"], dtype=np.float32)          # [18, 541]
        masks = np.array(resp["masks"], dtype=np.float32)      # [18, 19]
        ground_truth = np.array(resp["ground_truth"], dtype=np.float32)  # [360]

        info = {
            "roles": resp["roles"],
            "factions": resp.get("factions", []),
            "phase": resp["phase"],
            "day": resp["day"],
            "alive": resp["alive"],
            "ground_truth": ground_truth,
            "seed": resp.get("seed"),
        }

        self._phase = resp["phase"]
        self._done = False
        return obs, masks, info

    def step(self, actions):
        """
        Execute one game step (night or vote).

        Args:
            actions: np.ndarray [18] of ints — target indices (0-17) or 18 for no_action/abstain.
                     Use -1 or None to let heuristic AI decide for that player.

        Returns:
            obs:     np.ndarray [18, 541]
            masks:   np.ndarray [18, 19]
            rewards: np.ndarray [18]
            done:    bool
            info:    dict
        """
        if self._done:
            raise RuntimeError("Game already ended. Call reset().")

        # Build action list — only include players with explicit actions
        action_list = []
        for i in range(NUM_PLAYERS):
            a = int(actions[i]) if actions[i] is not None else -1
            if a >= 0 and a <= 18:
                action_list.append({"actorId": i, "targetId": a if a < 18 else None})

        # Determine command based on current phase
        if self._phase == "NIGHT":
            cmd = {"cmd": "step_night", "actions": action_list}
        else:
            cmd = {"cmd": "step_vote", "actions": action_list}

        resp = self._send(cmd)
        if not resp.get("ok"):
            raise RuntimeError(f"Step failed: {resp.get('error')}")

        obs = np.array(resp["obs"], dtype=np.float32)
        masks = np.array(resp["masks"], dtype=np.float32)
        rewards = np.array(resp["rewards"], dtype=np.float32)
        done = resp["done"]
        ground_truth = np.array(resp["ground_truth"], dtype=np.float32)

        info = {
            "phase": resp["phase"],
            "day": resp["day"],
            "alive": resp["alive"],
            "victory": resp.get("victory"),
            "ground_truth": ground_truth,
            "usage": resp.get("usage"),
            "counts": resp.get("counts"),
        }

        self._phase = resp["phase"]
        self._done = done

        # If game ended during night (before vote), we're done
        # If night resolved to DAY phase, auto-advance to vote phase
        # The RL agent gets one action per full cycle (night + vote)
        # But we expose both phases for finer control

        return obs, masks, rewards, done, info

    def step_full_round(self, night_actions, vote_actions):
        """
        Convenience: execute a full night+vote round.

        Args:
            night_actions: np.ndarray [18] — night targets
            vote_actions:  np.ndarray [18] — vote targets

        Returns:
            obs, masks, rewards, done, info (after vote)
        """
        # Night
        obs, masks, rewards_n, done, info = self.step(night_actions)
        if done:
            return obs, masks, rewards_n, done, info

        # Vote
        obs, masks, rewards_v, done, info = self.step(vote_actions)

        # Combine rewards (only terminal matters, but sum shaping)
        rewards = rewards_n + rewards_v
        return obs, masks, rewards, done, info

    def close(self):
        """Shut down the JS subprocess."""
        if self._proc is not None:
            try:
                self._proc.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError):
                pass
            self._proc.kill()
            self._proc.wait()
            self._proc = None

    def __del__(self):
        self.close()


# ─── Quick Test ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=== MafiaEnv Test ===")
    env = MafiaEnv(theme="GOOD_VS_EVIL", difficulty="hard", seed=42)

    obs, masks, info = env.reset()
    print(f"Reset OK — obs: {obs.shape}, masks: {masks.shape}")
    print(f"Roles: {info['roles']}")
    print(f"Phase: {info['phase']}, Day: {info['day']}, Alive: {len(info['alive'])}")

    # Run full game with heuristic AI (actions = all -1 → let AI decide)
    steps = 0
    total_rewards = np.zeros(NUM_PLAYERS, dtype=np.float32)
    done = False

    while not done and steps < 30:
        # Let heuristic AI handle everything (pass -1 for all)
        actions = np.full(NUM_PLAYERS, -1, dtype=np.int32)
        obs, masks, rewards, done, info = env.step(actions)
        total_rewards += rewards
        steps += 1

        phase = info["phase"]
        alive = len(info["alive"])
        day = info["day"]
        if done:
            print(f"  Step {steps}: GAME OVER — Day {day}, Alive: {alive}")
            print(f"  Victory: {info['victory']}")
        elif steps % 2 == 0:
            print(f"  Step {steps}: Phase={phase}, Day={day}, Alive={alive}")

    print(f"\nTotal steps: {steps}")
    print(f"Final rewards: {total_rewards}")
    print(f"Winners (reward > 0): {[i for i in range(NUM_PLAYERS) if total_rewards[i] > 0]}")

    env.close()
    print("=== Test Complete ===")
