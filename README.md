## Disclaimer
This project is an original, non-commercial technical prototype for learning and experimentation.
It does not use or include any assets, code, data, or materials from any existing commercial games.
Any similarities are purely coincidental.

# Night / Day 18
Single-player social deduction: 1 human + 17 AI, multiple themes/roles, deterministic night/day loop.

## Quick Play (single-player)
1) Serve files locally (avoid `file://`):
```bash
python -m http.server 8000
```
2) Open `http://localhost:8000/` and click **New Game**.

## Multiplayer (experimental)
- Centralized WebSocket server; humans connect,空位由 **hard** AI 補滿。
- Host 準備：
  1) 開裁判伺服器：  
     ```bash
     npm install
     npm run start   # 預設 ws://<host>:3001
     ```
  2) 開靜態檔案（供所有玩家開網頁）：  
     ```bash
     python -m http.server 8000
     ```  
     玩家用瀏覽器開 `http://<host>:8000/multiplayer.html`。
- 玩家加入：
  1) 在頁面輸入 WS URL（例如 `ws://<host>:3001`）與名字。  
  2) 按 Join。第一個加入者自動成為 Host。  
  3) Host 選擇 Theme，按 Start 開局。  
  4) 夜晚送夜行動；白天聊天；投票階段送投票/遺言。倒數結束會自動結算（Host 也可手動 Resolve）。  
  5) 遊戲結束後可由 Host 按 Restart，再按 Start 重開。
- 備註：請確保 3001 (WS) 與 8000 (靜態頁) 允許 LAN/FW 通行；最多 18 人，座位鎖定後缺席者自動補 AI。
- 若要手動測試協議（無 UI）：JSON over ws
  - `{"type":"join","name":"Alice"}`
  - Host: `{"type":"start","theme":"GOOD_VS_EVIL"}`
  - 夜行動：`{"type":"night_action","action":{"type":"POLICE_INVESTIGATE","targetId":3}}`
  - 投票：`{"type":"vote","targetId":5,"lastWords":"gg"}`
  - Host 結算：`{"type":"resolve_night"}` / `{"type":"resolve_vote"}`
  - 白天聊天：`{"type":"chat","text":"hi"}` (DAY)

## Gameplay Highlights
- 18 players fixed: 1 human + 17 AI.
- Themes: presets like Good vs Evil, etc. (select and restart).
- Night: police/killers/doctor/sniper/agent/smoke/bomb/fire, etc.; factions need majority; fixed resolution order with protection/absorb/purify rules.
- Day: chat + vote; if no majority, highest votes are executed; vote box shows who voted for whom.
- Identity visibility: you always see yourself; police see police, killers see killers; others are Hidden while alive, revealed on death.
- Doctor: two empty injections on the same target cause a fatal overdose.

## Files
- `index.html`, `styles.css` – single-player UI.
- `multiplayer.html`, `src/multi.js` – multiplayer lobby UI.
- `src/roles.js` – roles, factions, themes, death causes.
- `src/state.js` – game state helpers, death marking, faction counts.
- `src/engine.js` – night resolution, voting, victory checks.
- `src/view.js` – per-player masked views.
- `src/ai.js` – AI actions, chat, voting logic.
- `src/main.js` – single-player browser wiring/rendering.
- `server.js` – WebSocket game host (centralized referee).
- `tests/simulate.js` – headless win-rate simulator (all AI).

## Win-Rate Simulation
```bash
node tests/simulate.js 500
```
Prints win percentages by faction (all AI, human slot auto-played). Increase the number for more samples.
