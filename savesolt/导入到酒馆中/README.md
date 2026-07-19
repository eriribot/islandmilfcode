# IslandMilfCode 本机存档桥

该脚本把游戏 iframe 发出的存档事件转换成 SillyTavern 文件操作。浏览器 IndexedDB 仍用于运行时缓存，持久副本写入酒馆数据目录。

## 安装

1. 打开酒馆助手的角色脚本管理。
2. 导入同目录下的 `IslandMilfCode本机存档桥.json`，并绑定当前角色卡。
3. 启用脚本并重新载入角色卡。
4. 控制台出现 `[IslandMilfCode Saves] 本机存档桥已启动` 即表示桥接成功。

需要直接查看或手动粘贴源码时，使用上一级目录中的 `IslandMilfCode本机存档桥.js`。

## 文件布局

- `user/files/islandmilfcode-backups-v2.json`：所有存档的索引、状态、摘要、记忆库、玩家档案和消息。`user/files` 根目录只新增这一个文件。
- `user/images/islandmilfcode-avatars/`：玩家自定义头像。
- `user/images/islandmilfcode-assets-<saveId>/`：对应存档的正文图片资源。

SillyTavern 的标准 `/api/files/upload` 不允许文件名包含目录分隔符，因此存档主体采用单文件汇总，图片则使用支持子目录的原生图片接口。这样不会在 `user/files` 根目录为每个存档散落三份文件。

旧版 `islandmilfcode-backup-index-v1.json` 与 `islandmilfcode-{save,messages,assets}-*.json` 仍可恢复，但脚本不会自动删除这些旧文件，避免误删唯一备份。成功写入新版汇总文件后，可由用户自行确认并整理旧文件。

手动保存会立即写入；自动存档在游戏空闲约 12 秒后写入。标题页的“从本机 user/files 恢复”不依赖浏览器缓存。
