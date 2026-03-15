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
