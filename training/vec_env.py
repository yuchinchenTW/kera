"""
Vectorized Mafia Environment (v2)

Runs N parallel games using N BatchedMafiaEnv(num_games=1) subprocesses.
Each subprocess handles one game with step_round for 2x fewer IPC calls.

Usage:
    vec = VecMafiaEnv(num_envs=64)
    obs, masks, infos = vec.reset()
    while training:
        actions = policy(obs, masks)
        obs, masks, rewards, dones, infos = vec.step(actions)
"""

import numpy as np
from concurrent.futures import ThreadPoolExecutor
from env import BatchedMafiaEnv, NUM_PLAYERS, OBS_DIM, TOTAL_MASK_DIM


class VecMafiaEnv:
    """Vectorized: N separate single-game processes for true parallelism."""

    def __init__(self, num_envs=16, theme="GOOD_VS_EVIL", difficulty="hard",
                 seed_start=None, max_workers=None):
        self.num_envs = num_envs
        self.theme = theme
        self.difficulty = difficulty

        self.envs = []
        for i in range(num_envs):
            self.envs.append(BatchedMafiaEnv(num_games=1, theme=theme, difficulty=difficulty))

        self._max_workers = max_workers or min(num_envs, 16)
        self._executor = ThreadPoolExecutor(max_workers=self._max_workers)
        self._game_counter = num_envs

        # Pre-allocate
        self.obs_buf = np.zeros((num_envs, NUM_PLAYERS, OBS_DIM), dtype=np.float32)
        self.mask_buf = np.zeros((num_envs, NUM_PLAYERS, TOTAL_MASK_DIM), dtype=np.float32)
        self.reward_buf = np.zeros((num_envs, NUM_PLAYERS), dtype=np.float32)
        self.done_buf = np.zeros(num_envs, dtype=bool)
        self.ground_truth_buf = np.zeros((num_envs, NUM_PLAYERS * 20), dtype=np.float32)
        # Track phases per env
        self._phases = ["NIGHT"] * num_envs

    def reset(self):
        def reset_one(i):
            seed = self._game_counter + i
            self._game_counter += 1
            obs, masks, infos = self.envs[i].reset(seeds=[seed])
            return i, obs[0], masks[0], infos[0]

        futures = [self._executor.submit(reset_one, i) for i in range(self.num_envs)]
        infos = [None] * self.num_envs

        for f in futures:
            i, obs, masks, info = f.result()
            self.obs_buf[i] = obs
            self.mask_buf[i] = masks
            self.done_buf[i] = False
            self.ground_truth_buf[i] = info["ground_truth"]
            self._phases[i] = info["phase"]
            infos[i] = info

        return self.obs_buf.copy(), self.mask_buf.copy(), infos

    def step(self, actions):
        """
        Step all envs. actions: [num_envs, 18, 4] or [num_envs, 18].
        Automatically does night or vote based on each env's phase.
        """
        actions = np.array(actions)
        if actions.ndim == 2:
            actions = np.stack([actions, np.zeros_like(actions),
                                np.full_like(actions, 18), np.zeros_like(actions)], axis=-1)

        def step_one(i):
            env = self.envs[i]
            act = actions[i:i+1]  # [1, 18, 4]

            # Use step which handles phase detection
            obs, masks, rewards, dones, infos = env.step(act)

            done = dones[0]
            info = infos[0]

            # Auto-reset
            if done:
                new_seed = self._game_counter
                self._game_counter += 1
                info["terminal_usage"] = info.get("usage")
                info["terminal_rewards"] = rewards[0].copy()
                new_obs, new_masks, new_infos = env.reset(seeds=[new_seed])
                obs[0] = new_obs[0]
                masks[0] = new_masks[0]
                info["ground_truth"] = new_infos[0]["ground_truth"]
                info["reset_roles"] = new_infos[0].get("roles")

            return i, obs[0], masks[0], rewards[0], done, info

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
            self._phases[i] = info["phase"]
            infos[i] = info

        return (
            self.obs_buf.copy(),
            self.mask_buf.copy(),
            self.reward_buf.copy(),
            self.done_buf.copy(),
            infos,
        )

    def close(self):
        for env in self.envs:
            env.close()
        self._executor.shutdown(wait=False)

    def __del__(self):
        self.close()
