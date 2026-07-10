# Game Develop Simulator Preview Interfaces

Status: local preview contract only. This is not wired to `actions`, `message-format`, `memorydatabase`, `plot-routing`,
Tavern Helper, or host chat.

Source is TypeScript (`main.ts` + `scenarios.ts`). The browser loads the generated, git-ignored `dist/app.js`.

Build and contract simulation commands run from the parent template root:

```text
pnpm build:game-preview
pnpm simulate:v07-routing
pnpm simulate:v07-routing -- --json
```

## Boundary

The preview now treats game development as the primary gameplay object:

```text
PRESS ANY KEY
-> game development simulator screen
-> player chooses a development action
-> local settlement candidate
-> Review queue
-> approved project/staff patch
-> deterministic mock PlotFlagProposal
-> production proposal validator
-> local-only fact snapshot
-> production route resolver
-> optional local choice demonstration
```

The v07 signals are secondary. They are not the main UI and are not committed to the current system.

## Public Preview API

### `loadGameDevelopState(): GameDevelopSnapshot`

Returns the current local simulator state:

```ts
type GameDevelopSnapshot = {
  screen: 'cover' | 'play';
  turn: number;
  project: GameProjectState;
  staff: Record<string, StaffState>;
  storySignals: Record<string, 'yes' | 'no' | undefined>;
  reviewQueue: SettlementCandidate[];
  lab: ProposalLabState;
  localChoice: 'stay' | 'akane' | 'solo' | null;
};
```

### `settlePlayerAction(input): SettlementCandidate | null`

Calculates a candidate result without mutating authoritative state.

```ts
type PlayerActionInput = {
  actionId: 'concept' | 'scenario' | 'art' | 'code' | 'megumi' | 'debug' | 'promo' | 'blackgold' | 'rest';
};
```

### `queueNarrativeCandidate(result): ReviewQueueResult`

Adds a settlement result to the local Review queue. This is where a future AI narrative draft request would be created,
but the preview does not call AI.

### `applyHumanReview(decision): ReviewResult`

Applies, rejects, or marks the first queued candidate in the preview only.

```ts
type HumanReviewDecision = {
  candidateId?: string;
  decision: 'approve' | 'reject' | 'revise';
  notes?: string;
};
```

### `exportRouteSignals(): PlotFlagDelta[]`

Exports locally accepted route facts only after the shared validator accepts their evidence:

```ts
type PreviewRouteSignal = {
  machineId: 'v07';
  flagId: string;
  storageKey: `plotFlag.v07.${string}`;
  value: 'yes';
};
```

These objects are returned from the preview API only. They are not committed to `memorydatabase`.

### `runLabScenario(scenarioId): void`

Runs a local scenario through:

```text
bounded proposal prompt builder
-> mock raw response
-> reviewPlotFlagProposal()
-> local all-or-nothing write
-> resolvePlotRoutes()
```

Scenarios cover compliant stay/Akane/solo proposals, checked-empty, one repair, repeated protocol failure, unknown
choice injection, contradictory flags, fake evidence, lower date boundary, and missing `generateRaw`.

### `confirmLocalRoute(routeId, skipDialog?): boolean`

Demonstrates final choice locking through the shared pure `confirmPlotRouteChoice()` guard. The guard requires a manual
source, the bounded choice window, an eligible route, and no different valid existing choice. It returns the exact
attributes commit candidate, but this preview only copies its value into local memory. Production
`plotRoute.v07.choice` is not written.

## Primary Game State

```ts
type GameProjectState = {
  title: string;
  genre: string;
  theme: string;
  platform: string;
  phase: string;
  weeksLeft: number;
  budget: number;
  progress: number;
  fun: number;
  creativity: number;
  writing: number;
  art: number;
  code: number;
  polish: number;
  hype: number;
  bugs: number;
  fatigue: number;
};
```

```ts
type StaffState = {
  name: string;
  role: string;
  skill: number;
  morale: number;
};
```

## Cover Entry

`club_war.png` is the title screen. The only overlay is `PRESS ANY KEY`. Pressing any key or clicking/tapping the cover
calls `enterGame()`.

## Action Chain

```text
keydown/pointerdown on cover
-> enterGame()
-> DOM click [data-action-id]
-> settlePlayerAction({ actionId })
-> applyProjectDeltas(preview)
-> applyStaffDeltas(preview)
-> queueNarrativeCandidate(candidate)
-> applyHumanReview({ decision: 'approve' })
-> applyProjectDeltas(state)
-> applyStaffDeltas(state)
-> build deterministic local PlotFlagProposal
-> reviewPlotFlagProposal()
-> accepted deltas update local storySignals
-> resolvePlotRoutes()
-> exportRouteSignals()
```

Until `applyHumanReview('approve')`, project and staff must not mutate. Story signals additionally require proposal
validation after approval.

## Current Development Actions

| Action      | Primary effect                                  | Optional story signal              |
| ----------- | ----------------------------------------------- | ---------------------------------- |
| `concept`   | game name/type/scope, progress, creativity, fun | `second_project_seed_ready`        |
| `scenario`  | writing quality                                 | `utaha_author_pride_supported`     |
| `art`       | art quality                                     | `eriri_high_battlefield_supported` |
| `code`      | code/progress, increases bugs                   | none                               |
| `megumi`    | management, polish, fewer bugs                  | `megumi_coplanner`                 |
| `debug`     | polish, fewer bugs                              | none                               |
| `promo`     | hype                                            | none                               |
| `blackgold` | high-intensity writing/art/progress burst       | `blackgold_counterwill`            |
| `rest`      | lowers fatigue                                  | none                               |

## Current Connection State

只是本地状态演示.

No host messages, database rows, plot flags, worldbook scans, generation requests, or plugin hooks are touched.
