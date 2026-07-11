# Fix Plan v2 — V07 route flags + school calendar

Written: 2026-07-11
Replaces: `fix.md` (v1). Keep v1 on disk for history, but follow this file, not that one.
Why this exists: two rounds of external review found real holes in v1. This version fixes those holes. See "What changed from v1" at the bottom if you want the diff story.
Style: short steps, one thing at a time, exact file names and line numbers.
Rule for this round: **only write planning documents. Do not edit `.ts`/`.css` files. Do not run `pnpm build`.** The user already has `watch` running on port 8000.

---

## 1. STOP — same open question as v1, still unresolved

The automatic route-fact checker's start/stop window still has the same problem v1 found: 8 of the most important route flags (`blackgold_counterwill`, `user_knows_counterwill`, `user_stay_commitment_grounded`, `blackgold_not_staying_confirmed`, `user_stay_position_available`, `user_exit_commitment_grounded`, `group_exit_without_tomoya_grounded`, `group_exit_participant_snapshot_ready`) can only be written starting `2013-03-04`. If you make the checker stop on `2013-03-04`, none of them can ever be written automatically. Nothing in this review round changed that fact. Get the user's answer on Option A vs Option B (see v1 section 1) before touching `proposalWindow`/`promptWindow` dates. Everything else below does not depend on this.

---

## 2. Manual flag control — corrected storage model

**What was wrong in v1:** v1 said "check `source === 'manual'` on the flag's attribute row to know it's locked." That's broken, and here's the exact reason, confirmed by reading the code: `memorydatabase/upsert.ts:445-449` —

```ts
if (latest && latest.value === patch.value) {
  latest.lastSeenAt = now;
  latest.updatedAt = now;
  return { action: 'unchanged', rowId: latest.id };
}
```

If the AI already wrote `yes` (`source: 'progress-commit'`) and the player then manually picks `yes` to "lock" it, the value didn't change — so `upsertAttribute` takes the early-return branch and never creates a new row. `source` stays `progress-commit`. The lock silently never happens. The very first time a player tries to confirm a value the AI already got right, the lock fails.

**Corrected design: keep the fact and the lock in two separate places.**

1. **Fact value** (unchanged): `plotFlag.v07.<flagId>` in `db.attributes`, written the same way it is today — by `commitPlotFlagDeltas()` for automatic writes.
2. **New: override record**, its own attribute key: `plotFlagOverride.v07.<flagId>`, `valueType: 'json'`, value is a small JSON object: `{ "mode": "manual", "value": "yes" | "no" }`. This is a completely separate row from the fact value. Setting it never touches the fact row directly.
3. **Reading the effective value** (new function, `plot-state-machine/manual-override.ts`, function `getEffectivePlotFlagValue(db, flagId)`):
   - If an active `plotFlagOverride.v07.<flagId>` row exists with `mode: 'manual'`, its `value` wins — return that, and mark the source as `'manual'` for display purposes.
   - Otherwise, fall back to the plain fact row (`plotFlag.v07.<flagId>`), source `'progress-commit'` (or whatever it actually was).
4. **"恢复未知" (clear to unset):** this now means "delete/expire the override row," NOT "delete the fact row." Do this through the normal `upsertAttribute`-style commit path — write a new override row that means "no override" (e.g. `{ "mode": "auto" }`), rather than reaching into `db.attributes` and flipping `expired` by hand (see next section for why).
5. **Automatic writes must skip overridden flags.** In `actions/index.ts`'s `runPostTurnPlotFlagReview`, before calling `commitPlotFlagDeltas`, check `getEffectivePlotFlagValue`'s override status for each delta's `flagId`; if `mode === 'manual'`, drop that delta and log `plot-route-review:skipped-manual-lock`. The fact row itself is untouched either way — the override just wins when both exist.

This is more storage than v1 proposed, but it's the only version where "the player locked this value" is a fact that can never be silently erased just because the AI happens to propose the same value again.

## 3. Never hand-mutate `expired` — go through a real commit function

**What was wrong in v1:** v1 said to find the active attribute row and set `row.expired = true` directly. This bypasses `updatedAt`, the incremental index update (`memorydatabase/indexes.ts`), the supersede/expire audit chain, and produces no record of *why* it was cleared.

**Corrected design:** add one new function next to `upsertAttribute` in `memorydatabase/upsert.ts` (or call `upsertAttribute` itself with a sentinel), e.g.:

```ts
export function clearOverride(db: IslandMemoryDB, targetId: string, key: string, reason: string): UpsertResult {
  return upsertAttribute(db, {
    targetId,
    key,
    value: JSON.stringify({ mode: 'auto' }),
    valueType: 'json',
    reason,
    source: 'manual',
  });
}
```
This goes through the exact same path every other write goes through — same audit fields, same index update, same supersede chain. Do not write directly to `db.attributes` from anywhere outside `memorydatabase/upsert.ts` and `memorydatabase/editor.ts`.

## 4. The debug memory editor is a write path too — it must obey the same rules

**New finding this round, not in v1 or the first review:** `memorydatabase/editor.ts` already has generic functions — `updateMemoryRow` (line 225), `insertMemoryRow` (line 296), `expireMemoryRow` (line 242) — that can edit *any* attribute row, including `plotFlag.v07.*` and the new `plotFlagOverride.v07.*` keys, completely outside the route-flag system. If the debug editor is reachable in the shipped UI (check whether it's dev-only or player-facing before treating this as urgent), it's a fourth write path nobody has been guarding.

**What to do:** before shipping the invariant check (section 5), find every place `memorydatabase/editor.ts`'s attribute-editing functions can be reached from the UI. If it's player-facing, the shared invariant check (section 5) must run there too, not just in the AI proposal path and the new manual-flag UI. If it's dev/debug-only and not reachable by players, it's lower priority, but say so explicitly in your write-up rather than silently ignoring it.

## 5. One shared invariant boundary, not a special case buried in `proposal.ts`

**What was wrong in v1:** the stay/solo conflict check only lived inside `reviewPlotFlagProposal()` (the AI-proposal path). The new manual-flag UI from v1 could still let a player set `stay=yes` AND `solo=yes` by hand, since nothing was checking there.

**Corrected design:** define the V07 mutual-exclusion rules once, as data, not as one `if` buried in one function:

```ts
// plot-state-machine/invariants.ts
export type PlotFlagInvariant = {
  id: string;
  description: string;
  // returns an error message if violated, or null if OK, given the full merged flag-value map
  check: (values: PlotFlagValueMap) => string | null;
};

export const V07_INVARIANTS: PlotFlagInvariant[] = [
  {
    id: 'stay_vs_solo',
    description: '留下承诺已落地时，不能同时成立单飞或退出承诺。',
    check: values =>
      values.user_stay_commitment_grounded === 'yes' &&
      (values.solo_route_open === 'yes' || values.user_exit_commitment_grounded === 'yes')
        ? '同一状态下 user_stay_commitment_grounded 和 solo_route_open/user_exit_commitment_grounded 不能都成立。'
        : null,
  },
  // See section 6 for the additional invariants the second review asked for — add them here as more entries,
  // same shape. Do not special-case any of them inline elsewhere.
];

export function checkPlotFlagInvariants(values: PlotFlagValueMap): string[] {
  return V07_INVARIANTS.map(inv => inv.check(values)).filter((msg): msg is string => Boolean(msg));
}
```

Then call `checkPlotFlagInvariants()` from **every** place that can change a V07 flag's effective value:
- `plot-state-machine/proposal.ts`'s `reviewPlotFlagProposal()` — after merging deltas into current values, same as v1 planned, just call the shared function instead of an inline check.
- The new manual-flag UI's "set yes/no" handler (in `index.ts`, wherever you wire the buttons from Fix 2 of v1) — compute what the merged state would be if this one manual edit were applied, run `checkPlotFlagInvariants`, and if it returns any message, **do not write the override** — show the message to the player instead and let them decide (this is the "至少手动 UI 必须在提交前检查，并向玩家显示冲突" requirement from the review — don't silently block, tell the player why).
- Anywhere in `memorydatabase/editor.ts` that's reachable by players (see section 4).
- Any future migration code that touches these keys.

## 6. Broaden the invariant set beyond stay-vs-solo

Add these as additional entries in `V07_INVARIANTS` (exact wording of the messages is up to you, keep them close to these descriptions):

1. **Exit-but-still-staying:** `user_exit_commitment_grounded === 'yes'` at the same time as `user_stay_commitment_grounded === 'yes'` (this overlaps with the first rule but should be its own explicit entry so the error message is specific).
2. **Group-follow established but solo entry not open:** `group_exit_without_tomoya_grounded === 'yes'` while `solo_route_open !== 'yes'`. Per `v07.ts`, `solo_route_open` is a prerequisite for both solo routes — if the group-follow fact got set without the entry flag, that's an inconsistent state, reject it.
3. **Participant snapshot without group-follow:** `group_exit_participant_snapshot_ready === 'yes'` while `group_exit_without_tomoya_grounded !== 'yes'`.
4. **Locked choice whose basis no longer holds:** this one isn't a same-batch check like the others — it's already partly handled by `resolver.ts`'s `needs_review` state when a locked choice's `basisHash` stops matching current flags. Confirm (read `resolver.ts` again, `resolvePlotRoutes()`) that a *manual* flag edit also triggers this re-check correctly, the same way an automatic AI write does — since both go through the same `resolvePlotRoutes()` call whenever the phone企划页 re-renders, this should already work once section 5's shared boundary is in place, but write a test for it explicitly rather than assuming.

## 7. `schoolYearCount` must be real, not a second date-math system

**What was wrong in v1:** v1 proposed a new standalone `getSchoolYearCount()` function, then explicitly said "don't let `identity-resolver.ts` use it." That makes it dead code by v1's own instruction — it would only ever be exercised by its own test, never by anything a player actually sees. This is exactly the "two systems that can quietly drift apart" problem flagged elsewhere in this project's own docs, and v1 fell into it.

**Corrected design:** don't write a second function. Extract the one that already exists.

1. Open `school-calendar/identity-resolver.ts`, find the private `getSchoolYear()` function (around line 102–108):
   ```ts
   function getSchoolYear(date: string): number | null {
     const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
     if (!match) return null;
     const year = Number(match[1]);
     const month = Number(match[2]);
     return month >= 4 ? year : year - 1;
   }
   ```
2. Export it (remove the module-private restriction), and add a second, also-exported, thin wrapper right next to it:
   ```ts
   export function getSchoolYearCount(date: string): number | null {
     const year = getSchoolYear(date);
     return year === null ? null : year - 2012;
   }
   ```
3. Everywhere in `identity-resolver.ts` that currently calls `getSchoolYear(...)` directly keeps doing so unchanged — you're not replacing internal logic, you're just making the existing function part of the public surface so tests and any future audit UI can call the *real* one instead of a reimplementation.
4. Delete the standalone-file idea from v1 (`school-calendar/school-year.ts`) entirely — don't create it.

**How to check it worked:** the same test values as v1 (`2012-12-07 → 0`, `2013-03-04 → 0`, `2013-03-31 → 0`, `2013-04-01 → 1`), but now calling the real exported `getSchoolYearCount` from `identity-resolver.ts`, in `scripts/simulate-school-calendar.ts`. If this function's behavior ever changes, the test changes with it automatically — there's nothing left to drift.

## 8. Graduation ceremony — three layers, not `date === X`

**What was wrong in v1 (both the original doc and my own defense of it after your first correction):** `date === UTAHA_GRADUATION_DATE` stops the message from repeating on *later days*, but does nothing to stop it repeating multiple times on the *same day* if the player sends several messages on `2013-03-04`. And separately, treating graduation as a fixed `profile.graduationDate` field doesn't generalize — most characters don't have that field at all (confirmed: only `utaha` and `shoko` have one in `BUILT_IN_RULES`; Eriri, Megumi, the player, and future cohorts don't), and `ResolvedSchoolIdentity` doesn't even expose `graduationDate` as a field. And "permanent, irreversible status" was also wrong as a design goal — if the game ever allows rolling the story date backward past a graduation, the character must correctly become a student again, not stay stuck as a graduate.

**Good news found this round: the exact mechanism this needs already exists in the codebase**, built for a different purpose — main-event completion tracking.

`剧情第七卷.json`'s last event, `SAE_07-8`, dated `2013-03-04`, titled "在毕业典礼上告白，大多会沦为和稀泥对不对？", *is* Utaha's graduation ceremony. It already has an `事件状态` field with values like `未触发`/`进行中`/`已结束`, tracked in `statusData.world.mainEvents['SAE_07-8']`, and `plot-routing.ts` already has a helper for exactly this:
```ts
function isFinishedMainEventStatus(status: string | undefined) {
  return /已结束|跳过|延后|已完成/.test(String(status ?? '').trim());
}
```
(currently module-private in `plot-routing.ts` — export it, same as `getSchoolYear` above, don't reimplement it.)

**The corrected model, four layers:**

1. **Date eligible** (necessary, not sufficient): `getDatePart(currentTime) === '2013-03-04'`. This is the SAE_07-8 event's own trigger date — read it from the event data, don't hardcode a second copy of the date string if you can avoid it (check whether `message-format.ts`'s existing plot-library reader already exposes an event's trigger date somewhere reusable; if not, it's fine to keep one constant, just keep it named clearly, e.g. `SAE_07_8_DATE`, not `UTAHA_GRADUATION_DATE`, since it's really "the event's date," not "a fact about Utaha").
2. **Event active, not yet finished:** `statusData.world.currentMainEventId === 'SAE_07-8'` AND `!isFinishedMainEventStatus(statusData.world.mainEvents['SAE_07-8'])`. Only while both are true does the "today is the ceremony" prompt line get injected. This is what actually solves the "same day, five turns" problem the review raised — once the event's status flips to finished (which happens through the normal main-event completion flow, the same way every other event in this story gets marked done), the line stops, even if it's still calendar-date `2013-03-04` and the player keeps sending messages.
3. **Per-character participation eligibility (uses the real `getSchoolYearCount`, not a `graduationDate` field check):** for each of `input.targets` present this turn, derive their current grade from `getSchoolYearCount(currentDate)` + their base grade/school (the same computation `resolveTargetSchoolIdentity` already does internally) — a character is an eligible graduate for *this* event only if their derived grade calculation puts them at "finishing 3rd year, this school, this date." Concretely: reuse `resolveTargetSchoolIdentity(target, currentTime).kind === 'graduate'` as the eligibility signal (it already does the right date-driven computation — see layer 4) rather than checking a `graduationDate` field that most profiles don't have. This is what lets Fix 5 (the "X is NOT graduating" contrastive line) work for anyone present, not just Izumi, without hardcoding names.
4. **Persistent identity — unchanged, and confirm it stays a pure function of date:** `resolveTargetSchoolIdentity`'s existing `profile.graduationDate && input.date >= profile.graduationDate` check (for Utaha specifically) already recomputes fresh from `date` on every single call — it is *not* stored as a one-way latch anywhere today. Do not "fix" this into a persisted boolean while implementing layers 1–3. If a rollback ever moves `currentTime` before `2013-03-04`, the very next call to `resolveTargetSchoolIdentity` must correctly return `kind: 'student'` again for Utaha, with no special-case code needed — confirm this with a test (see below), don't just assume it.

**File-level plan:**

- `plot-routing.ts`: export `isFinishedMainEventStatus`.
- `school-calendar/constants.ts`: keep `UTAHA_GRADUATION_DATE` if you want (it's still useful as the persistent-identity cutover in layer 4), but stop using it as the *only* gate for the ceremony line — that's now layers 1+2.
- `school-calendar/prompt-adapter.ts`, `buildSchoolCalendarFactLines()`: replace the current
  ```ts
  if (date >= UTAHA_GRADUATION_DATE) {
    lines.push('- School calendar: 2013-03-04 is Utaha graduation ceremony day; ...');
  }
  ```
  with a check across layers 1+2 (date match AND event active AND not finished) before pushing the ceremony line — this needs `statusData.world.currentMainEventId` and `statusData.world.mainEvents` passed into `buildSchoolCalendarFactLines`'s input, which it doesn't currently receive; add them to `SchoolCalendarFactInput`.
- Keep the existing `date >= UTAHA_GRADUATION_DATE` style check ONLY for the ongoing "don't write Utaha as a normal student" identity line (layer 4) — that one is correctly a `>=`, unlike the ceremony line.

**How to check it worked:** extend `scripts/simulate-school-calendar.ts`:
- `mainEvents['SAE_07-8'] = '未触发'`, `currentMainEventId = 'SAE_07-1'`, date `2013-03-04` → ceremony line must NOT appear (event not active yet).
- `mainEvents['SAE_07-8'] = '进行中'`, `currentMainEventId = 'SAE_07-8'`, date `2013-03-04` → ceremony line MUST appear.
- Same as above, called five times in a row (simulating five turns the same day) with the event still `进行中` → line appears all five times (this is expected and fine — the event is still active all five times; the fix is that it stops once *finished*, not that it only fires once regardless of event status).
- `mainEvents['SAE_07-8'] = '已结束'`, date still `2013-03-04` → ceremony line must NOT appear, even same-day.
- Date `2013-03-05` (event finished) → ceremony line must NOT appear (existing v1 test, keep it).
- **Rollback check (new):** resolve Utaha's identity at `2013-03-10` (graduate), then resolve again at `2013-03-01` using the same profile object — assert `kind` goes back to `'student'`. This is the test that proves layer 4 is genuinely non-latching.
- Izumi contrastive line (from Fix 5 of v1) still applies, but now driven by `resolveTargetSchoolIdentity(izumi, date).kind !== 'graduate'` at layer 3, not a `graduationDate` field check.

## 9. Fix 5's contrastive line still needs Chrome verification, not just better prompt text

The review's point stands regardless of the above: a prompt line is a probability nudge, not a guarantee. After building layers 1–3, the acceptance test for "Izumi is not written as graduating" is still a real Chrome playtest on `2013-03-04` with the event active, checked by a human — not just "the assertion in the simulate script passed." Say this explicitly in the human-review write-up; don't let a passing script stand in for it.

## 10. Test-instruction contradiction from v1 — fixed

v1 said "don't build" in the ground rules, then told the tester to run `pnpm build:dev` in Fix 2's manual-check section. Corrected: the user already runs `watch`. Any manual browser check in this plan means: wait for `watch` to finish rebuilding on its own, then refresh port 8000. Do not run `pnpm build` or `pnpm build:dev` yourself unless the user explicitly says to.

---

## 11. Order to do this in

1. Section 7 (`schoolYearCount` extraction) — smallest, no dependencies, do first.
2. Section 8 (graduation three-layer model) + section 9 — do together, this is the best-scoped fix with the clearest test story.
3. Section 5 + 6 (shared invariant boundary + full invariant set) — do next, no dependency on the above.
4. Section 2 + 3 (override storage model + safe clear function) — depends on section 5 existing, since the manual-edit handler needs to call `checkPlotFlagInvariants` before writing an override.
5. Section 4 (audit the debug editor's reach) — can happen any time, doesn't block anything else, but must happen before this is called done.
6. Section 1 (the date-window STOP question) — only once the user answers it.

After all of this: same rule as v1 — write a new `HP-00x` entry, get a real Chrome playtest, don't call any of this "done" off a script pass alone.

---

## What changed from v1 (for your own tracking, not for the executor)

- Manual flag lock: separate `plotFlagOverride.*` key instead of relying on `source === 'manual'` on the fact row (that check never fires when the value doesn't change).
- No more direct `row.expired = true` — goes through a real commit function.
- New: audit the debug memory editor as a fourth write path.
- Mutual exclusion moved to a shared, data-driven invariant list checked by every write path, not one `if` inside the AI-proposal reviewer.
- Invariant set broadened from 1 rule to 4.
- `schoolYearCount` is now the identity-resolver's real internal date math, exported, not a second parallel function.
- Graduation ceremony redesigned around the existing main-event status machinery (`SAE_07-8`, `isFinishedMainEventStatus`) instead of a raw date comparison, fixing the same-day-repeat gap and generalizing per-character eligibility via `getSchoolYearCount` instead of a `graduationDate` field most characters don't have.
- Explicitly corrected: graduation/grade identity must stay a pure, non-latching function of current date so rollback works correctly — not "permanent and irreversible" as stated earlier in this conversation.
- Removed the "don't build" vs "run `pnpm build:dev`" contradiction.
