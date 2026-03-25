"""
Fast Python Game Engine for RL Training

Minimal GOOD_VS_EVIL implementation: 4 Police, 4 Killer, 1 Doctor, 1 Sniper, 8 Civilian.
Runs entirely in Python — no IPC, no subprocess. Designed for maximum training throughput.

All game logic mirrors src/engine.js behavior for the GOOD_VS_EVIL theme.
"""

import numpy as np
from dataclasses import dataclass, field
from typing import Optional

NUM_PLAYERS = 18
ROLES = ["POLICE"] * 4 + ["KILLER"] * 4 + ["DOCTOR"] * 1 + ["SNIPER"] * 1 + ["CIVILIAN"] * 8

# Role indices
R_POLICE = 0
R_KILLER = 1
R_DOCTOR = 2
R_SNIPER = 3
R_CIVILIAN = 4

ROLE_MAP = {"POLICE": R_POLICE, "KILLER": R_KILLER, "DOCTOR": R_DOCTOR, "SNIPER": R_SNIPER, "CIVILIAN": R_CIVILIAN}
ROLE_NAMES = ["POLICE", "KILLER", "DOCTOR", "SNIPER", "CIVILIAN"]

# Faction
F_BLUE = 0
F_RED = 1
ROLE_FACTION = {R_POLICE: F_BLUE, R_KILLER: F_RED, R_DOCTOR: F_BLUE, R_SNIPER: F_RED, R_CIVILIAN: F_BLUE}

# Chat types
CHAT_SILENCE = 0
CHAT_ACCUSE = 1
CHAT_DEFEND = 2
CHAT_CLAIM = 3
CHAT_DEFLECT = 4

# 20 role IDs for observation encoding (matches state_encoder.js)
ROLE_IDS_FULL = [
    "POLICE", "KILLER", "DOCTOR", "SNIPER", "AGENT", "TERRORIST", "COWBOY",
    "KIDNAPPER", "ZOMBIE", "RIOT_POLICE", "ARSONIST", "HEAVENLY_FIEND",
    "VINE_DEMON", "BRAT", "NIGHTMARE_DEMON", "EXORCIST", "NECROMANCER",
    "PURIFIER", "GRUDGE_BEAST", "CIVILIAN",
]
FULL_ROLE_IDX = {r: i for i, r in enumerate(ROLE_IDS_FULL)}
NUM_ROLES_FULL = 20


@dataclass
class Player:
    id: int
    role: int           # R_POLICE, R_KILLER, etc.
    faction: int        # F_BLUE, F_RED
    alive: bool = True
    # Doctor tracking
    empty_injections: int = 0  # consecutive empty shots on same target
    last_doctor_target: int = -1
    # Sniper
    sniper_shots: int = 0
    # Doctor
    doctor_injections: int = 0
    doctor_saves: int = 0


class FastGame:
    """Single game instance."""

    def __init__(self, seed=None):
        self.rng = np.random.RandomState(seed)
        self.day = 1
        self.phase = "NIGHT"  # NIGHT, DAY, VOTE, END
        self.victory = None   # None, "BLUE", "RED"

        # Shuffle roles
        roles = list(ROLES)
        self.rng.shuffle(roles)

        self.players = []
        for i in range(NUM_PLAYERS):
            r = ROLE_MAP[roles[i]]
            self.players.append(Player(id=i, role=r, faction=ROLE_FACTION[r]))

        self.role_names = [roles[i] for i in range(NUM_PLAYERS)]

        # Belief system (per-player suspicion of others)
        # Initialize to 0.5 (uncertain)
        self.suspicion = np.full((NUM_PLAYERS, NUM_PLAYERS), 0.5, dtype=np.float32)

        # Vote history: [round][voter] = target_id
        self.vote_history = []
        # Chat history: [round][(speaker_id, chat_type, target_id)]
        self.chat_history = []
        self.current_chat = []
        # Role claims: player_id -> claimed role string
        self.role_claims = {}
        # Last words: dead player accusations/defenses
        self.last_words_accused = np.zeros(NUM_PLAYERS, dtype=np.float32)
        self.last_words_defended = np.zeros(NUM_PLAYERS, dtype=np.float32)

        # Police tracking
        self.police_confirmed = {}  # target_id -> "red"/"blue"
        self.police_public_red = None  # publicly revealed red player

        # Usage stats
        self.doctor_injections = 0
        self.doctor_saves = 0
        self.doctor_overdoses = 0
        self.sniper_shots = 0
        self.police_found_red = 0
        self.night_kills = 0
        self.vote_kills = 0

        # Saved last night
        self.saved_ids = set()

    def alive_players(self):
        return [p for p in self.players if p.alive]

    def alive_ids(self):
        return [p.id for p in self.players if p.alive]

    def faction_counts(self):
        blue = sum(1 for p in self.players if p.alive and p.faction == F_BLUE)
        red = sum(1 for p in self.players if p.alive and p.faction == F_RED)
        killers = sum(1 for p in self.players if p.alive and p.role == R_KILLER)
        return blue, red, killers

    def check_victory(self):
        blue, red, killers = self.faction_counts()
        if killers == 0:
            self.victory = "BLUE"
            return True
        if killers >= blue:  # red >= non-red alive
            self.victory = "RED"
            return True
        return False

    def resolve_night(self, actions):
        """
        Process night actions.

        actions: dict of player_id -> (target_id or -1)
        Returns: list of events
        """
        self.saved_ids = set()
        events = []

        alive = set(self.alive_ids())

        # Collect actions per role
        killer_votes = {}   # target -> vote count
        police_target = None
        doctor_target = None
        sniper_target = None

        for pid, target in actions.items():
            p = self.players[pid]
            if not p.alive or target < 0 or target >= NUM_PLAYERS:
                continue
            if target not in alive or target == pid:
                continue

            if p.role == R_KILLER:
                killer_votes[target] = killer_votes.get(target, 0) + 1
            elif p.role == R_POLICE:
                police_target = target  # last police vote wins (simplified)
            elif p.role == R_DOCTOR:
                if p.doctor_injections < 6:
                    doctor_target = target
                    p.doctor_injections += 1
                    self.doctor_injections += 1
            elif p.role == R_SNIPER:
                if p.sniper_shots < 4:
                    sniper_target = target
                    p.sniper_shots += 1
                    self.sniper_shots += 1

        # Resolve killer majority vote
        kill_target = None
        if killer_votes:
            best_target = max(killer_votes, key=killer_votes.get)
            kill_target = best_target

        # Police investigation
        if police_target is not None and self.players[police_target].alive:
            target_p = self.players[police_target]
            if target_p.faction == F_RED:
                self.police_confirmed[police_target] = "red"
                self.police_found_red += 1
                # Auto-reveal publicly (simplified)
                if self.police_public_red is None:
                    self.police_public_red = police_target
            else:
                self.police_confirmed[police_target] = "blue"

        # Doctor protection
        protected = set()
        if doctor_target is not None:
            protected.add(doctor_target)
            # Track overdose risk
            doc = [p for p in self.players if p.role == R_DOCTOR and p.alive]
            if doc:
                d = doc[0]
                if kill_target != doctor_target and sniper_target != doctor_target:
                    # Empty injection (target wasn't attacked)
                    if d.last_doctor_target == doctor_target:
                        d.empty_injections += 1
                        if d.empty_injections >= 2:
                            # Overdose kill!
                            self.players[doctor_target].alive = False
                            self.doctor_overdoses += 1
                            self.night_kills += 1
                            events.append(("overdose", doctor_target))
                            d.empty_injections = 0
                    else:
                        d.empty_injections = 0
                    d.last_doctor_target = doctor_target
                else:
                    d.empty_injections = 0
                    d.last_doctor_target = doctor_target

        # Apply killer kill (blocked by doctor)
        if kill_target is not None and self.players[kill_target].alive:
            if kill_target in protected:
                self.saved_ids.add(kill_target)
                self.doctor_saves += 1
                events.append(("saved", kill_target))
            else:
                self.players[kill_target].alive = False
                self.night_kills += 1
                events.append(("killed", kill_target))

        # Sniper kill (unblockable by doctor in this simplified version,
        # but can be blocked if target == doctor_target for balance)
        if sniper_target is not None and self.players[sniper_target].alive:
            # Sniper headshot — not blocked by doctor
            self.players[sniper_target].alive = False
            self.night_kills += 1
            events.append(("sniped", sniper_target))

        # Update beliefs based on night results
        self._update_beliefs_night(events)

        # Check victory after night kills
        if self.check_victory():
            self.phase = "END"
        else:
            self.phase = "DAY"
        return events

    def resolve_vote(self, votes):
        """
        Process vote actions.

        votes: dict of player_id -> target_id
        Returns: executed player id or None
        """
        alive = self.alive_ids()
        tally = {}
        vote_record = {}

        for pid, target in votes.items():
            p = self.players[pid]
            if not p.alive or target < 0:
                continue
            if target < NUM_PLAYERS and self.players[target].alive:
                tally[target] = tally.get(target, 0) + 1
                vote_record[pid] = target

        self.vote_history.append(vote_record)
        # Store last vote record for reward calculation
        self.last_vote_record = vote_record

        # Find execution target (plurality)
        executed = None
        if tally:
            max_votes = max(tally.values())
            candidates = [t for t, v in tally.items() if v == max_votes]
            executed = self.rng.choice(candidates)
            self.players[executed].alive = False
            self.vote_kills += 1

        self.last_executed = executed

        # Update beliefs based on votes
        self._update_beliefs_vote(vote_record, executed)

        # Check victory or forced draw at day 30
        if self.check_victory():
            self.phase = "END"
        elif self.day >= 30:
            self.victory = "NONE"
            self.phase = "END"
        else:
            self.day += 1
            self.phase = "NIGHT"
            self.current_chat = []

        return executed

    def process_chat(self, chat_actions):
        """
        Process chat actions during day phase.

        chat_actions: dict of player_id -> (chat_type, chat_target, claim_role)
        """
        round_chat = []
        for pid, (ctype, ctarget, crole) in chat_actions.items():
            p = self.players[pid]
            if not p.alive:
                continue
            if ctype == CHAT_SILENCE:
                continue
            round_chat.append((pid, ctype, ctarget, crole))

            # Update beliefs based on chat
            if ctype == CHAT_ACCUSE and 0 <= ctarget < NUM_PLAYERS:
                # Someone accused ctarget — slightly increase suspicion
                for obs_pid in self.alive_ids():
                    if obs_pid == pid:
                        continue
                    self.suspicion[obs_pid, ctarget] = min(1.0, self.suspicion[obs_pid, ctarget] + 0.05)

            elif ctype == CHAT_DEFEND and 0 <= ctarget < NUM_PLAYERS:
                for obs_pid in self.alive_ids():
                    if obs_pid == pid:
                        continue
                    self.suspicion[obs_pid, ctarget] = max(0.0, self.suspicion[obs_pid, ctarget] - 0.03)

            elif ctype == CHAT_CLAIM:
                self.role_claims[pid] = crole

        self.current_chat = round_chat
        self.chat_history.append(round_chat)

    def _update_beliefs_night(self, events):
        """Update suspicion based on night events."""
        for event_type, target_id in events:
            if event_type == "killed":
                # Killed player revealed as their faction
                faction = self.players[target_id].faction
                if faction == F_BLUE:
                    # Blue was killed — killers are more likely among survivors who aren't blue-confirmed
                    pass
            elif event_type == "saved":
                # Someone was saved — slightly reduce suspicion on them
                for pid in self.alive_ids():
                    self.suspicion[pid, target_id] = max(0.0, self.suspicion[pid, target_id] - 0.1)

        # Police results affect police's own suspicion
        for target_id, result in self.police_confirmed.items():
            for pid in self.alive_ids():
                if self.players[pid].role == R_POLICE:
                    if result == "red":
                        self.suspicion[pid, target_id] = 0.95
                    else:
                        self.suspicion[pid, target_id] = 0.05

        # Public reveal affects everyone
        if self.police_public_red is not None:
            for pid in self.alive_ids():
                self.suspicion[pid, self.police_public_red] = min(1.0, self.suspicion[pid, self.police_public_red] + 0.3)

    def _update_beliefs_vote(self, vote_record, executed):
        """Update suspicion based on voting patterns."""
        if executed is not None:
            faction = self.players[executed].faction
            # If we executed a red, voters who voted for them gain trust
            # If we executed a blue, voters who voted for them are suspicious
            for voter, target in vote_record.items():
                if target == executed:
                    for obs_pid in self.alive_ids():
                        if faction == F_RED:
                            self.suspicion[obs_pid, voter] = max(0.0, self.suspicion[obs_pid, voter] - 0.05)
                        else:
                            self.suspicion[obs_pid, voter] = min(1.0, self.suspicion[obs_pid, voter] + 0.05)


# ─── Observation Encoder ───────────────────────────────────────────────────────

OBS_DIM = 1135
TOTAL_MASK_DIM = 63
GLOBAL_DIM = 30
PER_PLAYER_DIM = 35
VOTE_GRAPH_DIM = NUM_PLAYERS * NUM_PLAYERS
CHAT_MATRIX_DIM = NUM_PLAYERS * 4
LAST_WORDS_DIM = NUM_PLAYERS * 3
OWN_ROLE_DIM = 25


def encode_all_fast(game):
    """
    Vectorized encoder: produce obs[18, 1135] and masks[18, 63] for all players at once.
    Avoids per-player Python loops by using numpy broadcasting.
    """
    N = NUM_PLAYERS
    obs = np.zeros((N, OBS_DIM), dtype=np.float32)
    masks = np.zeros((N, TOTAL_MASK_DIM), dtype=np.float32)

    # Pre-compute shared arrays
    alive_arr = np.array([p.alive for p in game.players], dtype=np.float32)  # [18]
    role_arr = np.array([p.role for p in game.players], dtype=np.int32)       # [18]
    faction_arr = np.array([p.faction for p in game.players], dtype=np.int32) # [18]
    alive_count = alive_arr.sum()

    # ── Pre-compute social matrices (shared across all observers) ──

    # Vote graph [18, 18]
    vote_graph = np.zeros((N, N), dtype=np.float32)
    vote_together = np.zeros((N, N), dtype=np.float32)
    last_tally = np.zeros(N, dtype=np.float32)
    for vr in game.vote_history:
        for voter, target in vr.items():
            vote_graph[voter, target] += 1
        # Vote-together
        targets_by_voter = vr
        voter_list = list(targets_by_voter.keys())
        for vi in range(len(voter_list)):
            for vj in range(vi + 1, len(voter_list)):
                if targets_by_voter[voter_list[vi]] == targets_by_voter[voter_list[vj]]:
                    vote_together[voter_list[vi], voter_list[vj]] += 1
                    vote_together[voter_list[vj], voter_list[vi]] += 1
    if game.vote_history:
        for _, target in game.vote_history[-1].items():
            last_tally[target] += 1

    row_sums = vote_graph.sum(axis=1, keepdims=True)
    row_sums[row_sums == 0] = 1
    vote_graph_norm = vote_graph / row_sums
    max_tally = max(1.0, last_tally.max())
    max_together = max(1.0, vote_together.max())

    # Chat matrices [18, 18]
    accuse_count = np.zeros((N, N), dtype=np.float32)
    defend_count = np.zeros((N, N), dtype=np.float32)
    for round_chat in game.chat_history:
        for (speaker, ctype, ctarget, _) in round_chat:
            if ctype == CHAT_ACCUSE and 0 <= ctarget < N:
                accuse_count[speaker, ctarget] += 1
            elif ctype == CHAT_DEFEND and 0 <= ctarget < N:
                defend_count[speaker, ctarget] += 1

    acc_row_sum = accuse_count.sum(axis=1, keepdims=True); acc_row_sum[acc_row_sum == 0] = 1
    def_row_sum = defend_count.sum(axis=1, keepdims=True); def_row_sum[def_row_sum == 0] = 1
    acc_col_sum = accuse_count.sum(axis=0)
    def_col_sum = defend_count.sum(axis=0)
    speak_total = accuse_count.sum(axis=1) + defend_count.sum(axis=1)  # [18]
    mention_total = acc_col_sum + def_col_sum  # [18]

    # Suspicion matrix
    susp = game.suspicion  # [18, 18]

    # Role full indices
    role_full_idx = np.array([FULL_ROLE_IDX.get(ROLE_NAMES[game.players[i].role],
                              FULL_ROLE_IDX["CIVILIAN"]) for i in range(N)], dtype=np.int32)

    # ── Build obs for ALL 18 players at once ──

    for pid in range(N):
        p = game.players[pid]
        o = 0

        # Global (30)
        obs[pid, o] = min(game.day / 15, 1.0); o += 1
        obs[pid, o + (0 if game.phase == "NIGHT" else 1 if game.phase == "DAY" else 2)] = 1; o += 3
        obs[pid, o] = alive_count / N; o += 1
        obs[pid, o] = (1 - alive_arr[faction_arr == F_BLUE]).sum() / N; o += 1
        obs[pid, o] = (1 - alive_arr[faction_arr == F_RED]).sum() / N; o += 1
        o += 1  # green
        obs[pid, o] = 1; o += 8  # theme
        ratio = alive_count / N
        is_early = 1.0 if game.day <= 2 and ratio > 0.7 else 0.0
        is_late = 1.0 if not (game.day <= 4 and ratio > 0.4) else 0.0
        is_mid = 1.0 if not is_early and not is_late else 0.0
        obs[pid, o] = is_early; obs[pid, o+1] = is_mid; obs[pid, o+2] = is_late; o += 3
        obs[pid, o] = game.doctor_injections / 6; o += 1
        obs[pid, o] = game.doctor_saves / 6; o += 1
        obs[pid, o] = game.sniper_shots / 4; o += 1
        o = GLOBAL_DIM

        # Per-player (18 x 35)
        is_killer = p.role == R_KILLER
        is_police = p.role == R_POLICE

        for qid in range(N):
            q = game.players[qid]
            base = o

            obs[pid, o] = 1.0 if qid == pid else 0.0; o += 1
            obs[pid, o] = alive_arr[qid]; o += 1

            known = 0.0
            if qid == pid: known = 1.0
            elif is_killer and role_arr[qid] == R_KILLER and alive_arr[qid]: known = 1.0
            elif is_police and role_arr[qid] == R_POLICE and alive_arr[qid]: known = 1.0
            obs[pid, o] = known; o += 1

            # Role probs (20)
            if not alive_arr[qid] or qid == pid or known:
                obs[pid, o + role_full_idx[qid]] = 1.0
            else:
                s = susp[pid, qid]
                obs[pid, o + FULL_ROLE_IDX["KILLER"]] = s * 0.5
                obs[pid, o + FULL_ROLE_IDX["SNIPER"]] = s * 0.2
                obs[pid, o + FULL_ROLE_IDX["POLICE"]] = (1 - s) * 0.3
                obs[pid, o + FULL_ROLE_IDX["DOCTOR"]] = (1 - s) * 0.1
                obs[pid, o + FULL_ROLE_IDX["CIVILIAN"]] = (1 - s) * 0.4
            o += NUM_ROLES_FULL

            obs[pid, o] = susp[pid, qid]; o += 1
            obs[pid, o] = last_tally[qid] / max_tally; o += 1
            obs[pid, o] = min(speak_total[qid] / 5, 1.0); o += 1
            obs[pid, o] = min(mention_total[qid] / 5, 1.0); o += 1

            obs[pid, o] = accuse_count[pid, qid] / acc_row_sum[pid, 0]; o += 1
            obs[pid, o] = defend_count[pid, qid] / def_row_sum[pid, 0]; o += 1
            obs[pid, o] = accuse_count[qid, pid] / acc_row_sum[qid, 0]; o += 1
            obs[pid, o] = defend_count[qid, pid] / def_row_sum[qid, 0]; o += 1
            obs[pid, o] = vote_together[pid, qid] / max_together; o += 1
            obs[pid, o] = game.last_words_accused[qid]; o += 1
            obs[pid, o] = game.last_words_defended[qid]; o += 1
            obs[pid, o] = 0; o += 1

        # Vote graph (324)
        obs[pid, o:o + VOTE_GRAPH_DIM] = vote_graph_norm.ravel()
        o += VOTE_GRAPH_DIM

        # Chat matrix (72)
        for qid in range(N):
            obs[pid, o] = accuse_count[qid].sum(); o += 1
            obs[pid, o] = defend_count[qid].sum(); o += 1
            obs[pid, o] = acc_col_sum[qid]; o += 1
            obs[pid, o] = def_col_sum[qid]; o += 1

        # Last words (54)
        obs[pid, o:o+N] = game.last_words_accused; o += N
        obs[pid, o:o+N] = game.last_words_defended; o += N
        o += N  # claimed roles = 0

        # Own role (25)
        obs[pid, o + role_full_idx[pid]] = 1; o += NUM_ROLES_FULL
        obs[pid, o + faction_arr[pid]] = 1; o += 3
        if p.role == R_DOCTOR:
            obs[pid, o] = (6 - game.doctor_injections) / 6
        elif p.role == R_SNIPER:
            obs[pid, o] = (4 - game.sniper_shots) / 4
        o += 2

    # ── Build masks ──
    phase = game.phase
    alive_set = set(int(i) for i in range(N) if alive_arr[i])

    for pid in range(N):
        p = game.players[pid]
        if not p.alive:
            masks[pid, 18] = 1; masks[pid, 19] = 1; masks[pid, 42] = 1
            continue

        alive_others = [q for q in alive_set if q != pid]

        if phase == "NIGHT":
            # Target: night action
            if p.role == R_CIVILIAN:
                masks[pid, 18] = 1
            else:
                for qid in alive_others:
                    if p.role == R_KILLER and role_arr[qid] == R_KILLER: continue
                    masks[pid, qid] = 1
                masks[pid, 18] = 1
            # Chat: enabled during NIGHT (executed after resolve_night)
            masks[pid, 19:24] = 1  # all chat types
            for qid in alive_others:
                masks[pid, 24 + qid] = 1
            masks[pid, 42] = 1  # nobody
            masks[pid, 43:63] = 1  # claim roles
        else:
            # VOTE: only target head active, chat/claim forced to silence/none
            for qid in alive_others:
                masks[pid, qid] = 1
            masks[pid, 18] = 1  # abstain
            masks[pid, 19] = 1  # silence only
            masks[pid, 42] = 1  # chat target nobody

    return obs, masks


def compute_rewards_fast(game, prev_alive=None, events=None):
    """
    Compute rewards for all players.
    Includes per-step shaping rewards to encourage role-appropriate actions.
    """
    rewards = np.zeros(NUM_PLAYERS, dtype=np.float32)

    # ── Night event rewards ──
    if prev_alive is not None and events:
        for event_type, target_id in events:
            if event_type == "killed":
                victim = game.players[target_id]
                if victim.faction == F_BLUE:
                    # Killing police is highest value
                    kill_reward = 0.06 if victim.role == R_POLICE else 0.03
                    for p in game.players:
                        if p.role == R_KILLER and p.alive:
                            rewards[p.id] += kill_reward
                elif victim.faction == F_RED:
                    for p in game.players:
                        if p.role == R_KILLER and p.alive:
                            rewards[p.id] -= 0.02

            elif event_type == "sniped":
                victim = game.players[target_id]
                sniper = next((p for p in game.players if p.role == R_SNIPER and p.alive), None)
                if sniper:
                    if victim.faction == F_BLUE:
                        rewards[sniper.id] += 0.05
                    else:
                        rewards[sniper.id] -= 0.05

            elif event_type == "saved":
                for p in game.players:
                    if p.role == R_DOCTOR and p.alive:
                        rewards[p.id] += 0.05

            elif event_type == "overdose":
                victim = game.players[target_id]
                for p in game.players:
                    if p.role == R_DOCTOR and p.alive:
                        if victim.faction == F_RED:
                            rewards[p.id] += 0.06
                        else:
                            rewards[p.id] -= 0.08

        # Police: reward for finding red
        if game.police_found_red > 0:
            prev_found = getattr(game, '_prev_found_red', 0)
            if game.police_found_red > prev_found:
                for p in game.players:
                    if p.role == R_POLICE and p.alive:
                        rewards[p.id] += 0.05
                game._prev_found_red = game.police_found_red

    # ── Chat action rewards ──
    last_chat = getattr(game, 'current_chat', [])
    for (speaker_id, ctype, ctarget, crole) in last_chat:
        speaker = game.players[speaker_id]

        # --- Killer chat rewards ---
        if speaker.role == R_KILLER:
            if ctype == CHAT_ACCUSE and 0 <= ctarget < NUM_PLAYERS:
                if game.players[ctarget].faction == F_BLUE:
                    rewards[speaker_id] += 0.02  # accuse blue = good deception
            if ctype == CHAT_DEFEND and 0 <= ctarget < NUM_PLAYERS:
                if game.players[ctarget].faction == F_RED:
                    rewards[speaker_id] += 0.02  # defend red ally = teamwork
            if ctype == CHAT_CLAIM and 0 <= crole < len(ROLE_IDS_FULL):
                if ROLE_IDS_FULL[crole] == "POLICE":
                    rewards[speaker_id] += 0.04  # claim police = deception

        # --- Police chat rewards ---
        if speaker.role == R_POLICE:
            if ctype == CHAT_CLAIM and 0 <= crole < len(ROLE_IDS_FULL):
                if ROLE_IDS_FULL[crole] == "POLICE":
                    rewards[speaker_id] += 0.04  # claim police = reveal identity
            if ctype == CHAT_ACCUSE and 0 <= ctarget < NUM_PLAYERS:
                if game.players[ctarget].faction == F_RED:
                    rewards[speaker_id] += 0.05  # accuse red = share real intel
            if ctype == CHAT_DEFEND and 0 <= ctarget < NUM_PLAYERS:
                if game.players[ctarget].faction == F_BLUE:
                    rewards[speaker_id] += 0.02  # tell others who is blue = share info

    # ── Vote execution rewards (per-voter) ──
    vote_record = getattr(game, 'last_vote_record', {})
    executed = getattr(game, 'last_executed', None)

    # Detect fake police reveal: a killer who claimed police accused someone in chat.
    # This is tracked INDEPENDENTLY from real reveal (police_public_red).
    # A game can have both a real reveal AND a fake reveal at the same time.
    fake_reveal_target = None  # player ID that killer-as-fake-police accused
    if executed is not None:
        for pid, role in game.role_claims.items():
            claimed = role if isinstance(role, str) else ""
            pid_int = int(pid) if isinstance(pid, str) else pid
            if (claimed == "POLICE" or role == R_POLICE):
                if game.players[pid_int].role == R_KILLER:
                    for (speaker, ctype, ctarget, _) in getattr(game, 'current_chat', []):
                        if speaker == pid_int and ctype == 1 and ctarget == executed:
                            fake_reveal_target = executed
                            break
            if fake_reveal_target is not None:
                break

    if executed is not None and vote_record:
        victim_faction = game.players[executed].faction

        # Track who was alive when voting (before execution)
        pre_vote_alive = {vid for vid in vote_record.keys()}
        for voter_id, target_id in vote_record.items():
            voter = game.players[voter_id]
            # Don't skip executed voters — they cast a valid vote

            if target_id == executed:
                if victim_faction == F_RED:
                    rewards[voter_id] += 0.04  # correct vote

                    # Non-police blue: big bonus for following real reveal
                    if voter.faction == F_BLUE and voter.role != R_POLICE:
                        if game.police_public_red == executed:
                            rewards[voter_id] += 0.08  # followed real intel
                else:
                    # Voted out a blue — penalty depends on victim's role
                    victim = game.players[executed]
                    if victim.role == R_POLICE or victim.role == R_DOCTOR:
                        rewards[voter_id] -= 0.05  # killed key role = big mistake
                    elif victim.role == R_CIVILIAN:
                        pass  # civilian death = acceptable loss, no penalty
                    else:
                        rewards[voter_id] -= 0.02  # other blue roles = small penalty

                    # Non-police blue: penalty for being tricked by fake police
                    if voter.faction == F_BLUE and voter.role != R_POLICE:
                        if fake_reveal_target == executed:
                            rewards[voter_id] -= 0.02  # tricked by fake police

            # Non-police blue: penalty for IGNORING real reveal
            if voter.faction == F_BLUE and voter.role != R_POLICE:
                if game.police_public_red is not None:
                    revealed_alive = game.players[game.police_public_red].alive if game.police_public_red < NUM_PLAYERS else False
                    if revealed_alive and target_id != game.police_public_red:
                        rewards[voter_id] -= 0.04  # ignored real police intel

    # ── Accusation outcome rewards ──
    # If someone accused a player who got voted out, reward/punish based on faction
    if executed is not None and last_chat:
        for (speaker_id, ctype, ctarget, _) in last_chat:
            if ctype == CHAT_ACCUSE and ctarget == executed:
                if game.players[executed].faction == F_RED:
                    rewards[speaker_id] += 0.03  # accused someone who was red — good call
                elif game.players[executed].faction == F_BLUE:
                    rewards[speaker_id] -= 0.02  # accused someone who was blue — bad call

    # ── Terminal rewards ──
    if game.victory is not None:
        for i in range(NUM_PLAYERS):
            p = game.players[i]
            if game.victory == "BLUE":
                rewards[i] += 1.0 if p.faction == F_BLUE else -1.0
            elif game.victory == "RED":
                rewards[i] += 1.0 if p.faction == F_RED else -1.0
            elif game.victory == "NONE":
                rewards[i] -= 0.5  # draw penalty — both sides failed
            if p.alive:
                rewards[i] += 0.05

    return rewards


def encode_ground_truth_fast(game):
    """Ground truth roles for centralized critic."""
    gt = np.zeros(NUM_PLAYERS * NUM_ROLES_FULL, dtype=np.float32)
    for i in range(NUM_PLAYERS):
        role_name = ROLE_NAMES[game.players[i].role]
        idx = FULL_ROLE_IDX.get(role_name, FULL_ROLE_IDX["CIVILIAN"])
        gt[i * NUM_ROLES_FULL + idx] = 1
    return gt


# ─── Batched Environment ──────────────────────────────────────────────────────

try:
    from fast_encode_jit import encode_game_jit as _jit_encode
    _USE_JIT = True
except ImportError:
    _USE_JIT = False


class FastBatchEnv:
    """
    N games running in pure Python. No IPC.
    Uses Numba JIT encoder for 290x faster observation encoding.
    Compatible interface with VecMafiaEnv.
    """

    def __init__(self, num_envs=16, theme=None, difficulty=None, **kwargs):
        self.num_envs = num_envs
        # Note: fast_engine only implements GOOD_VS_EVIL. theme/difficulty
        # are accepted for API compatibility but not used.
        self.games = [None] * num_envs
        self._seed = 0
        self._use_jit = _USE_JIT
        if self._use_jit:
            # Warm up JIT on first call
            g = FastGame(seed=0)
            _jit_encode(g)
            print(f"[FastBatchEnv] Numba JIT encoder active")

    def reset(self):
        obs = np.zeros((self.num_envs, NUM_PLAYERS, OBS_DIM), dtype=np.float32)
        masks = np.zeros((self.num_envs, NUM_PLAYERS, TOTAL_MASK_DIM), dtype=np.float32)
        infos = []

        for i in range(self.num_envs):
            self._seed += 1
            self.games[i] = FastGame(seed=self._seed)
            if self._use_jit:
                o, m = _jit_encode(self.games[i])
            else:
                o, m = _jit_encode(self.games[i]) if self._use_jit else encode_all_fast(self.games[i])
            obs[i] = o
            masks[i] = m
            infos.append({
                "roles": self.games[i].role_names,
                "phase": "NIGHT",
                "day": 1,
                "alive": self.games[i].alive_ids(),
                "ground_truth": encode_ground_truth_fast(self.games[i]),
            })

        return obs, masks, infos

    def step(self, actions):
        """
        actions: [num_envs, 18, 4] — target, chat_type, chat_target, claim_role
        """
        actions = np.array(actions)
        if actions.ndim == 2:
            actions = np.stack([actions, np.zeros_like(actions),
                                np.full_like(actions, 18), np.zeros_like(actions)], axis=-1)

        obs = np.zeros((self.num_envs, NUM_PLAYERS, OBS_DIM), dtype=np.float32)
        masks = np.zeros((self.num_envs, NUM_PLAYERS, TOTAL_MASK_DIM), dtype=np.float32)
        rewards = np.zeros((self.num_envs, NUM_PLAYERS), dtype=np.float32)
        dones = np.zeros(self.num_envs, dtype=bool)
        infos = [None] * self.num_envs

        for i in range(self.num_envs):
            game = self.games[i]

            # Parse actions for this game
            act = actions[i]  # [18, 4]

            # Track alive state before step (for shaping rewards)
            prev_alive = [p.alive for p in game.players]
            events = []

            if game.phase == "NIGHT":
                # Night actions
                night_actions = {}
                for pid in range(NUM_PLAYERS):
                    t = int(act[pid, 0])
                    if t >= 0 and t < 18:
                        night_actions[pid] = t
                events = game.resolve_night(night_actions)

                # Process chat actions for day phase
                if game.phase == "DAY" and game.victory is None:
                    chat_actions = {}
                    for pid in range(NUM_PLAYERS):
                        ct = int(act[pid, 1])
                        ct_target = int(act[pid, 2])
                        cr = int(act[pid, 3])
                        chat_actions[pid] = (ct, ct_target, cr)
                    game.process_chat(chat_actions)
                    game.phase = "VOTE"  # auto-advance to vote

            else:
                # Vote actions
                vote_actions = {}
                for pid in range(NUM_PLAYERS):
                    t = int(act[pid, 0])
                    if t >= 0 and t < 18:
                        vote_actions[pid] = t
                game.resolve_vote(vote_actions)

            # Encode (with shaping rewards)
            rewards[i] = compute_rewards_fast(game, prev_alive, events)
            dones[i] = game.victory is not None

            info = {
                "phase": game.phase,
                "day": game.day,
                "alive": game.alive_ids(),
                "victory": {"winner": game.victory} if game.victory else None,
                "ground_truth": encode_ground_truth_fast(game),
                "usage": {
                    "doctorInjections": game.doctor_injections,
                    "doctorSaves": game.doctor_saves,
                    "doctorOverdoses": game.doctor_overdoses,
                    "sniperShots": game.sniper_shots,
                    "policeFoundRed": game.police_found_red,
                    "nightKills": game.night_kills,
                    "voteKills": game.vote_kills,
                },
            }

            # Auto-reset if done
            if dones[i]:
                info["terminal_usage"] = info["usage"]
                info["terminal_rewards"] = rewards[i].copy()
                self._seed += 1
                self.games[i] = FastGame(seed=self._seed)

            o, m = _jit_encode(self.games[i]) if self._use_jit else encode_all_fast(self.games[i])
            obs[i] = o
            masks[i] = m
            if dones[i]:
                info["ground_truth"] = encode_ground_truth_fast(self.games[i])
            infos[i] = info

        return obs, masks, rewards, dones, infos

    def close(self):
        pass


# ─── Test ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import time

    N = 64
    print(f"=== FastBatchEnv Test ({N} games, pure Python) ===")

    env = FastBatchEnv(num_envs=N)
    obs, masks, infos = env.reset()
    print(f"Reset: obs {obs.shape}, masks {masks.shape}")

    total_games = 0
    t0 = time.time()
    steps = 0

    for _ in range(200):
        actions = np.random.randint(0, 19, (N, NUM_PLAYERS, 4))
        actions[:, :, 1] = np.random.randint(0, 5, (N, NUM_PLAYERS))  # chat type
        obs, masks, rewards, dones, infos = env.step(actions)
        steps += 1
        total_games += dones.sum()

    elapsed = time.time() - t0
    sps = steps * N / elapsed
    gps = total_games / elapsed
    print(f"\n{steps} batched steps, {total_games} games in {elapsed:.1f}s")
    print(f"Speed: {sps:.0f} env-steps/sec, {gps:.0f} games/sec")
    print("=== Done ===")
