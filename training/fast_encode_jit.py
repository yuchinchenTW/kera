"""
Numba JIT-compiled observation encoder.
Replaces the Python for-loop encoder with compiled machine code.
No C compiler needed — Numba compiles at runtime.
"""

import numpy as np
from numba import njit, prange

NUM_PLAYERS = 18
OBS_DIM = 1135
MASK_DIM = 63
GLOBAL_DIM = 30
PER_PLAYER_DIM = 35
NUM_ROLES_FULL = 20

# Full role indices
IDX_POLICE = 0
IDX_KILLER = 1
IDX_DOCTOR = 2
IDX_SNIPER = 3
IDX_CIVILIAN = 19

# Simplified role -> full index
ROLE_TO_FULL = np.array([0, 1, 2, 3, 19], dtype=np.int32)

# Simplified role IDs
R_POLICE = 0
R_KILLER = 1
R_DOCTOR = 2
R_SNIPER = 3
R_CIVILIAN = 4

F_BLUE = 0
F_RED = 1


@njit(cache=True)
def _encode_all(
    role_arr,        # int32[18]
    faction_arr,     # int32[18]
    alive_arr,       # float32[18]
    suspicion,       # float32[18, 18]
    vote_graph,      # float32[18, 18]
    vote_together,   # float32[18, 18]
    accuse_count,    # float32[18, 18]
    defend_count,    # float32[18, 18]
    last_tally,      # float32[18]
    lw_accused,      # float32[18]
    lw_defended,     # float32[18]
    day,             # int
    phase_idx,       # int: 0=NIGHT, 1=DAY, 2=VOTE
    doctor_inj,      # float
    doctor_saves,    # float
    sniper_shots,    # float
    role_to_full,    # int32[5]
):
    N = 18
    obs = np.zeros((N, OBS_DIM), dtype=np.float32)
    masks = np.zeros((N, MASK_DIM), dtype=np.float32)

    # Pre-compute
    alive_count = np.float32(0.0)
    dead_blue = np.float32(0.0)
    dead_red = np.float32(0.0)
    for i in range(N):
        alive_count += alive_arr[i]
        if alive_arr[i] == 0:
            if faction_arr[i] == F_BLUE:
                dead_blue += 1
            else:
                dead_red += 1

    max_tally = np.float32(1.0)
    for i in range(N):
        if last_tally[i] > max_tally:
            max_tally = last_tally[i]

    max_together = np.float32(1.0)
    for i in range(N):
        for j in range(N):
            if vote_together[i, j] > max_together:
                max_together = vote_together[i, j]

    # Row/col sums
    acc_row = np.zeros(N, dtype=np.float32)
    def_row = np.zeros(N, dtype=np.float32)
    acc_col = np.zeros(N, dtype=np.float32)
    def_col = np.zeros(N, dtype=np.float32)
    speak_t = np.zeros(N, dtype=np.float32)
    mention_t = np.zeros(N, dtype=np.float32)
    # Raw row sums for chat matrix output (before normalization)
    acc_row_raw = np.zeros(N, dtype=np.float32)
    def_row_raw = np.zeros(N, dtype=np.float32)

    for i in range(N):
        for j in range(N):
            acc_row[i] += accuse_count[i, j]
            def_row[i] += defend_count[i, j]
            acc_col[j] += accuse_count[i, j]
            def_col[j] += defend_count[i, j]
        acc_row_raw[i] = acc_row[i]
        def_row_raw[i] = def_row[i]
        speak_t[i] = acc_row[i] + def_row[i]
    for i in range(N):
        mention_t[i] = acc_col[i] + def_col[i]
        # Normalize for per-player division (avoid div-by-zero)
        if acc_row[i] == 0: acc_row[i] = 1
        if def_row[i] == 0: def_row[i] = 1

    # Game phase
    ratio = alive_count / N
    is_early = np.float32(1.0) if day <= 2 and ratio > 0.7 else np.float32(0.0)
    is_late = np.float32(1.0) if not (day <= 4 and ratio > 0.4) else np.float32(0.0)
    is_mid = np.float32(1.0) if is_early == 0 and is_late == 0 else np.float32(0.0)

    for pid in range(N):
        o = 0
        ik = 1 if role_arr[pid] == R_KILLER else 0
        ip = 1 if role_arr[pid] == R_POLICE else 0

        # Global (30)
        obs[pid, o] = min(day / 15.0, 1.0); o += 1
        obs[pid, o + phase_idx] = 1.0; o += 3
        obs[pid, o] = alive_count / N; o += 1
        obs[pid, o] = dead_blue / N; o += 1
        obs[pid, o] = dead_red / N; o += 1
        o += 1
        obs[pid, o] = 1.0; o += 8
        obs[pid, o] = is_early; obs[pid, o+1] = is_mid; obs[pid, o+2] = is_late; o += 3
        obs[pid, o] = doctor_inj / 6.0; o += 1
        obs[pid, o] = doctor_saves / 6.0; o += 1
        obs[pid, o] = sniper_shots / 4.0; o += 1
        o = GLOBAL_DIM

        # Per-player (18 x 35)
        for qid in range(N):
            obs[pid, o] = 1.0 if qid == pid else 0.0; o += 1
            obs[pid, o] = alive_arr[qid]; o += 1

            kn = np.float32(0.0)
            if qid == pid:
                kn = 1.0
            elif ik == 1 and role_arr[qid] == R_KILLER and alive_arr[qid] > 0:
                kn = 1.0
            elif ip == 1 and role_arr[qid] == R_POLICE and alive_arr[qid] > 0:
                kn = 1.0
            obs[pid, o] = kn; o += 1

            fi = role_to_full[role_arr[qid]]
            if alive_arr[qid] == 0 or qid == pid or kn > 0:
                obs[pid, o + fi] = 1.0
            else:
                s = suspicion[pid, qid]
                obs[pid, o + IDX_KILLER] = s * 0.5
                obs[pid, o + IDX_SNIPER] = s * 0.2
                obs[pid, o + IDX_POLICE] = (1 - s) * 0.3
                obs[pid, o + IDX_DOCTOR] = (1 - s) * 0.1
                obs[pid, o + IDX_CIVILIAN] = (1 - s) * 0.4
            o += NUM_ROLES_FULL

            obs[pid, o] = suspicion[pid, qid]; o += 1
            obs[pid, o] = last_tally[qid] / max_tally; o += 1
            obs[pid, o] = min(speak_t[qid] / 5.0, 1.0); o += 1
            obs[pid, o] = min(mention_t[qid] / 5.0, 1.0); o += 1

            obs[pid, o] = accuse_count[pid, qid] / acc_row[pid]; o += 1
            obs[pid, o] = defend_count[pid, qid] / def_row[pid]; o += 1
            obs[pid, o] = accuse_count[qid, pid] / acc_row[qid]; o += 1
            obs[pid, o] = defend_count[qid, pid] / def_row[qid]; o += 1
            obs[pid, o] = vote_together[pid, qid] / max_together; o += 1
            obs[pid, o] = lw_accused[qid]; o += 1
            obs[pid, o] = lw_defended[qid]; o += 1
            obs[pid, o] = 0; o += 1

        # Vote graph (324)
        for r in range(N):
            for qid in range(N):
                obs[pid, o] = vote_graph[r, qid]; o += 1

        # Chat matrix (72) — use raw counts, not normalized
        for qid in range(N):
            obs[pid, o] = acc_row_raw[qid]; o += 1
            obs[pid, o] = def_row_raw[qid]; o += 1
            obs[pid, o] = acc_col[qid]; o += 1
            obs[pid, o] = def_col[qid]; o += 1

        # Last words (54)
        for qid in range(N):
            obs[pid, o] = lw_accused[qid]; o += 1
        for qid in range(N):
            obs[pid, o] = lw_defended[qid]; o += 1
        o += N

        # Own role (25)
        fi = role_to_full[role_arr[pid]]
        obs[pid, o + fi] = 1.0; o += NUM_ROLES_FULL
        obs[pid, o + faction_arr[pid]] = 1.0; o += 3
        if role_arr[pid] == R_DOCTOR:
            obs[pid, o] = (6.0 - doctor_inj) / 6.0
        elif role_arr[pid] == R_SNIPER:
            obs[pid, o] = (4.0 - sniper_shots) / 4.0
        o += 2

        # Masks
        if alive_arr[pid] == 0:
            masks[pid, 18] = 1; masks[pid, 19] = 1; masks[pid, 42] = 1
            continue

        if phase_idx == 0:
            if role_arr[pid] == R_CIVILIAN:
                masks[pid, 18] = 1
            else:
                for qid in range(N):
                    if qid == pid or alive_arr[qid] == 0: continue
                    if role_arr[pid] == R_KILLER and role_arr[qid] == R_KILLER: continue
                    masks[pid, qid] = 1
                masks[pid, 18] = 1
            masks[pid, 19] = 1
        else:
            for qid in range(N):
                if qid == pid or alive_arr[qid] == 0: continue
                masks[pid, qid] = 1
                masks[pid, 24 + qid] = 1
            masks[pid, 18] = 1
            masks[pid, 19] = 1; masks[pid, 20] = 1; masks[pid, 21] = 1
            masks[pid, 22] = 1; masks[pid, 23] = 1
            for r in range(NUM_ROLES_FULL):
                masks[pid, 43 + r] = 1
        masks[pid, 42] = 1

    return obs, masks


def encode_game_jit(game):
    """Wrapper: extract numpy arrays from game object and call JIT encoder."""
    role_arr = np.array([p.role for p in game.players], dtype=np.int32)
    faction_arr = np.array([p.faction for p in game.players], dtype=np.int32)
    alive_arr = np.array([1.0 if p.alive else 0.0 for p in game.players], dtype=np.float32)

    # Pre-compute social matrices
    N = 18
    vote_graph = np.zeros((N, N), dtype=np.float32)
    vote_together = np.zeros((N, N), dtype=np.float32)
    last_tally = np.zeros(N, dtype=np.float32)
    accuse_count = np.zeros((N, N), dtype=np.float32)
    defend_count = np.zeros((N, N), dtype=np.float32)

    for vr in game.vote_history:
        for voter, target in vr.items():
            vote_graph[voter, target] += 1
        vl = list(vr.items())
        for i in range(len(vl)):
            for j in range(i + 1, len(vl)):
                if vl[i][1] == vl[j][1]:
                    vote_together[vl[i][0], vl[j][0]] += 1
                    vote_together[vl[j][0], vl[i][0]] += 1
    if game.vote_history:
        for _, target in game.vote_history[-1].items():
            last_tally[target] += 1

    rs = vote_graph.sum(axis=1, keepdims=True)
    rs[rs == 0] = 1
    vote_graph /= rs

    for rc in game.chat_history:
        for (speaker, ctype, ctarget, _) in rc:
            if ctype == 1 and 0 <= ctarget < N:
                accuse_count[speaker, ctarget] += 1
            elif ctype == 2 and 0 <= ctarget < N:
                defend_count[speaker, ctarget] += 1

    phase_idx = 0 if game.phase == "NIGHT" else 1 if game.phase == "DAY" else 2

    return _encode_all(
        role_arr, faction_arr, alive_arr, game.suspicion,
        vote_graph, vote_together, accuse_count, defend_count,
        last_tally, game.last_words_accused, game.last_words_defended,
        game.day, phase_idx,
        float(game.doctor_injections), float(game.doctor_saves), float(game.sniper_shots),
        ROLE_TO_FULL,
    )
