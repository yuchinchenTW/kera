# Night / Day 18

## Disclaimer
This project is an original, non-commercial technical prototype for learning and experimentation.
It does not use or include any assets, code, data, or materials from any existing commercial games.

## Quick Start
```bash
npm install
npm start          # serves http://localhost:3001
```
- Single-player: `http://localhost:3001/`
- Multiplayer: `http://localhost:3001/multiplayer.html`

## Overview (EN)
- Social deduction game for 18 seats with multiple themed role mixes.
- Single-player (1 human + 17 AI) and WebSocket multiplayer (multiple humans, AI fills remaining seats and takes over on disconnect).
- Fixed night/day cadence, majority/plurality daytime votes, private faction chats with real-time ally action visibility.
- Four AI difficulty levels with behavioral analysis, deception strategies, and Bayesian belief systems.

## 摘要（中文）
- 18 人社交推理遊戲，多種主題角色組合。
- 單人模式（1 人類 + 17 AI）與 WebSocket 多人模式（多名真人，AI 填補空位並在斷線時接管）。
- 夜/日節奏固定，白天多數/最高票處決，陣營私聊即時同步隊友夜間行動。
- 四種 AI 難度，含行為分析、欺騙策略、貝氏信念系統。

## Project Structure

| File | Description |
|------|-------------|
| `server.js` | Node.js HTTP + WebSocket server, room/lobby management, multiplayer game flow |
| `src/engine.js` | Game engine: night resolution, vote resolution, victory checks |
| `src/ai.js` | AI decision system: beliefs, night actions, voting, chat generation |
| `src/state.js` | Game state initialization, player/death management, faction counts |
| `src/roles.js` | Role/faction/theme/phase definitions, role metadata |
| `src/view.js` | Per-player view builder (hides info based on role visibility rules) |
| `src/rng.js` | Seeded RNG for deterministic replays |
| `src/main.js` | Single-player client UI renderer |
| `src/multi.js` | Multiplayer client UI renderer |
| `index.html` | Single-player entry page |
| `multiplayer.html` | Multiplayer entry page |
| `styles.css` | Shared stylesheet |
| `tests/simulate.js` | Headless simulation for win-rate analysis |

## Multiplayer

### Setup
One process serves both static files and WebSocket:
```bash
npm install && npm start
```
Open `http://<host>:3001/multiplayer.html` (use `https/wss` when deployed behind TLS).

### Flow
1. Set WS URL and join with a name (first joiner becomes Host).
2. Host picks a theme and clicks **Start**.
3. Night phase: players submit actions within the timer; unsubmitted players are auto-resolved by AI.
4. Day phase: faction chats, public chat, then vote. Host can click Resolve or wait for timer.
5. Use **Restart** then **Start** for a new match.

### Disconnect Handling
When a player disconnects mid-game, their seat is taken over by the AI system. The player name is suffixed with `(AI)`. The AI difficulty for multiplayer is fixed at **Hard**.

### Real-time Ally Visibility
During the night phase, same-role allies (killers/police/grudge beasts) can see each other's action choices in real time, both before and after resolution. Actions are persisted in faction chat so they survive page refreshes.

### WebSocket Protocol

**Client -> Server:**

| Field | Type | Description |
|-------|------|-------------|
| `type: "join"` | Join | `name`: display name, `spectator`: boolean, `waitForStart`: boolean |
| `type: "start"` | Host | `theme`: theme ID string |
| `type: "night_action"` | Action | `action`: `{ type, targetId }` |
| `type: "vote"` | Vote | `targetId`: player ID |
| `type: "last_words"` | Chat | `text`: last words string |
| `type: "chat"` | Chat | `text`: message, `channel`: `"killer"` / `"police"` / `"grudge"` / `"spectator"` |
| `type: "resolve"` | Host | Force-resolve current phase |
| `type: "restart"` | Host | Reset room for new game |

**Server -> Client:**

| Field | Type | Description |
|-------|------|-------------|
| `type: "joined"` | Init | `playerId`, `host`, `spectator` |
| `type: "lobby"` | Lobby | `seats[]`: current seat list |
| `type: "phase"` | Flow | `phase`, `day` |
| `type: "view"` | State | Full player view (role-filtered) |
| `type: "acked"` | Confirm | `action`, `actorName`, `role`, `targetName` |
| `type: "action_log_killer"` | RT | Real-time killer ally action |
| `type: "action_log_police"` | RT | Real-time police ally action |
| `type: "action_log_grudge"` | RT | Real-time grudge ally action |
| `type: "chat"` | Chat | `channel`, `sender`, `text` |
| `type: "timer"` | UI | `label`, `remaining` (seconds) |
| `type: "error"` | Error | `message` |

## AI Difficulty System

All AI decisions are purely algorithmic (no external LLM). A seeded RNG ensures deterministic replays.

### Difficulty Levels

| Parameter | Easy | Normal | Hard | Nightmare |
|-----------|------|--------|------|-----------|
| Suspicion scaling | 0.6x | 1.0x | 1.3x | 1.6x |
| Random voting | 80% | 60% | 20% | 5% |
| Follow police reveal | 50% | 70% | 95% | 98% |
| Red team deception | - | - | Yes | Yes |
| Behavioral analysis | - | - | Yes | Yes |

### Belief System
Each AI maintains a Bayesian probability distribution over every other player's possible role (`aiMemory.roleProbs`). Updated each round based on observable signals:
- Chat mentions, vote flips, vote order, bandwagon pressure
- Police-revealed red confirmation
- Hard+: voting pattern consistency, vote-together pair detection, silence analysis, death correlation

### Hard+ Enhancements
- **Behavioral analysis**: Tracks cross-day voting graphs, mutual voting pairs, and chat activity patterns.
- **Smart killer targeting**: Avoids likely-protected targets, prioritizes active speakers and police.
- **Self-threat awareness**: Doctor self-protects more when threatened; terrorist triggers when about to be voted out.
- **Sniper timing**: Conservative early game, aggressive once enough intel accumulates.
- **Red deception**: Strategic deflection (20%), aggressive bluff accusations (25%), subtle ally defense (15%), vote scattering among killers.
- **Contextual chat**: References past votes, vote flips, and deaths instead of generic statements.
- **Strategic betrayal**: Sells out exposed teammates only when they're likely dead anyway.

### Single-player vs Multiplayer AI
- Single-player: difficulty is chosen at game creation.
- Multiplayer: fixed at Hard. When a player disconnects, AI takes over their seat at the same difficulty.

## Gameplay Loop

### Night Phase
1. **Control actions** resolve first: smoke (Riot Police), purify (Purifier), kidnap (Kidnapper) — these block targets from acting.
2. **Remaining actions** resolve: kills, protections, investigations, bites, etc.
3. **Protection stack**: Agent shield > Fiend absorb > Doctor revive. Unstoppable causes bypass all.
4. **Deaths resolve**: delayed kills (cowboy, necromancer) apply after instant kills.
5. **Zombie conversions**: pending bites convert at next night start.

### Day Phase
- AI-generated chat lines appear in public log.
- Private faction channels: killers / police / grudge beasts / spectators.
- Players discuss and vote.

### Vote Phase
- Majority vote (>50% of eligible voters) executes the target.
- If no majority, the player with the most votes is executed.
- Brat revives on first execution (revealed, loses future voting power).
- Dead players may leave last words (unless death type forbids it).

## Victory Conditions

| Condition | Winner |
|-----------|--------|
| All killers eliminated | BLUE wins |
| Killers >= non-killer alive | RED wins |
| Zombies > 1/3 of alive | GREEN (Zombie) wins |
| Berserk grudge + killers == 0 | GREEN (Grudge) wins |
| Berserk grudge + police == 0 | GREEN (Grudge) wins |
| Non-berserk grudge alive when RED/BLUE would win | Grudge overrides |

## Themes (Role Counts)

| Theme | Composition |
|-------|-------------|
| Good vs Evil | 4 Police, 4 Killers, Doctor, Sniper, 8 Civilians |
| Counter-Terror Crisis | 4 Police, 4 Killers, Doctor, Sniper, Agent, Terrorist, 6 Civilians |
| Wild West | 4 Police, 4 Killers, Doctor, Sniper, Cowboy, Kidnapper, 6 Civilians |
| Doomsday Horror | 4 Police, 4 Killers, Doctor, Sniper, Cowboy, Kidnapper, Zombie, 5 Civilians |
| Street Fury | 4 Police, 4 Killers, Riot Police, Arsonist, Agent, Terrorist, 6 Civilians |
| Psychic Century | 4 Police, 4 Killers, Doctor, Sniper, Heavenly Fiend, Vine Demon, Brat, 5 Civilians |
| Other Dimension | 4 Police, 4 Killers, Exorcist, Nightmare Demon, Purifier, Necromancer, 6 Civilians |
| Final Judgement | 4 Police, 4 Killers, 3 Grudge Beasts, Cowboy, Sniper, 5 Civilians |

## Roles & Rules (EN)
- **Civilian (BLUE)**: No night action.
- **Police (BLUE)**: Night vote to investigate; majority result reveals faction/role to police (terrorist appears BLUE). Investigating a Kidnapper executes that kidnapper's hostage (blockable, once per kidnapper).
- **Killer (RED)**: Night murder vote; majority/plurality kills one non-red target (blockable, doctor-revivable).
- **Doctor (BLUE)**: 6 injections. Cancels blockable deaths from killers/kidnap ransom/agent link/vine swap unless the cause is non-revivable (sniper, bomb, arson, zombie bite/fatal, fiend shot, exorcist petrify, necromancer curse). Two empty shots on the same target cause an unstoppable fatal overdose.
- **Sniper (RED)**: Up to 4 headshots; instant kill, no last words; agent shield can body-block.
- **Agent (BLUE)**: Protect one target; clears smoke, sets a life link-if agent dies, the protected target dies (blockable). Blocks vine seeds, gasoline marks, and smoke on the target.
- **Terrorist (RED)**: Bomb a target; both bomber and target die unstoppably. If the target is RED, only the bomber dies.
- **Cowboy (BLUE)**: Gamble shot. Outcomes: 1/3 delayed kill on target, 1/2 click (nothing), 1/6 wild backfire (kills target, a random extra, and the cowboy).
- **Kidnapper (RED)**: Kidnaps one target (blocks their action). Cannot pick the same target twice in a row. When investigated by police, executes the current hostage once.
- **Zombie (GREEN)**: Bite target. 1 bite = pending conversion next night; 2 bites = immediate conversion; 3 bites = fatal infection (unstoppable). Biting a zombie kills the biter.
- **Riot Police (BLUE)**: 4 smoke grenades. Each smoke prevents actions; two smokes on the same night cause a blockable smoke death.
- **Arsonist (RED)**: Up to 4 gasoline marks (blocked by agent/fiend). Ignite burns all marked targets unstoppably (no last words). One action per night: mark or ignite.
- **Heavenly Fiend (BLUE)**: Starts in ABSORB (protect/soak most blockable attacks for the target). When an attack is absorbed, switches to CHARGE; next night can fire a blockable shot, then returns to ABSORB. Cannot absorb self or unstoppable causes.
- **Vine Demon (RED)**: Single-use seed. If a BLUE (non-civilian) action touches the seeded target that night, both the target and that blue actor die (blockable, doctor-revivable). If the demon would die and the seeded target lives, death swaps to the seeded target.
- **Brat (BLUE civilian)**: On first execution by vote, revives instantly, is revealed, and permanently loses voting power. Second execution kills.
- **Nightmare Demon (RED)**: Attacks kill Civilians/Brats instantly; against others, learns the target's role (no kill).
- **Exorcist (BLUE)**: Chain up to `maxChain` blockable petrify strikes per night (base 3; mistakes reduce max). Hitting non-RED ends the chain that night, reduces maxChains by 1, and after 3 mistakes the power is lost. Doctor cannot revive petrify.
- **Necromancer (RED)**: Gains 1 soul from any death they did not cause (day deaths stored and applied at next night start). If <2 souls at night start, cannot act. Uses all souls: 2 souls = delayed curse kill; 3 souls = instant un-blockable-by-agent kill (blockable flag false); 4 souls = unstoppable, no last words. Souls reset after cursing; doctor cannot revive cursed targets.
- **Purifier (BLUE)**: Cleanses one target: target cannot act and most actions/votes ignore them; also wipes necromancer souls. Sniper/unstoppable effects can still kill them.
- **Grudge Beast (GREEN)**: Private grudge chat. Each night (not berserk) they vote one judgment target: RED -> info shared to police & marked; BLUE non-civilian -> info shared to killers; Civilian -> random grudge beast dies. If any grudge beast dies at night (not by their own punish), they become berserk: judging stops, they instead night-vote a kill (majority). Win: berserk grudge wins when killers==0 or police==0; if RED/BLUE would win while a non-berserk grudge is alive, grudge overrides that win. Trigger faction is tracked for berserk co-wins.

## 角色與規則 (中文)
- 平民（藍）：沒有夜行動。
- 警察（藍）：夜間共同投票查一人；多數結果只回報給警察（恐怖份子視為藍方）。若查到綁匪，綁匪的人質會被處決一次（可被保護）。
- 殺手（紅）：夜間謀殺投票，多數／最高票處決一名非紅方（可被醫生救）。
- 醫生（藍）：共 6 針。可救回殺手殺害／綁票處決／特務連動／藤魔交換等可阻擋的死亡；無法救狙擊、炸彈、縱火、喪屍咬死、天煞射殺、驅魔石化、死靈詛咒。對同一目標打 2 發空針會造成無法阻擋的致死過量。
- 狙擊手（紅）：最多 4 發即死狙擊，無遺言；特務護盾可擋。
- 特務（藍）：保護一人，清除煙霧並建立生命連動；特務死亡時被保護者一同死亡（可被阻擋、可被醫生救）。可擋汽油彈、藤魔種子、煙霧。
- 恐怖份子（紅）：投擲炸彈，自己與目標一起死亡且不可阻擋；若目標是紅方只有自己死亡。
- 牛仔（藍）：賭槍：1/3 延遲擊殺目標、1/2 空包彈、1/6 失控連殺（目標 + 隨機一人 + 自己）。
- 綁匪（紅）：綁架一人使其無法行動，不可連續兩晚同目標。被警察查到時會處決當前人質一次。
- 喪屍（綠）：咬擊。1 咬＝下一晚轉化預約，2 咬＝立即轉喪屍，3 咬＝不可阻擋死亡；咬到喪屍會反噬咬者死亡。
- 防暴警察（藍）：4 顆煙霧彈，使目標當晚無法行動；同夜被煙兩次會因煙霧過量死亡（可被阻擋）。
- 縱火狂（紅）：最多 4 個汽油標記（可被特務／天煞吸收）。引燃時所有被標記者即時燒死、不可阻擋且無遺言。每晚只能標記或引燃其一。
- 天煞（藍）：初始吸收模式，保護一人並吸收大多數可阻擋的攻擊；成功吸收後變成充能模式，下一晚可射殺一人（可阻擋），之後回到吸收。無法吸收自身或不可阻擋攻擊。
- 藤魔（紅）：單次種子。若當晚有警察陣營（非平民）動作接觸種子目標，目標與該藍方一起死亡（可被阻擋／醫生可救）。若藤魔將死且種子目標存活，死亡會轉嫁給種子目標。
- 屁孩（藍，平民系）：第一次被公決時復活並曝光，之後失去投票權；第二次處決必死。
- 夢魔（紅）：攻擊只殺平民／屁孩；若目標不是平民，改為得知對方職業（不殺）。
- 驅魔人（藍）：每晚可連鎖最多 `maxChain` 次石化攻擊（初始 3，可阻擋）。打到非紅方當晚連鎖中止並減少最大連鎖數，累積 3 次誤擊後失去能力。被石化者醫生無法救。
- 死靈（紅）：非自身擊殺的每個死亡都獲得 1 靈魂（白天先暫存，夜初加入，最多 4）。夜晚若靈魂 <2 則無法行動；行動時耗盡靈魂：2 魂＝延遲詛咒擊殺、3 魂＝立即擊殺（不可被特務擋）、4 魂＝不可阻擋且無遺言。施放後靈魂清零，醫生無法救。
- 除靈師（藍）：淨化一名目標，使其當晚無法行動、對多數行動／投票免疫，並清除死靈靈魂。狙擊／不可阻擋攻擊仍可擊殺。
- 怨靈獸（綠）：擁有怨靈獸私人頻道。未狂暴時每晚票選「審判」一人：紅方 -> 身份告知警察並標記；藍方非平民 -> 身份告知殺手；平民 -> 隨機犧牲一名怨靈獸。任一怨靈獸在夜晚死亡（非自身處決）即進入狂暴，只能在夜晚多數決擊殺。勝利條件：狂暴後若警察為 0 或殺手為 0 則怨靈獸勝；若紅或藍要取勝時仍有未狂暴的怨靈獸存活，怨靈獸會覆寫勝利；狂暴觸發方會影響共贏判定。

## 勝利條件

| 條件 | 獲勝方 |
|------|--------|
| 所有殺手被消滅 | 藍方勝利 |
| 殺手數量 >= 非殺手存活數 | 紅方勝利 |
| 喪屍 > 存活人數的 1/3 | 綠方（喪屍）勝利 |
| 狂暴怨靈 + 殺手 == 0 | 綠方（怨靈）勝利 |
| 狂暴怨靈 + 警察 == 0 | 綠方（怨靈）勝利 |
| 紅/藍即將獲勝但仍有未狂暴怨靈存活 | 怨靈覆寫勝利 |

## Simulation
```bash
node tests/simulate.js 500    # runs 500 all-AI games, prints win rates by faction
```
Increase the number for larger samples. Useful for balancing roles and difficulty tuning.
