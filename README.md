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
- Centralized WebSocket server; humans connect, empty seats are filled by **hard** AI.
- Install deps and start server:
  ```bash
  npm install
  npm run start   # ws://localhost:3001
  ```
- Web lobby: host the repo statically (same as single-player) and open `multiplayer.html`. Enter server URL + name -> Join. Host clicks Start.
- Client protocol (JSON over ws) for manual testing:
  - `{"type":"join","name":"Alice"}` joins lobby (first join becomes host).
  - Host: `{"type":"start","theme":"GOOD_VS_EVIL"}` start; seats lock.
  - Night action: `{"type":"night_action","action":{"type":"POLICE_INVESTIGATE","targetId":3}}`
  - Vote: `{"type":"vote","targetId":5,"lastWords":"gg"}` (omit `targetId` to abstain).
  - Host resolves: `{"type":"resolve_night"}` / `{"type":"resolve_vote"}`.
  - Day chat: `{"type":"chat","text":"..."}` (only during DAY).
- Server pushes per-player masked views: `{"type":"view", view}`, plus `lobby`, `started`, `phase` events.
- Max 18 seats; restart: host sends `{"type":"restart"}` then `start` again.

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
