# Fix Plan: turn on the Game Development feature for Solo Route / Akane Route

Written: 2026-07-11
For: a coding AI that will make the actual code changes
Style: short steps, one thing at a time, exact file names and line numbers

## 0. What this plan does, in plain words

Right now the "Game Development" phone app already has: a weekly plan (5 workdays + 1 weekend), route-specific actions, and Kairosoft-style numbers (budget, fun, creativity, writing, art, code, polish, hype, bugs, fatigue). But it never tells the story-writing AI what happened that week. This plan connects the two:

1. Only let the Game Development app be used on the "Solo" route or the "Akane" route (not "Stay").
2. When the player has just submitted a week's plan, put that week's plan into the SAME prompt as their next message, so the main AI writes a real story turn about that week.
3. Make sure that week's plan is only shown to the AI ONCE (the turn right after it was submitted), not forever after — this is the exact same kind of bug we already found and fixed once before (the "today is graduation day" message that kept repeating every day). Do not repeat that mistake here.
4. Add a small safety net for when AI generation fails right after a week is submitted.

## 1. Decisions already made — do not re-litigate these

These were already discussed and decided before this plan was written. Follow them as-is:

- **Which routes get the feature:** only `solo` family (`solo_user_exit`, `solo_group_exit_except_tomoya`) and `akane` family (`akane_core`). The `stay` family does NOT get the Game Development app in this round.
- **No new date/event gate.** Do not invent a story event ID or a date range to decide when the dev-game "starts." Just use "the player has confirmed one of the solo/akane routes" as the on/off switch — same as today, just narrowed to those two families.
- **Settlement stays exactly as it works today.** The numbers (budget, fun, creativity, etc.) already get calculated by plain code (`submitGameDevelopmentWeek()`) the instant the player submits a week — no AI involved in the math, and that is correct, keep it that way. Do NOT rebuild this into a "wait for AI, then apply" two-step system. Instead just add a simple "redo this week" recovery button for the rare case where the AI generation afterward fails (see Fix D).
- **The AI's job after a dev week is narrow, not the same as a normal turn.** If you ever build a "figure out what happened this week" AI pass (Fix E, optional), it must be a brand-new, narrow task with an explicit list of things it's allowed to write — copy the pattern already used by the route-flag reviewer (`plot-state-machine/proposal.ts` + `actions/index.ts`'s `runPostTurnPlotFlagReview`). Do NOT reuse the general `buildProgressPrompt()` for this — that pass is allowed to change far more (time, location, clothing, main story event) than a dev-week update needs, and it could "drift" into changing things it shouldn't.

## 2. Ground rules (same as before)

1. Read code with UTF-8, search with `rg`.
2. Do not `git reset`/`git checkout` — lots of uncommitted work already exists.
3. Do not run `pnpm build` unless asked; the user runs their own `watch` on port 8000.
4. Do this as its own separate change, not mixed into the V07 route-flag fixes from the other plan (`fix.md`).
5. Run the test command after each numbered fix below. Don't move to the next fix with a failing test.
6. When done, write a new `HP-00x` entry in `humanpending.md` (same format as the existing entries) and ask for a real human playtest on port 8000. Do not say this "works" just because a script passed.

---

## Fix A — Only unlock Game Development on Solo / Akane routes

**File:** `phone/render.ts`, function `renderGameDevelopmentPhonePage` (around line 1548).

**Current code (around line 1558–1561):**
```ts
const receipt = resolution.choiceReceipt;
if (!receipt || resolution.choiceState !== 'chosen') {
  return renderGameDevelopmentLock(state, '先去企划页选择接下来的创作路线，确认后就能开始开发游戏。');
}
```

**Change to:**
```ts
const receipt = resolution.choiceReceipt;
if (!receipt || resolution.choiceState !== 'chosen') {
  return renderGameDevelopmentLock(state, '先去企划页选择接下来的创作路线，确认后就能开始开发游戏。');
}
if (receipt.familyId !== 'solo' && receipt.familyId !== 'akane') {
  return renderGameDevelopmentLock(state, '这条路线暂不开放游戏开发玩法，游戏开发目前只支持单飞或朱音路线。');
}
```

Also check `getGameDevelopmentHomeMeta` (around line 1501–1508) — the function that shows the little status text under the "开发" icon on the phone home screen. Add the exact same `familyId` check there, and return a short locked label (for example `'仅单飞/朱音路线开放'`) instead of calling `readGameDevelopmentState` when the family is `stay`. Do this so the home screen icon doesn't say something misleading (like "第 3 周") on a Stay-route save where the feature isn't available.

**How to check it worked:** build with `pnpm build:dev`, load port 8000 with a save on the Stay route, confirm the "开发" app shows the new locked message. Then load (or simulate) a save with the Solo or Akane route confirmed, confirm the app opens normally like before.

---

## Fix B — Give the main AI a read-only summary of the week's plan

**Goal:** right after the player submits a week (fills all 6 slots and hits submit), their VERY NEXT story message should carry that week's plan into the prompt, so the AI writes a story turn that actually reflects it. After that one turn, stop showing it (see Fix C for the "only once" part).

**Step B1 — add a "has this been shown to the AI yet" field.**

File: `game-development/index.ts`. Find the `GameDevelopmentSubmission` type (around line 47) and add one field:
```ts
export type GameDevelopmentSubmission = {
  submissionId: string;
  week: number;
  routeFamily: PlotRouteFamilyId;
  routeVariant: PlotRouteVariantId;
  submittedAt: string;
  context: string;
  slots: GameDevelopmentSlot[];
  narratedAt: string | null; // <-- add this. null = AI has not written this week's story turn yet.
};
```
In `submitGameDevelopmentWeek()` (around line 334–366), where `submission` is built, set `narratedAt: null`.

**Step B2 — build the read-only prompt block.**

Still in `game-development/index.ts`, you already have `buildSubmissionContext()` (around line 393) that builds a `[GAME_DEVELOPMENT_WEEK]` text block. Export a new small function that only returns this block when it's actually relevant to the current turn:

```ts
export function buildPendingGameDevelopmentContext(state: GameDevelopmentState): string {
  const submission = state.lastSubmission;
  if (!submission || submission.narratedAt) return '';
  return submission.context;
}
```

(`submission.context` already holds the `[GAME_DEVELOPMENT_WEEK] ... [/GAME_DEVELOPMENT_WEEK]` text built by `buildSubmissionContext()` at submit time — reuse it as-is, don't rebuild it.)

**Step B3 — wire it into the main prompt.**

File: `message-format.ts`, function `buildPrompt()` (starts around line 1353).

1. Add a new optional field to the `options` parameter (near line 1367, next to `memoryDB`):
   ```ts
   gameDevelopmentContext?: string;
   ```
2. Find where other read-only context blocks get joined into the final prompt string (look at how `plotContext` from `buildCurrentPlotContext()`, around line 1433, gets added into the assembled prompt — search a few dozen lines below line 1433 for where `plotContext` is actually concatenated in). Add `options?.gameDevelopmentContext` the same way, as its own labeled block, right next to where `plotContext` is added. Only include it if the string is non-empty.

**Step B4 — pass the block in from the caller.**

File: `actions/index.ts`, wherever `buildPrompt(...)` is actually called for a normal player turn (search for `buildPrompt(` — there are a couple of call sites, look at the ones used inside `submitMessage()`'s main flow, near where `plotLibrary` and `memoryDB` are already passed in as options).

Before calling `buildPrompt`, compute:
```ts
const routingContext = buildPlotRoutingContext(ctx.state.statusData, ctx.memoryDB);
const receipt = routingContext.v07.resolution.choiceReceipt;
const isDevRoute = receipt && (receipt.familyId === 'solo' || receipt.familyId === 'akane');
const gameDevelopmentContext = isDevRoute
  ? buildPendingGameDevelopmentContext(readGameDevelopmentState(ctx.memoryDB, receipt))
  : '';
```
Then pass `gameDevelopmentContext` into the `buildPrompt(...)` options object.

(`buildPlotRoutingContext` and `readGameDevelopmentState` are both already imported/used elsewhere in this file — reuse the same imports, don't create new ones.)

**How to check it worked:** this needs a manual browser check, since it depends on real generation. On a Solo or Akane save: build a project, fill all 6 weekly slots, submit. Send your next normal story message. Open dev tools / the debug log (`recordGenerationDebug` calls already exist in this file — you can add one more like `recordGenerationDebug(ctx, 'game-development:context-injected', { week, submissionId })` right where you compute `gameDevelopmentContext`, so you can confirm from the debug log whether the block was actually included) and confirm the block was non-empty for that one turn.

---

## Fix C — Mark the week as "already narrated" so it doesn't repeat forever

**This is the most important step. Skipping it recreates the exact bug we already found and fixed once (`school-calendar/prompt-adapter.ts`'s "today is graduation day" message that kept firing every day forever because it checked `date >= X` instead of `date === X`). Do not let that happen here.**

**File:** `game-development/index.ts` — add a new function:
```ts
export function markGameDevelopmentWeekNarrated(
  db: IslandMemoryDB,
  receipt: PlotRouteChoiceReceipt,
  narratedAt: string,
): void {
  const state = readGameDevelopmentState(db, receipt);
  if (!state.lastSubmission || state.lastSubmission.narratedAt) return; // nothing pending, or already marked — do nothing
  const next: GameDevelopmentState = {
    ...state,
    lastSubmission: { ...state.lastSubmission, narratedAt },
  };
  commitGameDevelopmentState(db, next); // reuse whatever the existing save function is called — check the exact name near the bottom of this file
}
```

**File:** `actions/index.ts` — call this right after the main story turn successfully completes, in the same place/order where `runPostTurnPlotFlagReview` already gets called (search for that call, around line 1627, inside the post-turn sequence that already runs `runSecondaryProgressUpdate` → route review → phone message → summary). Add the new call in that same sequence, guarded the same way you computed `isDevRoute` in Fix B4:
```ts
if (isDevRoute) {
  markGameDevelopmentWeekNarrated(ctx.memoryDB, receipt, ctx.state.statusData.world.currentTime);
  ctx.persistConversation();
}
```

**How to check it worked:** add a small test in a new or existing script under `scripts/` (follow the same style as `scripts/simulate-v07-routing.ts` — plain assertions, no test framework):
- Build a fake `GameDevelopmentState` with a `lastSubmission` where `narratedAt: null`. Call `buildPendingGameDevelopmentContext()` — assert it returns a non-empty string.
- Call `markGameDevelopmentWeekNarrated(...)`, then call `buildPendingGameDevelopmentContext()` again on the updated state — assert it now returns `''`.
- This proves the "only once" rule works as a pure function, before you even touch the browser.

Then manually verify in the browser: after the one turn following a week's submission, send a second normal message — confirm (via the debug log from Fix B4) that the game-development block is NOT included on that second message.

---

## Fix D — Safety net if generation fails right after a week is submitted

**Problem this avoids:** the week's numbers are already updated the moment the player clicks submit (Fix's decision #2 above — this is intentional, keep it). But if the AI call right after that fails, times out, or the player refreshes mid-stream, the player is left with an advanced week and no story to show for it, with no way to fix it except waiting for next week.

**What to add:** a small "重新讲述这一周" (retell this week) button, shown only when `lastSubmission` exists and `narratedAt` is still `null` AND the normal generation failed or was abandoned (you can detect "abandoned" simply: if the player is looking at the Game Development page and `lastSubmission.narratedAt` is still null while they're clearly past that turn — for a first version, it's fine to just always show this button whenever `narratedAt` is null, worded as "补写这一周的正文" (write up this week's story), and let the player trigger it manually any time). Clicking it should just re-run the normal `submitMessage()` flow with the pending game-dev context still attached (Fix B/C already make sure the context is included as long as `narratedAt` is null) — you do not need any new settlement logic, this button just gives the player an easy way to prompt themselves to send a message that will pick up the still-pending context.

This is intentionally simple. Do not build a queue, a retry counter, or new state for this — it's just a UI shortcut that nudges the player to send their next message, since Fix B/C already guarantee that message will carry the right context.

**How to check it worked:** manual check — submit a week, then (without sending your next message) reopen the Game Development page, confirm the button appears; click it, confirm it behaves like clicking to write a normal message (drops you into the input box, or sends a neutral continue prompt — match whatever the existing "continue writing" entry point already does elsewhere in `index.ts`, don't invent a second one).

---

## Fix E — (Optional, do only if requested) Narrow AI pass for relationship/memory effects from a dev week

Skip this fix unless specifically asked for it. Fix A–D already deliver the core feature: solo/akane-only, weekly numbers, and the AI narrating each week using the real plan. This fix is only needed if the game should also automatically pick up relationship changes (e.g., "User and Eriri bonded during a crunch") from that week's story text into the memory database.

If asked to build this:

1. Add a new `SecondaryTaskKind` value, e.g. `'game-development-turn'`, in `secondary-api.ts`'s union (next to the existing `'progress'`, `'phone-progress'`, etc.).
2. Build a new prompt function (new file, e.g. `game-development/turn-review.ts`) modeled directly on `plot-state-machine/proposal-prompt.ts` + `proposal.ts`: it should only be allowed to propose relationship/impression deltas and narrative-memory events, with required evidence quotes from the actual turn text (copy the evidence-unit / quote-matching approach already used for V07 flags — don't invent a new evidence format). It must explicitly reject/ignore any attempt to change `currentMainEventId`, `mainEvents`, project numbers, session state, or route choice — those are out of its allowlist entirely, the same way the V07 reviewer's schema doesn't have fields for anything outside plot flags.
3. Call it from `actions/index.ts` in the same post-turn sequence as Fix C, using `runSecondaryTask` with `kind: 'custom'` and `generateRaw` only (same as `runPostTurnPlotFlagReview` already does) — do not let it fall back to `generate()`.
4. Gate it the same way as Fix B/C: only run when `isDevRoute` is true and there was a pending (`narratedAt === null`) submission for this turn.

This is real, separate work — closer in size to Fix A–D combined again. Confirm it's actually wanted before starting it.

---

## 3. Order to do this in

1. Fix A (route gating) — smallest, no dependencies, do first.
2. Fix B (inject context into main prompt) — depends on nothing else here.
3. Fix C (mark as narrated) — do immediately after Fix B, in the same sitting. Do not ship B without C; that would ship the exact repeat-forever bug we already fixed once.
4. Fix D (redo button) — small UI addition, do after B/C are verified working.
5. Fix E — only if separately requested.

After all of this: write a new `HP-00x` entry in `humanpending.md`, and get a real human to play through one full week on the Solo route and one full week on the Akane route in the actual browser (port 8000) before calling any of this "done." Specifically ask the human tester to confirm: (a) the story turn right after submitting actually reflects what was planned that week, and (b) the SECOND message after that does not repeat the same "here's what happened this week" content again.
