# IslandMilfCode 本机存档桥

该脚本只把游戏 iframe 发出的存档事件转换成 SillyTavern 文件操作。v3 采用“浏览器先提交、酒馆目录后台同步”：桥临时不可用时玩家仍可继续玩，恢复后会重试同步。剧情正文始终只在承载游戏的 `#0` iframe 内渲染；存档桥不会创建、修改或隐藏宿主聊天楼层。

## 安装

1. 打开酒馆助手的角色脚本管理。
2. 导入同目录下的 `IslandMilfCode本机存档桥.json`，并绑定当前角色卡。
3. 启用脚本并重新载入角色卡。
4. 控制台出现 `[IslandMilfCode Saves] v3 本机存档桥已启动` 即表示桥接成功。

需要直接查看或手动粘贴源码时，使用上一级目录中的 `IslandMilfCode本机存档桥.js`。

## v3 文件布局

支持多级目录的 SillyTavern 使用 `user/files/islandmilfcode/` 作为唯一根目录：

- `dialogue/`：楼层正文块和楼层索引。
- `summaries/`：大小总结与全局摘要对象。
- `memory/`：记忆库对象。
- `system/`：registry、root、状态和兼容数据。
- `media/`：图片清单；实际图片仍在 `user/images/islandmilfcode-v3-images/`。
- `legacy/`：v1/v2 整包备份和旧索引。

对象仍按内容哈希共享，目录只负责分类，不改变 v3 schema、hash 或 registry 引用。桥读取时依次兼容新分类目录、旧 `user/files/islandmilfcode-v3/` 单目录和旧根目录平铺；迁移对象时先写新位置并回读校验，再删除旧副本。
- `user/images/islandmilfcode-v3-images/`：v3 正文插图与头像。
- `islandmilfcode-archive-probe-v3.json`：固定名称的写入/回读能力探针；探测完即删除，不会不断制造新文件。

提交顺序为对象 → root → registry，并在最后回读 registry。同一页面的写操作由桥串行提交；跨标签页提交和删档优先使用 Web Locks，不支持时用带超时续租的 `localStorage` 租约降低整份 registry 相互覆盖的概率。物理删除只接受浏览器原生 Web Locks：缺少它的旧 WebView 仍可正常存档和游玩，但 `gc.status` 会显示 `deferred`，不会冒险并发删文件。读取和列表查询可并发，长存档恢复不会因为排在写入队列后面而提前超时。

桥会先检查同 `kind + hash` 对象的实际正文；内容一致时直接复用，不再重复上传，正文不一致或 JSON 损坏时用浏览器副本补写。图片会核对内容摘要与实际图片路径，仍可读取时不重传，内容变化或文件缺失时自动补写。每轮同步在浏览器 F12 控制台只汇总一次 `[archive-bridge] 备份成功` 或 `[archive-bridge] 备份失败`；相同后台错误的后续重试不反复刷屏，恢复后再报一次成功。

从现在开始，每个存档只保留当前 root 和上一 root 两代恢复点。第三代及更旧 revision 在 registry 提交并回读成功后进入引用回收；仍被当前存档、上一版或其他手动分支共享的 chunk/index/state 会保留。提交成功不会等待大清理：桥把完整待删清单先写进 registry，再在后台每批最多处理 32 个逻辑 JSON，刷新或重启后可从清单继续。多个待回收项按最久未处理者轮换，不会一直只清最新一项。

删除存档会先从 registry 移除条目并写入延迟提交栅栏，再在后台回收该存档独占的 root/index/state/chunk JSON；删除前已经生成的旧提交不会把它复活。图片实体和 image manifest 当前主动保留，因为图片共享关系藏在楼层块里：对玩家而言，多留少量附件比误删仍在剧情中使用的图片更可接受。回收失败只会留下待重试垃圾，不会回滚已经成功的存档或删档。

展开汇总对象可查看 `archiveLayout`、`uploaded` / `reused`（逻辑对象数）、`jsonUploads` / `imageUploads` / `fileUploads`（真实文件写入数），以及 `gc.status/deleted/retainedShared/failed/pendingTombstones/pendingFiles/registryLock` 回收统计。`scheduled/running` 表示后台仍在分批清理，`complete` 表示最近一项已完成，`deferred/partial` 会留待后续探测或提交重试；要执行物理回收，`registryLock` 应为 `web-locks`。`missingImages > 0` 表示浏览器图片仓库原本就缺少这些图片：正文和状态仍会完成备份并标记 `degraded`，不会为了附件阻断玩家存档。

已配套修改的标准 SillyTavern 不再把每个 upload/delete 打到终端；明细统一追加到 `data/logs/file-operations-YYYY-MM-DD.log`。浏览器控制台仍只保留每轮一条成功或失败汇总。

旧 revision 的迟到重试不会把 registry 倒退；同 revision 若指向不同 root 会拒绝覆盖。删档时当前页面已排队的旧同步会被取消，registry 中的持久栅栏还会拒绝其他标签页在删除前已经生成的迟到提交；删除后的真实新操作仍可重新创建同一 id。若当前 root 的状态、摘要、记忆或最后一个楼层块不可读，桥会尝试 `previousRootHash` 并标记为降级恢复，不会用空摘要或残缺楼层覆盖完整存档。回收校验不完整时只延后物理删除，不会阻断浏览器存档、本机 registry 提交和游玩。

注意：新规则能持续约束正常提交产生的版本历史，但没有宿主“列出全部 user/files 文件”的通用接口，因此早期崩溃时已经脱离 registry 链的孤儿文件无法仅凭桥可靠枚举。不要手工批量删除；先完成玩家验证，再单独对备份副本做一次性整理。

### 宿主目录协议

- 标准 SillyTavern：对官方 `1.18.0`（提交 `51ad27fb86d39a3daca3adaa970375c9670c12df`）应用 `savesolt/SillyTavern-1.18.0-v3-directory-host.patch`，先执行 `git apply --check <补丁路径>`，确认通过后再执行 `git apply <补丁路径>` 并重启 ST。其他版本不要强行套用此补丁。
- TauriTavern：官方当前版本还没有这个上传参数；本项目提供 `savesolt/TauriTavern-v3-directory-host.patch` 供 TT 宿主源码应用和重新构建。
- 未应用宿主补丁时，桥会自动显示 `archiveLayout: "flat-v3"` 并继续正常存档/回收；已支持分类目录时为 `archiveLayout: "categorized-v1"`。旧 `subdir-v1` 只保留为读取兼容。目录不是可玩性的前置条件。

## 旧版兼容文件

- `user/files/islandmilfcode/legacy/islandmilfcode-backups-v2.json`：旧版整包存档；根目录旧副本仍可读取。
- `user/images/islandmilfcode-avatars/`：玩家自定义头像。
- `user/images/islandmilfcode-assets-<saveId>/`：对应存档的正文图片资源。

旧 v1/v2 仍按原布局保留，不会被 v3 回收误删。

旧版 `islandmilfcode-backup-index-v1.json`、`islandmilfcode-{save,messages,assets}-*.json` 和 v2 汇总文件仍可恢复，脚本不会自动删除。同一 saveId 同时有 v3/v2/v1 时，恢复列表会保留各个候选并标明来源；玩家选择的 v1 或 v2 会被优先读取，只有该候选缺失或损坏时才尝试同 saveId 的另一份。v1 图片文件单独损坏或丢失时只忽略图片，不阻断剧情和状态恢复。

若 v2 汇总文件含有无法识别的条目，新写入会失败并保留原文件，不会把坏条目过滤后覆盖。registry 顶层格式异常也会保留原文件。

手动保存会立即写入；自动存档在游戏空闲约 12 秒后写入。标题页的“从本机 user/files 恢复”不依赖浏览器缓存。
