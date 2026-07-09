Original prompt: 我们应该先弄个gamedevelop的预览页面看看先把架子玩法搭好,之前club-war的代码你也知道的吧,不过要更适配下。只动游戏玩法的架子不要和目前的系统进行交接，以及定好接口哪些。

2026-07-09

- Scope locked to independent local preview under `gamedevelop-preview/`.
- Read `ai_narrative_driver_saekano_akanezaka.md`; core design translated as variable-driven gameplay, AI narrative as candidate only, human review before writeback.
- Read Aldent harness references; current connection state must remain "只是本地状态演示".
- Read develop-web-game skill; preview exposes `window.render_game_to_text` and `window.advanceTime`.
- Created static preview files:
  - `index.html`
  - `styles.css`
  - `app.js`
  - `interfaces.md`
- Design notes:
  - Actions include daily affection/relationship time, planning, Megumi co-planning, black-gold battlefield, Akane investigation, Akane talk, solo prep, rest, and Review drill.
  - Actions generate settlement candidates first. State only changes after "通过 Review".
  - Route scope is stay / akane / solo; canon remains default follow-original inertia.
  - No imports from current app modules.

TODO:

- Ran static preview through the develop-web-game Playwright client via file URL.
- Inspected `test-output/shot-0.png`; canvas renders the route resource board correctly.
- Found the first action payload clicked relative to the canvas, so it did not hit DOM action buttons. Replaced the payload with deterministic no-op frames and use `--click-selector` for DOM action probes.
- Tightened the public mock adapter:
  - `settlePlayerAction(input)` now accepts the documented object shape and legacy string shorthand.
  - `applyHumanReview(decision)` now supports approve / reject / revise results.
  - UI and `render_game_to_text` expose the latest trigger chain so function -> switch flow is visible.
- Documented exact mock gate rules and the player comfort loop in `interfaces.md`.

TODO:

- Re-ran the develop-web-game Playwright client with `--click-selector "#act-planning"` into `test-output-clean/`.
  - Clean output has only `shot-0.png`, `shot-1.png`, `state-0.json`, `state-1.json`; no `errors-*.json`.
  - `render_game_to_text` shows `pendingReview.action = "企划拼装"` while `turn` and stats remain unchanged before Review.
- Ran an extra API probe with the Playwright package bundled in the skill directory:
  - `settlePlayerAction({ actionId: 'megumi', freeText, targetIds })` queues a candidate.
  - `applyHumanReview({ decision: 'revise' })` keeps the candidate queued and does not mutate stats.
  - `applyHumanReview({ decision: 'reject' })` removes the candidate and does not mutate stats.
  - `applyHumanReview({ decision: 'approve' })` advances `turn` from 1 to 2 and applies the candidate deltas.
- Captured full-page screenshot at `test-output-fullpage-api.png`; layout shows state, action board, Review queue, gates, trigger chain, and interface boundary together.
- Current connection state remains `只是本地状态演示`.
- Main system modules were not edited in this loop.

Verification for third loop:

- `node --check gamedevelop-preview\app.js` passed.
- Static grep confirmed no remaining `enter-status-btn` or `第七卷路线开关` main-view wording.
- develop-web-game client could not enter via cover click because its `--click` coordinates are canvas-relative and the cover has no canvas. This was treated as a limitation of that helper for the title screen, not a page runtime failure.
- A Playwright probe using the bundled skill dependency verified:
  - initial `phase: "cover"`;
  - pressing Space enters `phase: "play"`;
  - clicking `#act-concept` creates a pending Review candidate without mutating project values;
  - clicking `#review-btn` advances to turn 2, changes phase to `原型制作`, applies project values, and sets `second_project_seed_ready` to true.
- Captured screenshots:
  - `test-output-sim-cover.png`
  - `test-output-sim-entered.png`
  - `test-output-sim-pending.png`
  - `test-output-sim-approved.png`

2026-07-09 third review loop:

- Human review said the previous version still looked like the phone "企划"/v07 lock app, but this preview should be a real game-development display like a Kairosoft-style development simulator.
- Changed the preview again:
  - Cover now uses `PRESS ANY KEY`; keyboard or pointer input enters the simulator.
  - Main screen is now a project dashboard with game name, genre, theme, platform, phase, weeks left, budget, progress, fun, creativity, writing, art, code, polish, hype, bugs, and fatigue.
  - Added staff rows for User, 惠, 英梨梨, and 诗羽 with role, skill, and morale.
  - Development actions are now `concept`, `scenario`, `art`, `code`, `megumi`, `debug`, `promo`, `blackgold`, and `rest`.
  - v07 route flags are demoted to a small "剧情信号摘要"; they are secondary outputs after Review, not the main display.
- Updated `interfaces.md` around project/staff state and the new action chain.
- Current connection state remains `只是本地状态演示`.
- Main system modules were not edited in this loop.
- If accepted later, add stronger mock cases for the eight Akanezaka legality tests.

2026-07-09 second review loop:

- Human review said focus was wrong: `club_war` should be the cover, then enter a status bar; do not add typography over the image; status bar should display where the prior v07 route locks are shown; this is the start of game-development gameplay.
- Changed the preview accordingly:
  - `club_war.png` is now a cover screen with no extra title text on the image itself.
  - `#enter-status-btn` switches into the gameplay/status-bar screen.
  - Left status panel now mirrors v07 route-lock grouping by date and shows `待确认 / 候选 / 已点亮`.
  - Gameplay actions now produce v07 lock candidates such as `second_project_seed_ready`; Review approval turns candidates into local mock open flags.
  - `exportRouteSignals()` now returns `machineId: 'v07'` shaped deltas, but still does not write to memory/database.
- Verification:
  - `node --check gamedevelop-preview\app.js` passed.
  - develop-web-game client clicked `#enter-status-btn`; `render_game_to_text` showed `phase: "play"` and no `errors-*.json` output.
  - Extra Playwright probe captured:
    - `test-output-cover-fullpage.png`: cover only, no added text over the image.
    - `test-output-status-pending-fullpage.png`: v07 status bar shows `second_project_seed_ready` as `候选`.
    - `test-output-status-approved-fullpage.png`: Review approval changes turn to 2 and exports `plotFlag.v07.second_project_seed_ready`.
  - In-app browser claim/reload was blocked by the Browser plugin file URL policy, so final visual verification used local Playwright screenshots rather than controlling the open in-app tab.
- Current connection state remains `只是本地状态演示`.
- Main system modules were not edited in this loop.
