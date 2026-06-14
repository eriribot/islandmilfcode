Original prompt: DESIGN.md 根据这个md文件修复提到的问题

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
