# Single-Player 18-Player Social Deduction Game (1 Human + 17 AI)
**Design Doc (for Codex-driven implementation)**

## 1. Overview
This project recreates a classic “night/day” social deduction game inspired by Kira Online / “Mafia / Werewolf” style rules.

- Total players per match: **18**
- Player types: **Human (1)** + **AI (17)**
- The game is team-based with possible **third-party** roles.
- Each match assigns roles **randomly** according to a selected **Theme** (preset role distributions) or a **Custom Setup**.

Primary goal: each faction uses its abilities and daytime voting to eliminate opponents and satisfy win conditions.

---

## 2. Core Game Loop (Night → Day)
Each round consists of:

### 2.1 Night Phase
At night, specific roles perform actions:
- **Killers faction** selects a target to kill (majority vote among killers required).
- **Police faction** selects a target to investigate (majority vote among police required).
- **Special roles** act depending on the selected Theme (doctor heal, agent protect, etc.).
- Some roles have **private channels** (Police channel, Killer channel, and some third-party channels).

### 2.2 Day Phase
During the day:
1. Players discuss (AI dialogue + player dialogue UI).
2. A timed **public vote** occurs.
3. If a player receives **more than half** of total votes within the time limit, they are executed.

### 2.3 Death Message (Last Words)
When a player dies, they may leave a short message within a limited time:
- Up to **32 English characters** or **16 Chinese characters**
- Some death types **do not allow** last words (e.g., instant bomb death).
- Dead players cannot take further actions.

---

## 3. Factions and Win Conditions
The game supports **three sides**:

### 3.1 Red Faction (Evil / Killer Side)
Common roles: Killer, Kidnapper, Arsonist, Terrorist, etc.

**Win condition (standard rule):**
- Red wins if **the number of Killers is greater than or equal to the number of surviving Blue players**, **and** the remaining roles on the field are only:
  - Police, Killers, Civilians (no other special roles remain), **or**
- **Police are all eliminated**, **or**
- **Civilians are all eliminated**.

> Note: In this rule set, anyone who is not Police or Killer is treated as “Civilian” for the purpose of these win checks, regardless of their true faction background.
For win-condition checks only, "Civilian" is a virtual category that includes
all non-Police, non-Killer roles, regardless of their actual faction.
Third-party victory conditions are checked separately and take precedence.

### 3.2 Blue Faction (Justice / Police & Civilian Side)
Common roles: Police, Civilian, Doctor, Agent, etc.

**Win condition:**
- Blue wins if **all Killers are eliminated**.

### 3.3 Green Faction (Third Party)
Roles: Zombie, Grudge Beast (and other special third-party roles).

**Win condition:**
- Depends on the specific role definition.

---

## 4. Themes (18 Players Presets)
Each theme defines the exact role counts when the room is full (18 players).

### 4.1 Good vs Evil (Standard 18)
- Police x4
- Killer x4
- Doctor x1
- Sniper x1
- Civilian x8

### 4.2 Counter-Terror Crisis (18)
- Police x4
- Killer x4
- Doctor x1
- Sniper x1
- Agent x1
- Terrorist x1
- Civilian x6

### 4.3 Wild West (18)
- Police x4
- Killer x4
- Doctor x1
- Sniper x1
- Cowboy x1
- Kidnapper x1
- Civilian x6

### 4.4 Doomsday Horror (18)
- Police x4
- Killer x4
- Doctor x1
- Sniper x1
- Cowboy x1
- Kidnapper x1
- Zombie x1
- Civilian x5

### 4.5 Street Fury (18)
- Police x4
- Killer x4
- Riot Police x1
- Arsonist x1
- Agent x1
- Terrorist x1
- Civilian x6

### 4.6 Psychic Century (18)
- Police x4
- Killer x4
- Doctor x1
- Sniper x1
- Heavenly Fiend x1
- Vine Demon x1
- Brat x1
- Civilian x5

### 4.7 Other Dimension (18)
- Police x4
- Killer x4
- Exorcist x1
- Nightmare Demon x1
- Purifier x1
- Necromancer x1
- Civilian x6

### 4.8 Final Judgement (18)
- Police x4
- Killer x4
- Grudge Beasts x3
- Cowboy x1
- Sniper x1
- Civilian x5

### 4.9 Custom Setup
Host can manually assign role counts with constraints:
- Must include at least **1 Police**, **1 Killer**, **1 Civilian (no special role)**.
- Certain roles may be unavailable in custom mode (e.g., Grudge Beast).
- “Standard custom” example:
  - Police x2, Killer x2, Civilian x1, and most other roles x1 each (excluding some special roles).
- Many community variants exist (hint rooms, domino rooms, etc.), including extreme distributions.

---

## 5. Role Catalog (Abilities Summary)
Below are key roles and rules to implement.

### 5.1 Police (Blue)
- Night: vote to **investigate** one target.
- If police votes do not reach **majority**, the investigation is **invalid**.
- Police know each other and share a private police chat.
- Police cannot directly communicate with other Blue-background roles (e.g., Doctor).

**Aliases:** P, police

### 5.2 Killer (Red)
- Night: vote to **murder** one target.
- If killer votes do not reach **majority**, the kill is **invalid**.
- Killers know each other and share a private killer chat.
- Killers cannot directly communicate with other Red-background roles (e.g., Sniper, Terrorist).

**Aliases:** K, killer

### 5.3 Civilian (Blue)
- No night action.
- Largest population; helps with daytime voting.
- Cannot know anyone’s role unless revealed by death or special mechanics.

**Aliases:** pin, ping

### 5.4 Doctor (Blue)
- Night: choose one target (including self) to **inject**.
- If the target is killed that night by certain kill types, the target **revives immediately**.
- If the target is not killed, doctor accumulates an **empty injection**.
  - After **2 empty injections**, the injected target dies (including doctor).
- In 18-player rooms: **max 4 injections** total.

**Cannot revive** certain death causes (e.g., headshot, bomb, some supernatural attacks).
Some protections can be blocked/absorbed by certain roles (see Agent / Heavenly Fiend).

**Alias:** E

### 5.5 Sniper (Red)
- Night: choose a target to **shoot**; target dies **immediately**.
- In 18-player rooms: **max 4 shots** total.
- No private communication with killers; killers may leave “sniper lists” via last words.

**Alias:** G

### 5.6 Agent (Blue)
- Night: choose a target to **protect**.
- Protected target is immune to many attacks.
- If the Agent is killed by any killing method, the protected target **also dies**.

Protection does **not** block some special attacks (bomb, certain high-tier necromancer attacks, arson ignition, zombie bite, kidnapper execution, etc.).

### 5.7 Terrorist (Red)
- Night: choose a target for **suicide bombing**.
- Terrorist and target die **immediately** and **cannot leave last words**.
- Bomb attacks cannot be blocked.
- If target is Red faction, bombing fails and terrorist self-destructs.

Special note:
- Police investigation shows Terrorist as “Civilian”.
- Doctor “double injection” interactions can cause collateral effects (design explicitly).

### 5.8 Cowboy (Blue)
- Night: attempt to shoot a target via **Russian roulette**.
  - Hit (2/6): target dies at end of night.
  - Miss (3/6): no effect.
  - Bonus (1/6): special bullet; can chain to another target the same night.
    - If special bullet is drawn twice in one night, it mutates:
      - Displays “Oops” and kills the cowboy + two other targets.
- If cowboy dies or is kidnapped that night, the attack fails.

### 5.9 Kidnapper (Red)
- Night: choose a target to **kidnap**.
- Kidnapped target cannot act that night.
- If kidnapper is identified by police, the kidnapped target is **executed (ransom killed)**.
- Cannot kidnap the same person on consecutive nights.

### 5.10 Zombie (Green / Third Party)
- Night: bite a target.
  - Bitten target becomes Zombie next night.
  - If bitten by 2 zombies same night: converts immediately that night.
  - If bitten by 3+ zombies: target dies.
  - If a zombie bites another zombie: the biter dies (infection backlash).
- Day speech is altered with “Err…”, “yaa…” etc.; last words are scrambled.
- Zombies cannot communicate with each other.

**Win condition:** if more than half of alive players are zombies, zombies win alone.

### 5.11 Riot Police (Blue)
- Night: throw a **smoke grenade** at a target.
  - Smoked target cannot be targeted by others and cannot act.
  - If smoked twice, target dies immediately.
- In 18-player rooms: **max 4 grenades** total.
- Smoke grenade can be blocked/absorbed by some roles.

### 5.12 Arsonist (Red)
- Night: choose ONE option:
  1) Throw a gasoline bottle at a target (marks them), OR
  2) Ignite and kill all previously marked targets at once.
- Gasoline bottle can be blocked/absorbed by some roles.

### 5.13 Heavenly Fiend (Blue)
Has two modes:

1) **Absorb Mode**
- Protect a target and absorb incoming attacks (but cannot absorb attacks aimed at self).
- If absorption succeeds, switches to Charge Mode.

2) **Charge Mode**
- Shoot a target; target dies immediately.
- After shooting, switches back to Absorb Mode.

Some special attacks cannot be absorbed (bomb, some necromancer tiers, arson ignition, zombie bite, kidnapper execution, etc.).

### 5.14 Vine Demon (Red)
- Night: plant a **seed** on a target.
- If the seed successfully sprouts, Vine Demon loses all abilities afterward.
Seed sprout conditions (any one triggers):
1) The target is also targeted by a Blue player action that night; after sprout, the target and that Blue actor both die.
2) If Vine Demon would die from a lethal attack, the seeded target dies instead.

Seed can be blocked/absorbed by some roles.

### 5.15 Brat (Blue)
- No night action.
- If executed by daytime vote, Brat reveals identity and **revives on the spot**.
  - After revival: identity is public, loses abilities, loses voting rights.

### 5.16 Nightmare Demon (Red)
- Night: attack a target.
  - If target is Civilian or Brat: target dies immediately.
  - Otherwise: attack fails, but Nightmare Demon learns the target’s role.

### 5.17 Exorcist (Blue)
- Night: petrify attack; target dies immediately.
- If the target is Red, Exorcist may continue to a next target (up to 3 total attacks).
- If Exorcist hits a non-Red target, chain stops.
- Every time Exorcist hits a Blue/Civilian incorrectly, the maximum remaining chain count is reduced by 1.
  - After 3 “wrong hits” total, Exorcist loses all abilities.
- Hitting Zombies does not count as a wrong hit penalty.

### 5.18 Necromancer (Red)
- Gains 1 soul whenever someone dies (excluding necromancer’s own kills).
- Needs **>= 2 souls** at the start of night to act; after acting, souls reset to 0.
Attack depends on souls (max 4):
- 2 souls: target dies at end of night (fails if necromancer dies that night or is purified).
- 3 souls: target dies immediately.
- 4 souls: target dies immediately and cannot leave last words.

### 5.19 Purifier (Blue)
- Night: cleanse a target.
  - Cleansed target cannot act.
  - Police/Killer vote effects on the cleansed target become invalid.
  - If target is Necromancer, the necromancer’s souls reset to 0.

Purifier can negate some actions (police/killer votes, doctor injection, agent protection, cowboy attack, zombie bite, 2-soul necromancer).
Purifier cannot negate some actions (sniper shot, terrorist bomb, kidnapper kidnapping, riot police smoke because target becomes untargetable, arson ignition, heavenly fiend actions, vine seed sprout, exorcist attack, nightmare demon attack, 3+ soul necromancer).

### 5.20 Grudge Beast (Green / Third Party)
- Has an independent Grudge Beast chat.
- Night: choose a target to **judge** and learn their role.
Effects depend on target:
- If target is Red: Grudge Beast learns role and also reveals that role to Police (and Police can no longer investigate that target).
- If target is Blue-special (non-civilian): Grudge Beast learns role and reveals it to Red.
- If target is normal Civilian: one Grudge Beast is eliminated.

**Berserk State:**
- If any Grudge Beast is killed at night (by any faction’s killing method), the group enters Berserk.
- In Berserk, Grudge Beasts act like Killers: they vote to murder a target (majority required).

**Win conditions:**
- If Berserk is triggered: Grudge Beasts win alone by killing the last Killer or the last Police.
- If the game ends without Berserk being triggered: Grudge Beasts win alone (unless all were executed by vote or eliminated by judging a civilian).
- If the winning faction is the one that killed the first Grudge Beast (triggering Berserk), Grudge Beast may also win alongside the other faction depending on the end state (define exact rule in code).

Victory Precedence (highest first):
1. Grudge Beast solo victory
2. Zombie majority victory
3. Red faction victory
4. Blue faction victory
---

## 6. Implementation Notes (Single-Player + AI)
### 6.1 AI Requirements
- Each AI has:
  - Hidden role
  - Memory of public events (votes, deaths, last words)
  - Suspicion model (who is likely Red/Blue/Green)
  - Strategy model (cooperate with faction, bluff, mislead, survive)
- Private channels:
  - Police chat (AI-only if human is not police)
  - Killer chat (AI-only if human is not killer)
  - Third-party chats where applicable (Grudge Beast)
- Night voting inside factions requires a majority among those role members.

### 6.2 Deterministic Engine + Log
Recommended:
- A deterministic rules engine that resolves night actions in a consistent order.
- A complete event log for replay/debugging:
  - Actions chosen
  - Blocks/absorbs
  - Conversions (zombie)
  - Death causes
  - Last words

### 6.3 Death Cause System
Model deaths with explicit cause tags because many abilities depend on the kill type:
- e.g., `KILLER_MURDER`, `SNIPER_HEADSHOT`, `TERROR_BOMB`, `ZOMBIE_BITE`, `EXORCIST_PETRIFY`, etc.

---

## 7. Suggested MVP Scope
To ship quickly:
1. Start with **Good vs Evil (Standard 18)** only.
2. Implement: Police, Killer, Civilian, Doctor, Sniper
3. Add: day chat, day vote execution, last words
4. Then expand to additional themes and roles.

---

## 8. Appendix: Terminology
- “Majority vote” = strictly more than half of eligible voters in that private group.
- “Immediate death” = death occurs during night phase resolution, may suppress last words depending on rule.
- “Civilian (for win checks)” = anyone who is not Police or Killer, regardless of their actual faction label in UI.

# Codex Implementation Plan — Single-Player 18-Player Social Deduction (1 Human + 17 AI)
**Goal:** Build a Kira-Online-inspired night/day deduction game with deterministic rules, explainable logs, and *strong* AI reasoning.

---

## 0. Non-Goals / Constraints
- Single-player only (no networking).
- 18 players fixed: **1 human + 17 AI**.
- Deterministic simulation core (seeded RNG).
- UI can be minimal initially (CLI or simple web UI), but must support:
  - Day discussion
  - Voting
  - Night action selection (for the human if applicable)
  - Last words (short)

---

## 1. Repo Structure (Recommended)
/game
/core
engine.ts # phase loop + state machine
resolver.ts # resolves night actions in strict order
state.ts # canonical game state types
rng.ts # seeded RNG
rules.ts # theme presets + validation
victory.ts # win condition checks
log.ts # event log + redacted views
/roles
index.ts # role registry
police.ts
killer.ts
civilian.ts
doctor.ts
sniper.ts
...more roles later
/ai
agent.ts # AI agent interface + orchestrator
belief.ts # belief state, suspicion, Bayesian-ish updates
planner.ts # action selection via utility + constraints
dialogue.ts # message generation layer (safe + role-consistent)
memory.ts # episodic memory + retrieval
world_model.ts # structured model of others' likely roles
explain.ts # produces human-readable rationale & trace
/ui
cli.ts (or web/)
/data
themes.json # role distributions
config.json # timers, message limits, difficulty knobs
/tests
resolver.test.ts
victory.test.ts
roles.test.ts

markdown
Copy code

---

## 2. Game State Model (Data Schema)
### 2.1 Canonical State
- `GameState`
  - `seed: number`
  - `dayNumber: number`
  - `phase: "NIGHT" | "DAY" | "VOTE" | "END"`
  - `players: PlayerState[]` (length 18)
  - `theme: ThemeId`
  - `aliveIds: number[]`
  - `deadIds: number[]`
  - `publicLog: PublicEvent[]`
  - `privateLogs: Map<ChannelId, PrivateEvent[]>`
  - `pendingActions: Action[]` (night/day actions queued)
  - `voteState: VoteState`
  - `limits: UsageLimits` (shots/injections/etc.)
  - `victory: VictoryState | null`

### 2.2 Player State
- `PlayerState`
  - `id: number`
  - `name: string`
  - `isHuman: boolean`
  - `role: RoleId` (hidden)
  - `faction: "BLUE" | "RED" | "GREEN"`
  - `alive: boolean`
  - `publicRevealedRole?: RoleId` (e.g., Brat reveal)
  - `status: StatusFlags` (smoked, kidnapped, purified, seeded, marked, etc.)
  - `lastWords?: string`
  - `ai?: AIAgentState` (if not human)

### 2.3 Events & Redaction
All actions resolve into events.
- Store full truth in `engineLog`.
- Derive `publicLog` by redacting hidden info.
- Provide per-faction private views:
  - Police channel sees police-only info (members, their votes).
  - Killer channel sees killer-only info.
  - Third-party channel if applicable.

---

## 3. Deterministic Phase Loop (State Machine)
### 3.1 Main Loop
1. `SETUP` → assign roles with seeded RNG → initialize channels
2. Repeat until victory:
   - `NIGHT`
     - Collect actions (human if role acts, AIs act)
     - Resolve actions deterministically → update state → emit events
   - `DAY`
     - Discussion window (AI talk + human input)
   - `VOTE`
     - Collect votes → execute if > 50% within time → last words
     - Check victory
3. `END`

### 3.2 Resolution Ordering (Strict, Testable)
Define a fixed resolution order to avoid ambiguity. Example baseline:
1. Apply “cannot act” statuses: kidnapped, smoked, purified, dead
2. Resolve **targeting prevention** (smoke untargetable, etc.)
3. Resolve **protections/absorbs** (agent protect, heavenly fiend absorb)
4. Resolve **role-group votes** (police investigate, killers murder)
5. Resolve **instant kills** (sniper shot, terrorist bomb, etc.)
6. Resolve **delayed kills** (end-of-night deaths)
7. Resolve **conversions** (zombie bite converts)
8. Apply **resource limits** (shots used, injections used)
9. Emit events (private then public redactions)
10. Check victory conditions

> Each role defines: `intent`, `priority`, `blockableBy`, `unblockableTags`, and `deathCause`.

Rule: Night actions are considered simultaneous,
but resolution follows the fixed priority order.
If an action's owner is killed before its resolution step,
the action fails unless explicitly stated otherwise by the role.
---

## 4. Stronger AI System (Design)
Your AI must feel like it is **reasoning**, not random guessing. Use a layered approach:

## 4.1 AI Layers (From Fast to Deep)
### Layer A: Rule-Valid Action Generator
Guarantee legal actions:
- Cannot target dead/untargetable
- Respect usage limits (shots/injections)
- Respect cooldowns (kidnap cannot repeat same target)
- Respect role-specific rules

### Layer B: Belief Model (World Model)
Maintain probabilistic beliefs about each player’s role/faction.

- `P(faction = RED | BLUE | GREEN)` per player
- optional: `P(role = X)` per player (only for roles in current theme)
- Track “hard constraints”:
  - Known police members (if police AI)
  - Known killer members (if killer AI)
  - Revealed roles (brat reveal, etc.)
  - Impossible assignments due to theme counts

#### Evidence Signals (Examples)
- Voting patterns (who saves whom, who pushes whom)
- Night outcomes:
  - If someone dies despite a claimed protect, update beliefs
  - If police report exists (AI can infer from behavior, not direct truth)
- Dialogue:
  - Contradictions
  - Overconfident claims
  - Coordination language (possible same-faction)

#### Update Mechanism
Use a simple but effective method:
- Start with priors based on theme distribution.
- Apply multiplicative likelihood updates per event:
  - `posterior ∝ prior * likelihood(event | hypothesis)`
- Normalize.

This is not “true Bayes” but produces stable, understandable behavior.

### Layer C: Utility-Based Planner (Decision Making)
Choose actions by maximizing expected utility:
- For each candidate action `a`:
  - Simulate *N rollouts* (lightweight) with sampled hidden roles consistent with beliefs
  - Score outcomes using a role-specific utility function
  - Pick best action (or softmax sample for variation)

#### Utility Components (Examples)
- Survival value (stay alive)
- Faction progress (eliminate enemies)
- Information gain (investigations)
- Avoid friendly fire (sniper/cowboy risks)
- Long-term deception (don’t expose)
- Threat reduction (remove confirmed/likely enemy)

### Layer D: Deception & Social Strategy Module
AI should:
- Bluff when beneficial (especially RED)
- Coordinate implicitly with faction mates using subtle cues (not explicit truth leaks)
- Create plausible stories consistent with public info

Key concept: **separate “Truth State” from “Public Persona.”**
- Truth: hidden role, beliefs.
- Persona: what they *claim* and the consistency they maintain.

### Layer E: Rationale + Trace (Explainability)
For debugging and for player trust, each AI action logs:
- Top 3 reasons (short)
- Key evidence used
- Confidence score
- Alternative actions considered

Example rationale format:
- `Action: vote_execute Player7`
- `Reasons:`
  1) “Player7 defended Player12 (high RED probability) repeatedly.”
  2) “Player7 shifted vote late to avoid majority.”
  3) “My belief: P(Player7 is RED)=0.62.”
- `Alternatives:` vote Player3 (0.58), abstain (0.41)

---

## 4.2 Difficulty Settings (Knobs)
Make the game tunable:
- **Easy:** shallow beliefs, fewer rollouts, more randomness, less deception
- **Normal:** beliefs + utility planner, limited rollouts
- **Hard:** deeper rollouts, better deception, better consistency checking
- **Nightmare:** strong priors, aggressive coordination, tighter story constraints

Config knobs:
- `rolloutsPerDecision` (e.g., 8 / 24 / 64)
- `beliefUpdateStrength`
- `lieRate` (per faction/role)
- `chatAggressiveness`
- `riskTolerance`

---

## 4.3 Rollout Simulation (Key to “Stronger Thinking”)
### What is a rollout?
A lightweight simulation of “what might happen next” given uncertain roles.

#### Steps
1. Sample a complete hidden-role assignment consistent with:
   - theme counts
   - revealed roles
   - known same-faction members (private knowledge)
   - current belief distributions
2. Simulate 1–2 future cycles (night+day) using fast heuristics.

Rollout depth is configurable:
- Easy: 0.5 cycle (night only)
- Normal: 1 full cycle
- Hard/Nightmare: 2 full cycles

3. Score final state using utility.
4. Repeat N times, take expected score.

This makes AI feel strategic and forward-looking.

---

## 5. Dialogue Generation (AI Chat)
### 5.1 Dialogue Goals
- Provide arguments, suspicion, defense, misdirection.
- Stay consistent with persona and known facts.
- Avoid leaking hidden truth (unless role reveal rules allow it).

### 5.2 Structured Dialogue Pipeline
1. **Intent selection** (accuse/defend/redirect/ask/question/claim)
2. **Content plan** (choose 1–2 evidence points from memory)
3. **Surface realization** (generate natural language message)
4. **Consistency check** (don’t contradict previous claims)
5. **Safety filters** (no disallowed content)

Messages should be short and human-like.

---

## 6. MVP Build Order (Pragmatic)
### Phase 1 (Playable Core)
- Theme: **Good vs Evil**
- Roles: Police, Killer, Civilian, Doctor, Sniper
- Day chat + vote + last words
- Deterministic engine + logs
- AI: belief + utility planner (minimal rollouts)

### Phase 2 (Stronger AI)
- Add rollout simulation
- Add persona consistency + deception module
- Add explainable rationale viewer

### Phase 3 (Expand Roles/Themes)
Add roles incrementally with tests per role:
- Agent, Terrorist, Kidnapper, Cowboy
- Then zombie / purifier / necromancer, etc.

---

## 7. Testing Strategy (Critical)
### 7.1 Unit Tests
- Role legality checks
- Resolver ordering correctness
- Victory conditions
- Redaction correctness (public vs private)

### 7.2 Simulation Tests
- Run 1,000 seeded games:
  - ensure no crashes
  - ensure games terminate
  - measure win rates by faction and difficulty
  - detect degenerate strategies (e.g., always vote same)

---

## 8. “Codex Tasks” (Copy/Paste Work Packages)
### Task A: Core Engine Skeleton
- Implement state machine: setup → night → day → vote → end
- Add deterministic RNG & event logging
- Add theme loading & role assignment validation

### Task B: Action System + Resolver
- Define `Action` interface and priorities
- Implement resolver ordering
- Emit public/private events

### Task C: Implement 5 Core Roles
- Police: investigate by faction vote
- Killer: murder by faction vote
- Doctor: injection + empty injection rules + limited uses
- Sniper: immediate shot + limited uses
- Civilian: no actions

### Task D: AI v1 (Beliefs + Utility)
- Initialize priors based on theme counts
- Evidence updates (votes, kills, claims)
- Action selection by expected utility
- Simple dialogue intents

### Task E: AI v2 (Rollouts + Persona)
- Sample role assignments consistent with constraints
- Run rollouts 1–2 cycles
- Persona memory + consistency constraints
- Rationales for every decision

---

## 9. Notes on IP / Inspired Design
This is an original implementation *inspired by* classic social deduction mechanics. Use original assets, names, UI, and code.
