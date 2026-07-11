# Fix Plan for docs/v07-human-review-failure-repair-handoff-v0.4.md

Written: 2026-07-11
For: a coding AI that will make the actual code changes
Style: short steps, one thing at a time, exact file names and line numbers

## 0. My review of the handoff doc

I read the doc and checked it against the real code (not just trusted the text). Here is what I found:

- Every specific claim in the doc that I checked was TRUE. I opened the real files and the bugs described are really there:
  - `plot-state-machine/v07.ts` really has no code that stops "stay" and "solo" flags from both being `yes` at the same time.
  - `plot-state-machine/review-settings.ts` really only has one on/off switch for everything, not one switch per flag.
  - `plot-state-machine/v07.ts` really has `proposalWindow` = `2013-02-25` to `2013-03-31`, and this window is NOT tied to "volume 7" in any way — it is just two hard-coded dates.
  - `school-calendar/prompt-adapter.ts` line 30 really says `if (date >= UTAHA_GRADUATION_DATE)`, so it repeats the "today is graduation day" message on EVERY day from 2013-03-04 onward forever, not just on 2013-03-04.
  - `relationship.ts` line 981 really has a fallback that can use `target.meta.schoolCalendarSyncedAt` (a saved/cached date) instead of the real current story date.
  - There is no `schoolYearCount` field or function anywhere in the code yet. The doc is right that it does not exist.
- So: **the doc is accurate. You can trust it.**

- I also found ONE problem the doc did not mention. This is important, read section 1 below before doing anything with dates.

## 1. STOP — one thing to confirm with the user first

The doc says (section 2.3 and section 5): the automatic route-fact checker should turn off starting on `2013-03-04` ("到 2013-03-04 关闭...也就是 2013-03-04 当天不再运行该自动判定器").

But I checked `plot-state-machine/v07.ts` and most of the important route flags — the ones that decide "stay" vs "solo" vs "leave as a group" — are only allowed to be written starting `2013-03-04` (their `earliestDate` is `2013-03-04`). These are: `blackgold_counterwill`, `user_knows_counterwill`, `user_stay_commitment_grounded`, `blackgold_not_staying_confirmed`, `user_stay_position_available`, `user_exit_commitment_grounded`, `group_exit_without_tomoya_grounded`, `group_exit_participant_snapshot_ready`.

**If you turn the checker off starting exactly on `2013-03-04`, none of these flags can ever be written by the automatic checker, because the earliest day they are allowed to be written IS `2013-03-04`.** That would make it impossible to ever unlock the "stay alone", "solo exit", or "group exit" routes through the normal automatic flow. This looks like it would break the single most important part of the whole feature.

I do **not** think this is what the user wants. Two ways to fix this — a person who knows the story needs to pick one:

- **Option A (recommended default):** Keep the automatic checker running through the whole existing window (`2013-02-25` to `2013-03-31`), but only use `2013-03-04` as the moment the checker's status changes from "fully automatic" to "needs the player to confirm by hand" (see Fix 2 below, the per-flag manual review screen). This keeps the flags working AND matches the spirit of "give the player control once route choices start."
- **Option B:** Change the `earliestDate` of those 8 flags to something before `2013-03-04` (for example `2013-03-01`, matching the closest earlier flag), and only then make the automatic checker fully stop at `2013-03-04`. This needs a person who has read the story to confirm the new earlier dates make narrative sense.

**Do not silently pick one of these and code it.** Show this section to the user and ask which option they want, OR ask them to clarify what "关闭" (close) was actually supposed to mean if it wasn't either of these. Everything else in this fix.md (Fix 1, Fix 2, Fix 4–7) does **not** depend on this question and can be done first.

## 2. Ground rules (copied and simplified from the handoff doc, section 6)

1. Read code with UTF-8. Use `rg` (ripgrep) to search, not plain `grep`, if available.
2. There are already a lot of uncommitted changes in this project. Do not run `git reset`, `git checkout`, or anything that throws away existing work.
3. Do not run `pnpm build` yourself unless the user asks. The user runs a `watch` process on port 8000 and will refresh it themselves.
4. Do not touch the "game development" panel (`game-development/index.ts`). That is a separate, unrelated task. Leave it alone.
5. Do not merge Fix areas together in one giant patch. Do the route-flag fixes (Fix 1–3) and the school-year fixes (Fix 4–7) as separate, independent changes, so each can be tested on its own.
6. After each fix, run the test script(s) named in that fix's "How to check it worked" box. If a test fails, stop and fix it before moving to the next item — do not move on with a failing test.
7. When you are done with all fixes, this still needs a real human to test it in the actual browser (port 8000) before anyone can say it works. Do not claim it is "done" or "working" just because the automated test scripts pass. Write your results into `humanpending.md` using the same format already used in that file (look at the existing `HP-00x` entries for the format).

---

## Fix 1 — Add a hard "stay" vs "solo" rule (no code allowed to break this)

**Problem:** Right now, nothing in the code stops the AI reviewer from marking BOTH "user is staying" and "user is leaving" as true at the same time. The doc's human test showed this actually happened.

**File to change:** `plot-state-machine/proposal.ts`

**What to do:**

1. Open `plot-state-machine/proposal.ts`. Find the function `reviewPlotFlagProposal`.
2. After the loop that builds the `validated` array (around line 137, right before `if (errors.length) return rejected(proposal, errors);`), add a new check.
3. The new check must build the "final state" — what each flag's value WOULD be after this proposal is applied — by merging `context.currentValues` with the new `validated` deltas (a delta's value wins over the old value for the same `flagId`).
4. Using that merged final state, check this rule:
   - IF `user_stay_commitment_grounded` would be `yes`
   - AND (`solo_route_open` would be `yes` OR `user_exit_commitment_grounded` would be `yes`)
   - THEN this is not allowed.
5. If the rule is broken, do NOT return the deltas. Instead push a new error, for example:
   ```ts
   errors.push({
     code: 'stay_solo_conflict',
     message: '同一提案不能同时让 user_stay_commitment_grounded 和 solo_route_open/user_exit_commitment_grounded 都成立。',
   });
   ```
6. You will need to add `'stay_solo_conflict'` to the `PlotFlagReviewErrorCode` union type in `plot-state-machine/types.ts` (it is a list of string literals near line 81–96).
7. This check must run in CODE, not depend on the AI prompt being good. The AI prompt in `proposal-prompt.ts` can stay as it is — do not spend time trying to make the prompt smarter. The point of this fix is: even if the AI model is wrong, the code refuses to save a broken combination.
8. Important: when this rule blocks a proposal, do NOT silently drop only the bad flag and keep the rest. Reject the WHOLE proposal (this is what "fail closed" means in the doc) so nothing partial gets written. The existing `rejected(...)` pattern already does this for other errors — copy that pattern.

**How to check it worked:**

Open `scripts/simulate-v07-routing.ts`. Add a new test case near the existing ones that:
- Sets `currentValues.user_stay_commitment_grounded = 'yes'`.
- Sends a fake AI proposal that tries to also set `solo_route_open = 'yes'` (or `user_exit_commitment_grounded = 'yes'`).
- Asserts the result `status` is `'rejected'` and the errors array contains `'stay_solo_conflict'`.

Then run:
```
node -e "process.env.TS_NODE_COMPILER_OPTIONS=JSON.stringify({module:'CommonJS',moduleResolution:'node'});require('ts-node/register/transpile-only');require('./src/islandmilfcode/scripts/simulate-v07-routing.ts')"
```
from the project root (`E:\web\tavern_helper_template-main`). All checks must print as passing, including your new one.

---

## Fix 2 — Let the player see and fix each route flag by hand

**Problem:** Right now there is only ONE on/off switch ("自动路线事实核对") for the whole automatic checker. The player cannot see or fix a single wrong flag.

**What the player needs (from the doc):**
- A list of every V07 flag, showing: its label, its current value (`yes` / `no` / `unset`), what yes/no mean, when it was last changed, and the evidence text that caused it.
- Buttons to set a flag to `yes`, `no`, or back to `unset` by hand.
- Once the player has set a flag by hand, the automatic checker must NOT quietly overwrite it again later.

**Good news:** the storage system already has everything needed. You do not need a new database. Look at `memorydatabase/upsert.ts`, function `upsertAttribute`. Every flag write already stores: `value`, `reason` (includes the evidence text), `createdAt`, and `source` (`'progress-commit'` for automatic writes, `'manual'` already exists as an allowed value for hand-made writes).

**Steps:**

1. **New file:** `plot-state-machine/manual-override.ts`. Add these functions:
   - `listPlotFlagAudit(db, machineId)` — for every flag in `V07_PLOT_MACHINE.flags`, find its latest row in `db.attributes` (same lookup style as `readActiveAttributeValue` in `memory.ts`), and return an object with: `id`, `label`, `yesMeaning`, `noMeaning`, `value` (`'yes'` / `'no'` / `'unset'` if no active row), `source`, `reason`, `updatedAt`.
   - `setPlotFlagManually(db, flagId, value)` — looks up the flag's `storageKey`, calls `upsertAttribute` with `source: 'manual'` and a `reason` like `'玩家手动设置'`.
   - `clearPlotFlagToUnset(db, flagId)` — finds the currently active row for that flag's `storageKey` in `db.attributes` and sets `expired = true` on it directly (do not call `upsertAttribute`, since that always creates a new value — we want NO active row, meaning `unset`).

2. **Protect manual values from being overwritten:** In `actions/index.ts`, function `runPostTurnPlotFlagReview` (around line 902), right before calling `commitPlotFlagDeltas(review.deltas, ...)` around line 983, filter `review.deltas`: for each delta, check if the CURRENT active row for that flag has `source === 'manual'`. If it does, drop that delta from the list and write a debug log entry like `'plot-route-review:skipped-manual-lock'` with the flag id. Only pass the remaining deltas into `commitPlotFlagDeltas`.
   - This is the priority rule: **manual always wins until the player clears it back to unset.** Write this rule down in a comment in the code so future readers understand it.

3. **New phone screen:** In `phone/render.ts`, add a new function `renderPlotFlagsPhonePage(state, renderers)` similar to `renderSettingsPhonePage`. For each flag from `listPlotFlagAudit`, render: label, value badge (yes/no/unset), meaning text, evidence quote (`reason`), last-changed time, and three buttons: "设为成立" (set yes), "设为不成立" (set no), "恢复未知" (clear to unset). Follow the same HTML/CSS class style already used in `renderSettingsPhonePage` in the same file.

4. **Wire it up:** In `phone/render.ts`'s `renderSettingsPhonePage`, add a new button under the existing "自动路线事实核对" toggle, like the existing `settings-action` buttons, that navigates to this new page (copy the pattern used for other `phoneRoute` navigation buttons — search `index.ts` for `phoneRoute` and `data-action` to see how existing buttons switch pages, and copy that exact pattern for consistency). Give the new page a route id such as `app:plot-flags`.
   - In `index.ts`, find where `data-action="return-to-title"` and other settings buttons are wired (search for `.addEventListener('click'` near the settings button wiring), and add click handlers for the new "set yes / set no / clear" buttons that call the new functions from step 1, then re-render.

5. Do **not** remove the existing single on/off switch. Keep it — it is still useful as a big kill-switch. This fix only ADDS the per-flag screen, it does not replace the switch.

**How to check it worked:**

- There is no existing automated test for phone UI clicks other than `scripts/verify-phone-home-pagination.ts`, which is about a different screen. For this fix, the check is manual: build with `pnpm build:dev`, load the page on port 8000, open Settings, open the new flag list page, and confirm:
  - All flags show up with correct label and current value.
  - Setting a flag by hand updates it immediately and survives a page reload.
  - After setting a flag by hand, running one more normal turn (that would normally trigger the automatic checker) does NOT change that flag back.
  - "恢复未知" (clear to unset) removes the value and lets the automatic checker write to it again.
- Write these manual test results into `humanpending.md` as a new `HP-00x` entry, following the existing format, and ask for a new human review — same as the doc's section 9 says. Do not claim this is finished without that human check.

---

## Fix 3 — Automatic checker start/stop window

This depends on the answer to the STOP question in section 1. Do this AFTER the user answers it.

If the user picks **Option A**:
- No change needed to `proposalWindow` in `plot-state-machine/v07.ts`. Leave `start: '2013-02-25'`, `end: '2013-03-31'` as is (this is already inside volume 7's real range, which is `2013-02-08` to `2013-03-31` — see `剧情第七卷.json`, field `时间范围`).
- Instead, in the new phone screen from Fix 2, once `currentDate >= '2013-03-04'`, show a banner that says something like: "路线选择已经开始，请手动核对每一条路线事实。" (Route selection has begun; please check each route fact by hand.) This is a UI-only change, not a logic change.

If the user picks **Option B**:
- In `plot-state-machine/v07.ts`, change the `earliestDate` of the 8 flags named in section 1 from `'2013-03-04'` to the date the user confirms (for example `'2013-03-01'`).
- Then change `proposalWindow.end` from `'2013-03-31'` to `'2013-03-03'` (one day before `2013-03-04`, since the window check is `date <= end`, so `'2013-03-03'` is the last day it can still run).
- Also change `proposalWindow.start` from `'2013-02-25'` to `'2013-02-08'` (volume 7's real start date, from `剧情第七卷.json`), so the window truly starts at "volume 7 begins," not an arbitrary earlier guess.

**How to check it worked (either option):**

Add assertions to `scripts/simulate-v07-routing.ts` matching whichever option was picked (for Option B: assert the window rejects `2013-03-04` and later; for Option A: assert nothing changed, window behavior is identical to before). Run the same command shown in Fix 1's test section. All checks must pass.

---

## Fix 4 — Stop repeating "today is graduation day" forever

**Problem:** `school-calendar/prompt-adapter.ts` line 30 says `if (date >= UTAHA_GRADUATION_DATE)`. `UTAHA_GRADUATION_DATE` is `'2013-03-04'`. Because this uses `>=` and never checks an end date, this message gets added to EVERY prompt on EVERY day from `2013-03-04` onward — forever, even on `2013-04-01` or later. It should only fire on the one actual ceremony day.

**File:** `school-calendar/prompt-adapter.ts`

**Change this:**
```ts
if (date >= UTAHA_GRADUATION_DATE) {
  lines.push('- School calendar: 2013-03-04 is Utaha graduation ceremony day; after this date, do not write Utaha as a normal third-year student attending daily classes.');
}
```
**To this:**
```ts
if (date === UTAHA_GRADUATION_DATE) {
  lines.push('- School calendar: today (2013-03-04) is Utaha graduation ceremony day. This is a one-time event, happening only today.');
}
```

**Why this is still safe:** Utaha's ONGOING "already graduated" status (for days AFTER `2013-03-04`) is handled by a different, separate mechanism that already works correctly: `resolveTargetSchoolIdentity()` in `identity-resolver.ts` (line 309) already checks `profile.graduationDate && input.date >= profile.graduationDate` and returns `kind: 'graduate'` for her on any day on/after `2013-03-04`. That result is turned into its own prompt line (`School identity: 诗羽 = ...graduate`) by the loop a few lines below in the same file (`buildSchoolCalendarFactLines`, lines 43–47), as long as Utaha is one of this turn's `targets`. So removing the daily repeat of the "ceremony day" line does NOT remove her graduate status from the prompt — it only removes the wrong repeated "today is the ceremony" claim.

**How to check it worked:**

Add test cases to `scripts/simulate-school-calendar.ts`:
- `buildSchoolCalendarFactLines({ currentTime: '2013-03-04', ... })` must include the ceremony-day line.
- `buildSchoolCalendarFactLines({ currentTime: '2013-03-05', ... })` must NOT include any "today is graduation ceremony" text.
- `buildSchoolCalendarFactLines({ currentTime: '2013-04-01', ... })` must NOT include any "today is graduation ceremony" text.
- `resolveTargetSchoolIdentity({...utaha...}, '2013-03-10')` must still return `kind: 'graduate'`.

Run with:
```
node -e "process.env.TS_NODE_COMPILER_OPTIONS=JSON.stringify({module:'CommonJS',moduleResolution:'node'});require('ts-node/register/transpile-only');require('./src/islandmilfcode/scripts/simulate-school-calendar.ts')"
```
from the project root. All checks must pass.

---

## Fix 5 — Say clearly who is NOT graduating on graduation day

**Problem:** The human test found that on `2013-03-04`, the AI wrote Izumi (波岛出海, a middle-school student) as graduating together with Utaha. The code that resolves Izumi's identity is already correct (it says she is `初3`, middle school, not a graduate) — but that fact was not being said loudly enough next to the "today is graduation" line, so the AI ignored it.

**File:** `school-calendar/prompt-adapter.ts`, function `buildSchoolCalendarFactLines`

**What to do:**

1. Right after the ceremony-day line you just fixed in Fix 4 (still inside the `if (date === UTAHA_GRADUATION_DATE)` block), add a loop over `input.targets`.
2. For each target, call `resolveTargetSchoolIdentity(target, input.currentTime)`.
3. If that target's `kind` is NOT `'graduate'`, add a line like:
   ```
   - School calendar: today is the graduation ceremony, but ${identity.name} is NOT graduating (currently ${identity.label}). Do not write ${identity.name} as a graduate or as officially finishing school today.
   ```
4. This only needs to run for targets present in that turn's context (`input.targets`) — do not try to loop over every character in the game, only the ones already passed in.

**How to check it worked:**

Add a test to `scripts/simulate-school-calendar.ts`: build a fake `targets` array containing both Utaha and Izumi, call `buildSchoolCalendarFactLines` with `currentTime: '2013-03-04'`, and assert the output contains a line naming Izumi as NOT graduating. Run the same command as Fix 4.

---

## Fix 6 — Stop using saved/cached time to guess school year

**Problem:** `relationship.ts` line 981 has a fallback: if the caller does not pass `currentTime`, it uses `target.meta?.schoolCalendarSyncedAt` (a saved value from the last time the game synced) instead. The doc says this must never happen — school year must always come from the real current story date, never from a saved/cached field.

**File:** `relationship.ts`, function `getCharacterAnchorGuidance` (around line 976–990)

**Current code (around line 981):**
```ts
const currentTime = String(input.currentTime ?? target.meta?.schoolCalendarSyncedAt ?? '').trim();
```

**Change to:**
```ts
const currentTime = String(input.currentTime ?? '').trim();
```

Then check what happens a few lines below (around line 989: `if (currentTime) { ... buildSchoolRelationGuardLine(...) ... }`). If `currentTime` is empty, that whole block is already skipped (no school-year guard line gets added at all) — that is the correct, safe behavior: "we don't know today's date, so don't guess." Confirm this stays true after your change (do not add a new fallback in its place).

**Also do this — a safety search, not a code change:** search the whole `src/islandmilfcode` folder for every other place that reads `schoolCalendarSyncedAt`, `schoolIdentityKind`, or `schoolIdentityLabel`. As of this writing, they are only written in `school-calendar/state-sync.ts`, saved/restored in `state/saves.ts`, and displayed (not decided) in `render.ts` and `phone/render.ts`. Confirm no other file uses them to make a decision about someone's grade or graduation status. If you find one, remove that read the same way as above (require the real current date to be passed in instead).

**How to check it worked:**

1. Search the code yourself for the string `schoolCalendarSyncedAt` and read every result — confirm none of them are used to decide grade/graduation, only to display or save/restore a label.
2. Add a test to `scripts/simulate-school-calendar.ts`: call `getCharacterAnchorGuidance` (or whatever public function wraps it — check `relationship.ts`'s exports) WITHOUT `currentTime`, but with a target whose `meta.schoolCalendarSyncedAt` is set to some date. Assert the result does NOT contain any school-year/grade guard text.
3. Run the same simulate-school-calendar command as Fix 4. All checks must pass.

---

## Fix 7 — Add an explicit "school year count" helper, matching the user's exact table

**Why:** The current code already computes grade from birthday + date (not from saved state), which is correct in spirit. But the doc asks for a clear, testable "count" concept the user can reason about directly: 2012 school year = count 0, and count goes up by 1 every time the date crosses `04-01`. Right now nothing in the code exposes this count directly, so it is hard to write a test that matches the user's exact wording.

**New file:** `school-calendar/school-year.ts`

```ts
/**
 * Returns how many school years have passed since the 2012 school year (which is count = 0).
 * The school year flips forward on every 04-01.
 * Examples: 2012-12-07 -> 0, 2013-03-04 -> 0, 2013-03-31 -> 0, 2013-04-01 -> 1.
 */
export function getSchoolYearCount(date: string): number | null {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const schoolYear = month >= 4 ? year : year - 1;
  return schoolYear - 2012;
}
```

This is intentionally a tiny, pure function with no dependency on saved state — it only looks at the date string you give it. This matches the exact math already used inside `identity-resolver.ts`'s private `getSchoolYear()` function (which does `month >= 4 ? year : year - 1`), just exposed publicly and offset to start at `2012 = 0`.

Do not rewire the whole identity-resolver system to use this new function — that system already works correctly (it is date-driven, not persistence-driven; the only real bugs were Fix 4, Fix 5, and Fix 6 above). This new function exists so the count can be:
- shown in the new manual-flag / audit screens if useful later, and
- tested directly against the user's exact required numbers (see below).

**How to check it worked:**

Add to `scripts/simulate-school-calendar.ts`:
```ts
assert(getSchoolYearCount('2012-12-07') === 0, 'count 2012-12-07');
assert(getSchoolYearCount('2013-03-04') === 0, 'count 2013-03-04');
assert(getSchoolYearCount('2013-03-31') === 0, 'count 2013-03-31');
assert(getSchoolYearCount('2013-04-01') === 1, 'count 2013-04-01');
```
Run the same simulate-school-calendar command as Fix 4. All four must pass.

---

## 3. Order to do this in

1. Read section 1 (the STOP question) and get the user's answer before touching any date window.
2. Fix 4, then Fix 5 (school calendar bugs — safe, no open questions, do these first).
3. Fix 6 (remove the saved-time fallback — safe, no open questions).
4. Fix 7 (the count helper + its tests — safe, no open questions).
5. Fix 1 (the stay/solo hard rule — safe, no open questions).
6. Fix 3 (the window change — only after the user answers section 1).
7. Fix 2 (the manual per-flag screen — biggest piece of work, do it last since it touches UI and depends on nothing else being broken).

After all of this, per the project's own rule (see `docs/v07-human-review-failure-repair-handoff-v0.4.md` section 9): **do not say this is "done" or "ready."** Write a new `HP-00x` entry in `humanpending.md`, list exactly what was changed and what automated tests passed, and ask the user to test it for real in the browser on port 8000. Only the user's real test can close this out.
