# 真实宿主楼层驱动的游戏存档索引方案 v0.1

> 状态：设计评审稿，只定义合同，不授权修改生产代码。
>
> 本文取代 `local-save-floor-segmentation-proposal-v0.1.md` 的“本地 archive 是完整正文权威”结论。旧文保留为被否决方案，不继续在上面补丁式修改。

## 0. 先把 `Archive` 说清楚

当前代码里的 `Archive` 只是 `state/archive-repository.ts` 这套本地内容寻址存储的历史命名。它不是 TT / SillyTavern 的聊天楼层，也不应该成为第二套剧情权威。

新方案只使用下面四个名词：

| 名词 | 含义 |
| --- | --- |
| 真实宿主楼层 | TT/ST `chat` 中实际存在的 user / assistant 消息，正文唯一权威 |
| 本地存档索引 | 从游戏楼层定位到真实消息、状态检查点、摘要边界和图片引用的小型索引 |
| 恢复镜像 | 本地保存的正文灾备副本，只在明确恢复时用于重建真实楼层 |
| 运行时窗口 | 当前 UI 和 prompt 真正装入内存的有界消息集合 |

以后生产代码可把 `ArchiveRepository` 逐步改名为 `SaveIndexRepository`。旧的 `archive-v3` 只作为兼容格式名保留。

一句话结论：

```text
真实 TT/ST 消息保存故事，本地索引保存“故事在哪里”和“游戏状态走到哪里”，图片文件单独保存。
```

## 1. 问题不是图片，也不是单纯的 chunk 数字

### 1.1 当前并没有真正以宿主楼层驱动

[inspected] 当前正文主链调用 `generate()` / `generateRaw()` 时使用 `should_silence: true`，结果先写进 `state.uiMessages`。

[inspected] `createChatMessages` 只有类型声明，生产主正文链没有调用；`MESSAGE_SENT` 和 `/trigger await=true` 也没有生产调用。

[inspected] `loadMessagesFromChat()` 虽然能读取带标记的宿主消息，但当前进入 v3 存档走的是 `hydrateArchiveMessages()`，后者从本地 floor chunk 还原正文。

因此现状的实际权威是本地 `uiMessages/archive`，不是用户要求的真实宿主楼层。先前文档把这个现状误当成目标，是第一处根本错误。

### 1.2 v3 名义分块，运行时仍然全量

[inspected] 当前 v3 已有：

```text
root -> floor-index page -> floor-chunk
FLOOR_CHUNK_SIZE = 16
INDEX_PAGE_CHUNK_COUNT = 128
FLOOR_CACHE_LIMIT = 24
```

但关键热路径仍然破坏了分块收益：

- `enterSave()` 调 `hydrateArchiveMessages()`。
- `hydrateArchiveMessages()` 调 `streamArchiveFloors()`。
- `streamArchiveFloors()` 用 `Promise.all` 读取全部 chunk，再恢复完整 `uiMessages`。
- 编辑、回滚、删除和图片替换多次调用 `streamArchiveFloors()`。
- `republishFloors()` 给所有 floor 换 revision，导致所有内容 hash 失效。

所以现在是“磁盘分块，内存全载；写一个旧楼层，整条历史重新发布”。把 16 改成 24、32 或 128 都不能单独修复它。

### 1.3 楼层增大时陡增的主体是重复快照

[executed] 对 `artifacts/live-save-baseline-before-v07-simulation.json` 逐条重算 JSON 字节：

| 样本 | 消息数 | 完整 chatLog | 只留 id/role/speaker/text | statusSnapshot |
| --- | ---: | ---: | ---: | ---: |
| 最大单槽 | 161 | 7,901,409 B | 358,592 B | 6,720,790 B |
| 典型长槽 | 237 | 3,487,838 B | 591,884 B | 1,659,607 B |

最大单槽中，正文最小字段只占约 4.5%，`statusSnapshot` 占约 85%。图片已经外置以后，继续拆图片当然不会消掉这部分。

当前 v3 又为每个 floor 保存 `beforeTurnState` 和 `afterTurnState`。成熟方案必须消除重复状态，而不是只继续切正文文件。

### 1.4 真实楼层权威有一个不可消除的成本

[web-inspected] SillyTavern 当前 `release` 的 `trySaveChat()` 仍把整个 `chatData` 映射成 JSONL 后写文件。只要真实消息必须保留，宿主聊天文件至少会按正文总量线性增长。

这部分不能由 IslandMilfCode 假装消失。我们能做的是：

- 不往每条真实楼层塞完整状态、MemoryDB、摘要或图片字节。
- 不在 IslandMilfCode 内存里再复制一份完整聊天数组。
- 不在 IslandMilfCode 本地存档里重复保存多份正文和状态。
- 只让宿主 DOM 和卡片 UI 渲染有界窗口。

声称“真实楼层全部保留，同时宿主聊天文件大小不随楼层增长”违反基本事实，不属于本方案目标。

## 2. 根不变式

1. 真实 host user / assistant 消息是叙事正文唯一权威。
2. 稳定身份是 `floorId`，`message_id` 只是当前宿主数组位置，会因删除或插入而变化。
3. 正常打开、阅读、生成、编辑都从真实楼层读取；恢复镜像不能静默覆盖已有真实楼层。
4. 状态使用“周期完整 checkpoint + 每层单向 patch”。第 N 层的 before 状态等于父楼层的 after 状态；不再每层重复保存 before + after 两份完整快照。
5. 图片二进制始终在独立资产仓库，楼层与存档只保存 `assetId/contentHash`。
6. 自动保存的写入量与总楼层数无关；连续自动保存不能连续制造新文件名。
7. UI、生成上下文和导出是三种不同读模型，禁止再共用一个全量 `uiMessages` 数组。
8. host 写入成功而本地索引失败时，host 仍然胜出并可重建索引；本地成功而 host 缺失时不得冒充正文已提交。
9. prompt、世界书、shujuku/ACU、数据库时机和 hidden-floor 行为分别验收，存档重构不得顺便改变它们。
10. `index.ts` 只负责装配和生命周期，不接收新的存档业务实现。

## 3. 权威矩阵

| 数据 | 权威来源 | 本地存档职责 | 冲突规则 |
| --- | --- | --- | --- |
| 玩家输入正文 | 真实 host user 消息 | 定位、hash、恢复镜像 | host 胜出 |
| AI 正文 | 真实 host assistant 消息 | 定位、hash、恢复镜像 | host 胜出 |
| qrf/规划/插件字段 | 对应真实 host user 消息上的插件字段 | 默认不复制、不伪造 | host/plugin 胜出 |
| 当前游戏状态 | 已提交 checkpoint，运行时镜像到 `stat_data` | 保存当前 checkpoint | revision 冲突必须可见 |
| 历史回滚状态 | `.imcp` 内周期 checkpoint + 单向 state patch | 按楼层恢复并校验 `stateAfterHash` | 缺失时降级，不猜精确状态 |
| 摘要与 MemoryDB | 当前 checkpoint 中的 summary/memory | 保存内容及覆盖边界 | 边界不能超过真实楼层 head |
| 图片 | 独立 asset store | 楼层只记引用 | 图片缺失不阻断正文 |
| UI 卡片 | 有界运行时窗口 | 无权威性 | 每次从 host/index 回读 |
| 存档槽 head/分支 | slot A/B | 指向共享历史的 `headFloorVersionId` | 选择能被有效 manifest 满足的最高完整 slot revision |

“真实楼层为主”不等于把所有游戏状态塞回每条宿主消息。正文和插件原生字段属于 host；大状态属于游戏存档 checkpoint。混在一起正是宿主文件膨胀的来源。

## 4. 真实消息协议

每个游戏回合有一个稳定 `floorId` 和一个 `exchangeId`。宿主消息只增加不可变的小标记：

```ts
type IslandHostMarkerV1 = {
  v: 1;
  source: 'islandmilfcode';
  runId: string;
  branchId: string;
  floorId: string;
  parentFloorId: string | null;
  exchangeId: string;
  part: 'user' | 'assistant';
};
```

落到当前 API 时继续使用 `data.islandmilfcode_source = 'islandmilfcode'` 作为快速兼容标记，详细字段放在同一个 `data.islandmilfcode` 对象中。

明确禁止写入每条 host 消息：

- archive/root revision；
- 完整 `statusData`；
- `summaryStore`；
- `MemoryDB`；
- 完整手机记录；
- 图片 base64/blob；
- 整份 prompt 或生成上下文。

插件自己写入的 `qrf_plot*`、swipe、世界书或数据库字段不属于本模块，必须原样保留。

### 为什么不能用 `message_id` 当永久主键

[inspected] 当前删除单条消息后，代码会把后续 `tavernMessageId` 全部减一。这已经证明 message id 是位置，不是稳定身份。

本地索引保存 `lastKnownMessageId` 只是快速定位。读取时必须核对消息里的 `floorId + part`；不匹配就按 marker 修复 locator，不能拿错误位置的正文继续玩。

## 5. 四条链路必须分开

### 5.1 生成链

最终目标流程：

```text
UI 提交
-> 创建并回读真实 hidden user 消息
-> 运行被选定的生成路线
-> 得到并回读真实 hidden assistant 消息
-> 状态/摘要/手机任务结算
-> 提交本地 checkpoint 和索引
-> UI 从真实消息刷新
```

生成路线只能二选一：

| 路线 | 用途 | 边界 |
| --- | --- | --- |
| direct-compatible | 保留当前 `generate/generateRaw` prompt 语义；完成后显式创建真实 assistant 消息 | 不宣称触发 shujuku 原生规划 |
| native-hook | 真实 user 消息后发 `MESSAGE_SENT`，再 `/trigger await=true`，由宿主生成 assistant | 必须单独实战验收 qrf、世界书、数据库和正文 |

存档设计不替用户选择这两条路线，也不允许两条同时运行造成双生成。

### 5.2 宿主消息链

- 创建 user 后必须按 `exchangeId` 回读并取得真实 message id。
- assistant 只有完整非空正文被接受后才能成为完成楼层。
- host 写入失败时，UI 显示失败，slot head 不前进。
- host 成功、本地提交失败时，记录 `index-behind-host`，下次从 marker 增量补索引。
- 编辑先 `setChatMessages` 并回读成功，再更新本地 hash/镜像。
- 回滚先确定真实目标 IDs，再从尾部删除并回读确认；不能只截本地数组。

### 5.3 插件/数据库链

- direct-compatible 路线保持当前插件副作用边界，不把“正文生成成功”写成“qrf 已保存”。
- native-hook 路线只轮询当前 user floor 的 `qrf_plot*`，不扫描旧消息猜成功。
- 本地恢复镜像默认不复制插件数据库，也不伪造 qrf。

### 5.4 UI 镜像链

- streaming 卡片只是临时 UI，不是已提交正文。
- 完成后 UI 必须从 host 回读的 user/assistant 消息建立卡片。
- host/index 不一致时显示 degraded 状态，不允许继续显示一个“本地成功、host 不存在”的假楼层。

## 6. 运行时窗口

推荐边界：

| 窗口 | 默认值 | 硬上限 | 原因 |
| --- | ---: | ---: | --- |
| Reader 当前批次 | 8 层 | 16 层 | 手机和桌面都容易控制 DOM |
| Host 预取 | 当前批次前后各 4 层 | 32 条消息 | 覆盖翻页且不全量复制 chat |
| 主生成近期正文 | 12 层 | 16 层 | 与当前 prompt 设计接近，较低语义风险 |
| Floor locator cache | 64 层 | 128 层 | 只含小索引，不含正文大对象 |

进入 1000 层存档时只做：

```text
读 registry/root/checkpoint
-> 读 manifest 指向的索引快照与短 delta 链
-> range-read 包含 head 的一个压缩 frame
-> 按 lastKnownMessageId 请求最多 32 条 host 消息
-> 校验 floorId/part/hash
-> 渲染最后 8 层
```

禁止再调用 `getChatMessages('0-{{lastMessageId}}')`，禁止进入时调用 `streamArchiveFloors()`。

摘要、搜索、导出不能借口“需要全部历史”恢复全量 `uiMessages`：

- 摘要按未摘要范围分批流式读取。
- 搜索使用 host 搜索能力或逐段扫描，结果只返回 locator。
- 导出按 manifest locator 逐 frame 写出，不在内存拼一份巨型 JSON。

## 7. 本地文件布局

### 7.1 一个 run 共享一组卷

同一局游戏的 autosave、manual save 和后续分支共享一个 `runId` 目录。slot 只保存 `branchId + headFloorVersionId + headHash + 当前 checkpoint + minManifestRevision`，绝不复制此前的正文、状态历史或卷文件。

完整桥接后的推荐物理布局：

```text
user/files/islandmilfcode/
├─ registry-a.json
├─ registry-b.json
└─ runs/
   └─ <runId>/
      ├─ manifest-a.json
      ├─ manifest-b.json
      ├─ slots/
      │  ├─ autosave-a.json
      │  ├─ autosave-b.json
      │  ├─ manual-001-a.json
      │  └─ manual-001-b.json
      └─ floors/
         ├─ volume-0000.imcp       # 每个物理卷 <= 8 MiB
         ├─ volume-0001.imcp
         └─ ...
```

图片继续放独立资产仓库，`.imcp` 只保存引用：

```text
user/images/islandmilfcode-assets/<contentHash>.<ext>
```

`registry-a/b.json` 是所有 run 共用的标题页目录，不计入每个 run 的文件数。`manifest-a/b.json` 是小型提交根；楼层 locator 的索引快照和增量索引也写入 `.imcp` frame，避免每次 autosave 重写一个随总楼层数增长的巨型 JSON manifest。

### 7.2 目录不是现有 vanilla 接口已经具备的能力

[web-inspected] 当前 SillyTavern 与 TauriTavern 的 `/api/files/upload` 都只接收文件名，没有物理目录、append、range read 或 stat 合同。因此必须明确区分：

| 模式 | 物理布局 | 正确性 | 性能结论 |
| --- | --- | --- | --- |
| full bridge | 真实 `runs/<runId>/...` 目录，支持 append/range read | 完整 | 可以验收增量写与 frame 懒加载 |
| browser IndexedDB | 同一 manifest/frame 逻辑，frame 为 IDB record/blob | 完整 | 是否发生真实范围 I/O 必须单测，不能仅凭逻辑分块推断 |
| vanilla flat fallback | `imc-<runToken>-volume-0000.imcp` 等扁平文件名 | 可保存/恢复 | 只能整卷读改写，必须显示 `flat-whole-file/degraded`，不得宣称同等性能 |

扁平前缀可以减少文件数，却不能伪装成物理文件夹或真正 range read。实现 full bridge 时，桥只接受 save root 下的规范化相对路径；绝对路径、`..` 和符号链接越界必须拒绝。

### 7.3 为什么不再使用 active A/B/C JSON

active A/B/C 仍然会把一个不断增长的 JSON 对象反复序列化、压缩和覆盖。新的正文与状态历史只 append 到当前 `.imcp` 卷；A/B 只留给很小的 manifest、registry 和 slot 提交根。

一次普通 autosave 不创建新文件名。当前卷达到 8 MiB 才创建下一个卷；历史编辑也 append correction frame，而不是再制造一份旧楼层段文件。

## 8. 8 MiB Pack Volume 合同

### 8.1 逻辑楼层记录

```ts
type PackedFloorV1 = {
  floorId: string;
  floorVersionId: string;
  branchId: string;
  parentFloorId: string | null;
  parentFloorVersionId: string | null;
  hostUser: { lastKnownMessageId: number; textHash: string };
  hostAssistant?: { lastKnownMessageId: number; textHash: string };
  recoveryText: { user: string; assistant?: string };
  state: {
    kind: 'patch' | 'checkpoint';
    parentStateHash: string | null;
    stateAfterHash: string;
    patch?: JsonPatchOperation[];
    checkpoint?: FloorStateSnapshot;
  };
  summaryBoundary: number;
  memoryBoundary: number;
  imageAssetIds: string[];
};
```

`recoveryText` 默认开启以支持跨电脑或清空浏览器后的显式恢复，但它永远只是灾备镜像：正常 Reader、生成和编辑都从 host 读正文；host 文本与镜像 hash 冲突时 host 胜出。

不保存 `rawText + visibleText` 两份。卷内只保存真实 host `message` 的一份原文，Reader 继续用正文解析器派生显示文本。

状态不能再为每层复制完整快照。默认每 32 层或累计 patch canonical bytes 达到 256 KiB 时写一个完整 checkpoint，其余楼层只写从父状态到 `stateAfter` 的确定性 JSON patch。数组默认整项替换，不引入自定义数组合并语义；删除、`null` 与合法零值必须可区分。恢复任意楼层最多读取一个 checkpoint 和其后 31 个 patch，并以每层 `stateAfterHash` 校验结果。slot 另外保存当前 head 的完整 checkpoint，所以正常打开不需要重放历史 patch。

### 8.2 物理卷与独立 frame

```text
volume hard limit:          8 MiB = 8,388,608 bytes
frame target payload:       256 KiB canonical bytes
frame hard payload:         512 KiB canonical bytes
frame stored hard payload:  576 KiB
frame codec:                gzip；不支持时 identity
frame kinds:                FLOOR_BATCH / CORRECTION / INDEX_DELTA /
                            INDEX_SNAPSHOT / INDEX_PAGE
```

每个 volume 先写固定卷头，至少包含 `magic/formatVersion/runId/volumeId/createdAt`；卷头也计入 8 MiB。每个 frame 都有固定头，至少包含 `magic/version/kind/codec/headerLength/storedLength/canonicalLength/payloadSha256`。frame 独立压缩、独立校验；读取一个楼层只 range-read 命中的 frame，不解压整个 8 MiB 卷。

256 KiB 是批量迁移、导入和 compaction 的聚合目标，不是在线 autosave 的等待条件。正常回合必须在本回合事务边界立即提交，即使因此产生一个较小 frame；最迟在 512 KiB canonical payload 前拆分。楼层数不是边界：轻楼层可以很多，重楼层可以很少。

单个极端楼层超过 512 KiB 时使用带 `recordId + partIndex + partCount` 的 continuation frames，不能因为一个大楼层重新引入 2 MiB 上限或整卷读取。单个 stored payload 不得超过 576 KiB；一个逻辑楼层的本地重组上限为 8 MiB。超过时 host 正文仍然提交，但恢复镜像省略超限字段并记录 `recovery-mirror-oversized`，不能让本地镜像失败反向否定 host 成功。

一个 frame 的落盘 locator 形如：

```ts
type FrameLocatorV1 = {
  volume: number;
  offset: number;
  length: number;       // frame header + stored payload
  storedSha256: string; // 对 range-read 到的原始 bytes 校验
};

type FloorExtentV1 = FrameLocatorV1 & {
  itemIndex: number;
  partIndex: number;
  partCount: number;
};

type FloorLocatorV1 = {
  floorVersionId: string;
  parts: FloorExtentV1[];
};
```

加载索引后的逻辑视图就是：

```text
(branchId, floorId, floorVersionId)
  -> { parts: [{ volume, offset, length, storedSha256, itemIndex, partIndex, partCount }] }
```

continuation 读取必须拒绝缺片、重复 part、partCount 不一致、乱序无法重排或重组后超过 8 MiB；不能返回半个楼层。

`floorVersionId` 不可变。slot 保存的是 `branchId + headFloorVersionId`；编辑共享祖先时为当前 slot 派生新 branch 并写新 floor version，其他 manual slot 仍指向旧版本。禁止用全局 `floorId -> latest` 覆盖表，否则“共享历史”会变成跨存档串改。

### 8.3 小 manifest 与有界索引

`manifest-a/b.json` 不内联全部楼层对象，只保存：

- `revision`、`previousRevision`、`runId`、格式版本；
- 每个卷的 `committedLength`；
- 最新 `INDEX_SNAPSHOT/INDEX_PAGE` 根 locator；
- snapshot 后最多 32 个 `INDEX_DELTA` locator；
- 当前可达 volume 集合与 compaction 状态。

每次新增或修正楼层时，把 locator 变化写入一个很小的 `INDEX_DELTA` frame。达到 32 个 delta 时，在卷内追加合并后的 `INDEX_SNAPSHOT`；快照超过单 frame 上限时拆成 `INDEX_PAGE`，根只保存 page locator。这样正常 autosave 的正文、索引和 manifest 写入量都不随总楼层数线性增长，打开时也不会追一条无限 journal。

slot 是玩家存档 head 的提交点，manifest 是全 run 的可达对象目录。`minManifestRevision` 表示“打开此 slot 至少需要哪个 manifest 能力版本”，不是要求永远保留那个精确 A/B revision；后续 manifest 必须继续包含所有有效 slot 可达的 `headFloorVersionId`。manifest 已写而 slot 尚未写时只是未提交的新对象，不能让 slot 自行前进。

### 8.4 Append、提交和断电恢复

桥的 append 使用乐观并发合同：

```text
append(path, bytes, expectedSize)
  -> { offset, length, newSize }
```

`expectedSize` 与 stat 不一致就失败，防止两个标签页把 frame 交叉写进同一位置。一个 frame 的提交顺序是：

1. 每次 append 前都计算完整 encoded frame（frame header + stored payload）；`currentSize` 已包含 volume header。若 `currentSize + encodedFrameLength > 8 MiB`，封闭当前卷并创建下一个卷。此规则同样适用于 data、continuation、index delta、snapshot 和 page。
2. append 完整 frame，按返回的 offset/length range-read 回来。
3. 校验原始 bytes 的 `storedSha256`，再解压校验 `payloadSha256`。
4. append 对应 `INDEX_DELTA`，同样回读校验。
5. 整文件覆盖 inactive manifest，关闭文件后回读 revision/hash。
6. 整文件覆盖 inactive slot 并回读；只有 slot 的 `headFloorVersionId/headHash/minManifestRevision` 能被新 manifest 满足时，head 才提交。

manifest 记录每个卷的 `committedLength`。崩溃发生在步骤 2 到 4 时，文件尾可能存在完整或半个未引用 frame；恢复只相信最高有效 manifest 的 `committedLength + locator`，尾部一律忽略。

若 stat 大于 committedLength，下一次写入不在未知尾部后盲目续写：封闭该卷并开启新卷。若 manifest 引用范围超过实际文件长度、短读或 hash 不符，该 manifest 无效并回退另一个 A/B revision，同时显示 degraded。

### 8.5 修正帧与压实

历史正文编辑先修改真实 host 并回读，然后为当前 branch append 一个包含新 `floorVersionId` 和完整逻辑记录的 `CORRECTION` frame；新 branch 索引指向新版本。其他 slot 仍可能引用旧版本，所以旧 bytes 只有在从所有有效 slot 都不可达后才计入 obsolete，绝不原地改写。

仅当一个已封闭卷的不可达 bytes 超过约 25%，或所有不可达 bytes 合计至少能减少一个卷时，才允许后台 compaction：

```text
range-read 仍可达 frames
-> append 到新 volume
-> 逐 frame 回读校验
-> 写新索引与 inactive manifest
-> 更新所有引用该 revision 的 slot A/B
-> 确认 registry/manifest/slot 两套 A/B 都不再引用旧卷
-> 删除旧卷
```

compaction 失败只留下尚未被 manifest 引用的新卷，不能损坏当前存档。它是低频维护，不在普通 autosave 热路径；运行中允许短暂多出新卷，文件数上界以压实完成后的稳态计算。

### 8.6 文件数与容量预期

[assumed] 在 v5 encoder 基准完成前，3000 层、gzip、稳态 compaction、仅 autosave slot 的规划值为约 5 到 10 个 `.imcp` 卷。它不是按楼层硬算，而是由压缩后 frame 总 bytes 决定；identity fallback 不共享这个容量目标：

```text
5..10 floor volumes
+ 2 run manifests
+ 2 autosave slot files
= 9..14 files per run
```

全局再共享 2 个 registry 文件；每增加一个 manual slot 固定增加 2 个小 JSON，不复制任何历史卷。图片资产另计。

[executed] 用现有真实 payload 按 user/assistant 配对外推 3000 层的 gzip 边界实验中，保留旧完整结构的最大样本约 76.59 MiB，而只保留最小正文约 7.21 MiB。这个跨度再次说明决定卷数的是重复状态结构和正式 encoder，而不是“每卷固定多少楼”。5–10 是要用新 checkpoint/patch schema 验证的容量预算，不是现有样本已经证明的保证。

连续 100 次 autosave 若未跨越 8 MiB 卷边界，新增文件名必须为 0。`5..10` 必须在真实 3000 层 fixture 上执行 encoder 后才能从 `assumed` 升为 `passed`；若实际超过，按 bytes 报告，不调整楼层数来粉饰结果。

## 9. 保存、编辑、回滚和分支

### 9.1 普通回合提交

```text
1. 取得 run 单写者资格，重读当前 manifest/slot revision
2. host user 写入并按 floorId + part 回读
3. host assistant 写入/生成并按 floorId + part 回读
4. 计算 floorVersion、state patch/checkpoint，append 数据和索引 frame
5. range-read 新 frame 并校验 stored/canonical hash
6. 覆盖 inactive manifest，关闭后回读校验
7. 覆盖 inactive slot（含 head checkpoint），关闭后回读校验
8. UI 从 host 回读刷新并显示保存结果
```

步骤 2 到 3 确立正文；步骤 4 到 7 确立游戏存档。host assistant 失败时 slot head 不前进，host 中已创建的 user 作为可重试的 incomplete exchange 明确显示。host 已成功但步骤 4 到 7 失败时记录 `index-behind-host`，下次按 marker 补索引；不得删除或隐藏已成功的 host 正文。本地 frame 存在但 host 缺失时也不得报告正文已提交。

v5 首版以单 `runId` 单写者为合同。同一浏览器的多标签页必须用 Web Locks 或等价 lease 串行化；发现 manifest revision、slot revision 或 volume expectedSize 改变时返回 `save-conflict` 并重载，不能静默 last-write-wins。跨电脑同时写同一 run 不在首版支持范围。

### 9.2 编辑历史正文或替换图片

- 正文编辑先改 host 并回读，再为当前 branch append 一个 `CORRECTION` frame 和索引 delta；不重写命中卷或其他卷。
- 编辑共享祖先时自动派生 branch 与新 `floorVersionId`，其他 slot 继续引用旧版本。
- 图片重生成只写新 asset，再 append 目标 floor 的新引用版本；不改 host 正文 hash，不改其他楼层 frame。
- 禁止 `streamArchiveFloors() -> republishFloors()`。
- 单条中间消息删除会让后续 host message id 位移。这是显式 O(N) locator 维护操作，可以分页回读 host 并追加批量索引 delta；禁止重发正文或重写历史数据 frame。正常打开和 autosave 仍须有界。

### 9.3 回滚

- 回到 user 输入：从父 checkpoint + patch 还原 before 状态，保留目标 user，删除或失活其 assistant 与当前 host 的未来消息。
- 回到完成楼层：还原并校验目标 `stateAfterHash`，目标 assistant 保留。
- 先验证目标 `floorId + floorVersionId` 对应的真实 host 消息，再执行 host 变化并回读。
- 本地只创建新 branch/head slot revision，不重写未变 volume；旧版本在仍被其他 slot 引用时继续保留。

### 9.4 手动存档和分支

- 新 slot 只写 A/B 两个小文件，指向同一 `branchId + headFloorVersionId` 和当前卷索引。
- 继续玩时在首次分歧处创建新 branch；新增 floor/correction 仍 append 到同一组 run volumes。
- 删除一个 slot 只减少可达性引用；compaction/GC 从所有有效 slot A/B 计算 live floor versions。
- 最后一个 slot 删除后，才允许 bridge 对已经规范化并确认位于 save root 内的整个 `runs/<runId>` 执行 `deleteTree`。

这直接否决“每个手动档复制 3000 层历史”的做法。文件夹好删不能以复制所有正文为代价。

当前活跃分支以真实 host 为正文权威。若加载的 inactive slot 对应楼层已不在当前 host chat，必须进入第 10.2 节的显式恢复/宿主分支切换流程；不能因为本地卷仍有 `recoveryText` 就把它当成正常阅读链。

## 10. 打开与恢复协议

### 10.1 正常打开

1. 先读取 slot A/B；从高到低寻找 checksum 完整的 slot revision。
2. 对每个候选 slot，再从 manifest A/B 中选择 `revision >= minManifestRevision`、包含其 `headFloorVersionId/headHash` 的最高完整 revision；仅仅存在更高但未被 slot 提交的 manifest，不能推进 head。
3. 校验所选 manifest 的 `offset + length <= committedLength <= stat.size <= 8 MiB`。
4. range-read 索引 snapshot/pages 与最多 32 个 delta，再读取 head frame；不扫描目录或整卷。
5. 从 slot 的 head checkpoint 建立当前状态，校验 `stateAfterHash`。
6. 按 locator 向 host 请求有界消息范围，校验 `runId + floorId + part + textHash`。
7. host 多出已完成 floor 时增量补索引；host 文本被编辑时追加 correction，host 不被覆盖。
8. 渲染 Reader 8 层，翻页时只 range-read 新命中 frame。

### 10.2 显式恢复

只有以下情况才使用 `recoveryText`：

- 当前 host chat 缺少这个 run 的真实楼层；
- 用户明确选择“从本地存档重建宿主楼层”；
- 系统先展示将新增/替换的楼层数量与目标 chat，用户确认后执行。

恢复流程：

```text
按 manifest locator range-read 并校验 recovery frames
-> 创建新的真实 user/assistant messages
-> 回读 marker/text/hash
-> 记录新的 lastKnownMessageId
-> append locator correction 并发布新的 manifest/slot
```

已有真实楼层与恢复镜像冲突时绝不自动覆盖。默认结果是 `host-conflict`，保留两边并要求人工选择。

恢复是在重建记录，不是在重新演出一遍剧情。它不得重发 `MESSAGE_SENT`、不得调用 `/trigger await=true`、不得重新触发生成、qrf、世界书或数据库副作用；插件自有数据是否可恢复必须由插件自己的合同处理。

### 10.3 v2/v3 迁移

- 旧 v2/v3 先保持只读，禁止打开即删除或覆盖。
- host 已有完整 marked floors：从 host 建索引，旧 archive 只供校验。
- host 没有真实 floors：把旧 chatLog 作为“待恢复源”，必须走显式恢复流程。
- 新 v5 root 回读通过后才标记迁移完成。
- 不需要新增一组“迁移状态/通知/辅助/诊断”模块来证明迁移存在；一个 importer、一份 journal、可执行合同足够。

## 11. TT/ST 能力边界

| 能力 | SillyTavern 当前 release | TauriTavern 当前 main | 本方案 |
| --- | --- | --- | --- |
| 真实 chat 数据 | 完整 `chat[]` | ChatSurface 合同仍视聊天为数据事实 | 正文权威 |
| DOM 有界 | `chat_truncation` + `showMoreMessages()` | ChatSurface virtual projection，最多 32 viewport items | 不自行展开宿主 DOM |
| 后端历史读取 | 当前标准接口会保存/读取完整 JSONL | 已有 tail/before cursor 的 windowed payload 读取 | adapter 能力探测 |
| `.imcp` 物理子目录/append/range | 当前标准 upload 均不提供 | 当前标准 upload 均不提供 | full bridge 才能通过完整性能合同 |
| 图片资产 | 独立 images 路径 | 独立 image route | 继续按 content hash 外置 |

宿主消息能力和存档文件能力是两组不同合同，禁止再混成一个“TT/ST 已支持”布尔值：

```ts
type HostTimelineCapabilities = {
  boundedRead: boolean;
  createMessages: boolean;
  updateMessages: boolean;
  deleteMessages: boolean;
  nativeTrigger: boolean;
};

type SaveFileCapabilities = {
  wholeFileRead: boolean;
  wholeFileWriteAndReadBack: boolean; // 小型 registry/manifest/slot
  physicalDirectories: boolean;
  append: boolean;
  rangeRead: boolean;
  stat: boolean;
  list: boolean;
  deleteFile: boolean;
  deleteTree: boolean;
};
```

full bridge 在已有小 JSON 整文件读写之外至少提供：

```text
mkdir(relativePath)
append(relativePath, bytes, expectedSize)
readRange(relativePath, offset, length)
stat(relativePath)
list(relativePath)
deleteFile(exactVolumeRelativePath)
deleteTree(exactRunRelativePath)
```

`list` 只用于迁移、修复和 GC，正常打开必须从 registry/manifest 定位，禁止扫描整个 run。`deleteFile` 只删除经可达性检查后已无任何 A/B 引用的精确旧卷；`deleteTree` 只删除最后一个 slot 已移除的精确 run 目录。整文件覆盖未证明底层原子 replace 时不得叫“atomic”；正确性来自 inactive A/B、checksum、关闭后的 read-back 和 revision 冲突检查。

物理目录支持本身不是成熟度证明。只有目录、append、range read、stat 和小根文件回读全部实测通过，才能报告 full bridge；缺任一关键能力都进入明确 degraded backend。现有 patch 必须按 TT/ST 各自当前代码重新基线，不能盲目套旧补丁。

## 12. 模块边界

只新增能形成明确边界的模块：

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| `host-timeline-adapter` | bounded read、marker 校验、create/update/delete、locator 修复 | prompt、存档文件 |
| `save-pack-codec` | frame 编解码、压缩、hash、continuation、state patch/checkpoint | 文件 I/O、host 消息 |
| `save-index-repository` | manifest/slot/index/volume 提交、分支可达性与读取 | DOM、host 消息副作用 |
| `message-window-store` | Reader/生成/摘要的有界窗口 | 永久存储 |
| `save-file-bridge` | 受限路径、whole-file、append/range/stat/list/deleteTree | 业务楼层含义 |

`index.ts` 只装配这些模块。导入、恢复、GC 是 repository/bridge 的命令，不再向 `index.ts` 塞第二套入口。

## 13. 为什么 Claude 7 月 30 日方案失败

其中有三个判断值得保留：活跃块旧 hash 会制造垃圾版本；逐层 revision 会扩大失效；正文、状态和图片需要不同生命周期。

失败发生在这些地方：

1. 没先纠正权威模型，仍把本地 archive 当正文源，忽略真实 host floors。
2. 固定 128 层建立在平均压缩比上，没有用硬字节上限保护长尾。
3. 为了“删一个文件夹”放弃跨 slot 共享，明确接受每个分支复制整份历史，与减少文件/体积目标冲突。
4. 活跃 journal 仍使用新 hash 文件名，文件数依赖立即 GC。旧 A/B/C 方案虽然限制了文件名，却仍会反复整包重写增长中的 active JSON；它不是当前 pack-volume 方案。
5. 新增 v4 模块没有接到生产 repository，测试只验证新纯函数，不能证明真实保存链。
6. `image-gallery.ts` 引用不存在的 `IDB_STORE_V4`，新增 store 又没有升级 IDB schema version。
7. 恢复入口重复进入 `index.ts`，read capability 与 write/upload probe 混在一起。
8. 大量“完成报告”替代了可执行验收，最终文档自己的已知问题与完成结论矛盾。

正确学习方式是保留它对写放大和生命周期的观察，丢弃“模块越多越像完成”和“复制历史换删除方便”的实现。

## 14. 明确拒绝的方案

| 方案 | 拒绝原因 |
| --- | --- |
| 本地 archive 作为正常正文权威 | 与用户确认的真实楼层权威冲突 |
| 一个 30 MiB JSON | 每次 stringify/base64/回读都复制整包，不能懒加载 |
| 一层一个文件 | 楼层数直接等于文件数 |
| 只把 chunk 16 改成 128 | 不修全量 hydrate、全量 republish 和垃圾版本 |
| 每个 save slot 独占完整历史 | 手动档数量乘以历史体积 |
| 每次 active 保存使用新 hash 文件 | 没有 GC 就无限增文件 |
| 固定 active A/B/C 大 JSON | 文件名有界，但每回合仍整包序列化和覆盖 |
| 把状态/摘要/MemoryDB 塞进 host message metadata | 直接放大宿主 JSONL |
| 用本地镜像自动覆盖 host | 破坏真实楼层权威且可能覆盖玩家手工编辑 |
| 依赖物理目录才可保存 | 当前 upstream TT/ST 都不支持该上传参数 |
| gzip 当作根治 | 只减字节，不解决全量读取、文件版本和权威冲突 |

## 15. 实现顺序和授权边界

### Loop 1：真实楼层提交与 locator

- 实现 `HostTimelineAdapter`。
- 保持当前 prompt 文本和状态结算语义。
- 建立真实 user/assistant 楼层和 marker。
- 实战验收 host message 链。

这一步会改变真实宿主消息，开始实现前需要用户明确授权。

### Loop 2：有界运行时窗口

- 把 `uiMessages` 消费者分为 Reader、prompt、摘要、导出和维护操作。
- 正常打开不再 full hydrate。
- 执行 100/1000/3000 层内存与延迟基准。

### Loop 3：v5 Pack Volume 与文件桥

- 实现 8 MiB `.imcp` volume、独立 256–512 KiB frame、continuation 和 hash 校验。
- 实现周期 checkpoint + state patch、卷内 index snapshot/delta、manifest/slot A/B。
- 扩展 `savesolt` 桥的受限目录、append、range-read、stat、list、deleteTree 能力。
- 浏览器 IndexedDB 与本机 bridge 使用相同逻辑合同，但分别报告实际 I/O 证据。

### Loop 4：恢复、迁移、导出和 GC

- 显式 host 重建。
- v2/v3 只读 importer。
- 流式导出。
- 最后做 v2/v3 importer、显式宿主重建、流式导出和保守 compaction/GC。

不允许四个 loop 一次强行 merge。每个 loop 都要真实证据，尤其不能让纯函数测试替宿主链验收。

## 16. 可执行成功合同

| 合同 | 通过条件 |
| --- | --- |
| H01 真实楼层 | 一次 UI 回合产生可回读的真实 user/assistant IDs，marker/floorId/text 精确一致 |
| H02 host 优先 | 手工编辑 host 正文后重开，UI 显示 host 新文本，本地旧镜像不覆盖 |
| H03 写失败可见 | host assistant 写入失败时 slot head 不前进，UI 不显示保存成功 |
| W01 有界打开 | 1000 层打开不出现 `0-{{lastMessageId}}`、`streamArchiveFloors()` 或全量 `uiMessages` |
| W02 窗口上限 | 稳态 Reader 最多 16 层，host 一次预取最多 32 条消息 |
| P01 Encoder | 冻结真实 3000 层 fixture，gzip/identity 分别报告 canonical/stored bytes、frame/volume 数；每卷 <= 8,388,608 B，每个非 continuation canonical payload <= 512 KiB、stored payload <= 576 KiB |
| P02 自动保存 | 在当前卷空间足够时连续 100 次 autosave 新增文件名为 0；给定相同新楼层与当前 checkpoint 大小时，floor/index/manifest/slot 的 calls 与 bytes 不随既有 100/1000/3000 层增长 |
| P03 Range read | full bridge 打开 head 并随机读取 100 个楼层时只读取各自精确 offset/length，不读取完整 `.imcp`；flat/IDB 结果单独报告 |
| P04 单点编辑 | host 编辑第 50 层并回读后只 append correction/index；旧卷前缀逐 byte 不变，其他 floor locator/hash 不变，不全量读历史 |
| P05 崩溃矩阵 | 分别在 data append、回读、index append、manifest write、slot write 中断；重开只能得到完整旧 head 或完整新 head，未引用尾部不提交 |
| P06 手动存档 | 新建 manual slot 固定增加 2 个小 JSON、0 个 volume，已有 volume hash 不变 |
| P07 Compaction | >25% obsolete fixture 压实前不删旧卷；所有有效 slot 内容一致且 manifest A/B 都不引用旧卷后才删除 |
| P08 容量报告 | 3000 层 gzip 规划目标为 5–10 卷、每 run 9–14 文件；实测超出必须原样报告，不允许改 fixture 自证 |
| R01 root 回退 | 最新 manifest/slot 损坏时使用上一完整 A/B revision，并标记 degraded |
| R02 显式恢复 | host 为空时由 recovery mirror 重建，完成后逐条回读校验，不静默覆盖冲突 |
| B01 分支隔离 | 编辑共享祖先产生新 branch/floorVersion，旧 manual slot 仍读到原版本 |
| I01 图片独立 | 图片重生成不改 host 正文，只 append 新引用记录，正文在图片缺失时仍可读 |

验收状态只能写 `passed`、`failed` 或 `not run`。自动测试是证据，不是玩家接受。

四条链路分别报告：

- 生成链；
- host message 链；
- 插件/数据库链；
- UI 镜像链。

## 17. 当前结论

[executed] 本轮样本测量与文档静态检查完成；8 MiB pack-volume 合同已写入本文。

[inspected] 当前 `main` 仍停在 `2bafefc`，落后 `origin/main` 17 个提交；本方案不依赖合并这些提交。

[not run] 没有修改生产代码，没有构建，没有 TT/ST 实机写入，也没有人工验收。P01–P08、H01–H03、W01–W02、R01–R02、B01、I01 当前全部是待执行合同，不是通过报告。

下一次真正实现应从 Loop 1 开始，而不是先写 v5 文件格式。没有真实 host floor，后面的“游戏存档索引”只会再次变成另一套自说自话的聊天存档。

### 新对话开工边界

本文静态检查通过后可以开新对话，但一次只授权一个 loop。第一轮建议明确写成：

```text
只实施本文 Loop 1：真实楼层提交与 locator。
不合并 2026-07-30 的 17 个远端提交；不实施 pack volume、迁移或 GC；
不改变 prompt 语义、世界书路由、shujuku/ACU 时机、数据库行为和 hidden-floor 行为。
完成后分别报告生成链、host-message 链、插件/数据库链、UI 镜像链，
状态只用 passed / failed / not run；本地 mock 不能替代真实 TT/ST 证据。
```

Loop 1 实战验收后再授权 Loop 2 或 Loop 3。不要在新对话里一次强制实现四个 loop，也不要把 Claude 的远端提交先 merge 进来再修。

## 18. 联网依据

- [SillyTavern `showMoreMessages` / `printMessages`](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/script.js#L1431-L1484)：完整 `chat[]` 与有界 DOM 是两层；`chat_truncation` 只控制显示批次。
- [SillyTavern `trySaveChat`](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/src/endpoints/chats.js#L457-L467)：当前保存仍将整个 chat 数组序列化为 JSONL。
- [SillyTavern files upload](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/src/endpoints/files.js#L28-L47)：当前上游上传接口没有目录参数。
- [TauriTavern ChatSurface contract](https://github.com/Darkatse/TauriTavern/blob/d2d10fe5e4578179daa35c45af469781c1e6ab5d/docs/API/ChatSurface.md)：完整聊天是数据事实，DOM 是可丢弃的有界投影。
- [TauriTavern windowed payload](https://github.com/Darkatse/TauriTavern/blob/d2d10fe5e4578179daa35c45af469781c1e6ab5d/src-tauri/crates/tt-adapter-storage-core/src/repositories/file_chat_repository/windowed_payload.rs)：当前已有 tail/before cursor 的 JSONL 分窗读取。
- [TauriTavern bounded ChatSurface](https://github.com/Darkatse/TauriTavern/blob/d2d10fe5e4578179daa35c45af469781c1e6ab5d/src/tauri/main/services/chat-surface/bounded-chat-surface.js)：宿主维护有界 message projection。
- [TauriTavern files upload route](https://github.com/Darkatse/TauriTavern/blob/d2d10fe5e4578179daa35c45af469781c1e6ab5d/src/tauri/main/routes/resource-routes.js#L52-L68)：当前上游同样没有目录参数。
- [Claude 交接 commit](https://github.com/eriribot/islandmilfcode/commit/6cebda2782e77cd1da26f1f5f32183a9f27e3f97)：用于事故分析，不作为待合并实现。
# 状态：已撤销

用户已明确恢复 `#0 iframe-only` 架构。本设计中的真实 hidden host user/assistant 楼层、locator 和 host-authoritative 重开不再接入生产流程；本文仅保留为历史设计记录，不得作为当前实现依据。
