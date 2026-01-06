## Disclaimer
This project is an original, non-commercial technical prototype for learning and experimentation.
It does not use or include any assets, code, data, or materials from any existing commercial games.
Any similarities are purely coincidental.

# Night / Day 18
Single-player social deduction: 1 human + 17 AI, multiple themes/roles, deterministic night/day loop.

## Quick Play (single-player)
1) Start the built-in static server + referee:
```bash
npm install
npm start   # serves http/ws on :3001
```
2) Open `http://localhost:3001/` and click **New Game**.

## 中文快速指引
- 安裝與啟動：先跑 `npm install`，再 `npm start`（HTTP/WS 皆在 3001 埠）。
- 單人遊玩：瀏覽 `http://localhost:3001/`，點「New Game」即可開局。
- 多人遊玩：開 `http://<host>:3001/multiplayer.html`，輸入 WS URL（例：`ws://<host>:3001`），輸入暱稱加入；第一位是房主，選主題後點 Start，夜晚送出夜行動，白天聊天，投票階段送出投票/遺言，房主可手動 Resolve。
- 佈署範例：若部署在 `https://kera.onrender.com`，連線用 `wss://kera.onrender.com`，步驟同上。
- 全 AI 勝率模擬：`node tests/simulate.js 500`（數字可調，預設標準主題）。

## Multiplayer (experimental)
- One process serves both WebSocket and pages:
  ```bash
  npm install
  npm start   # http://<host>:3001 , ws://<host>:3001
  ```
- Open `http://<host>:3001/multiplayer.html`
- In-page steps:
  1) Set WS URL to `ws://<host>:3001` (use `wss://` if behind https).
  2) Enter a name, click **Join** (first joiner becomes Host).
  3) Host picks a theme, clicks **Start**.
  4) Night: send night actions. Day: chat. Vote: send vote/last words; timers auto-resolve or Host can click Resolve.
  5) After game end, Host clicks **Restart** then **Start** for a new match.
- Ports: only 3001 needed (http + ws). Up to 18 seats; empty seats auto-filled by AI.

### Render deploy example
- If deployed at `https://kera.onrender.com`:
  - Open `https://kera.onrender.com/multiplayer.html`
  - WS URL: `wss://kera.onrender.com`
  - Join and start as above.

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
