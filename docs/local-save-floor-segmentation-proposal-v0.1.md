# 本地存档楼层分块方案讨论稿 v0.1

> 目的：这份文档用于讨论 TT/TauriTavern 与 SillyTavern 环境下，如何把 IslandMilfCode 的完整历史存档拆成更少、更稳定、可懒加载的本地文件。
>
> 结论先行：我不满意“直接把 `FLOOR_CHUNK_SIZE` 改成某个数字”的方案。成熟方案应该是“每个存档一个逻辑目录/前缀 + 楼层范围 segment + 小 manifest/root + 宿主窗口化渲染”。楼层边界不是一个孤立常量，而是一套同时约束楼层数、字节数、热窗口和恢复点的策略。

## 1. 现在真正的问题

### 1.1 不是图片没分出去，而是宿主和存档都在被完整历史拖住

[assumed] 你已经把 CG/图片主体外置了，所以后续方案不再把“继续拆图片”当作主要答案。

[inspected] 当前项目已经有 v3 归档骨架：`root -> floor-index page -> floor-chunk`，代码位置在 [`state/archive-repository.ts`](../state/archive-repository.ts)，当前常量是：

```ts
const FLOOR_CHUNK_SIZE = 16;
const INDEX_PAGE_CHUNK_COUNT = 128;
const FLOOR_CACHE_LIMIT = 24;
```

这说明系统已经不是完全“一个巨大 JSON”的思路，但现有边界仍偏保守：16 层一个块对性能很安全，但长期档的 floor chunk 文件数量会偏多。

[executed] 用本仓库样本 `artifacts/live-save-baseline-before-v07-simulation.json` 估算，样本本身约 30.7 MiB，内部单条消息大小有明显长尾：

| 指标 | 消息 JSON 字节数 |
|---|---:|
| p50 | 约 16 KiB |
| p75 | 约 22 KiB |
| p90 | 约 26 KiB |
| p95 | 约 45 KiB |
| p99 | 约 89 KiB |
| max | 约 127 KiB |

这意味着“按楼层切块”不能只看平均值。大多数楼层很轻，但长文本、状态快照、旧字段兼容、摘要和插件残留会让某些块突然变厚。

### 1.2 TT/ST 的卡顿有两个来源，不能混成一个

第一类是存储层卡顿：读取、解析、base64 转换、回读校验、上传下载都在处理太大的 JSON 或太多文件。

第二类是宿主渲染卡顿：TT/ST 聊天页如果继续持有完整历史 `chatLog`，即使磁盘已经分块，渲染层仍然可能被高楼层拖慢。

所以本地存档分块只能解决一半；另一半必须是宿主内只保留当前窗口。否则就是“硬盘上分了块，页面里还是一整坨”。

### 1.3 为什么 Steam 式单文件不能直接照搬

Steam 游戏一个 30 MiB 单档通常是原生文件读写，甚至可能是二进制、压缩块、内存映射或游戏自己控制的 I/O。

TT/ST 里的 `user/files` 不是同一种东西：

- [inspected] 当前项目文档已记录 TT 移动端 `user/files` 单文件内联读取上限为 16 MiB，超过会失败；见 [`docs/local-save-performance-calendar-next-loop-v0.3.md`](./local-save-performance-calendar-next-loop-v0.3.md)。
- [inspected] 本地桥目前通过 `/api/files/upload` 上传 JSON，需要 JSON stringify、UTF-8/base64、宿主回读和再次解析。
- [assumed] 即使低于 16 MiB，WebView 里一次性读大 JSON 也会制造明显内存峰值。

所以“一个 30 MiB JSON 存档文件”在 TT/ST 里不是成熟，是把风险集中到一个不可分页的大对象上。

### 1.4 为什么“一层一个文件”也不行

一层一个文件看起来最懒加载，但会把 1000 层变成 1000 个正文文件，再叠加 root、index、state、summary、memory、image manifest、旧 revision 和 GC 残留。

这会重新制造你在另一台电脑看到的“几百上千个存档文件”问题。文件系统、宿主文件 API、目录列表、回收流程都会变烦。

正确单位应该是“楼层范围 segment”，不是单楼层文件。

## 2. 设计目标

这个方案必须同时满足这些目标：

| 目标 | 说明 |
|---|---|
| 完整历史 | 本地 archive 是完整权威来源，不能为了性能截断旧楼层。 |
| 文件数量可控 | 文件数量随楼层范围增长，不随保存次数无限增长。 |
| 单文件有界 | 任意 JSON 文件远低于 TT 移动端 16 MiB 限制。 |
| 可懒加载 | 进入存档、跳楼层、向上翻页都只读必要 segment。 |
| 宿主减压 | TT/ST 聊天页只承载当前窗口，不继续持有完整历史。 |
| 可恢复 | 保留当前 root 和上一 root；新 root 验证前旧 root 仍是权威。 |
| 可迁移 | 玩家看到的是每个存档一个逻辑文件夹/前缀，而不是一坨无意义散件。 |
| 可降级 | 宿主不支持目录时退回扁平文件名，但逻辑上仍按 save 分组。 |

## 3. 推荐总体结构

每个游戏存档使用一个逻辑目录。如果宿主文件 API 支持目录，就真的放目录；如果不支持，就由 `savesolt` 桥使用安全扁平文件名模拟目录。

推荐逻辑结构：

```text
user/files/islandmilfcode-v4/
  registry.json
  saves/<saveToken>/
    manifest.json
    roots/
      root-r000123-<hash>.json
      root-r000122-<hash>.json
    indexes/
      floor-index-000000-<hash>.json
    segments/
      floors-000000-000023-<hash>.json
      floors-000024-000047-<hash>.json
      floors-000048-000071-<hash>.json
    state/
      state-r000123-<hash>.json
    summary/
      summary-<hash>.json
    memory/
      memory-<hash>.json

user/images/islandmilfcode-v4-images/<saveToken>/
  <contentHash>.<ext>
```

扁平 fallback 例子：

```text
islandmilfcode-v4-<saveToken>-segments-floors-000000-000023-<hash>.json
```

这样玩家概念上看到的是“一个存档一个目录”，宿主不支持目录时也不会退回巨型 bundle。

## 4. 楼层边界方案

### 4.1 我建议把“边界”分成四层

| 边界 | 推荐值 | 用途 |
|---|---:|---|
| UI 热窗口 | 当前楼层 ±2 到 ±3 | TT/ST 页面实际渲染的楼层。 |
| 生成上下文窗口 | 最近约 12 层 + 摘要/记忆 | prompt 构造需要的近期上下文。 |
| 存档 segment | 目标 24 层，最多 32 层 | 本地楼层正文块。 |
| index page | 128 个 segment | root 不直接列出所有楼层块。 |

关键点：UI 窗口和存档 segment 不是同一个东西。UI 可以只显示 5 到 7 层，但磁盘一个 segment 可以装 24 到 32 层。

### 4.2 推荐默认策略

我建议 v4 使用“楼层数 + 字节数”的组合策略：

```text
segment target floors: 24
segment max floors:    32
segment soft bytes:    1 MiB
segment hard bytes:    2 MiB
index page size:       128 segments
```

封块规则：

1. 从某个 `startFloor` 开始写当前 active segment。
2. 如果达到 24 层，并且序列化后接近或超过 1 MiB，就封块。
3. 如果没有到 1 MiB，可以继续装到 32 层。
4. 如果还没到 24 层但已经超过 2 MiB，立即封块。
5. 如果单个楼层本身超过 2 MiB，说明正文或状态里混入了不该进楼层块的大对象，应报可恢复错误，并把大对象改成资源引用，而不是硬塞进 segment。

这比单纯“每 24 层一个文件”成熟，因为它承认楼层重量有长尾。

### 4.3 为什么不是 16、48 或 100

| 候选 | 判断 |
|---|---|
| 16 层 | 当前实现的安全档；单块小，但长期文件数偏多。 |
| 24 层 | 我推荐的保守默认；能明显减少文件数，同时上传/回读仍轻。 |
| 32 层 | 可作为上限；桌面端大概率没问题，但移动端和长文本档要靠字节上限兜住。 |
| 48 层 | 文件数更好看，但 active segment 重写成本变高，长文本档可能变钝。 |
| 100 层 | 对文件数友好，但不像懒加载块，更像中型 bundle；不适合作为默认。 |

用 3000 层估算 floor segment 数量：

| 每块楼层 | 3000 层约需要 |
|---:|---:|
| 16 | 188 个 segment |
| 24 | 125 个 segment |
| 32 | 94 个 segment |
| 48 | 63 个 segment |
| 100 | 30 个 segment |

这里不能只追求 30 个文件。因为 autosave 会频繁写 active segment，块越大，每次写入、hash、base64、回读校验越重。

所以我的判断是：默认 24，允许 32，靠字节上限提前封块。这样不追求漂亮数字，追求长期稳定。

## 5. TT/ST 如何联动

### 5.1 宿主聊天不是权威历史

TT/ST 的聊天页只作为“当前可见窗口”和交互壳：

```text
宿主 chat window:
  最近 5～7 层正文
  当前输入/生成状态
  archive pointer: saveId, rootHash, currentFloor
  必要摘要提示
```

完整历史在本地 archive：

```text
ArchiveRepository:
  getFloor(saveId, floorIndex)
  getFloorWindow(saveId, centerFloor, radius)
  getPromptContext(saveId)
  truncateAfterFloor(...)
  streamAllForExport(...)
```

向上滚动或跳转楼层时，桥层按 `floor-index` 找到对应 segment，只 materialize 那一小段到宿主页面。

### 5.2 TT 和 ST 的差异只留在桥层

业务层不应该判断“这是 TT 还是 ST”。业务层只问：

```text
local archive backend 能不能:
  写 JSON 对象
  读 JSON 对象
  写图片资源
  读图片资源
  提交 root
  回读 registry
```

`savesolt` 桥负责把这些动作翻译成 TT/ST 的文件 API。目录支持、扁平 fallback、上传路径差异都不要漏到游戏业务里。

## 6. 保存与恢复流程

### 6.1 autosave

一次普通 autosave 不应该写全档：

```text
1. 写当前 dirty floor 或 active segment
2. 写当前 state/checkpoint
3. 写受影响的 floor-index page
4. 写新 root
5. 最后更新 registry 指针
6. 回读 registry/root 校验 hash 和 revision
```

只有 registry 指到新 root 后，新 revision 才算提交成功。

### 6.2 root A/B 回退

registry 对每个存档至少保留：

```text
currentRootHash
previousRootHash
revision
updatedAt
```

当前 root 读不回来时，尝试上一 root。上一 root 也读不回来，报告具体缺失的 index page 或 segment，不返回半份存档。

### 6.3 GC 不是正确性的前提

[inspected] 现有桥已经有 registry tombstone 和延迟 GC 设计，见 [`savesolt/导入到酒馆中/README.md`](../savesolt/导入到酒馆中/README.md)。

GC 只能用来减少旧文件，不能作为“存档是否正确”的前提。即使 GC 因 Web Locks、移动端或宿主限制失败，存档也必须可玩，只是垃圾文件下次再清。

## 7. 迁移方案

迁移旧 v3/v2 文件时不要删除旧文件。

推荐迁移顺序：

1. dry-run 扫描旧 registry/root/index/chunk，生成迁移报告。
2. 验证所有楼层连续、状态可恢复、图片引用可读。
3. 写入新的 v4 目录/前缀。
4. 回读 manifest/root/index/segments 并校验 hash。
5. 发布新的 active pointer。
6. 保留旧 v3/v2 文件，只把它们标为 legacy source。
7. 未来如果要清理，单独做 dry-run 清理工具，列出明确文件名，人工确认后再删。

这一步不要碰剧情、prompt、世界书、hidden floor、shujuku 或同层桥链路。

## 8. 验收标准

这个方案是否成功，不看“文件夹漂不漂亮”，看下面这些合同：

| 场景 | 验收 |
|---|---|
| 进入 1000 层存档 | 不读取完整历史，只读 registry、root、state、当前 index page、当前 segment。 |
| 第 1000 层跳第 50 层 | 通过 index 直达目标 segment，不扫描前 950 层。 |
| 连续 autosave 20 次 | 文件数不按保存次数线性暴涨，只改 active segment/root/registry 和必要索引。 |
| 单块过大 | 提前封块或报告具体大对象，不生成 16 MiB 附近的大 JSON。 |
| 宿主页面回看 | 页面只持有当前窗口，不因为历史总层数增长而全量渲染。 |
| 当前 root 损坏 | 自动尝试 previous root，并给出 degraded 提示。 |
| 桥不可用 | 浏览器侧仍能保存和继续玩，本地同步显示 pending。 |

## 9. 我的最终建议

我建议分两步：

第一步，短期 v3 修正：

```text
固定 chunkSize 从 16 调到 24
保留 indexPageChunkCount = 128
保持当前 root/index/chunk 结构
增加 chunk byteLength 记录和过大警告
```

这是低风险、容易验证的版本。它能把 floor chunk 文件数减少约三分之一，但不宣称彻底解决所有高楼层压力。

第二步，成熟 v4：

```text
每存档逻辑目录/前缀
segment 使用 startFloor/endFloorExclusive，不再依赖固定 floor/chunkSize 公式
24 层目标、32 层上限、1 MiB soft、2 MiB hard
宿主只保留热窗口
local archive 作为完整历史权威
manifest/root 只保存指针和校验信息
```

我会把第二步作为真正方案。第一步只是止血，不是终局。

## 10. 需要拿出去讨论的问题

下面这几个问题适合拿给其他人商讨：

1. 默认 segment 是 24 层还是 32 层？我偏 24，因为 TT/ST 的 WebView 和 base64 传输比原生游戏更脆。
2. 是否接受 v4 把 `chunkSize` 固定公式改成 range index？我建议接受，因为字节上限和固定公式天然冲突。
3. 宿主聊天窗口到底保留 ±2 还是 ±3 层？我偏 ±2，向上滚动时预取。
4. 是否要做“桌面 profile”和“移动 profile”？我倾向先不要，默认策略统一，后续靠真实 chunk 统计再调。
5. 玩家看到的目录是否必须是真的目录？我建议逻辑目录优先，宿主不支持时扁平 fallback。

