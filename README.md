# Night / Day 18

**Live Demo / 線上體驗：** https://kera.onrender.com/multiplayer.html

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
- Fixed night/day cadence, majority/plurality daytime votes, private faction chats (day + night) with real-time ally action visibility.
- Four AI difficulty levels with behavioral analysis, deception strategies, Bayesian belief systems, personality, role claiming, and emotional responses.
- **Hard AI powered by trained neural network** — 650M-step MAPPO self-play policy served via ONNX Runtime (GOOD_VS_EVIL theme only), with automatic fallback to heuristic AI for other themes.

## 摘要（中文）
- 18 人社交推理遊戲，多種主題角色組合。
- 單人模式（1 人類 + 17 AI）與 WebSocket 多人模式（多名真人，AI 填補空位並在斷線時接管）。
- 夜/日節奏固定，白天多數/最高票處決，陣營私聊（日夜皆有）即時同步隊友夜間行動。
- 四種 AI 難度，含行為分析、欺騙策略、貝氏信念系統、個性系統、角色宣告、情緒反應。
- **困難 AI 由訓練神經網路驅動** — 650M 步 MAPPO 自我對弈策略，透過 ONNX Runtime 推理（僅限正邪對決主題），其他主題或模型不存在時自動退回啟發式 AI。

## Project Structure / 專案結構

| 檔案 File | 說明 Description |
|------|-------------|
| `server.js` | Node.js HTTP + WebSocket 伺服器，房間/大廳管理，多人遊戲流程 |
| `src/engine.js` | 遊戲引擎：夜晚結算、投票結算、勝利判定 |
| `src/ai/` | AI 決策系統（模組化） |
| `src/ai/utils.js` | AI 工具函式（clamp、isHard、rng helpers） |
| `src/ai/analysis.js` | 投票/聊天模式分析、推理鏈、陣營機率 |
| `src/ai/memory.js` | 貝氏信念系統（ensureBeliefs） |
| `src/ai/targeting.js` | 各角色目標選擇邏輯 |
| `src/ai/night.js` | 夜間行動生成（buildAiNightActions） |
| `src/ai/vote.js` | 投票決策生成（buildAiVoteActions） |
| `src/ai/chat.js` | 公開/陣營/遺言聊天生成 |
| `src/ai/templates.js` | 雙語聊天模板（純資料） |
| `src/ai/neural.js` | 神經網路 AI（ONNX 推理、動作轉換） |
| `src/ai/index.js` | AI 模組公開 API re-export |
| `src/state.js` | 遊戲狀態初始化、玩家/死亡管理、陣營人數統計 |
| `src/roles.js` | 角色/陣營/主題/階段定義、角色元資料 |
| `src/view.js` | 玩家視角產生器（依角色可見性規則隱藏資訊） |
| `src/rng.js` | 種子亂數產生器，確保可重現的遊戲結果 |
| `src/main.js` | 單人模式客戶端 UI 渲染器 |
| `src/multi.js` | 多人模式客戶端 UI 渲染器 |
| `index.html` | 單人模式入口頁面 |
| `multiplayer.html` | 多人模式入口頁面 |
| `styles.css` | 共用樣式表 |
| `tests/simulate.js` | 無頭模擬測試，勝率分析工具 |
| `tests/behavior_audit.js` | 250 場行為審計：驗證各角色行動/聊天/投票邏輯一致性 |

## Multiplayer / 多人模式

### 啟動 Setup
一個程序同時提供靜態檔案與 WebSocket 服務：
```bash
npm install && npm start
```
開啟 `http://<host>:3001/multiplayer.html`（部署在 TLS 後請使用 `https/wss`）。

### 遊戲流程 Flow
1. 設定 WS URL 並輸入名稱加入（第一位加入者成為房主 Host）。
2. 房主選擇主題後點擊 **開始**。
3. 夜晚階段：玩家在計時器內提交行動；未提交的玩家由 AI 自動執行。
4. 白天階段：陣營私聊（AI 在私人頻道產生策略性討論）、公開聊天、然後投票。房主可點擊「結算」或等待計時器結束。
5. 使用 **重新開始** 再點 **開始** 以進行新一局。

### 斷線處理 Disconnect Handling
玩家中途斷線時，AI 系統接管該座位，名稱後綴顯示 `(AI)`。多人模式的 AI 難度固定為 **Hard（困難）**。

### 即時隊友可見性 Real-time Ally Visibility
夜晚階段，同陣營隊友（殺手/警察/怨靈獸）可即時看到彼此的行動選擇，結算前後皆可見。行動記錄保存在陣營聊天中，重新整理頁面也不會遺失。

### WebSocket 協議 Protocol

**客戶端 → 伺服器 Client -> Server:**

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

**伺服器 → 客戶端 Server -> Client:**

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

## AI Difficulty System / AI 難度系統

所有 AI 決策皆為純演算法（不使用外部 LLM）。種子亂數確保可重現的遊戲結果。

**困難模式（Hard）** 啟用時，若偵測到 ONNX 模型檔案（`training/mafia_policy.onnx`）且遊戲主題為 **GOOD_VS_EVIL（正邪對決）**，會使用 **650M 步自我對弈訓練的神經網路**做所有 AI 決策（夜間行動 + 投票 + 聊天），100% 保留訓練成果。其他主題或模型不存在時自動退回啟發式 AI，無需任何設定。

### 難度等級 Difficulty Levels

| 參數 Parameter | 簡單 Easy | 普通 Normal | 困難 Hard | 惡夢 Nightmare |
|-----------|------|--------|------|-----------|
| 決策引擎 Decision engine | 啟發式 | 啟發式 | **神經網路 (ONNX)** ¹ | **神經網路 (ONNX)** ¹ |
| 嫌疑倍率 Suspicion scaling | 0.6x | 1.0x | 1.3x (fallback) | 1.6x (fallback) |
| 隨機投票 Random voting | 80% | 60% | 20% (fallback) | 5% (fallback) |
| 跟隨警察揭露 Follow police reveal | 50% | 70% | 95% (fallback) | 98% (fallback) |
| 紅方欺騙 Red team deception | - | - | 有 Yes | 有 Yes |
| 行為分析 Behavioral analysis | - | - | 有 Yes | 有 Yes |

> ¹ 神經網路目前僅支援 GOOD_VS_EVIL（正邪對決）主題。其他主題的 Hard/Nightmare 使用啟發式 AI。
> 
> 注意：當神經網路模型載入且主題為 GOOD_VS_EVIL 時，Hard/Nightmare 的所有 AI 決策由神經網路處理，上述啟發式參數僅在 fallback 模式生效。

### 信念系統 Belief System
每個 AI 維護一組貝氏機率分佈，涵蓋所有其他玩家可能的角色（`aiMemory.roleProbs`）。每回合根據可觀察的訊號更新：
- 聊天提及、投票翻轉、投票順序、跟風壓力
- 警察揭露的紅方確認
- Hard+：投票模式一致性、共同投票配對檢測、沉默分析、死亡相關性

### Hard+ 強化系統 Hard+ Enhancements

**核心系統 Core Systems:**
- **行為分析 Behavioral analysis**：追蹤跨天投票圖譜、互投配對、聊天活躍度模式。
- **自身威脅感知 Self-threat awareness**：AI 追蹤自己被投出的可能性（得票數、被提及次數、警察揭露）。
- **情境聊天 Contextual chat**：雙語（EN/ZH）模板，引用過往投票、翻票、死亡事件。
- **跨回合記憶 Cross-round memory**：記錄每天誰指控/辯護了誰；偵測矛盾言論（先指控再辯護同一人 → 可疑）。
- **死亡歸因 Death attribution**：分析誰在白天推動處決了夜晚被殺的玩家，推斷殺手行為。
- **情緒系統 Emotion system**：AI 對事件產生情緒反應 — 被投票後憤怒、被壓力逼迫時防禦、被救後感激、受威脅時焦慮。
- **AI 個性 Personality**：4 種持久型人格（激進/謹慎/社交/沉默），影響聊天頻率、指控風格、投票信心。
- **遊戲階段感知 Game phase awareness**：前期（蒐集資訊、謹慎）→ 中期（推票、揭露）→ 後期（全力出擊、孤注一擲）。策略自動調整。
- **邏輯推理鏈 Deduction chains**：從已確認藍方傳播信任、從已確認紅方傳播嫌疑、死亡模式分析、消去法推理。
- **夜間結果推斷 Night result inference**：從夜晚結果推斷救援；提高醫生/特務被推測為保護者的機率。

**聊天與社交 Chat & Social:**
- **角色宣告（跳車）Role claiming**：藍方特殊職業在受威脅時宣告身份（第 2 天起）；紅方殺手假冒平民/醫生；當有人宣告你的真實角色時自動反駁。
- **回應式聊天 Responsive chat**：AI 根據自身信念對他人指控回覆同意/反對/質疑。
- **跟風與反駁 Bandwagon & counter**：當 3 人以上指控同一人時，其他人跟風（60%）或反駁辯護（30%）。
- **自我辯護 Self-defense**：被指控的 AI 以投票記錄為證據進行反駁。
- **紅方沉默策略 Red silence**：殺手偶爾保持沉默避免露餡；連續沉默 2 輪後強制發言。
- **假警察宣告 Fake police claim**：殺手罕見策略（8%，每局一次），偽造警察調查結果來陷害藍方。
- **信任建立 Trust building**：紅方 AI 先為低嫌疑玩家辯護以建立可信度，再伺機出手。只有殺手能看到殺手隊友（用真實角色辯護），其他紅方（狙擊手等）依靠觀察推測，避免資訊外洩。
- **策略遺言 Strategic last words**：瀕死 AI 留下角色相關訊息 — 藍方指控/辯護、紅方虛張/栽贓、綠方威脅。警察傾倒所有調查結果（分類型：RED/BLUE/GREEN，紅方優先排序）。醫生/特務遺言引用實際保護對象（`lastProtected`）。遺言以 `[LAST]` 標記寫入 dayChat，AI 信念系統可解析為線索但不計入活人聊天活躍度。
- **陣營私聊（日夜皆有）Faction chat**：殺手/警察/怨靈獸私人頻道，與實際 AI 決策邏輯統一。殺手夜間私聊呼叫真實目標選擇函式，白天描述實際投票策略分支（sell-out/scatter/split/mimic）；警察私聊引用真實調查目標與結果。回覆者針對 speaker 內容情境式回應，不再隨機挑模板。

**投票策略 Vote Strategy:**
- **投票時機感知 Vote timing**：第二輪跟風投票趨向共識目標。
- **策略性棄權 Strategic abstaining**：低信心藍方 AI 可能棄權而非隨機投票。
- **投票解釋 Vote explanation**：AI 投票後在聊天中解釋投票理由（`[VOTE]` 標記，不會被下一輪信念系統重複計算）。
- **投票修正 Vote correction**：當 AI 公聊指控 A 但實際投 B 時，補一句「改主意」修正句，減少表層不一致。
- **跟隨警察揭露 Follow reveal**：藍方非警察在公聊中 85% 會呼應已揭露紅方（對應投票端 95% 跟投率）。
- **分散投票 Vote scatter**：殺手協調分散票數到不同目標。

**藍方（警察陣營）Blue Team:**
- **警察 Police**：智慧調查選擇；策略性揭露時機（第 1 天不揭露，瀕死時傾倒所有情報）。
- **醫生 Doctor**：根據威脅程度自保（自動避免 overdose 風險 — 自身已有 1 次空針時強制保護他人）；避免重複保護同一人（除非成功救援）；預測殺手目標。
- **特務 Agent**：預測殺手目標（活躍發言者、疑似警察、曾被救者）並保護。遺言引用實際保護對象（`aiMemory.lastProtected`）。
- **天煞 Heavenly Fiend**：吸收模式模仿特務邏輯；充能模式優先射擊高殺手機率目標。
- **防暴警察 Riot Police**：煙霧彈只用在高信心紅方目標；不浪費在不確定的對象。
- **牛仔 Cowboy**：信心超過門檻才開槍；後期更為激進。
- **驅魔人 Exorcist**：謹慎連鎖攻擊 — 只對高紅方機率玩家出手；誤擊越多門檻越高。
- **除靈師 Purifier**：優先淨化殺手、死靈（清除靈魂）、警察揭露的紅方。
- **屁孩 Brat**：跟隨多數票以融入人群；第一次死亡前不引人注目。

**紅方（殺手陣營）Red Team:**
- **殺手 Killer**：避開被保護目標，優先活躍發言者與警察；目標輪替（跳過被救者、變換活躍度特徵）。
- **狙擊手 Sniper**：前期保守（第 1 天 30%），情報累積後轉為激進（第 3 天 65%+）。無法看到紅方隊友，依靠 suspicion 中位數過濾避免友射（跳過嫌疑最高 1/3 的候選人），優先射擊有正面藍方證據的目標（被救過、被紅方指控者）。
- **恐怖份子 Terrorist**：安全時按兵不動，自身威脅高時（`selfThreat > 0.7` → 70-95% 引爆）引爆。不依賴 `policeRevealedRed`（恐怖份子被查到會顯示為藍方）。
- **綁匪 Kidnapper**：鎖定高價值藍方（醫生 > 警察 > 特務）使其無法行動；永不綁架殺手隊友。
- **縱火狂 Arsonist**：耐心標記 3+ 目標再引燃；標記高價值藍方；高自危時降為 2+ 標記即引燃。
- **藤魔 Vine Demon**：種子目標選擇最可能被警察調查的人（高嫌疑 + 高藍方機率）。
- **夢魔 Nightmare Demon**：優先擊殺平民/屁孩；對不確定角色進行情報蒐集。
- **死靈 Necromancer**：儲存靈魂至 3+（更強效果）；只在瀕死時使用 2 靈魂。

**綠方（第三方）Green Team:**
- **怨靈獸（審判）Grudge Beast (judging)**：避免審判平民（會導致怨靈獸死亡）；偏好審判紅方（安全且情報給警察）。
- **怨靈獸（狂暴）Grudge Beast (berserk)**：追蹤觸發狂暴的陣營並追殺；優先活躍發言者。
- **喪屍 Zombie**：追蹤咬擊歷史 — 優先完成待轉化目標；避開可能被保護的目標。

### 資訊完整性 Information Integrity
AI 決策邏輯遵守與玩家相同的資訊可見性規則：
- **警察調查結果分層**：引擎在夜間查到紅方時寫入 `policeRevealedRed`（私有），但非警察 AI 只讀 `policePublicRevealedRed`（僅在警察公開宣布後才設值）。投票、信念系統、夜間行動評分全面使用公開版本。
- 平民投票邏輯不讀取隱藏角色（警察身份改由公開宣告 `roleClaims` 判斷，怨獸數量用主題預期數減已死數估算）。
- 非殺手紅方（狙擊手、恐怖份子等）無法看到殺手隊友，公聊/遺言的「辯護盟友」改用低嫌疑玩家替代。
- 投票後生成的解釋句（`[VOTE]`）和遺言（`[LAST]`）不會被下一輪信念系統當作新指控信號重複計算。
- **結構化事件追蹤**：夜間救援使用 `state.lastNightSavedIds[]` 結構化陣列（取代字串解析），所有 AI 角色和模擬工具共用。

### 單人 vs 多人 AI Single-player vs Multiplayer AI
- 單人模式：難度在建立遊戲時選擇。
- 多人模式：固定為 Hard（困難）。玩家斷線時，AI 以相同難度接管該座位。

## Gameplay Loop / 遊戲流程

### 夜晚階段 Night Phase
1. **控制行動**優先結算：煙霧（防暴警察）、淨化（除靈師）、綁架（綁匪）— 這些會阻止目標行動。
2. **其餘行動**結算：擊殺、保護、調查、咬擊等。
3. **保護堆疊**：特務護盾 > 天煞吸收 > 醫生救治。不可阻擋的攻擊繞過所有保護。
4. **死亡結算**：延遲擊殺（牛仔、死靈）在即時擊殺之後生效。
5. **喪屍轉化**：待轉化咬擊在下一個夜晚開始時轉化。

### 白天階段 Day Phase
- AI 產生的雙語聊天出現在公開日誌中（情緒驅動、回應式、含指控/辯護/角色宣告）。
- 陣營私人頻道（日夜皆有）：殺手/警察/怨靈獸/觀眾。AI 討論目標、威脅、投票協調。
- 玩家討論並投票。

### 遺言 Last Words
- 被處決或夜殺的玩家可以留下遺言（除非死亡類型禁止）。
- Hard AI 產生策略性遺言：藍方指控嫌疑人或辯護隊友、紅方虛張聲勢或栽贓無辜、警察傾倒調查結果、綠方威脅。

### 投票階段 Vote Phase
- 多數票（>50% 有投票權的玩家）處決目標。
- 若無多數票，最高票者被處決。
- 屁孩第一次被處決時復活（曝光，失去未來投票權）。

## Victory Conditions / 勝利條件 (EN)

| Condition | Winner |
|-----------|--------|
| All killers eliminated | BLUE wins |
| Killers >= non-killer alive | RED wins |
| Zombies > 1/3 of alive | GREEN (Zombie) wins |
| Berserk grudge + killers == 0 | GREEN (Grudge) wins |
| Berserk grudge + police == 0 | GREEN (Grudge) wins |
| Non-berserk grudge alive when RED/BLUE would win | Grudge overrides |

## Themes / 主題（角色組成）

| 主題 Theme | 角色組成 Composition |
|-------|-------------|
| 正邪對決 Good vs Evil | 4 警察、4 殺手、醫生、狙擊手、8 平民 |
| 反恐危機 Counter-Terror | 4 警察、4 殺手、醫生、狙擊手、特務、恐怖份子、6 平民 |
| 狂野西部 Wild West | 4 警察、4 殺手、醫生、狙擊手、牛仔、綁匪、6 平民 |
| 末日恐懼 Doomsday Horror | 4 警察、4 殺手、醫生、狙擊手、牛仔、綁匪、喪屍、5 平民 |
| 街頭暴動 Street Fury | 4 警察、4 殺手、防暴警察、縱火狂、特務、恐怖份子、6 平民 |
| 靈能世紀 Psychic Century | 4 警察、4 殺手、醫生、狙擊手、天煞、藤魔、屁孩、5 平民 |
| 異次元 Other Dimension | 4 警察、4 殺手、驅魔人、夢魔、除靈師、死靈、6 平民 |
| 終極審判 Final Judgement | 4 警察、4 殺手、3 怨靈獸、牛仔、狙擊手、5 平民 |

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

## Simulation / 模擬測試
```bash
node tests/simulate.js 500                           # 500 局，預設主題/難度
node tests/simulate.js 500 GOOD_VS_EVIL hard         # 指定主題和難度
node tests/simulate.js 200 --compare                 # 比較全部 4 種難度
node tests/simulate.js 100 GOOD_VS_EVIL hard --json  # 機器可讀 JSON 輸出
node tests/simulate.js 100 --zh                      # 中文版結果輸出
node tests/simulate.js 100 --zh --compare            # 中文版難度比較
node tests/simulate.js 100 GOOD_VS_EVIL hard --seed=12345  # 固定種子重現結果
node tests/simulate.js --help                        # 顯示所有選項及可用主題
node tests/simulate.js 200 GOOD_VS_EVIL hard --neural      # 全部 AI 使用 ONNX 神經網路
node tests/simulate.js 200 GOOD_VS_EVIL hard --neural-red  # 紅方用神經網路，藍方用啟發式
node tests/simulate.js 200 GOOD_VS_EVIL hard --neural-blue # 藍方用神經網路，紅方用啟發式
node tests/simulate.js 200 GOOD_VS_EVIL hard --neural-red=training/mafia_policy.onnx  # 指定模型路徑
node tests/behavior_audit.js                         # 250 場行為審計（行動/聊天/投票邏輯）
```

輸出內容包括：陣營勝率、遊戲長度分佈、勝利原因、各角色統計（勝率、存活率、夜殺率、票殺率），以及可選的難度比較表。

Output includes: faction win rates, game length distribution, victory reasons, per-role stats (win rate, survival rate, night-kill rate, vote-kill rate), and optional difficulty comparison table. Statistics are read from engine structural counters (`state.usage`), not string parsing.

行為審計輸出包括：警察調查準確度、殺手友射率/分散投票率/私聊目標命中率、醫生連續同目標率、狙擊手命中率、平民跟投率/聊天-投票一致性、死人發言檢測。

Behavior audit output includes: police investigation accuracy, killer friendly-fire / scatter-vote / private-chat target hit rates, doctor consecutive-target rate, sniper accuracy, civilian follow-reveal / chat-vote consistency, dead-speaker detection.

## AI Training / AI 訓練系統

本專案提供三種 AI 訓練方式，可獨立或組合使用。

Three AI training approaches are available, usable independently or combined.

### 安裝依賴 Install Dependencies

```bash
pip install torch numpy tensorboard numba cma
```

GPU 訓練需要 CUDA 版 PyTorch：
```bash
pip install torch --index-url https://download.pytorch.org/whl/cu128
```

### 訓練檔案結構 Training Files

| 檔案 File | 說明 Description |
|------|-------------|
| `training/fast_engine.py` | 純 Python 精簡遊戲引擎（GOOD_VS_EVIL，無 IPC，搭配 Numba JIT） |
| `training/fast_encode_jit.py` | Numba JIT 觀測編碼器（比 Python 快 292 倍） |
| `training/model.py` | MAPPO 策略網路（6.93M 參數, hidden=452，4 頭行動空間） |
| `training/export_onnx.py` | PyTorch → ONNX 匯出腳本 |
| `training/mafia_policy.onnx` | 匯出的 ONNX 模型（17.4MB，伺服器啟動時自動載入） |
| `training/train.py` | 訓練迴圈（PPO + GAE + 集中式 critic） |
| `training/evaluate.py` | RL vs 啟發式對戰評估 |
| `training/distill.py` | 策略蒸餾（NN → JS 線性權重） |
| `training/cma_optimize.py` | CMA-ES 權重自動搜尋 |
| `training/game_server.js` | 完整引擎 JSON 伺服器（多場批次，供 evaluate 用） |
| `training/state_encoder.js` | JS 觀測編碼器（1135 維，供 game_server 用） |
| `training/env.py` | 批次遊戲環境（支援 JS subprocess 或 Python 引擎） |
| `training/vec_env.py` | 多進程向量化環境（JS 引擎模式用） |
| `training/eval_weights.js` | CMA-ES 用的 JS 模擬評估器 |
| `training/weight_params.json` | 49 個可調參數定義（預設值 + 範圍） |

### 方式一：RL 自我對弈 / RL Self-Play (MAPPO)

用強化學習訓練神經網路策略。RL 可學會假冒警察、栽贓無辜、保護隊友、策略性沉默等人類策略。

RL trains a neural network through self-play. The agent can learn deception, strategic accusations, role claims, and social coordination.

**快速開始 Quick Start：**
```bash
# 從頭訓練 650M steps（RTX 5060 約 10 天，6.93M 模型）
python training/train.py --hidden 452 --lr 1e-4 --lr_min 5e-5 --ent_coef 0.01 --num_envs 256 --steps 650000000 --rollout_steps 128 --batch_size 8192 --eval_interval 14

# 較短的訓練（測試用，約 7 小時）
python training/train.py --hidden 452 --num_envs 256 --steps 28000000 --rollout_steps 128 --batch_size 8192

# 即時監控訓練進度
tensorboard --logdir training/logs
```

**接續訓練 Resume：**
```bash
# 從 checkpoint 繼續訓練到目標步數
python training/train.py --resume training/checkpoints/policy_final.pt --steps 650000000 --hidden 452 --lr 1e-4 --lr_min 5e-5 --ent_coef 0.01 --num_envs 256

# TensorBoard x 軸會正確接續，不會從 0 重跑
```

**匯出 ONNX 並部署到遊戲 Export & Deploy：**
```bash
# 匯出 ONNX 模型（伺服器啟動時自動載入）
python training/export_onnx.py --checkpoint training/checkpoints/policy_final.pt

# 啟動伺服器（自動載入 training/mafia_policy.onnx）
npm start
```

**評估訓練結果 Evaluate：**
```bash
# RL 策略 vs 啟發式 AI 各跑 200 場
python training/evaluate.py --checkpoint training/checkpoints/policy_final.pt --games 200 --mode all_rl
python training/evaluate.py --games 200 --mode all_heuristic

# 分析 RL 聊天/欺騙行為（殺手假冒警察、藍方跟票率等）
python training/analyze_behavior.py --checkpoint training/checkpoints/policy_final.pt --games 500
```

**主要參數 Key Arguments：**

| 參數 | 建議值 | 說明 |
|------|--------|------|
| `--num_envs` | 256 | 平行遊戲數（越大 GPU 利用率越高，但吃更多 RAM） |
| `--steps` | 650000000 | 總訓練步數（650M，完整訓練約 10 天） |
| `--hidden` | 452 | 模型隱藏層大小（452=6.93M 參數，336=3.95M，128=678K）需為 4 的倍數 |
| `--rollout_steps` | 128 | 每次收集多少步再更新（越大越穩定） |
| `--batch_size` | 8192 | PPO 小批次大小 |
| `--eval_interval` | 5 | 每幾次 update 記錄一次 TensorBoard（5 ≈ 每 3 分鐘） |
| `--lr` | 0.0003 | 學習率 |
| `--resume` | 路徑 | 從 checkpoint 接續訓練 |
| `--theme` | GOOD_VS_EVIL | 訓練主題（目前僅支援此主題） |
| `--save_dir` | training/checkpoints | 模型儲存位置 |
| `--log_dir` | training/logs | TensorBoard 日誌位置 |

**訓練時間預估 Training Time：**

| Steps | hidden | 參數量 | 耗時 (RTX 5060) | 預期效果 |
|-------|--------|--------|----------------|---------|
| 28M | 452 | 6.93M | ~12 小時 | 基礎策略測試 |
| 100M | 452 | 6.93M | ~1.8 天 | 殺手學會栽贓，entropy 穩定下降 |
| 300M | 452 | 6.93M | ~5.3 天 | 策略收斂中，BLUE 勝率 ~28% |
| 500M | 452 | 6.93M | ~8.8 天 | 策略成熟，entropy ~1.1 |
| 650M | 452 | 6.93M | ~11.4 天 | 完整訓練，BLUE 勝率 ~31% |

注意：hidden=452 (6.93M) + batch_size=8192 約 660 sps。速度會隨訓練推進下降 10-20%。

**速度參考 Performance（各配置峰值）：**

| 配置 | 速度 | 24 小時產量 |
|------|------|------------|
| 16 envs (JS IPC 舊版) | 175 sps | 15M steps |
| 64 envs (Python + Numba) | 750 sps | 65M steps |
| 128 envs | 1,300 sps | 112M steps |
| 256 envs (建議) | 1,550 sps | 134M steps |
| 512 envs | 1,700 sps | 147M steps |

**技術細節 Technical Details：**
- **多頭行動空間 (63 維)**：目標 (19) + 聊天類型 (5: 沉默/指控/辯護/宣稱角色/轉移) + 聊天對象 (19) + 角色宣稱 (20)
- **時序正確**：NIGHT step 只選夜間目標，VOTE step 選聊天+投票（看到夜晚結果後才決定聊天內容）
- **觀測向量 (1135 維)**：投票圖譜 (18x18)、聊天指控/辯護矩陣、遺言信號、信念分佈、角色資源、角色宣稱記錄
- **模型**：共享策略網路 + Multi-head Attention + 集中式 critic (CTDE)，6.93M 參數, hidden=452
- **條件式 PPO**：chat_target 只在 accuse/defend 時計入 loss，claim_role 只在 claim 時計入。Dead/forced agent 不影響 actor loss，但 critic 仍學習所有狀態
- **加速**：純 Python 引擎 + Numba JIT 觀測編碼（292x），無 Node.js subprocess 開銷
**TensorBoard 指標說明 Metrics Guide：**

| 指標 Metric | 位置 | 意義 | 健康範圍 |
|-------------|------|------|---------|
| `loss/policy` | 訓練 | 策略改善幅度（負值=策略在變好） | -0.01 ~ 0，穩定不大跳 |
| `loss/value` | 訓練 | critic 預測「會不會贏」的準度（越低越準） | 0.1 ~ 0.4，持續下降是好的 |
| `loss/entropy` | 訓練 | 行動隨機程度（高=探索中，低=確定策略） | 4-head 初期 ~5.0，收斂到 ~3.0 |
| `perf/steps_per_sec` | 效能 | 訓練速度 | 256 envs 約 1500 sps |
| `winrate/BLUE` | 遊戲 | 藍方（警察陣營）勝率 | 自我對弈趨近 0.5 |
| `winrate/RED` | 遊戲 | 紅方（殺手陣營）勝率 | 自我對弈趨近 0.5 |
| `game/avg_length` | 遊戲 | 平均遊戲天數（越長=雙方越強） | 5-7 天正常 |
| `game/total_games` | 遊戲 | 累計完成遊戲數 | 持續上升 |
| `usage/doctorInjections` | 角色 | 每場醫生平均打針數（上限 6） | ~3-4 |
| `usage/doctorSaves` | 角色 | 每場醫生平均救援數 | ~0.3-0.5 |
| `usage/doctorOverdoses` | 角色 | 每場雙針殺人次數 | ~0.2-0.3 |
| `usage/sniperShots` | 角色 | 每場狙擊手開槍數（上限 4） | ~3-3.5 |
| `usage/policeFoundRed` | 角色 | 每場警察查獲紅方數 | ~1.5-2.0 |
| `usage/nightKills` | 整體 | 每場夜間總死亡數 | ~7-9 |
| `usage/voteKills` | 整體 | 每場投票處決數 | ~4-6 |

**Per-step Shaping Rewards（每步即時獎勵）：**

訓練除了終局勝負（±1.0）外，每一步都有即時獎勵信號，教角色正確使用能力：

**夜間事件 Night Events：**

| 事件 | 對象 | 獎勵 | 目的 |
|------|------|------|------|
| 殺手殺死警察 | 存活殺手群 | +0.06 | 擊殺高價值目標 |
| 殺手殺死非警察藍方 | 存活殺手群 | +0.03 | 鼓勵擊殺 |
| 殺手殺到紅方 | 存活殺手群 | -0.02 | 懲罰友射 |
| 狙擊手打中藍方 | 狙擊手 | +0.05 | 鼓勵開槍（防止學會不開槍） |
| 狙擊手打到紅方 | 狙擊手 | -0.05 | 懲罰友射 |
| 醫生成功救人 | 醫生 | +0.05 | 鼓勵打針 |
| 醫生 overdose 紅方 | 醫生 | +0.06 | 精準 overdose 獎勵 |
| 醫生 overdose 藍方 | 醫生 | -0.08 | 重罰誤殺隊友 |
| 警察查到紅方 | 警察 | +0.05 | 鼓勵調查 |

**聊天行動 Chat Actions：**

| 事件 | 對象 | 獎勵 | 目的 |
|------|------|------|------|
| 殺手指控藍方 | 殺手 | +0.02 | 鼓勵栽贓 |
| 殺手辯護紅方隊友 | 殺手 | +0.02 | 鼓勵保護隊友 |
| 殺手宣稱警察 | 殺手 | +0.04 | 鼓勵假冒警察 |
| 警察宣稱警察 | 警察 | +0.04 | 鼓勵公開身份 |
| 警察指控紅方 | 警察 | +0.05 | 鼓勵分享紅方情報 |
| 警察告知誰是藍方 | 警察 | +0.02 | 鼓勵分享藍方情報 |

**投票結果 Vote Outcomes：**

| 事件 | 對象 | 獎勵 | 目的 |
|------|------|------|------|
| 投票投出紅方 | **投票者本人** | +0.04 | 正確判斷 |
| 非警察藍方跟隨真警察投紅方 | 投票者 | +0.08 extra | 跟對情報 |
| 投票投出警察/醫生 | **投票者本人** | -0.05 | 殺死關鍵角色重罰 |
| 投票投出其他藍方 | **投票者本人** | -0.02 | 小失誤 |
| 投票投出平民 | **投票者本人** | 0 | 可接受的損失 |
| 非警察藍方被假警察騙投藍方 | 投票者 | -0.02 extra | 被欺騙懲罰 |
| 有真揭露但非警察藍方沒跟投 | 投票者 | -0.04 | 懲罰忽略情報 |
| 指控某人→被投出→是紅方 | 指控者 | +0.03 | 獎勵有效指控 |
| 指控某人→被投出→是藍方 | 指控者 | -0.02 | 懲罰錯誤指控 |

**終局 Terminal：**

| 事件 | 對象 | 獎勵 |
|------|------|------|
| 陣營勝利 | 勝方全員 | +1.0 |
| 陣營失敗 | 敗方全員 | -1.0 |
| 存活加分 | 存活者 | +0.05 |

**如何判斷訓練是否正常 How to tell if training is healthy：**
- `entropy` 緩慢下降 = 策略在收斂（好），急跌 = 過早收斂（不好）
- `value loss` 持續下降 = AI 越來越會判斷局勢，自我對弈中回升到 0.18 是正常的（策略變複雜）
- `winrate` 初期紅方先跑（~80%），中期藍方追上，最終趨向 50:50
- `avg_length` 增加 = 雙方攻防品質提升
- `policy loss` 持續為負 = 策略在改善，接近 0 = 收斂
- `sniperShots` 如果持續下降到 <1.0 = shaping reward 不夠強
- `steps_per_sec` 穩定 = 沒有記憶體洩漏或效能退化

### 方式二：CMA-ES 權重優化 / CMA-ES Weight Optimization

自動搜尋現有啟發式 AI 中 49 個 hand-tuned 參數的最優組合。不改變 AI 架構，只調整權重。追求雙方都變強、遊戲品質提升。

Automatically searches optimal values for 49 hand-tuned heuristic parameters, optimizing for game quality (balance + length + engagement).

```bash
python training/cma_optimize.py                                    # 預設 100 代
python training/cma_optimize.py --generations 200 --games 200      # 更精確
python training/cma_optimize.py --population 16 --games 150        # 更大搜尋空間
```

- 預估時間：100 代 ≈ 1 小時
- 輸出：`training/optimized_weights.json`
- Fitness：遊戲品質導向（遊戲長度 35% + 平衡度 25% + 醫生救援 20% + 多樣性 20%）

### 方式三：策略蒸餾 / Policy Distillation

從訓練好的 NN 提取策略，轉換為 JS 啟發式可用的權重，部署到瀏覽器。

Extracts learned policy from trained NN into JS-compatible weights for browser deployment.

```bash
# 蒸餾（從 checkpoint 提取權重）
python training/distill.py --checkpoint training/checkpoints/policy_final.pt --samples 10000

# 輸出檔案：
#   training/learned_weights.json      — 原始權重數據
#   src/ai/learned_weights.js          — JS 模組（自動整合到遊戲）
```

整合方式：透過 `getWeight(role, phase, feature, default)` 注入，缺少的權重自動 fallback 到 hand-tuned 值。

### 完整訓練流程 Full Training Pipeline

```bash
# 1. 安裝依賴
pip install torch --index-url https://download.pytorch.org/whl/cu128
pip install numpy tensorboard numba cma onnx onnxruntime onnxscript

# 2. RL 訓練（掛著跑 ~10 天）
python training/train.py --hidden 452 --lr 1e-4 --lr_min 5e-5 --ent_coef 0.01 --num_envs 256 --steps 650000000 --rollout_steps 128 --batch_size 8192 --eval_interval 14

# 3. 監控（另開終端）
tensorboard --logdir training/logs

# 4. 評估
python training/evaluate.py --checkpoint training/checkpoints/policy_final.pt --games 200 --mode all_rl

# 5. 行為分析（殺手欺騙、藍方跟票等）
python training/analyze_behavior.py --checkpoint training/checkpoints/policy_final.pt --games 500

# 6. 匯出 ONNX 模型（部署到遊戲伺服器）
python training/export_onnx.py --checkpoint training/checkpoints/policy_final.pt

# 7. (可選) 蒸餾為 JS 線性權重（用於無 ONNX 環境）
python training/distill.py --checkpoint training/checkpoints/policy_final.pt --samples 10000

# 8. 啟動伺服器（自動載入 ONNX 模型）
npm start

# 9. 接續訓練更多 steps
python training/train.py --resume training/checkpoints/policy_final.pt --steps 800000000 --hidden 452 --lr 1e-4 --lr_min 5e-5 --ent_coef 0.01 --num_envs 256
```

### 架構圖 Architecture

```
         ┌─────────────────────────────────────────────┐
         │              Training (Python)               │
         │                                             │
         │  ┌─────────────┐     ┌──────────────────┐  │
         │  │ fast_engine  │────►│ fast_encode_jit  │  │
         │  │  (game sim)  │     │  (Numba JIT obs) │  │
         │  └──────────────┘     └────────┬─────────┘  │
         │                                │            │
         │                    obs [256, 18, 1135]      │
         │                                │            │
         │                       ┌────────▼─────────┐  │
         │                       │   MafiaPolicy    │  │
         │                       │   (GPU, 6.93M)    │  │
         │                       │   4-head output  │  │
         │                       └────────┬─────────┘  │
         │                                │            │
         │                   actions [256, 18, 4]      │
         │                                │            │
         │  ┌─────────────────────────────▼──────────┐ │
         │  │            train.py (MAPPO)             │ │
         │  │  PPO + GAE + centralized critic         │ │
         │  └─────────────────────────────┬──────────┘ │
         └────────────────────────────────┼────────────┘
                                          │
                              policy_final.pt
                                          │
                    ┌──────────────┬──────┼──────────────────┐
                    │              │      │                  │
              ┌─────▼─────┐ ┌─────▼────┐ ┌──────▼──────┐   ┌──────▼──────┐
              │ evaluate   │ │ analyze  │ │  distill    │   │  CMA-ES     │
              │ (vs heur.) │ │ behavior │ │  (NN→JSON)  │   │ (49 params) │
              └────────────┘ └──────────┘ └──────┬──────┘   └──────┬──────┘
                                                 │                  │
                                        learned_weights.js   optimized_weights
                                                 │                  │
                                          ┌──────▼──────────────────▼──────┐
                                          │     src/ai/ (JS heuristic)     │
                                          │     getWeight() fallback       │
                                          └────────────────────────────────┘

                    ┌──────────────┐
                    │ export_onnx  │
                    │ (PyTorch→ONNX│
                    └──────┬───────┘
                           │
                  mafia_policy.onnx (17.4MB)
                           │
                    ┌──────▼───────────────────────┐
                    │  src/ai/neural.js (ONNX RT)  │
                    │  Hard AI: neural network      │
                    │  (GOOD_VS_EVIL only)          │
                    │  Fallback: heuristic AI       │
                    └──────────────────────────────┘
```
