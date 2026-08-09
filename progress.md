Original prompt: DESIGN.md 根据这个md文件修复提到的问题

2026-08-09 shujuku v2 虚拟转发接线

- shujuku 路线已从 Island `generateRaw()` 改为临时 `chat[]` -> shujuku 包装 `TavernHelper.generate()` -> 虚拟 assistant -> `triggerUpdate()`；结果回写卡内状态，不创建宿主 `#1/#2`。
- 主回合与 AI 开场共用 `runShujukuVirtualTurn()`；Island 路线保持原生成器。重 roll 恢复轮前表快照后仍走同一入口。
- qrf、正文、数据库提交独立取证；只有当前 virtual user 的 qrf 写回能标记规划成功，`plannedText` 不能单独升级成功状态。
- 角色桥 `5.2.0` 导入 JSON 已同步。执行证据：虚拟转发 30、接线 30、消息 codec 13、prompt 隔离 15、路线绑定 9、存档兼容 39 条合同通过；生产构建通过。
- 真实酒馆中的 qrf、正文、storageFrame/表更新、刷新和重 roll 仍为 `not run`，见 `humanpending.md` HP-011。

2026-08-08 shujuku 角色桥运行域复核

- JS-Slash-Runner `main@69ac6804` 的脚本 iframe 对 `window.SillyTavern` 使用每次返回新 facade 的 getter；shujuku 缓存对象 A，角色桥后来读到对象 B，修改 B 不会影响 `triggerUpdate()` 读取的 A。
- 当前接通标签：`AutoCardUpdaterAPI` 真实状态读取已发现；逻辑规划、正文生成包装和数据库提交均未接通。角色桥保持 fail-closed，不再把缺少运行域误报为 CDN 缺少 `planVirtualTurn/updateVirtualTurn`。
- 生产调用链已不再调用本地 memoryDB 迁移或初次 handoff 导表；原生表与存档快照不一致时在生成前拒绝，且不会恢复/导入任何表。
- 执行证据：adapter 44 contracts、submit wiring 33、save compatibility 35、message codec 13、prompt isolation 15、save wiring 16、memory migration fixture 和角色桥 getter 反例均通过；生产构建及 `git diff --check` 通过。真实 qrf、正文和原生填表：`not run`。

2026-08-06 shujuku v2 接入第 1 批

- 增加 `NarrativeRoute`、`ShujukuCompatibilityState`、`ShujukuHandoffEnvelope`、qrf/pluginData 和真实 v2 storageFrame 类型合同。
- `state/store.ts` 的消息 codec 保留 `exchangeId`、`plannedText`、qrf、未知插件扩展及 assistant storageFrame；带动态插件字段的消息绕过旧 WeakMap 缓存，避免延迟证据被旧快照吞掉。
- `state/save-migration.ts` 与 `state/saves.ts` 的白名单/规范化路径保留同一批字段，v2→v3 迁移不再丢失逻辑 exchange 绑定。
- 旧 `HEAD` 上同一合同已执行失败，首个断点为 `exchangeId` 丢失；当前合同 `13 passed`。
- 生产构建、相关 ESLint、`git diff --check` 和最终 inline 产物安全检查通过；全仓 `tsc --noEmit` 仍被既有诊断阻断，新增 shujuku 行无新诊断。
- 当前接通标签：不涉及真实接通。未调用 shujuku、未触发生成、未读写数据库、未改变单 `#0` 拓扑。

2026-08-06 shujuku v2 接入第 2 批

- `state/saves.ts` 增加 memoryDB 读取保护：合法空库、仅过期内容和 malformed 输入不会覆盖非空 legacy `summaryStore`；malformed 输入也不会触发空写回。
- archive compatibility 现在持久化 route/branch/handoff/table checkpoint hash；提交、导入导出、fork 和 rollback 都校验 hash 并按目标分支恢复或清理兼容状态。
- 本地 Tavern archive transport 同步保存历史兼容 checkpoint；缺失 root/checkpoint compatibility 时 fail-closed。
- 新增保存兼容合同 `scripts/verify-shujuku-v2-save-compatibility.ts`（23 passed）和 wiring 合同 `scripts/verify-shujuku-v2-save-wiring.mjs`（10 passed）。
- 生产构建、archive/message 定向合同、相关 ESLint、inline bundle 安全和 `git diff --check` 通过；全仓 `tsc --noEmit` 仍被既有诊断阻断，未发现新增 shujuku 行诊断。
- 当前接通标签：仍不涉及真实接通。未探测/调用 shujuku，未创建 virtual session，未触发生成，未读写真实表，未改变单 `#0` 拓扑。

2026-03-15

- 已实现从 Tavern 聊天记录回灌 `uiMessages`：
  - `state/store.ts` 新增 `loadMessagesFromChat()`
  - 初始化时会读取宿主楼层之后的聊天消息
  - 加载时会把旧的 `is_hidden: false` 历史消息批量修正为 `is_hidden: true`
- 已实现消息持久化与 ID 映射：
  - `UiMessage` 新增 `tavernMessageId`
  - 新发出的 user / assistant 消息会在 `createChatMessages` 后回填对应的 Tavern message id
- 已实现回溯删除持久化消息：
  - `rollbackConversation()` 现在会根据 `tavernMessageId` 删除 Tavern 聊天记录中的对应消息
- 已实现会话历史注入 prompt：
  - `buildPrompt()` 现在会显式拼接 `uiMessages` 中的 user / assistant 历史
  - 避免 hidden 消息不进入上下文后导致刷新/继续生成丢历史
- 已实现事件同步：
  - `MESSAGE_EDITED`：更新本地消息
  - `MESSAGE_DELETED`：移除本地消息
  - `CHAT_CHANGED`：重载聊天消息并清空草稿
- 已补第二轮刷新修复：
  - 不再按“当前宿主楼层之后”恢复消息
  - 改为全聊天扫描 antiml 隐藏消息
  - 新持久化消息会打 `data.antiml_source = 'islandmilfcode'` 标记
  - 这样可避免刷新后宿主楼层变化导致首条丢失，也能避免把 0 层可见开场白当成读卡消息

验证：

- 定向 TypeScript 校验通过：
  - `npx tsc --noEmit --skipLibCheck --pretty false --target es2020 --module esnext --moduleResolution node src/islandmilfcode/index.ts src/islandmilfcode/actions/index.ts src/islandmilfcode/actions/streaming.ts src/islandmilfcode/state/store.ts src/islandmilfcode/message-format.ts src/islandmilfcode/types.ts`
- `pnpm build` 已通过（需提权，因为 webpack 的 schema dump 在沙箱中 `spawn EPERM`）
- 第二轮修复后再次 `pnpm build` 通过

遗留注意项：

- 我把 prompt 文案改成了更中性的英文版本，避免继续依赖旧模板文案；如果后续需要保留原中文口吻，可以只改文案而不改结构。
- Chrome DevTools 本地浏览器连接失败（系统里未启动可连接的 Chrome），这次没有完成可视化 smoke test，只做了构建和定向 TS 校验。

2026-03-15 variable persistence refactor

- Switched conversation persistence away from hidden chat messages.
- Added `ANTIML_CONVERSATION_KEY = antiml_conversation_v1` and now store user/assistant history in the host message variables.
- Reload now restores conversation from variables first; hidden chat messages are only used as legacy migration source.
- Legacy hidden antiml messages are migrated into variables and then deleted with `deleteChatMessages(..., { refresh: 'all' })` when possible.
- Updated MVU save flow to merge existing `MvuData` before replacing `stat_data`, so conversation variables are not overwritten.
- Validation:
  - `npx tsc --noEmit --skipLibCheck --pretty false --target es2020 --module esnext --moduleResolution node src/islandmilfcode/index.ts src/islandmilfcode/actions/index.ts src/islandmilfcode/actions/streaming.ts src/islandmilfcode/state/store.ts src/islandmilfcode/message-format.ts src/islandmilfcode/types.ts src/islandmilfcode/variables/adapter.ts`
  - Browser check in local SillyTavern: sending from the iframe no longer increased host `.mes` count.
  - After page reload, the iframe conversation was restored from variables.

2026-06-14 paper fullscreen plugin

- Added `plugins/fullscreen.ts` for the in-app paper workspace fullscreen flag, render button, and `F` shortcut guard.
- Wired the fullscreen button into `renderPaperWorkspace()` without using the browser Fullscreen API.
- Added CSS for `.paper-workspace.is-paper-fullscreen` so the rendered floor fills the viewport while staying inside the app.

- 2026-06-14 correction: fullscreen now also expands the host frame/message wrapper around the rendered islandmilfcode UI, not only the inner paper workspace.

- 2026-06-14 fullscreen fix: real SillyTavern host is iframe#TH-message--0--0; ST rewrites inline height, so fullscreen host CSS is now injected into parent document with !important rules.

- 2026-06-14 fullscreen host-chain fix: real page confirmed `window.frameElement instanceof HTMLElement` is false inside the Tavern Helper iframe, so the plugin now accepts cross-realm frame elements via `nodeType === 1`.
- Expanded host-chain takeover to include Tavern/SillyTavern wrappers: `#chat`, `#sheld`, `.mes`, `.mes_block`, `.mes_text`, `.mes_text_display`, and `.TH-render`, plus the iframe itself.
- Manual DevTools verification on `http://127.0.0.1:8000/`: marking `iframe#TH-message--0--0 -> .TH-render -> .mes_text -> .mes_block -> .mes -> #chat` produced rect `x=0,y=0,width=2560,height=1249`.
- Validation: `cmd /c pnpm build:dev` passed.

2026-06-14 fullscreen / mobile sizing pass

- Shifted the sizing work out of fullscreen host plumbing and into render/layout layers.
- `render.ts` now marks full-screen reader decks and illustration-heavy workspaces with semantic classes so CSS can tune width/height by content type.
- `styles.css` now uses variable-driven reader width, font size, line height, illustration height, and Saenai avatar sizing for fullscreen and phone-embedded modes.
- `phone/render.ts` now emits viewport-derived CSS variables for shell size, home avatar size, chat avatar size, embedded reader height, and illustration height.
- `phone/styles.css` now reads those variables so the phone UI scales with actual viewport space instead of fixed avatar/body sizes.
- Validation: `cmd /c pnpm run build` passed.
- Note: fullscreen host takeover logic in `plugins/fullscreen.ts` was left as-is after reverting the temporary live2d/waifu experiment.

2026-07-11 phone home pagination and V07 UI verification

- Restored the simulated autosave to `2012-12-07 18:00 / SAE_06-1`; the temporary V07 route choice and game-development state are absent.
- Added a fixed 3 x 3 phone home grid with a horizontally sliding app track, clickable page dots, swipe navigation, and a stationary Dock.
- Page changes update only the app track; the phone hero and Dock are not re-rendered for pagination.
- Reworded the V07 planning and game-development UI in plain Chinese and corrected oversized game-development buttons.
- Verification: production build passed, phone pagination contracts 12/12, V07 simulation 78/78, host bundle safety passed, targeted ESLint passed. `index.ts` retains only its two pre-existing lint errors.
- Human gate: replace the Tavern regex replacement body with `dist/islandmilfcode/index.html`, save, re-render, then test the live page on port 8000. Do not run watch.

2026-07-12 V07 rollback boundary reconciliation

- User evidence showed a save restored to `2012-12-07 18:00` while the V07 route choice and week-one game-development UI remained active.
- Root cause: rollback cleanup only reliably handled v2 receipts during the live rollback action; previously corrupted/legacy saves were trusted unchanged during `loadSave`.
- Added timeline reconciliation in `plot-state-machine/memory.ts`:
  - clear when the authoritative date/event lifecycle has rewound before the DDL;
  - clear v2 receipts when the current reader head is earlier than `anchorFloorIndex`;
  - write an auditable tombstone instead of physically deleting receipt history.
- `state/store.ts` now runs the same reconciliation after rollback/delete.
- `state/saves.ts` reconciles on load and persists the repaired memoryDB, so already-broken saves self-heal without touching `index.ts`.
- Direct execution evidence: pre-DDL and removed-anchor scenarios clear the choice; an intact anchor after the DDL remains selected.
- `npm run build:dev` passed. Targeted ESLint passed except the existing irregular-whitespace issue in `state/saves.ts`; filtered TypeScript output showed only pre-existing errors.
- Browser smoke test reached an unauthenticated 8000 entry and returned 401, so no real-page acceptance is claimed.
- Human gate: load the affected rolled-back save and confirm route choice/game-development are no longer active; then confirm a post-DDL save with an intact anchor still keeps its choice.

2026-07-11 phone home fit and tap regression

- Live DOM measurement on the 380 x 680 phone shell found each grid row was about 87.5 px while an app icon block was about 97 px, so the third-row descriptions were clipped.
- `phone/styles.css` now sizes home icons from `--phone-shell-width`, uses explicit compact line heights, and reduces the home-section gap. The measured icon block is about 81.8 px inside a roughly 91.5 px row.
- Real Chrome clicks confirmed the application route itself worked only when pointer capture was bypassed. `index.ts` now captures the pointer only after a horizontal gesture crosses the 36 px swipe threshold, preserving normal taps.
- Verification: build passed; pagination contracts 12/12; V07 routing 78/78; host bundle safety passed with all replacement-character checks at zero.
- Human gate: re-copy the latest build generated at 2026-07-11 12:19:31 into the Tavern regex, then re-run live tap/swipe/layout checks.

2026-07-12 game-development real narrative integration

- Replaced the production six-slot weekly state with schema v3 `workday -> weekend` turns.
- Enabled all three player route families. The frozen development profile preserves `stay_blackgold` separately from `stay_user_only`.
- Connected the phone page through `submitGameDevelopmentTurn()` to the existing real `submitMessage()` generator path.
- A turn settles only after a complete non-empty `<content>` result is finalized to the exact assistant message and the acceptance callback succeeds.
- Simulation, partial-stream recovery, cancellation, and missing Tavern generator paths cannot fire the game-development acceptance callback.
- Added stable persisted message IDs, durable `commit_pending`, retry-without-renarration, deterministic settlement, v2 baseline migration, and Reader rollback snapshots.
- The 2013-03-04 entry week treats Monday as consumed by SAE_07-8/route confirmation; its first workday range is 2013-03-05 through 2013-03-08.
- Verification evidence (not human acceptance): production webpack build passed; exact final inline HTML host safety passed with all replacement/entity/syntax risk counts at zero; no simulation or browser gameplay automation was run.
- Human gate: user will replace the Tavern artifact and test the complete real generator/save/rollback flow in one pass.
