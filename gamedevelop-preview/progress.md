Original
prompt: 我们应该先弄个gamedevelop的预览页面看看先把架子玩法搭好,之前club-war的代码你也知道的吧,不过要更适配下。只动游戏玩法的架子不要和目前的系统进行交接，以及定好接口哪些。

2026-07-09

- Scope locked to independent local preview under `gamedevelop-preview/`.
- Read `ai_narrative_driver_saekano_akanezaka.md`; core design translated as variable-driven gameplay, AI narrative as
  candidate only, human review before writeback.
- Read Aldent harness references; current connection state must remain "只是本地状态演示".
- Read develop-web-game skill; preview exposes `window.render_game_to_text` and `window.advanceTime`.
- Created static preview files:
  - `index.html`
  - `styles.css`
  - `app.js`
  - `interfaces.md`
- Design notes:
  - Actions include daily affection/relationship time, planning, Megumi co-planning, black-gold battlefield, Akane
    investigation, Akane talk, solo prep, rest, and Review drill.
  - Actions generate settlement candidates first. State only changes after "通过 Review".
  - Route scope is stay / akane / solo; canon remains default follow-original inertia.
  - No imports from current app modules.

TODO:

- Ran static preview through the develop-web-game Playwright client via file URL.
- Inspected `test-output/shot-0.png`; canvas renders the route resource board correctly.
- Found the first action payload clicked relative to the canvas, so it did not hit DOM action buttons. Replaced the
  payload with deterministic no-op frames and use `--click-selector` for DOM action probes.
- Tightened the public mock adapter:
  - `settlePlayerAction(input)` now accepts the documented object shape and legacy string shorthand.
  - `applyHumanReview(decision)` now supports approve / reject / revise results.
  - UI and `render_game_to_text` expose the latest trigger chain so function -> switch flow is visible.
- Documented exact mock gate rules and the player comfort loop in `interfaces.md`.

TODO:

- Re-ran the develop-web-game Playwright client with `--click-selector "#act-planning"` into `test-output-clean/`.
  - Clean output has only `shot-0.png`, `shot-1.png`, `state-0.json`, `state-1.json`; no `errors-*.json`.
  - `render_game_to_text` shows `pendingReview.action = "企划拼装"` while `turn` and stats remain unchanged before
    Review.
- Ran an extra API probe with the Playwright package bundled in the skill directory:
  - `settlePlayerAction({ actionId: 'megumi', freeText, targetIds })` queues a candidate.
  - `applyHumanReview({ decision: 'revise' })` keeps the candidate queued and does not mutate stats.
  - `applyHumanReview({ decision: 'reject' })` removes the candidate and does not mutate stats.
  - `applyHumanReview({ decision: 'approve' })` advances `turn` from 1 to 2 and applies the candidate deltas.
- Captured full-page screenshot at `test-output-fullpage-api.png`; layout shows state, action board, Review queue,
  gates, trigger chain, and interface boundary together.
- Current connection state remains `只是本地状态演示`.
- Main system modules were not edited in this loop.

2026-07-10 v07 reliable-route implementation loop 1:

- Scope: pure TypeScript route contracts, local simulation, and preview migration only.
- Added shared v07 proposal/prompt windows, the `solo_route_open` fact, stay/Akane/solo route definitions, strict
  proposal validation, and deterministic route resolution.
- Added the shared pure `confirmPlotRouteChoice()` guard. It only accepts a manual source inside the bounded choice
  window, requires current eligibility, locks an existing valid choice, and returns an attributes commit candidate
  without writing memoryDB.
- Migrated preview source from `app.js` to `main.ts` + `scenarios.ts`.
- Added an independent preview webpack config because the root entry discovery intentionally drops nested entries under
  `src/islandmilfcode/index.ts`.
- Preview now shows the complete local pipeline: rendered scene, mock AI proposal, TypeScript review, local simulated
  writes, eligibility, and local-only choice.
- Added `scripts/simulate-v07-routing.ts` to exercise real `runSecondaryTask()` with mocked `generateRaw` envelopes plus
  the shared validator/resolver.
- Current connection state: `只是本地状态演示`.
- Explicitly untouched in this loop: production prompt injection, real `plot-flags` task kind, memoryDB commits, phone
  Studio choice, host messages, shujuku/ACU/plugin hooks.

TODO after human review:

- Loop 2 may connect the reviewed proposal contract to real raw-only secondary generation, one repair, bounded prompt
  injection, and atomic memoryDB writes.
- Loop 3 may connect phone Studio route confirmation and persistent `plotRoute.v07.choice`.

Loop 1 execution evidence:

- `pnpm simulate:v07-routing` passed 80 contract assertions.
- The simulator exercised the real `runSecondaryTask()` envelope with mocked `generateRaw`; verified silent,
  non-streaming, ordered system/user prompts.
- `pnpm build:game-preview` passed with TypeScript checking enabled for bundled files.
- Targeted ESLint and `git diff --check` passed.
- `pnpm build:dev` and `pnpm build` both passed; production only reported the existing bundle-size warning.
- `verify-host-bundle-safety.mjs` passed against the production HTML with `hasFullPlotExport: true`.
- The develop-web-game Playwright client entered from the cover and produced text state without console-error artifacts.
- Additional Playwright interaction checks passed:
  - valid stay proposal -> five local writes, `stay` eligible, no automatic choice;
  - AI choice injection -> two failed attempts, `needs_review`, zero writes;
  - local human confirmation -> `stay` choice appears only after clicking;
  - missing `generateRaw` -> visible `unavailable`, zero writes;
  - project action -> pending Review does not mutate project; approval updates project and then passes the shared
    proposal validator.
- Re-ran the web-game client and full DOM probe after wiring the preview to `confirmPlotRouteChoice()`:
  - valid stay -> five local writes, no automatic choice, manual stay confirmation, then Akane overwrite rejected;
  - AI choice injection -> two rejected attempts, visible `needs_review`, zero writes, zero choice;
  - both probes reported no console errors, and the refreshed artifacts use the `shared-choice-*` prefix.
- Full-page screenshots and JSON states are under `gamedevelop-preview/test-output-v07-loop1/`.
- A 390x844 mobile Playwright pass reported zero control overlaps and captured `mobile-accepted-fullpage.png`.

Verification for third loop:

- `node --check gamedevelop-preview\app.js` passed.
- Static grep confirmed no remaining `enter-status-btn` or `第七卷路线开关` main-view wording.
- develop-web-game client could not enter via cover click because its `--click` coordinates are canvas-relative and the
  cover has no canvas. This was treated as a limitation of that helper for the title screen, not a page runtime failure.
- A Playwright probe using the bundled skill dependency verified:
  - initial `phase: "cover"`;
  - pressing Space enters `phase: "play"`;
  - clicking `#act-concept` creates a pending Review candidate without mutating project values;
  - clicking `#review-btn` advances to turn 2, changes phase to `原型制作`, applies project values, and sets
    `second_project_seed_ready` to true.
- Captured screenshots:
  - `test-output-sim-cover.png`
  - `test-output-sim-entered.png`
  - `test-output-sim-pending.png`
  - `test-output-sim-approved.png`

2026-07-09 third review loop:

- Human review said the previous version still looked like the phone "企划"/v07 lock app, but this preview should be a
  real game-development display like a Kairosoft-style development simulator.
- Changed the preview again:
  - Cover now uses `PRESS ANY KEY`; keyboard or pointer input enters the simulator.
  - Main screen is now a project dashboard with game name, genre, theme, platform, phase, weeks left, budget, progress,
    fun, creativity, writing, art, code, polish, hype, bugs, and fatigue.
  - Added staff rows for User, 惠, 英梨梨, and 诗羽 with role, skill, and morale.
  - Development actions are now `concept`, `scenario`, `art`, `code`, `megumi`, `debug`, `promo`, `blackgold`, and
    `rest`.
  - v07 route flags are demoted to a small "剧情信号摘要"; they are secondary outputs after Review, not the main
    display.
- Updated `interfaces.md` around project/staff state and the new action chain.
- Current connection state remains `只是本地状态演示`.
- Main system modules were not edited in this loop.
- If accepted later, add stronger mock cases for the eight Akanezaka legality tests.

2026-07-09 second review loop:

- Human review said focus was wrong: `club_war` should be the cover, then enter a status bar; do not add typography over
  the image; status bar should display where the prior v07 route locks are shown; this is the start of game-development
  gameplay.
- Changed the preview accordingly:
  - `club_war.png` is now a cover screen with no extra title text on the image itself.
  - `#enter-status-btn` switches into the gameplay/status-bar screen.
  - Left status panel now mirrors v07 route-lock grouping by date and shows `待确认 / 候选 / 已点亮`.
  - Gameplay actions now produce v07 lock candidates such as `second_project_seed_ready`; Review approval turns
    candidates into local mock open flags.
  - `exportRouteSignals()` now returns `machineId: 'v07'` shaped deltas, but still does not write to memory/database.
- Verification:
  - `node --check gamedevelop-preview\app.js` passed.
  - develop-web-game client clicked `#enter-status-btn`; `render_game_to_text` showed `phase: "play"` and no
    `errors-*.json` output.
  - Extra Playwright probe captured:
    - `test-output-cover-fullpage.png`: cover only, no added text over the image.
    - `test-output-status-pending-fullpage.png`: v07 status bar shows `second_project_seed_ready` as `候选`.
    - `test-output-status-approved-fullpage.png`: Review approval changes turn to 2 and exports
      `plotFlag.v07.second_project_seed_ready`.
  - In-app browser claim/reload was blocked by the Browser plugin file URL policy, so final visual verification used
    local Playwright screenshots rather than controlling the open in-app tab.
- Current connection state remains `只是本地状态演示`.
- Main system modules were not edited in this loop.
