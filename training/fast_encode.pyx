# cython: boundscheck=False, wraparound=False, cdivision=True
"""
Cython-optimized observation encoder for Mafia RL training.
Eliminates Python for-loop overhead in encode_all_fast.
"""

import numpy as np
cimport numpy as np
from libc.math cimport fmin, fmax

ctypedef np.float32_t FLOAT
ctypedef np.int32_t INT

cdef int NUM_PLAYERS = 18
cdef int OBS_DIM = 1135
cdef int MASK_DIM = 63
cdef int GLOBAL_DIM = 30
cdef int PER_PLAYER_DIM = 35
cdef int NUM_ROLES_FULL = 20
cdef int VOTE_GRAPH_DIM = 324  # 18*18
cdef int CHAT_MATRIX_DIM = 72  # 18*4
cdef int LAST_WORDS_DIM = 54   # 18*3
cdef int OWN_ROLE_DIM = 25

# Full role indices matching state_encoder.js
cdef int IDX_POLICE = 0
cdef int IDX_KILLER = 1
cdef int IDX_DOCTOR = 2
cdef int IDX_SNIPER = 3
cdef int IDX_CIVILIAN = 19

# Simplified role IDs
cdef int R_POLICE = 0
cdef int R_KILLER = 1
cdef int R_DOCTOR = 2
cdef int R_SNIPER = 3
cdef int R_CIVILIAN = 4

# Faction
cdef int F_BLUE = 0
cdef int F_RED = 1

# Map simplified role -> full role index
cdef int[5] ROLE_TO_FULL = [0, 1, 2, 3, 19]  # POLICE, KILLER, DOCTOR, SNIPER, CIVILIAN
cdef int[5] ROLE_FACTION = [0, 1, 0, 1, 0]   # BLUE, RED, BLUE, RED, BLUE


def encode_all_cy(
    np.ndarray[INT, ndim=1] role_arr,       # [18] simplified role id
    np.ndarray[INT, ndim=1] faction_arr,    # [18] faction
    np.ndarray[FLOAT, ndim=1] alive_arr,    # [18] 0/1
    np.ndarray[FLOAT, ndim=2] suspicion,    # [18, 18]
    np.ndarray[FLOAT, ndim=2] vote_graph,   # [18, 18] normalized
    np.ndarray[FLOAT, ndim=2] vote_together,# [18, 18]
    np.ndarray[FLOAT, ndim=2] accuse_count, # [18, 18]
    np.ndarray[FLOAT, ndim=2] defend_count, # [18, 18]
    np.ndarray[FLOAT, ndim=1] last_tally,   # [18]
    np.ndarray[FLOAT, ndim=1] lw_accused,   # [18]
    np.ndarray[FLOAT, ndim=1] lw_defended,  # [18]
    int day,
    int phase_idx,  # 0=NIGHT, 1=DAY, 2=VOTE
    float doctor_inj,
    float doctor_saves,
    float sniper_shots,
):
    """
    Encode observations and masks for all 18 players.
    Returns (obs[18, 1135], masks[18, 63]).
    """
    cdef np.ndarray[FLOAT, ndim=2] obs = np.zeros((NUM_PLAYERS, OBS_DIM), dtype=np.float32)
    cdef np.ndarray[FLOAT, ndim=2] masks = np.zeros((NUM_PLAYERS, MASK_DIM), dtype=np.float32)

    cdef int pid, qid, o, base, r
    cdef float alive_count, s, max_tally, max_together, ratio
    cdef float is_early, is_mid, is_late, known
    cdef float dead_blue, dead_red
    cdef float acc_row, def_row, speak_t, mention_t
    cdef int is_killer, is_police
    cdef int full_idx

    # Pre-compute
    alive_count = 0
    dead_blue = 0
    dead_red = 0
    for pid in range(NUM_PLAYERS):
        alive_count += alive_arr[pid]
        if alive_arr[pid] == 0:
            if faction_arr[pid] == F_BLUE:
                dead_blue += 1
            else:
                dead_red += 1

    max_tally = 1.0
    for pid in range(NUM_PLAYERS):
        if last_tally[pid] > max_tally:
            max_tally = last_tally[pid]

    max_together = 1.0
    for pid in range(NUM_PLAYERS):
        for qid in range(NUM_PLAYERS):
            if vote_together[pid, qid] > max_together:
                max_together = vote_together[pid, qid]

    # Accuse/defend row sums
    cdef np.ndarray[FLOAT, ndim=1] acc_row_sums = np.zeros(NUM_PLAYERS, dtype=np.float32)
    cdef np.ndarray[FLOAT, ndim=1] def_row_sums = np.zeros(NUM_PLAYERS, dtype=np.float32)
    cdef np.ndarray[FLOAT, ndim=1] acc_col_sums = np.zeros(NUM_PLAYERS, dtype=np.float32)
    cdef np.ndarray[FLOAT, ndim=1] def_col_sums = np.zeros(NUM_PLAYERS, dtype=np.float32)
    cdef np.ndarray[FLOAT, ndim=1] speak_total = np.zeros(NUM_PLAYERS, dtype=np.float32)
    cdef np.ndarray[FLOAT, ndim=1] mention_total = np.zeros(NUM_PLAYERS, dtype=np.float32)

    for pid in range(NUM_PLAYERS):
        for qid in range(NUM_PLAYERS):
            acc_row_sums[pid] += accuse_count[pid, qid]
            def_row_sums[pid] += defend_count[pid, qid]
            acc_col_sums[qid] += accuse_count[pid, qid]
            def_col_sums[qid] += defend_count[pid, qid]
        speak_total[pid] = acc_row_sums[pid] + def_row_sums[pid]

    for pid in range(NUM_PLAYERS):
        mention_total[pid] = acc_col_sums[pid] + def_col_sums[pid]
        if acc_row_sums[pid] == 0: acc_row_sums[pid] = 1
        if def_row_sums[pid] == 0: def_row_sums[pid] = 1

    # Game phase
    ratio = alive_count / NUM_PLAYERS
    if day <= 2 and ratio > 0.7:
        is_early = 1.0; is_mid = 0.0; is_late = 0.0
    elif day <= 4 and ratio > 0.4:
        is_early = 0.0; is_mid = 1.0; is_late = 0.0
    else:
        is_early = 0.0; is_mid = 0.0; is_late = 1.0

    # ── Encode each player ──
    for pid in range(NUM_PLAYERS):
        o = 0
        is_killer = 1 if role_arr[pid] == R_KILLER else 0
        is_police = 1 if role_arr[pid] == R_POLICE else 0

        # Global (30)
        obs[pid, o] = fmin(day / 15.0, 1.0); o += 1
        obs[pid, o + phase_idx] = 1.0; o += 3
        obs[pid, o] = alive_count / NUM_PLAYERS; o += 1
        obs[pid, o] = dead_blue / NUM_PLAYERS; o += 1
        obs[pid, o] = dead_red / NUM_PLAYERS; o += 1
        o += 1  # green
        obs[pid, o] = 1.0; o += 8  # theme GOOD_VS_EVIL
        obs[pid, o] = is_early; obs[pid, o+1] = is_mid; obs[pid, o+2] = is_late; o += 3
        obs[pid, o] = doctor_inj / 6.0; o += 1
        obs[pid, o] = doctor_saves / 6.0; o += 1
        obs[pid, o] = sniper_shots / 4.0; o += 1
        o = GLOBAL_DIM

        # Per-player (18 x 35)
        for qid in range(NUM_PLAYERS):
            base = o

            # is_self, is_alive, is_known_ally
            obs[pid, o] = 1.0 if qid == pid else 0.0; o += 1
            obs[pid, o] = alive_arr[qid]; o += 1

            known = 0.0
            if qid == pid:
                known = 1.0
            elif is_killer and role_arr[qid] == R_KILLER and alive_arr[qid] > 0:
                known = 1.0
            elif is_police and role_arr[qid] == R_POLICE and alive_arr[qid] > 0:
                known = 1.0
            obs[pid, o] = known; o += 1

            # role_probs (20)
            full_idx = ROLE_TO_FULL[role_arr[qid]]
            if alive_arr[qid] == 0 or qid == pid or known > 0:
                obs[pid, o + full_idx] = 1.0
            else:
                s = suspicion[pid, qid]
                obs[pid, o + IDX_KILLER] = s * 0.5
                obs[pid, o + IDX_SNIPER] = s * 0.2
                obs[pid, o + IDX_POLICE] = (1 - s) * 0.3
                obs[pid, o + IDX_DOCTOR] = (1 - s) * 0.1
                obs[pid, o + IDX_CIVILIAN] = (1 - s) * 0.4
            o += NUM_ROLES_FULL

            # suspicion, vote_pressure, speak, mention
            obs[pid, o] = suspicion[pid, qid]; o += 1
            obs[pid, o] = last_tally[qid] / max_tally; o += 1
            obs[pid, o] = fmin(speak_total[qid] / 5.0, 1.0); o += 1
            obs[pid, o] = fmin(mention_total[qid] / 5.0, 1.0); o += 1

            # Social (8)
            obs[pid, o] = accuse_count[pid, qid] / acc_row_sums[pid]; o += 1
            obs[pid, o] = defend_count[pid, qid] / def_row_sums[pid]; o += 1
            obs[pid, o] = accuse_count[qid, pid] / acc_row_sums[qid]; o += 1
            obs[pid, o] = defend_count[qid, pid] / def_row_sums[qid]; o += 1
            obs[pid, o] = vote_together[pid, qid] / max_together; o += 1
            obs[pid, o] = lw_accused[qid]; o += 1
            obs[pid, o] = lw_defended[qid]; o += 1
            obs[pid, o] = 0; o += 1  # claimed role

        # Vote graph (324)
        for r in range(NUM_PLAYERS):
            for qid in range(NUM_PLAYERS):
                obs[pid, o] = vote_graph[r, qid]; o += 1

        # Chat matrix (72)
        for qid in range(NUM_PLAYERS):
            obs[pid, o] = acc_row_sums[qid]; o += 1
            obs[pid, o] = def_row_sums[qid]; o += 1
            obs[pid, o] = acc_col_sums[qid]; o += 1
            obs[pid, o] = def_col_sums[qid]; o += 1

        # Last words (54)
        for qid in range(NUM_PLAYERS):
            obs[pid, o] = lw_accused[qid]; o += 1
        for qid in range(NUM_PLAYERS):
            obs[pid, o] = lw_defended[qid]; o += 1
        o += NUM_PLAYERS  # claimed roles = 0

        # Own role (25)
        full_idx = ROLE_TO_FULL[role_arr[pid]]
        obs[pid, o + full_idx] = 1.0; o += NUM_ROLES_FULL
        obs[pid, o + faction_arr[pid]] = 1.0; o += 3
        if role_arr[pid] == R_DOCTOR:
            obs[pid, o] = (6.0 - doctor_inj) / 6.0
        elif role_arr[pid] == R_SNIPER:
            obs[pid, o] = (4.0 - sniper_shots) / 4.0
        o += 2

        # ── Masks ──
        if alive_arr[pid] == 0:
            masks[pid, 18] = 1; masks[pid, 19] = 1; masks[pid, 42] = 1
            continue

        if phase_idx == 0:  # NIGHT
            if role_arr[pid] == R_CIVILIAN:
                masks[pid, 18] = 1
            else:
                for qid in range(NUM_PLAYERS):
                    if qid == pid or alive_arr[qid] == 0: continue
                    if role_arr[pid] == R_KILLER and role_arr[qid] == R_KILLER: continue
                    masks[pid, qid] = 1
                masks[pid, 18] = 1
            masks[pid, 19] = 1  # silence
        else:  # DAY/VOTE
            for qid in range(NUM_PLAYERS):
                if qid == pid or alive_arr[qid] == 0: continue
                masks[pid, qid] = 1
                masks[pid, 24 + qid] = 1  # chat target
            masks[pid, 18] = 1  # abstain
            masks[pid, 19] = 1; masks[pid, 20] = 1; masks[pid, 21] = 1
            masks[pid, 22] = 1; masks[pid, 23] = 1  # all chat types
            for r in range(NUM_ROLES_FULL):
                masks[pid, 43 + r] = 1

        masks[pid, 42] = 1  # chat target nobody

    return obs, masks
