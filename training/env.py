"""
Batched Mafia Game Environment for RL Training (v2)

Single Node.js process runs N games simultaneously.
Supports step_round (night+vote in one IPC call) for maximum throughput.

Usage:
    env = BatchedMafiaEnv(num_games=32)
    obs, masks, infos = env.reset()
    while training:
        actions = policy(obs, masks)         # [num_games, 18, 4]
        obs, masks, rewards, dones, infos = env.step_round(night_actions, vote_actions)
"""

import json
import subprocess
import numpy as np
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
GAME_SERVER_PATH = PROJECT_ROOT / "training" / "game_server.js"
NODE_CMD = "node"

NUM_PLAYERS = 18
OBS_DIM = 1135
NUM_ACTIONS = 19
TOTAL_MASK_DIM = 63


class BatchedMafiaEnv:
    """
    Batched environment: one Node.js process, N games.
    Eliminates per-env subprocess overhead.
    """

    def __init__(self, num_games=16, theme="GOOD_VS_EVIL", difficulty="hard"):
        self.num_games = num_games
        self.theme = theme
        self.difficulty = difficulty
        self._proc = None
        self._game_counter = 0
        self._start_server()

    def _start_server(self):
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
            bufsize=1,
        )

        # Initialize N games
        resp = self._send({"cmd": "init", "numGames": self.num_games,
                           "theme": self.theme, "difficulty": self.difficulty})
        if not resp.get("ok"):
            raise RuntimeError(f"Init failed: {resp}")

    def _send(self, cmd):
        line = json.dumps(cmd) + "\n"
        try:
            self._proc.stdin.write(line)
            self._proc.stdin.flush()
            response_line = self._proc.stdout.readline()
            if not response_line:
                raise RuntimeError("Game server closed")
            return json.loads(response_line.strip())
        except (BrokenPipeError, OSError) as e:
            raise RuntimeError(f"IPC failed: {e}")

    def reset(self, seeds=None):
        """Reset all N games. Returns obs[N,18,1135], masks[N,18,63], infos."""
        if seeds is None:
            seeds = [self._game_counter + i for i in range(self.num_games)]
            self._game_counter += self.num_games

        resp = self._send({"cmd": "reset_all", "seeds": seeds})
        if not resp.get("ok"):
            raise RuntimeError(f"Reset failed: {resp}")

        games = resp["games"]
        obs = np.array([g["obs"] for g in games], dtype=np.float32)
        masks = np.array([g["masks"] for g in games], dtype=np.float32)
        gt = np.array([g["ground_truth"] for g in games], dtype=np.float32)

        infos = []
        for g in games:
            infos.append({
                "roles": g.get("roles"),
                "factions": g.get("factions"),
                "phase": g["phase"],
                "day": g["day"],
                "alive": g["alive"],
                "ground_truth": np.array(g["ground_truth"], dtype=np.float32),
            })

        self._phases = [g["phase"] for g in games]
        self._dones = [g["done"] for g in games]
        return obs, masks, infos

    def reset_game(self, game_idx, seed=None):
        """Reset a single game (for auto-reset on done)."""
        if seed is None:
            seed = self._game_counter
            self._game_counter += 1

        resp = self._send({"cmd": "reset_all", "seeds":
            [seed if i == game_idx else -1 for i in range(self.num_games)]})
        # This resets all games, which is wasteful. Use targeted reset instead.
        # Actually, let's just reset the one that's done via a simpler mechanism.
        # For now, batch reset all done games at once.
        return resp

    def step_round(self, night_actions, vote_actions):
        """
        Execute night + vote for all games in ONE IPC call.

        Args:
            night_actions: [N, 18, 4] — per game, per player, 4 heads
            vote_actions:  [N, 18, 4] — per game, per player, 4 heads
            Use all -1 to let heuristic decide.

        Returns:
            obs[N,18,1135], masks[N,18,63], rewards[N,18], dones[N], infos[N]
        """
        game_inputs = []
        for g in range(self.num_games):
            na = self._build_action_list(night_actions[g])
            va = self._build_action_list(vote_actions[g])
            game_inputs.append({"nightActions": na, "voteActions": va})

        resp = self._send({"cmd": "step_round", "games": game_inputs})
        if not resp.get("ok"):
            raise RuntimeError(f"Step failed: {resp}")

        return self._parse_batch_response(resp["games"])

    def step(self, actions):
        """
        Single-phase step (night OR vote based on current phase).
        For backward compatibility with train.py.

        Args:
            actions: [N, 18, 4] or [N, 18] — per game, per player

        Returns:
            obs, masks, rewards, dones, infos
        """
        actions = np.array(actions)
        if actions.ndim == 2:
            # Legacy [N, 18] -> expand to [N, 18, 4]
            actions = np.stack([actions, np.zeros_like(actions),
                                np.full_like(actions, 18), np.zeros_like(actions)], axis=-1)

        # Determine phase per game — use majority phase
        night_games = sum(1 for p in self._phases if p == "NIGHT")
        if night_games > self.num_games // 2:
            cmd = "step_night_batch"
        else:
            cmd = "step_vote_batch"

        game_inputs = []
        for g in range(self.num_games):
            game_inputs.append({"actions": self._build_action_list(actions[g])})

        resp = self._send({"cmd": cmd, "games": game_inputs})
        if not resp.get("ok"):
            raise RuntimeError(f"Step failed: {resp}")

        return self._parse_batch_response(resp["games"])

    def _build_action_list(self, player_actions):
        """Convert [18, 4] numpy array to list of action dicts for game server."""
        action_list = []
        for i in range(NUM_PLAYERS):
            target = int(player_actions[i, 0]) if player_actions.ndim > 1 else int(player_actions[i])
            if target < 0:
                continue  # heuristic decides

            entry = {"actorId": i, "targetId": target if target < 18 else None}

            if player_actions.ndim > 1 and player_actions.shape[1] >= 4:
                chat_type = int(player_actions[i, 1])
                chat_target = int(player_actions[i, 2])
                claim_role = int(player_actions[i, 3])
                if chat_type > 0:
                    entry["chatType"] = chat_type
                    entry["chatTargetId"] = chat_target if chat_target < 18 else None
                    entry["claimRoleId"] = claim_role

            action_list.append(entry)
        return action_list

    def _parse_batch_response(self, games):
        """Parse batched game responses into numpy arrays."""
        N = self.num_games
        obs = np.zeros((N, NUM_PLAYERS, OBS_DIM), dtype=np.float32)
        masks = np.zeros((N, NUM_PLAYERS, TOTAL_MASK_DIM), dtype=np.float32)
        rewards = np.zeros((N, NUM_PLAYERS), dtype=np.float32)
        dones = np.zeros(N, dtype=bool)
        infos = [None] * N

        for g, game in enumerate(games):
            obs[g] = np.array(game["obs"], dtype=np.float32)
            masks[g] = np.array(game["masks"], dtype=np.float32)
            rewards[g] = np.array(game["rewards"], dtype=np.float32)
            dones[g] = game["done"]
            self._phases[g] = game["phase"]
            self._dones[g] = game["done"]

            infos[g] = {
                "phase": game["phase"],
                "day": game["day"],
                "alive": game["alive"],
                "victory": game.get("victory"),
                "ground_truth": np.array(game["ground_truth"], dtype=np.float32),
                "usage": game.get("usage"),
                "counts": game.get("counts"),
            }

        # Auto-reset done games
        done_indices = [g for g in range(N) if dones[g]]
        if done_indices:
            # Preserve terminal info
            for g in done_indices:
                infos[g]["terminal_usage"] = infos[g].get("usage")
                infos[g]["terminal_rewards"] = rewards[g].copy()

            # Reset done games
            seeds = [self._game_counter + i for i in range(len(done_indices))]
            self._game_counter += len(done_indices)

            reset_resp = self._send({"cmd": "reset_all",
                "seeds": [seeds.pop(0) if g in done_indices else -1 for g in range(N)]})

            if reset_resp.get("ok"):
                for g_idx, g_data in enumerate(reset_resp["games"]):
                    g = g_idx
                    if g not in done_indices:
                        continue
                    # Overwrite obs/masks with fresh game (but keep terminal rewards)
                    obs[g] = np.array(g_data["obs"], dtype=np.float32)
                    masks[g] = np.array(g_data["masks"], dtype=np.float32)
                    self._phases[g] = g_data["phase"]
                    self._dones[g] = False
                    infos[g]["ground_truth"] = np.array(g_data["ground_truth"], dtype=np.float32)
                    infos[g]["reset_roles"] = g_data.get("roles")

        return obs, masks, rewards, dones, infos

    def close(self):
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


# Legacy compat aliases
MafiaEnv = BatchedMafiaEnv


# ─── Quick Test ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import time

    N = 8
    print(f"=== BatchedMafiaEnv Test ({N} games in 1 process) ===")

    env = BatchedMafiaEnv(num_games=N, difficulty="hard")
    obs, masks, infos = env.reset()
    print(f"Reset OK — obs: {obs.shape}, masks: {masks.shape}")

    total_games = 0
    t0 = time.time()

    for step in range(50):
        # All heuristic (-1)
        night_act = np.full((N, NUM_PLAYERS, 4), -1, dtype=np.int32)
        vote_act = np.full((N, NUM_PLAYERS, 4), -1, dtype=np.int32)
        obs, masks, rewards, dones, infos = env.step_round(night_act, vote_act)

        for g, done in enumerate(dones):
            if done:
                total_games += 1
                v = infos[g].get("victory")
                if total_games <= 3:
                    print(f"  Game done: {v['winner'] if v else '?'} (step {step+1})")

        if total_games >= N * 3:
            break

    elapsed = time.time() - t0
    print(f"\n{total_games} games in {elapsed:.1f}s ({total_games/elapsed:.1f} games/sec)")

    env.close()
    print("=== Test Complete ===")
