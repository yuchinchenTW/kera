# 問題清單核對紀錄

核對日期：2026-09-07。基準 commit：`e5f1dd4`。環境：Windows、Node.js `v22.18.0`。

初次核對通過 34 個局部驗證；收到完整 #14、#15、#22～27 後增至 48 個。第一批修復已修改 `server.js`，範圍為 #1～5、#15；引擎與 AI 尚未修改。執行 `node tests/review_verification.mjs` 現通過 **52 項主檢查**，其中已包含 `tests/server_resolution.mjs` 的 13 個延遲結算/例外回歸情境，以及兩個頁面的完整靜態模組 import 檢查。

#1～5、#15 的探針已改成驗證修復後行為，其他探針仍用於確認尚未修正的行為與規則反例，不能把整套測試通過解讀成所有問題已修復。下方逐項核對表保留修復前證據及當時行號；目前修復狀態以「第一批修復」表為準。

「重現」指本次實際執行；「程式碼」指已追蹤相關呼叫與條件，但未做完整端到端重現。「部分成立」表示核心風險存在，但觸發條件、影響或規則解讀需要修正。

只對本機臨時子程序發送測試輸入，測試結束已關閉。沒有測試 Render 線上服務、實際耗盡記憶體、執行完整 250 場審計或做瀏覽器端到端測試。

## 第一批修復

| 編號 | 目前狀態 | 修復與驗證 |
| --- | --- | --- |
| 1 | 已修復，高 | 驗證 JSON 本體必須為物件且 type 為字串；name/text/theme/lastWords 若出現必須為字串。message listener 的整個 async 處理具有 rejection 邊界，預料外例外只回一般錯誤，不回傳堆疊。測試包含畸形 JSON、null/陣列/純量、全部文字訊息入口、錯誤後仍可加入，以及刻意觸發的非預期 TypeError。未新增會吞掉程序致命錯誤的全域 listener。 |
| 2 | 已修復，高 | 在任何提前拒絕連線之前先註冊 WebSocket error listener；發送前也檢查 OPEN。無效 UTF-8/RSV1 實測分別以 1007/1002 關閉該 socket，程序及下一位玩家連線正常。 |
| 3 | 已修復，高 | URL 解析與 percent decoding 錯誤回 400，HTTP handler 接住 serveStatic rejection。畸形 absolute URL 與壞 escape 實測不再終止程序，後續正常請求仍可服務。 |
| 4 | 已修復，中 | WebSocketServer maxPayload 設為 16 KiB，與原應用層上限一致。單一超限訊息與累計超限的 fragmented message 都以 1009 關閉；恰好 16 KiB 的有效 JSON 可正常處理，未做 OOM 壓測。 |
| 5 | 已修復，高 | 改成逐檔公開白名單，兩個 HTML、CSS 與前端模組仍可讀取。單獨保留 `/training/state_encoder.js`，因 neural.js 靜態 import 它，即使未啟用模型也需要載入；其餘 training 檔案、模型、server.js、.git、測試、稽核文件、套件檔與備份均拒絕。測試含編碼路徑、NUL/冒號/尾斜線、HEAD/query，以及經 HTTP 取得並連結兩個前端入口的完整靜態 import 圖。 |
| 15 | 已修復，中高 | 手動及 timer 共用 resolvePhase，在 await 前取得結算鎖並取消計時；timer 同時驗證實例、回合及階段。結算鎖綁定引擎實例，重開後舊成功/失敗不再清除新局狀態或釋放新局的鎖。實際合併 WebSocket frame 只結算一次；以原 server 原始碼及可控制的 timer/engine 替身測試 NIGHT/VOTE、手動/timer 競爭、延遲成功/失敗、取消後 callback、重開期間的旧結果。 |

結算錯誤的恢復方式也統一了：手動結算現在和原本 timer 路徑一樣，在失敗時向下一階段恢復並清除該階段提交，避免使用者重試已部分套用的回合；投票失敗只增加一天，既有 victory 則維持 END。這不是交易回滾，部分套用造成的局面損失仍不能還原。原本 timer 路徑即有這個限制。

## 第二批修復

範圍：#7～9、#11～14、#16、#17，修改 `server.js`、`src/engine.js`（人類提交去重）與 `src/multi.js`。`node tests/review_verification.mjs` 現通過 **54 項主檢查**；#7、#8、#9、#11、#12、#13、#14 的探針已改為驗證修復後行為，#31 的探針改為只驗證仍未修的 actorId 覆蓋部分。#6（觀戰隔離）與 #10（代理 IP）需產品/部署決定，未動。

| 編號 | 目前狀態 | 修復與驗證 |
| --- | --- | --- |
| 7 | 已修復，高 | 已入座的 socket 再送 join 回 "Already joined."，不新增座位；大廳中改為觀戰會釋放座位並觸發 host 遞補；觀戰者入座前先移除自己的舊連線紀錄，避免名字與自己碰撞。測試：同 socket join 三次只得 1 個 joined、2 個錯誤，斷線後大廳只剩 1 席。 |
| 8 | 已修復，高 | 遊戲中斷線時除了交給 AI，也從 `room.seats` 移除該席，restart/start 不再把離開的人重新設為人類。測試：guest 斷線後 restart+start，started.humans 為 1，座位 1 不再叫 Guest。 |
| 9 | 已修復，中 | 伺服器端：night_action、vote、公開聊天與三種陣營聊天在 `actor.isHuman === false` 時回 "AI controls your seat"。引擎端：resolveNight/resolveVote 對人類提交做 per-actor 去重（後送者勝），並在 `includeHuman !== true` 時忽略 AI 控制座位的提交。測試：AI 控制的殺手只留 1 票；同 actor 兩筆狙擊只執行最後一筆。 |
| 11 | 已修復，低 | `ensureHost` 要求 host 必須有座位；觀戰者加入時若無 host，只從有座位的連線挑選並送 host 事件；host 在大廳改為觀戰會失去 host 並遞補給其他入座者。測試：host 改觀戰後 start 被拒，另一入座者收到 host 事件。 |
| 12 | 已修復，低 | spectator_chat 需遊戲已開始，否則回 "Game not started."；`room.spectatorChat` 上限 200 行，超出移除最舊。 |
| 13 | 已修復（伺服器端），低 | night_action 的 targetId/extraTargets 與 vote 的 targetId 必須是 0～17 的整數，且在角色檢查之前驗證；nightActions 只保留 type/targetId/extraTargets/actorId。引擎對字串 target 仍為靜默丟棄（探針保留為現況說明）。 |
| 14 | 已修復，中 | 新增 `sanitizeText`（控制字元與換行轉空白、`||` 轉 `|`、截長度）與 `sanitizeName`（另移除半形/全形冒號），套用於 join 名字、公開/陣營/觀戰聊天、遺言與投票附帶遺言。測試：偽造名字與含換行/分隔符的訊息進入 publicLog 後不再能冒充說話者或分裂中英文內容。 |
| 16 | 已修復，中 | `connect()` 先卸除舊 socket 的 handler 再關閉，新 socket 的 onopen/onmessage/onclose 皆檢查自己仍是目前連線；斷線後的 UI 重置集中在 `resetConnectionUi`。未做瀏覽器端到端測試。 |
| 17 | 已修復，低 | 收到 lobby 訊息時呼叫 `clearGamePanel`：清空玩家列表、遺言、隊友、勝利與計時顯示，隱藏夜間/投票/聊天控制與各陣營聊天框，host 控制依 isHost 顯示。未做瀏覽器端到端測試。 |

`tests/server_resolution.mjs` 的「非預期例外被包住」情境原本靠畸形 targetId 觸發 TypeError，現在該輸入會被驗證擋下，改成從引擎 state 注入同步例外，仍驗證 "Unable to process message." 與後續訊息可用。

## 第三批修復

範圖：引擎規則 #19、#20、#23（殺手夜間部分）、#24、#27～#37，修改 `src/engine.js`、`src/state.js`、`src/rng.js`、`src/view.js`、`src/main.js`（夢魔情報顯示）與 `server.js`（主題驗證）。#18、#26 維持待裁定，#22 依規格結案；白天投票的最高票 fallback 依 README 保留。`node tests/review_verification.mjs` 仍為 **54 項**，對應探針已改為修復後斷言。同 seed 200 局 hard 模擬與 250 局行為審計結果與修復前完全一致（純 AI 對局中殺手/警察本就先協調共同目標），差異只出現在有人類參與且意見分歧的夜晚。

| 編號 | 目前狀態 | 修復與驗證 |
| --- | --- | --- |
| 19 | 已修復，高 | 牛仔命中與雙魂詛咒改以 `addKill(..., { timing: "delayed" })` 進入同一條保護管線，特務盾與天煞吸收生效；`delayedKills` 陣列移除。醫生依 `roles.js` 仍不可救這兩種死因（符合裁定）。測試：受保護目標存活且 `agentBlocks` 為 1；無保護時同一攻擊仍致死。 |
| 20 | 已修復，高 | 殺手擊殺歸因到一名行動中的殺手，縱火點燃歸因到縱火者，`grudgeState.triggerFaction` 因此可設為 RED。`GRUDGE_PUNISH` 依原設計仍不觸發。測試：殺手殺怨獸與縱火燒死怨獸都得到 triggerFaction=RED。 |
| 23（夜間） | 已修復，中 | 殺手票未達行動中殺手過半即無效，移除最高票與最小 id 平票邏輯。白天投票未動。測試：4 殺手 1:1 分票無人死亡並記錄 "Killers failed to agree"；3:1 仍成功。 |
| 24 | 已修復，中 | 移除殺手四段機率 fallback 與警察兩段 fallback；無共識即無行動，並寫入既有的 "failed to agree" / "could not agree" 訊息。測試：無票殺手在任何 rng 下都不殺人；警察分票不產生調查結果，合票仍正常。 |
| 27 | 已修復，中 | `view.js` 將 `privateLogs.nightmare` 交給夢魔視角；單人 `main.js` 的情報框同步顯示。測試：夢魔 view 含結果、目標角色仍 HIDDEN、其他玩家 view 不含。 |
| 28 | 已修復，中 | 移除人類驅魔師目標不足時的隨機補打；只打所選目標並受 maxChains 上限。測試：只選 1 人時鎖鏈用量 1、失誤 0、死亡 1。 |
| 29 | 已修復，低 | 新增 `kidnapTargetTonight`，於 `startNight` 轉成 `lastKidnapTarget`，只禁止連續兩晚同一目標。測試：A,B,A 允許；A,A 拒絕；A,休息,A 允許。 |
| 30 | 已修復，低 | Stage 2 先處理 `AGENT_PROTECT`/`FIEND_PROTECT` 再處理其他行動，解煙不再依提交順序。副作用：同夜的藤種、汽油標記會被已存在的護盾擋下，行為一致化；#26 探針的同夜情境改用警察調查觸發。 |
| 31 | 已修復，低 | 物件形式的 humanActions 以 map key 為 actorId，忽略 payload 的 actorId。測試：key 0（平民）帶 actorId=1 的狙擊被丟棄；key 1 帶 actorId=99 正常執行。 |
| 32 | 已修復，中 | 玩家 view 移除 `winrateHint`，`usage` 只回傳自己角色的計數器（醫生/狙擊/防暴/縱火/特務/牛仔）；觀戰 view 兩者皆不提供。單人 `main.js` 直接讀 engine.state，不受影響；`multi.js` 未使用這兩個欄位。 |
| 33 | 已修復，低 | 立即轉化殭屍的公開訊息改為 "Someone was overwhelmed..."，與隔夜轉化一致。 |
| 34 | 已修復，低 | `s = (s + C) | 0` 維持 int32；前 4,917,758 次結果與舊實作完全相同，600 萬次與參考實作零分歧。 |
| 35 | 已修復，低 | `normalizeSeed`：有限數字 `>>> 0`；純數字字串等同數字；其他字串以 FNV-1a 雜湊；null/BigInt 等拋 TypeError。 |
| 36 | 已修復，低 | rng 提供 `getState()`，`createRng(seed, resumeState)` 可從指定位置續跑，`cloneState` 據此重建 rng。測試：clone 與原本下一個亂數相同。 |
| 37 | 已修復，低 | `createInitialState` 先解析主題再取角色池，`state.theme` 記錄實際使用的 id；伺服器 `start` 對未知 theme 回 "Unknown theme." 而非靜默回退。 |

## 第四批修復

範圍：AI 作弊 #38～#44，修改 `src/ai/analysis.js`、`utils.js`、`night.js`、`targeting.js`、`vote.js`、`chat.js` 與 `src/state.js`。`node tests/review_verification.mjs` 增至 **58 項**。同 seed 200 局 hard 模擬：BLUE 勝率由 18.0% 變為 21.5%，平均天數 5.8 → 5.7；250 局行為審計的殺手友射率 26.3% → 25.9%，議題數不變。差異方向與「紅方不再偷看資訊」一致。

共用工具：`analysis.js` 新增 `publicRedIds`（所有曾被公開宣稱的紅方，含真警察揭露與殺手假冒）、`recordPublicRedClaim`（三個設定 `policePublicRevealedRed` 的地方統一經此記錄到 `state.policePublicRedIds`）、`canSeeFaction`（與 `view.js` 同規則）、`estimateFactionCounts`（以信念估算人數）；`utils.js` 新增 `publicChatMemory`。

| 編號 | 目前狀態 | 修復與驗證 |
| --- | --- | --- |
| 38 | 已修復，高 | 縱火者、藤魔、夢魔、死靈四處 `t.role === KILLER` 改為排除 `publicPoliceConfirmed` 中的公開紅方。測試：信念認為殺手是警察時，縱火者會標記該殺手。 |
| 39 | 已修復，高 | `publicPoliceConfirmed` 對非警察只回傳 `publicRedIds`；`vote.js` 內兩處直接讀 `state.policeConfirmed` 的 hard 邏輯同步改用公開集合。測試：私查 id 2 不再出現在平民視角。 |
| 40 | 已修復，高 | `vote.js` 非警察藍方與紅方賣隊友、`chat.js` 跟隨揭露改讀 `policePublicRevealedRed`。另移除 `canUseVoteTarget` 中「非警察不得投私查紅方」的限制（同樣依賴私有情報）。測試：公開指控 Player 4、私查 Player 1 時，藍方投 Player 4。 |
| 41 | 已修復，高 | 紅方跟票避開隊友改為 `canSeeFaction(actor, target) && target.faction === RED`，只有殺手互認、怨獸互認與死者可見。測試：helper 行為與 view 規則一致。 |
| 42 | 已修復，中 | 防暴警察 `bluePressure` 改用 `estimateFactionCounts`；`night.js` 不再 import `factionCounts`。測試：無信念時估算為 17×0.3 紅、17×0.7+1 藍。 |
| 43 | 已修復，中 | `night.js` 4 處、`targeting.js` 4 處、`vote.js` 2 處遍歷他人 `chatMemory` 改為 `publicChatMemory(p)`，過濾 `source: "faction"`；本人讀自己記憶的路徑（含 `applyDeductionChains`）不變。測試：人類殺手私聊產生 faction entry 後，公開讀取不含該筆。 |
| 44 | 已修復（程式碼核對），低 | 殭屍投票候選不再排除其他殭屍；未另寫行為測試，因候選集合差異受嫌疑值影響不易穩定斷言。 |

## 第五批修復

範圍：AI 行為 #45～#52，修改 `src/ai/utils.js`、`targeting.js`、`night.js`、`memory.js`、`analysis.js`、`vote.js`、`chat.js`、`index.js`、`src/engine.js` 與 `tests/behavior_audit.js`。`node tests/review_verification.mjs` 增至 **61 項**。同 seed 200 局 hard：BLUE 22.5%（上一批 21.5%），平均天數 5.7；normal 23.0%；OTHER_DIMENSION normal 32.0%。行為審計「聊天—投票一致性」由 5.6% 升到 25.6%，因為名字比對不再把 Player 10～18 誤判為 Player 1。

| 編號 | 目前狀態 | 修復與驗證 |
| --- | --- | --- |
| 45 | 已修復，中 | 新增 `pickTargetByBlueLikelihood`（取嫌疑最低者）。簡單/普通難度的狙擊手、縱火者、藤魔、夢魔、死靈改用它；綁匪評分改為 `(1-redProb)+(1-suspicion)`。困難分支未動。測試：信念認為 1 號是殺手、2 號是警察時，普通狙擊手射 2 號。 |
| 46 | 已修復，中 | 怨獸遺言在沒有目標時只從不需要目標名的模板中抽選。測試：四個 rng 值都不出現 undefined。 |
| 47 | 已修復，中 | 以 `aiMemory.chatParsed` 記錄已解析到的 dayChat 與陣營聊天索引，只解析新行；不再用「今天已有 entry」判斷。同時修掉陣營聊天每次呼叫都重複寫入的問題。測試：夜間私聊後再加入的白天公開聊天會被解析；重複呼叫不增加 entry。 |
| 48 | 已修復，中 | `ensureBeliefs` 以可觀察證據指紋（天數、階段、聊天長度、投票輪數、死亡、救援、公開揭露、宣稱、陣營聊天長度、個別調查結果數、角色）判斷是否重算；指紋相同直接跳過。測試：連續兩次呼叫 roleProbs 相同，新增投票紀錄後才改變。 |
| 49 | 已修復，低 | `pickHumanTarget` 只接受目標存活的人類提交。測試：人類殺手投死人時 AI 殺手另選活人。 |
| 50 | 已修復，低 | 殺手夜間簡報先決定是否改打跳警者，再組合描述用的 top/alt，首夜「Target X tonight」與實際目標一致。測試：roleClaims 有 5 號跳警時，簡報寫 Player 6 且 `_killerChatTarget` 為 5。 |
| 51 | 已修復，低 | `policePubliclyRevealed` 改為「公開揭露對象仍存活」，不再要求當天聊天再次提到；`policePublicRevealedRed` 本來就只在公開宣稱時設定。測試：第 3 天無人提及時，普通藍方仍投公開紅方。 |
| 52 | 已修復，中 | 新增 `mentionedPlayerIds`（長名優先、不重疊比對），套用於 memory、analysis、vote、chat、night、engine 與 behavior_audit 共 11 處；每行只計算一次以避免 O(n³)。測試：「Player 10 is suspicious」不再算成提及 Player 1。 |

## 規則裁定

- #18 維持待裁定的平衡問題；#21、#25 為誤報，#22 依既定勝利優先序結案。
- #23 白天採 README 的「多數票處決，無多數則最高票」。平票固定選最小 id 是已確認行為，若要換成其他平票規則需另訂。
- #23 殺手部分與 #24 夜間採 request.md:160、168、348 的「未達角色成員多數則行動無效」。理由是夜間殺手/警察使用獨立的共同決策規則，白天的最高票 fallback 不應自動套用到夜間。殺手少數票/隨機 fallback 及警察無共識仍調查列入後續引擎修復；本批未修改它們，README 的夜間描述亦待同批同步更新。
- #26 種子持續時間仍待裁定；#10 維持代理拓樸有條件成立；onnxruntime-node 保留現狀。

## 伺服器與連線

| 編號 | 判定與方法 | 證據與修正 |
| --- | --- | --- |
| 1 | 部分成立；重現，高 | `server.js:542,568,575,584,605,944`。只有 JSON.parse 的局部 catch；async message listener 的其餘例外無人接住。JSON `null`、`join.name=42`、`spectator_chat.text={}` 均使 Node exit 1。**`{"type":null}` 不會 crash**，實測回 Unknown message type。其他 name/text 呼叫也缺型別驗證，但各有角色或階段前置條件；`0/false/null` 常被邏輯 OR 改為預設值，不是所有非字串都會 crash。不必用全域 unhandledRejection listener 才能修復，重點是輸入驗證及局部錯誤處理。 |
| 2 | 成立；重現，高 | `server.js:528,542,1023` 沒有 socket error listener。無效 UTF-8 與未協商擴充的 RSV1 frame 都觸發 unhandled error event，Node exit 1。底層 TCP socket 的 error listener 不能代替 WebSocket 物件上的 listener。 |
| 3 | 成立；重現，高 | `server.js:303,322`。畸形 absolute request target `http://[` 令 new URL 拋錯，位置在 try 外，serveStatic 回傳的 rejection 未處理；實測 Node exit 1。 |
| 4 | 成立；套件設定重現，中 | `server.js:325,555`；已安裝 `node_modules/ws/lib/websocket-server.js:65` 預設 maxPayload=104857600。16 KiB 檢查在 message 事件才執行，無法限制前面的接收緩衝。沒有進行 OOM 壓測，因此不主張固定幾個 frame 必然耗盡所有部署環境的記憶體。 |
| 5 | 成立；重現，高 | `server.js:303` 起只限制 repo 路徑，沒有公開資源白名單。`/.git/config`、`/server.js`、`/training/eval_weights.js`、`/tests/behavior_audit.js`、`/request.md`、`/README.md.bak` 均實測 HTTP 200。是已知檔案路徑可下載，不代表有目錄列表功能。 |
| 6 | 成立；程式碼，低 | `server.js:576` 的 spectator join 無身份綁定；`src/view.js:110` 的觀戰 view 帶 spectatorChat。活人可用另一條連線取得死者頻道。這屬觀戰隔離缺口，是否容許開放觀戰讀此頻道需作產品決定。 |
| 7 | 成立；重現，高 | 原文開頭缺漏，本項按「同一 socket 重複 join」解讀。`server.js:600,607,608,1023` 每次 push seat，Map 卻只保留最後一筆；實测同 socket 加入 3 次，關閉後仍殘留 2 席。保留另一名 host 時，restart(false) 也不清除它們。需遵守限流間隔，不能理解成一次無間隔送 18 筆一定全部成功；最後一名 host 離開觸發整房 reset 時也可能清掉。 |
| 8 | 成立；重現，高 | `server.js:1027,132,141,451`。遊戲中斷線僅設 AI，seat 殘留。保留 host、斷開 guest，再 restart/start，實測只有 1 名連線玩家卻宣告 2 humans，guest 名字也恢復成人類座位。自動重開走同一 startGame，具有同樣缺陷；本次沒有等待 25 秒自動重開。最後 host 離開可觸發 reset，故不是每種斷線情境都殘留。 |
| 9 | 成立；程式碼及引擎重現，中 | `server.js:468,635,807` 未撤銷 AI 接管者的操作資格。`src/engine.js:1032,1051` 對人類提交與 AI 票分別累加，實測同 actor 出現兩票。夜間也分別加入 AI/humanActions，部分角色有資源限制，但沒有統一 per-actor 去重。 |
| 10 | 條件成立；程式碼，中 | `server.js:529,544` 以 TCP remoteAddress 計罰，10 次違規、5 分鐘封鎖設定確實存在。若多名玩家共用代理出口或 NAT 位址，會互相連坐；**無法由 repo 證明 Render 當前所有玩家恰好都是同一位址**。需要實際部署的代理拓樸/紀錄確認影響範圍。 |
| 11 | 部分成立；程式碼及另一條路徑重現，低 | `server.js:587` 的 host 候選未過濾 spectator，亦不另送 host 事件；但 `:591` 的 joined 本身含 host 布林，所以不能說該觀戰者一定完全收不到身份通知。該 host-vacancy 分支在一般流程是否可達未獨立重現。另已實測：原 host 同 socket 重新 join 成 spectator 後仍保有 host 且能 start，因 `ensureHost` 只比較 socket。 |
| 12 | 成立；程式碼，低 | `server.js:943` 在沒有 started 的情況仍允許 spectator 訊息 push 至 room.spectatorChat；沒有長度上限。引擎尚不存在時 broadcastViews 直接 return，所以没有聊天回饋。開始遊戲會清空，並非永遠跨局累積。 |
| 13 | 成立；程式碼及引擎重現，低 | `server.js:671,694,696` 用陣列索引驗證，允許數字字串，但不轉型。夜間 ack targetName=null，前端顯示 abstain；`src/state.js:145` 嚴格比對使狙擊等行動被丟棄。實測字串目標不扣子彈、不殺人。殺手/警察的群體票在後續 Object.entries/Number 路徑可能重新轉型，不能說所有夜間行動一定丟棄。白天 vote 也有型別不一致風險。 |
| 14 | 成立；伺服器重現及前端程式碼，中 | `server.js:51,912` 只截長度，保留名字裡的冒號、內部換行及雙豎線。實測已有 Alice (1) 時，另一人取名 Alice (1): trust me，可產生以 `Alice (1): trust me (1):` 開頭的聊天；含換行、假 [INTEL] 和語言分隔符的內容也原樣進入其他連線的 publicLog。`src/multi.js:747` 將公開訊息與帶 [INTEL] 的私有情報合併至同一文字區，換行可造成視覺上的系統訊息冒充。`:280` 的雙豎線分割讓中文端能只顯示攻擊者指定的右半段，連原作者前綴都可消失；`:749` 的英文公開日誌實際保留整個原字串，而非一定只顯示左半段，即時 chat 事件也先顯示原字串。此為訊息來源/顯示偽造，不會真的修改死亡或角色狀態，也不是由這條文字呈現路徑直接推得 XSS。未做瀏覽器端到端測試。 |
| 15 | 核心缺陷成立，影響較原述更直接；重現，中 | `server.js:787,789,856,859` 在 await 後才停 timer，且沒有結算中鎖；timer callback `:174,194,242` 沒有 phase/回合版本再檢查。原先「目前沒有真正 await 所以安全」不成立：`src/engine.js:135,1051` 已會 await async AI 函式，即使其內沒有 I/O，仍會暫停續行。已安裝 ws 的 `receiver.js:595` 預設可同步連續 emit message。實測 host 在一次 socket write 合併兩個合法 resolve_night frame，兩者都在 phase 改變前通過檢查，收到 **兩次 phase 結算結果**，沒有錯誤回覆。這次直接重現的是重複訊息造成的夜間重入；timer 與長時間非同步工作的競態、白天重複結算另由程式碼確認缺少防護，未各自做時間競態重現。不應只把 clearTimer 提前當成完整修復，因它不會阻止第二個結算訊息。 |
| 16 | 成立；程式碼，中 | `src/multi.js:434,454,479` 舊 socket 的 callback 沒有驗證是否仍為當前連線，可在新 joined/view 後清除共用狀態。是否出現取決於事件順序，並非每次重連都發生。onopen 也引用可被替換的全域 ws。 |
| 17 | 成立；程式碼，低 | `src/multi.js:548` 只更新 lobby 與少數標籤，不清除上一局玩家、私聊及操作面板；`renderLobby` 也沒有處理這些內容。此外 `renderView:669` 遇 null 直接 return，僅補呼叫 renderView 並不足以清空舊 UI。 |

## 遊戲引擎

| 編號 | 判定與方法 | 證據與修正 |
| --- | --- | --- |
| 18 | 行為成立；重現，規則待定 | `src/engine.js:358` 沒有自保限制，實測特務自保可擋狙擊。`src/main.js:775` 的預設目標清單也容許自己。不過 README/request 對 Agent 沒有明文禁止自保，FIEND 的禁止自保不能直接推成 Agent 規則。**不能說只剩炸彈、縱火、殭屍能殺**：投票、延遲牛仔/雙魂詛咒、四魂攻擊等也能突破。應列為已確認行為及待裁定的平衡問題。 |
| 19 | 部分成立；重現，高 | `src/engine.js:406,509,712,914`。牛仔命中及雙魂詛咒直接進 delayedKills，實測都殺死受特務保護者；牛仔走火的目標攻擊則走一般 pendingKills，防護路徑不一致。**醫生救援部分不是這個缺陷的證據**：`src/roles.js:17` 可救援清單沒有 COWBOY_SHOT，`:26` 明確禁止 NECROMANCER_CURSE，即使送進醫生過濾也不會救回。 |
| 20 | 部分成立；重現及程式碼，高 | `src/engine.js:590,695,942`，杀手/縱火擊殺沒有歸因，實測殺手殺怨獸後 berserk=true、triggerFaction=null。**不是所有怨獸共贏分支永遠不可達**：狙擊、夢魔等紅方攻擊有 killerId，仍可設 RED。且 `:1193` 的存活怨獸優先勝利會先攔下部分情況；`:1232` 沒要求怨獸仍活著。GRUDGE_PUNISH 在 `:937` 明確被排除觸發，不能當作相同遺漏。 |
| 21 | 不成立為既定規則 bug；反例重現 | 實測 2 殺手+1 狙擊對 1 警+1 民不判 RED，符合 `request.md:47`：人數條件是 **Killers >= surviving Blue 且只剩 Police/Killer/Civilian**。因此把紅方特殊角色也算 hasOtherSpecials 是目前文件要求，不能直接改成所有 RED 過半就贏。 |
| 22 | 依規格結案；重現 | `src/engine.js:1212` 的 RED 判定早於 BLUE，符合 `request.md:330`，使用者亦已確認。實測全場皆存活平民、警察/殺手/紅方皆為零時，結果仍是 RED。此結論排除綠方優先勝利條件；不是待修 bug。 |
| 23 | 行為成立；重現，規格衝突待裁定 | `src/engine.js:1082` 先看絕對多數，再在 `:1084` 採最高票 fallback。實測 18 人僅 2 票也處決；兩人各 1 票時不論提交順序，都處決較小 id。0 票才走無多數、無處決；10/18 票仍走 majority 公告，所以 **needed 並非完全沒用**，只是未成為是否處決的必要門檻。殺手也實測 4 人中只有 2 人分投不同目標，仍殺較小 id 者。`request.md:30,168` 要求多數，但 `README.md:20,261` 明列白天及殺手採 majority/plurality，文件互有差異。因此應分開記錄「與 request 不符但 README 已描述的 fallback」及「平票固定偏向小 id」，不能直接把所有 plurality 都當成無意誤寫。 |
| 24 | 部分成立；重現，中 | `src/engine.js:563,638` 的 fallback 取候選陣列第一人。實測殺手全棄權且 rng=0.1 時殺 Player 1；該席已死則改殺 Player 2。三名警察中兩人分投 Player 6/7，卻查了無人投票的 Player 1。偏差是**候選陣列順序**，不固定鎖 1、2 號；一般初始化按 id 排列，所以小 id 優先。殺手 rng=0.9 時不啟動 fallback，並非無票一定殺人；已有任一有效殺手票時先走 #23 的最高票分支。`:687` 不是所有引擎狀態都不可達：只剩警察並直接呼叫 resolveNight，實測可印 Police could not agree；但正常遊戲此時早應結束，故在仍有非警察存活的正常對局中，確實會被 fallback 遮蔽。警察無共識仍調查也違反 `request.md:160`。 |
| 25 | 原述不成立；反例重現 | `src/engine.js:1055` 雖沒有再次排除復活小鬼，**上游 `src/ai/vote.js:69` 已在 aiVoters 過濾 bratRevived**，後續一般與兜底票均從這份候選產生。easy/normal/hard/nightmare × includeHuman=false/true 共 8 組，直接呼叫 buildAiVoteActions 及完整 resolveVote 均沒有該席投票。因此目前不是「AI 復活小鬼仍投票」bug；只能視為未來更換產票來源時可加強的引擎邊界驗證。 |
| 26 | 行為成立；重現，持續時間規則待定 | `src/engine.js:256` 每晚重建 vineSeeds，`:471` 持久寫入的 vineSeededBy 無任何既有讀取者；`:531,852` 兩種交換皆只使用當晚的 Map。實測同晚播種後狙擊藤魔會換命，隔晚才狙擊則藤魔死、種子目標活；同晚/隔晚特務保護種子目標，也分別觸發/不觸發藍方行動交換。隔晚 vineSeededBy 仍保留，顯示其欄位與實際作用脫節。不过 `README.md:272` 對藍方觸發明寫 that night，而 `request.md:269` 沒明確寫有效期限，並寫成功發芽後才失去能力。故可確認「隔夜種子不生效」，若期望持續到發芽則是缺陷；僅凭目前文件不能把所有當晚有效行為都判成違規。 |
| 27 | 成立；重現及前端程式碼，中 | `src/engine.js:480` 將查到的角色記入 privateLogs.nightmare；實測人類夢魔查狙擊，完整 state 有 `Player 1 learned Player 2 is SNIPER.`，其 player view 卻沒有這條情報，目標角色仍 HIDDEN。`src/view.js:45` 只收警察/殺手/怨兽頻道；單人 `src/main.js:517` 同樣只收三者，多人 `src/multi.js:747` 依賴 view.privateIntel。兩個正式 UI 都無法顯示這筆夢魔情報；不是引擎根本沒產生結果，也不排除單人使用開發工具讀取完整 state。 |
| 28 | 成立；重現，中 | `src/engine.js:231` 主動補足人類驅魔師目標，實測只選 1 人卻使用超過 1 次鎖鏈；補打非紅方會進 `:493` 累加失誤。文件寫 up to maxChain，與強制填滿不符。 |
| 29 | 部分成立；重現，低 | `src/engine.js:311,313` 只記上一個成功綁架目標。**A→B→A 完全可行**，不是曾綁過就永遠不能綁。真正缺陷是 A→休息一晚→A 仍被拒絕，因沒有按夜晚重置或記錄日期。重現兩種序列；非法重複會靜默 break。 |
| 30 | 成立；重現，低 | `src/engine.js:328,360,373`。先清煙再執行被保護者行動可成功；反過來該行動先被 actorBlocked 丟棄，後清煙不會重跑。實測相同煙霧/特務/狙擊組合，僅調換保護與射擊順序便改變結果。原文的「怨靈」此處應是 **天煞 HEAVENLY_FIEND**。 |
| 31 | 成立；重現，低/引擎契約 | `src/engine.js:161,166,331,351` 信任 entry.actorId 且缺去重。實測 map key=0 的 payload 可令 actor 1 狙擊，另加 actor 1 的一筆則同夜射兩次。伺服器 `:694` 覆寫 actorId，故不是由此直接推得連線端可冒充別人；AFK 重複提交另見 #9。 |
| 32 | 部分成立；重現，中 | `src/view.js:77` 暴露全域 usage 和精確 winrateHint；`src/engine.js:54` 由真實 factionCounts 計算，確實洩漏隱藏陣營組成及轉化線索。doctorInjections 的增加洩漏醫生行動，但**不增加不等於醫生死亡**，也可能停手、被控制或用盡針；死亡本來就會公開角色。 |
| 33 | 成立；重現，低 | `src/engine.js:923` 立即轉化公開名字，實測玩家 view 的角色仍 HIDDEN，publicLog 已點名變殭屍。一般隔夜單咬轉化 `:90` 只寫 Someone，兩條路徑揭露程度不一致。 |
| 34 | 成立；重現，低 | `src/rng.js:5` 不截斷累加值。seed=0 與每步截為 32 位的參考實作比對，首次不同在第 **4,917,759** 次呼叫；仍然可重現，屬長序列精度問題。 |
| 35 | 部分成立；重現，低/輸入契約 | `src/rng.js:3` 不驗證 seed。`"abc"` 等不可轉為數字的值會映射 0，但 **`"123"` 與數字 123 相同，不是所有非 number 都变 0**；BigInt/Symbol 甚至會拋錯。是否支援字串 seed 需明確定義。 |
| 36 | 成立；重現，低/未使用 | `src/state.js:136` JSON clone 會刪掉函式 rng，實測 clone.rng=undefined。除新增驗證脚本外未找到既有呼叫，不是目前正常遊戲流程的已知故障。 |
| 37 | 成立；重現，中或低 | `src/state.js:62,88` 與 `src/roles.js` 的 roleListFromTheme：未知 id 使用 GOOD_VS_EVIL 角色池，state.theme 卻保留未知值。伺服器 `:624` 接受該輸入，使 `src/engine.js:1189` 的主題條件可失效。正常 UI 選項不會送未知值，主要是外部輸入驗證問題。 |

## AI、前端與工具鏈

| 編號 | 判定與方法 | 證據與修正 |
| --- | --- | --- |
| 38 | 成立；程式碼，高 | `src/ai/night.js:978,1013,1041,1272` 四種紅方特殊角色以真實 t.role 排除 KILLER。`src/view.js:9,22` 僅殺手互認，這些角色沒有同等資訊。主要是 hard+ 分支；部分 fallback 另選候選人，不代表所有分支都避免友軍。原文 view.js:257 行號不適用目前檔案。 |
| 39 | 成立；重現，高 | `src/ai/analysis.js:56` 只要 public id 非 null，就把完整 policeConfirmed 交給非警察。實測公開 id=1，仍可讀取未公開 id=2。多處 targeting/night/vote 使用這份資料；公開 id 被清掉時才關閉門檻，並非一次公開後永久開放。 |
| 40 | 成立；重現及程式碼，高 | `src/ai/vote.js:330,396` 混用 private/public id。構造公開指控 Player 4、私查紅方 Player 1，實測普通藍方 AI 投向私有的 Player 1。`src/ai/chat.js:449` 也在已公開部分情報後用最新私查目標接話，可能洩漏另一筆結果；假警察場景的直接重現是投票路徑。 |
| 41 | 成立；程式碼，高 | `src/ai/vote.js:671` 紅方跟票第二階段用真實 conTarget.faction 排除紅方，涵蓋沒有紅方互認權限的特殊角色。即使是殺手，也不應因此知道所有紅方特殊角色。 |
| 42 | 成立；程式碼，中 | `src/ai/night.js:906` 防暴警察使用實際 factionCounts 判定 bluePressure，行為會受未公開轉化影響。現有 view 本身也洩漏比例，修 #32 時需一併移除 AI 的這條資訊來源。 |
| 43 | 成立；程式碼，中 | `src/ai/memory.js:85` 將人類隊友私聊存為 source=faction；`src/ai/targeting.js:432,461,610,720` 及 night/vote 遍歷別人的 chatMemory，沒有排除此來源。需私聊被解析且相關選擇分支執行才影響結果；不是每次所有藍方都拿到原始私聊文字。 |
| 44 | 成立；程式碼，低 | `src/ai/vote.js:295` hard+ 殭屍直接避開全部真實殭屍，`src/view.js:5` 卻沒有同種互見權限；連未公開轉化者也能避開。 |
| 45 | 成立；程式碼，中 | `src/ai/targeting.js:8` 最大化紅方嫌疑；`src/ai/night.js:479,808,1000,1028,1058,1287` 的 easy/normal 紅方攻擊使用這個方向，綁匪更直接最大化 redProb+suspicion。是評分目標相反，不代表在估計錯誤時也必然打到真紅方。 |
| 46 | 成立；重現，中 | `src/ai/chat.js:1479` 少傳第二參數，`src/ai/templates.js:436` 模板是 `(name,t)`；實測 hard 怨獸遺言出現 undefined。不是 player.name 本身傳錯，而是抽到需要 t 的模板時漏傳目標。 |
| 47 | 成立；重現，中 | `src/ai/memory.js:46` 以「今天有任何 entry」判定全部聊天已解析。實測夜間 killerChat 先生成 faction entry，後加白天公開聊天就不再解析。即使私聊未進 dayChat，獨立 factionChat 解析仍可導致問題；同日新加公開訊息也一樣漏掉。 |
| 48 | 成立；重現，中 | `src/ai/memory.js:149,156` 每次混回先驗並再次套用舊證據，沒有事件/版本去重；實測沒有新事件連續呼叫兩次仍改變 roleProbs。`src/ai/targeting.js:703` 是額外入口，但只有實際呼叫 pickSniperSmartTarget 才多更新，**不是只要狙擊活著每晚必定兩次**。也不能保證每次機率都單調變尖，因同時有先驗衰減。 |
| 49 | 部分成立；重現，低 | `src/ai/night.js:33,44` 接受已死的 human target，實測 AI 仍生成對死人的殺手票。server 接收時驗 alive，因此主要是引擎直接輸入/失效狀態的問題；`src/engine.js:563` 等另有 fallback，**不一定真的浪費整晚**，但生成的票確實無效。 |
| 50 | 成立；程式碼，低 | `src/ai/chat.js:773` 先固定 top，再於 `:792` 覆寫 actualTarget/_killerChatTarget；首夜 `:805` 仍說 top.p.name。需要有已宣稱警察且不同於原挑選目標才會不一致。 |
| 51 | 成立；程式碼，低 | `src/ai/vote.js:34` 要求當天聊天再次提到 public id 才啟用跟隨分支，忽略前一天已公開的持續知識。hard+ 有再次公開的補救分支，easy/normal 缺少它；不代表普通 AI 絕不會因別的評分再投同一人。 |
| 52 | 成立；重現及程式碼，中 | `src/ai/memory.js:59`、`analysis.js:78`、`vote.js:23`、`chat.js:647,704`、`night.js:845,854,1112`、`src/engine.js:1003`、原審計的 includes 都有前綴碰撞。實測只提 Player 10，analysis 也把 Player 1 記為被提及。`vote.js:738` 的局部排序無法修復其他入口；自訂名稱也可碰撞。 |
| 53 | 成立；程式碼，中 | `src/main.js:767` 以真實 faction 排除全部 RED，玩家可從目標下拉缺席推知隱藏紅方。原文「排除 faction !== RED」容易誤讀；實際是 **只保留非 RED，排除 RED**。 |
| 54 | 成立；程式碼，中 | `src/main.js:877` locale change 呼叫 resetGame，`:212` 重新建立引擎，必定丟掉進度。已有 applyLocaleText/render，切語言不需重建遊戲。 |
| 55 | 成立；程式碼，低/功能缺口 | `index.html:30` 只有 seedDisplay；`src/main.js:212` 只用 Date.now，沒有 seed 輸入。另即使補輸入框，要完全重現仍需相同主題、難度、操作及 RNG 呼叫順序，seed 本身不等於整局回放。 |
| 56 | 部分成立；程式碼，中 | `package.json` 無 test script；`tests/behavior_audit.js:339` 列出 issues 後不設失敗狀態；`tests/simulate.js:655` 吞 worker error 並回部分統計。**不是字面上永遠 exit 0**：未捕捉例外可非零，simulate 的神經模型載入失敗 `:745` 也 exit 1。缺陷應寫成「審計發現問題/worker crash 不可靠地使測試失敗」。 |
| 57 | 成立；程式碼及建構行為核對，中 | `tests/behavior_audit.js:60,71,150` 未設 allAi/includeHuman，`src/state.js:71` 預設指定一名人類，該座位沒有正常 AI 行動。`resolveNight({})` 只是加入無 type 的無效行動。不是每個人類座位都必有夜技，但每場都缺該席的 AI 投票與行為。simulate.js 本身已設 allAi/includeHuman，不要一起誤改。 |
| 58 | 部分成立；Git/程式碼核對，中 | git ls-files 確認 tracked node_modules/ws、node_modules/.package-lock.json、README.md.bak、src/engine.js.bak；.gitignore 缺 node_modules。tracked checkpoint 為 76,696,057 bytes，約 76.7 MB/73.1 MiB，且位於現有忽略規則之下；**僅憑此不能證明歷史上曾用 git add -f**。prestart 每次跑 npm install 成立，但是否每次修改 lock 取決於安裝差異，不能說必改。onnxruntime-node 在 dependencies/lock 且本機未裝，然而 `src/ai/neural.js:19` 與 `tests/simulate.js:741` 的 --neural 功能確實使用，不宜當成死依賴直接移除。`training/eval_weights.js:124,131` 兩項 fitness 都由 avgDay 得出，totalDeaths 未使用，這兩点成立。未測遠端 GitHub push 的警告。 |

## 後續處理順序

1. 第一批 #1～5、#15 已完成；接著處理 #7～9 的 socket/seat/控制權一致性，以及 #10 的代理識別策略。
2. 統一公開/私有資訊的入口，修 #32、#38～44、#53，避免只修 view 卻仍由 AI 或選項洩漏。
3. 修行動結算與 UI/記憶缺陷；#23/#24 夜間按上方多數制裁定列入後續修復，#18/#26 保留待裁定。#21/#22 依規格結案，#25 為上游已有防護的誤報。
4. 隨後續修復將其餘局部重現轉成正確行為的回歸測試，補上會失敗的審計狀態；清理版本庫與依賴需保留實際使用的神經模型測試功能。
