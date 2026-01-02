# Night / Day 18 (Single-Player)

Single-player social deduction: 1 human + 17 AI, multiple themes/roles, deterministic night/day loop.

## Quick Play
1) Start a local server (avoid `file://` module blocking):
```bash
cd C:\Users\yuchi\Desktop\kera
python -m http.server 8000
```
Open `http://localhost:8000/` in your browser. (Or use `npx http-server . 8000` / VSCode Live Server.)
2) Pick a theme (top-right), click **New Game**, then play via the UI.

## Gameplay Highlights
- 18 players fixed: 1 human + 17 AI.
- Themes: presets like Good vs Evil, etc. (select and restart).
- Night: police/killers/doctor/sniper/agent/smoke/bomb/fire, etc.; factions need majority; fixed resolution order with protection/absorb/purify rules.
- Day: chat + vote; if no majority, highest votes are executed; vote box shows “who voted for whom”.
- Identity visibility: you always see yourself; police see police, killers see killers; others are Hidden while alive, revealed on death.
- Doctor: two empty injections on the same target cause a fatal overdose.

## Files
- `index.html`, `styles.css` – UI.
- `src/roles.js` – roles, factions, themes, death causes.
- `src/state.js` – game state helpers, death marking, faction counts.
- `src/engine.js` – night resolution, voting, victory checks.
- `src/ai.js` – AI actions, chat, voting logic.
- `src/main.js` – browser wiring/rendering.
- `tests/simulate.js` – headless win-rate simulator (all AI).

## Win-Rate Simulation
Run from project root:
```bash
node tests/simulate.js 500
```
Prints win percentages by faction (all AI, human slot auto-played). Increase the number for more samples.

## Tuning Notes
- AI chat/vote include noise; Red side avoids voting fellow Reds and will defend them in chat.
- Public events at night hide actor names (“Someone ...”). Votes are public with voter->target pairs.

---

# 夜 / 日 18（繁體摘要）

單人版推理遊戲：1 玩家 + 17 AI；夜晚行動、白天聊天與投票，多主題多角色，解算具決定性。

## 遊戲重點
- 夜晚：警/殺/醫/狙/特務/煙霧/炸彈/火燒等，多數決才生效，固定解算順序。
- 白天：聊天 + 投票，無多數則處決最高票；票箱會公開「誰投給誰」。
- 身份：自己永遠可見；警察互認、殺手互認；其他存活者顯示 Hidden，死亡公開。
- 醫生：同一目標空針累積到 2/2 會致死。

## 執行步驟
```bash
cd C:\Users\yuchi\Desktop\kera
python -m http.server 8000
```
在瀏覽器打開 `http://localhost:8000/`，選主題後按 **New Game**。

## 勝率模擬
```bash
node tests/simulate.js 500
```
輸出各陣營勝率，用來觀察平衡（全 AI 自動遊玩，含人類位）。***
