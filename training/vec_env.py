"""
Vectorized Mafia Environment

Runs N parallel games for efficient batch training.
Each game is an independent MafiaEnv subprocess.

Usage:
    vec = VecMafiaEnv(num_envs=64)
    obs, masks, infos = vec.reset()
    while training:
        actions = policy(obs, masks)       # [num_envs, 18]
        obs, masks, rewards, dones, infos = vec.step(actions)
        # auto-resets done environments
"""

import numpy as np
from concurrent.futures import ThreadPoolExecutor
from env import MafiaEnv, NUM_PLAYERS, OBS_DIM, NUM_ACTIONS


class VecMafiaEnv:
    """Vectorized environment running N parallel Mafia games."""

    def __init__(self, num_envs=16, theme="GOOD_VS_EVIL", difficulty="hard",
                 seed_start=None, max_workers=None):
        self.num_envs = num_envs
        self.theme = theme
        self.difficulty = difficulty

        # Create environments with different seeds
        self.envs = []
        for i in range(num_envs):
            seed = (seed_start + i) if seed_start is not None else None
            self.envs.append(MafiaEnv(theme=theme, difficulty=difficulty, seed=seed))

        self._max_workers = max_workers or min(num_envs, 8)
        self._executor = ThreadPoolExecutor(max_workers=self._max_workers)

        # Pre-allocate buffers
        self.obs_buf = np.zeros((num_envs, NUM_PLAYERS, OBS_DIM), dtype=np.float32)
        self.mask_buf = np.zeros((num_envs, NUM_PLAYERS, NUM_ACTIONS), dtype=np.float32)
        self.reward_buf = np.zeros((num_envs, NUM_PLAYERS), dtype=np.float32)
        self.done_buf = np.zeros(num_envs, dtype=bool)
        self.ground_truth_buf = np.zeros((num_envs, NUM_PLAYERS * 20), dtype=np.float32)

        # Track game count for auto-reset seeds
        self._game_counter = num_envs

    def reset(self):
        """
        Reset all environments.

        Returns:
            obs:   [num_envs, 18, 541]
            masks: [num_envs, 18, 19]
            infos: list of dicts
        """
        def reset_one(i):
            seed = self._game_counter + i
            self._game_counter += 1
            obs, masks, info = self.envs[i].reset(seed=seed)
            return i, obs, masks, info

        futures = [self._executor.submit(reset_one, i) for i in range(self.num_envs)]
        infos = [None] * self.num_envs

        for f in futures:
            i, obs, masks, info = f.result()
            self.obs_buf[i] = obs
            self.mask_buf[i] = masks
            self.done_buf[i] = False
            self.ground_truth_buf[i] = info["ground_truth"]
            infos[i] = info

        return self.obs_buf.copy(), self.mask_buf.copy(), infos

    def step(self, actions):
        """
        Step all environments with given actions. Auto-resets done envs.

        Args:
            actions: [num_envs, 18] int array — target indices per player per env

        Returns:
            obs:     [num_envs, 18, 541]
            masks:   [num_envs, 18, 19]
            rewards: [num_envs, 18]
            dones:   [num_envs] bool
            infos:   list of dicts
        """
        def step_one(i):
            env = self.envs[i]
            act = actions[i]

            obs, masks, rewards, done, info = env.step(act)

            # Auto-reset if done
            if done:
                new_seed = self._game_counter
                self._game_counter += 1
                # Preserve terminal info before reset overwrites
                info["terminal_obs"] = obs
                info["terminal_rewards"] = rewards
                info["terminal_usage"] = info.get("usage")
                new_obs, new_masks, new_info = env.reset(seed=new_seed)
                obs = new_obs
                masks = new_masks
                info["ground_truth"] = new_info["ground_truth"]
                info["reset_roles"] = new_info["roles"]

            return i, obs, masks, rewards, done, info

        futures = [self._executor.submit(step_one, i) for i in range(self.num_envs)]
        infos = [None] * self.num_envs

        for f in futures:
            i, obs, masks, rewards, done, info = f.result()
            self.obs_buf[i] = obs
            self.mask_buf[i] = masks
            self.reward_buf[i] = rewards
            self.done_buf[i] = done
            if "ground_truth" in info:
                self.ground_truth_buf[i] = info["ground_truth"]
            infos[i] = info

        return (
            self.obs_buf.copy(),
            self.mask_buf.copy(),
            self.reward_buf.copy(),
            self.done_buf.copy(),
            infos,
        )

    def close(self):
        """Shut down all environments and thread pool."""
        for env in self.envs:
            env.close()
        self._executor.shutdown(wait=False)

    def __del__(self):
        self.close()


# ─── Quick Test ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import time

    NUM_ENVS = 4
    print(f"=== VecMafiaEnv Test ({NUM_ENVS} envs) ===")

    vec = VecMafiaEnv(num_envs=NUM_ENVS, difficulty="hard", seed_start=100)

    obs, masks, infos = vec.reset()
    print(f"Reset OK — obs: {obs.shape}, masks: {masks.shape}")

    # Run games to completion
    total_steps = 0
    total_games = 0
    t0 = time.time()

    for _ in range(50):  # max 50 batched steps
        actions = np.full((NUM_ENVS, NUM_PLAYERS), -1, dtype=np.int32)
        obs, masks, rewards, dones, infos = vec.step(actions)
        total_steps += 1

        for i, done in enumerate(dones):
            if done:
                total_games += 1
                v = infos[i].get("victory")
                winner = v["winner"] if v else "?"
                r = infos[i].get("terminal_rewards")
                print(f"  Env {i}: Game ended — {winner} (step {total_steps})")

        if total_games >= NUM_ENVS * 2:
            break

    elapsed = time.time() - t0
    print(f"\nCompleted {total_games} games in {elapsed:.1f}s ({total_games/elapsed:.1f} games/sec)")
    print(f"Total batched steps: {total_steps}")

    vec.close()
    print("=== Test Complete ===")
