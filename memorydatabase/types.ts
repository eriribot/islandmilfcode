/** 数据库 schema 版本号，非兼容变更时递增 */
export const MEMORY_DB_VERSION = 1;

// ── 写入来源标识 ──

/** 标记每行数据由哪个 commit 点产生 */
export type CommitSource =
  | 'summary-minor'       // 小摘要生成后
  | 'summary-major'       // 大摘要生成后
  | 'summary-global'      // 全局摘要压缩后
  | 'progress-commit'     // 主回复 progress 分析提交
  | 'phone-directive'     // 手机指令分析提交
  | 'phone-scene-extract' // 手机场景提取提交
  | 'manual'              // 手动写入（调试/编辑器）
  | 'migration';          // 从旧 SummaryStore 迁移

/** 数据置信度，高置信度行不会被低置信度覆盖 */
export type MemoryConfidence = 'low' | 'medium' | 'high' | 'certain';

// ── 所有表行的基类 ──

/** 每张表的每一行都继承此结构 */
export type MemoryBaseRow = {
  /** 行唯一 ID（UUID） */
  id: string;
  /** 创建时间（ISO） */
  createdAt: string;
  /** 最后修改时间（ISO） */
  updatedAt: string;
  /** 产生此行的 commit 点 */
  source: CommitSource;
  /** 来源消息索引范围 [起始楼层, 结束楼层] */
  sourceRange?: [number, number];
  /** 重要度 1-5，用于检索排序 */
  importance?: number;
  /** 置信度 */
  confidence?: MemoryConfidence;
  /** 自由标签，用于检索过滤 */
  tags?: string[];
  /** 软删除标记，true 表示已失效 */
  expired?: boolean;
  /** 被哪一行覆盖（指向新行 ID） */
  supersededBy?: string;
  /** 同一事实重复出现时只更新此字段 */
  lastSeenAt?: string;
  /** 前向兼容：未来新增字段放这里，旧代码忽略 */
  extra?: Record<string, unknown>;
};

// ── 实体表 ──

/** 角色、玩家、地点、组织等实体登记 */
export type MemoryEntityRow = MemoryBaseRow & {
  kind: 'character' | 'player' | 'location' | 'organization' | 'concept';
  /** 实体唯一标识（对应 targetId 或自定义 ID） */
  entityId: string;
  /** 显示名 */
  name: string;
  /** 别名列表，用于模糊匹配 */
  aliases?: string[];
};

// ── 事件表 ──

/** 已发生的叙事事件 / 剧情节点 */
export type MemoryEventRow = MemoryBaseRow & {
  /** 事件短标题 */
  title: string;
  /** 事件详细描述 */
  description: string;
  /** 故事内时间 */
  gameTime?: string;
  /** 发生地点 */
  location?: string;
  /** 涉及角色 ID 列表 */
  involvedTargetIds?: string[];
  /** 关联的主线事件 ID */
  relatedMainEventId?: string;
  /** 事件结果 / 后续影响 */
  outcome?: string;
};

// ── 事实表 ──

/** 事实分类，对应旧 KeyFact 的 category */
export type MemoryFactCategory =
  | 'promise'   // 承诺
  | 'secret'    // 秘密
  | 'relation'  // 关系
  | 'item'      // 物品
  | 'event'     // 事件
  | 'location'  // 地点
  | 'profile'   // 人物设定
  | 'custom';   // 自定义

/** 稳定事实（从旧 KeyFact 迁移 + 新提取） */
export type MemoryFactRow = MemoryBaseRow & {
  category: MemoryFactCategory;
  /** 事实主体（谁/什么） */
  subject: string;
  /** 事实内容 */
  content: string;
  /** 关联实体 ID */
  relatedEntityIds?: string[];
};

// ── 关系表 ──

/** 角色间 / 角色与玩家间的关系 */
export type MemoryRelationRow = MemoryBaseRow & {
  /** 关系发起方（targetId 或 'player'） */
  fromId: string;
  /** 关系接收方 */
  toId: string;
  /** 关系标签：暗恋、竞争、信任等 */
  label: string;
  /** 关系阶段 */
  stage?: string;
  /** 关系亲密度数值 */
  affinity?: number;
  /** 互斥组：同组只保留最新 active 行 */
  exclusiveGroup?: string;
  /** 形成原因 */
  reason?: string;
};

// ── 印象表 ──

/** 角色对玩家（或对事件）的印象 */
export type MemoryImpressionRow = MemoryBaseRow & {
  /** 持有印象的角色 ID */
  targetId: string;
  /** 印象对象（玩家行为、事件、另一角色） */
  subject: string;
  /** 印象标签 */
  label: string;
  /** 情感极性：-1 负面 / 0 中性 / 1 正面 */
  polarity: -1 | 0 | 1;
  /** 印象权重 -5 ~ +5 */
  weight: number;
  /** 产生原因 */
  reason?: string;
};

// ── 任务表 ──

export type MemoryTaskStatus = 'pending' | 'done' | 'expired' | 'archived';

/** 承诺、待办、约定等可追踪事项 */
export type MemoryTaskRow = MemoryBaseRow & {
  /** 任务发起者 */
  ownerId?: string;
  /** 任务关联角色 */
  targetId?: string;
  /** 任务内容 */
  content: string;
  /** 触发条件 */
  trigger?: string;
  /** 截止时间（故事内） */
  deadline?: string;
  /** 当前状态 */
  status: MemoryTaskStatus;
  /** 完成时间 */
  resolvedAt?: string;
};

// ── 秘密表 ──

/** 秘密：特定角色知道但其他人不知道的信息 */
export type MemorySecretRow = MemoryBaseRow & {
  /** 秘密主题 */
  subject: string;
  /** 秘密内容 */
  content: string;
  /** 知情者列表（targetId 或 'player'） */
  knownBy: string[];
  /** 必须隐瞒的对象 */
  hiddenFrom?: string[];
  /** 暴露风险等级 */
  risk: 'low' | 'medium' | 'high';
  /** 是否已暴露 */
  revealed: boolean;
};

// ── 物品表 ──

/** 物品归属、位置、状态变化记录 */
export type MemoryItemRow = MemoryBaseRow & {
  /** 物品名 */
  name: string;
  /** 所有者 */
  ownerId?: string;
  /** 当前持有者（可能与所有者不同） */
  holderId?: string;
  /** 物品所在位置 */
  location?: string;
  /** 物品状态描述 */
  state?: string;
  /** 变动类型 */
  action?: 'gained' | 'lost' | 'transformed' | 'noted';
  /** 数量 */
  count?: number;
};

// ── 手机消息索引表 ──

/** 手机消息的可检索索引（正文仍在 PhoneMessageStore） */
export type MemoryPhoneMessageRow = MemoryBaseRow & {
  /** 对话对象角色 ID */
  targetId: string;
  /** 消息角色 */
  role: 'user' | 'assistant';
  /** 消息唯一 ID（用于去重） */
  messageId: string;
  /** 消息预览文本 */
  textPreview: string;
  /** 故事内时间 */
  time?: string;
  /** 关联事件 ID */
  linkedEventId?: string;
};

// ── 摘要表 ──

export type MemorySummaryLevel = 'minor' | 'major' | 'global';

/** 压缩摘要视图（minor / major / global） */
export type MemorySummaryRow = MemoryBaseRow & {
  /** 摘要层级 */
  level: MemorySummaryLevel;
  /** 覆盖的消息索引范围 */
  range: [number, number];
  /** 摘要正文 */
  text: string;
  /** 被此摘要压缩的行 ID 列表 */
  coveredRowIds?: string[];
  /** 被此摘要压缩的下级摘要 ID 列表 */
  coveredSummaryIds?: string[];
};

// ── 角色属性变化表（核心扩展点） ──

/**
 * 记录角色变量的每次变化。
 * StatusData 是当前快照，这里是变化轨迹。
 * 新变量（执念度、嫉妒度等）不需要改 schema，直接用不同的 key 即可。
 */
export type MemoryAttributeRow = MemoryBaseRow & {
  /** 角色 ID 或 'player' */
  targetId: string;
  /** 属性键名：'affinity' | '执念度' | 'jealousy' 等任意自定义键 */
  key: string;
  /** 变化后的值（统一字符串存储） */
  value: string;
  /** 值的实际类型提示，方便反序列化 */
  valueType?: 'number' | 'string' | 'boolean' | 'json';
  /** 变化前的值 */
  previousValue?: string;
  /** 数值型变量的差值，便于快速查"涨了多少" */
  delta?: number;
  /** 变化原因 */
  reason?: string;
};

// ── 数据库容器 ──

/** IslandMemoryDB：完整的内存数据库，跟存档一起序列化 */
export type IslandMemoryDB = {
  /** schema 版本号 */
  version: number;
  /** 所属存档的 runId */
  runId: string;
  /** 已处理到的消息索引（游标） */
  lastProcessedIndex: number;

  // 核心表
  entities: MemoryEntityRow[];
  events: MemoryEventRow[];
  facts: MemoryFactRow[];
  relations: MemoryRelationRow[];
  impressions: MemoryImpressionRow[];
  tasks: MemoryTaskRow[];
  secrets: MemorySecretRow[];
  items: MemoryItemRow[];
  phoneMessages: MemoryPhoneMessageRow[];
  summaries: MemorySummaryRow[];
  attributes: MemoryAttributeRow[];

  /** 扩展表注册位：未来新增表放这里，旧代码忽略，新代码 type-narrow 读取 */
  extensions?: Record<string, MemoryBaseRow[]>;
};

// ── 写入批次（commit 点使用） ──

/** 插入行的类型：省略基类字段和 source（由 batch 统一填充） */
type InsertPayload<T extends MemoryBaseRow> = Omit<T, keyof MemoryBaseRow | 'source'>;

/** 一次 commit 点可以插入的所有表 */
export type MemoryInserts = {
  entities?: InsertPayload<MemoryEntityRow>[];
  events?: InsertPayload<MemoryEventRow>[];
  facts?: InsertPayload<MemoryFactRow>[];
  relations?: InsertPayload<MemoryRelationRow>[];
  impressions?: InsertPayload<MemoryImpressionRow>[];
  tasks?: InsertPayload<MemoryTaskRow>[];
  secrets?: InsertPayload<MemorySecretRow>[];
  items?: InsertPayload<MemoryItemRow>[];
  phoneMessages?: InsertPayload<MemoryPhoneMessageRow>[];
  summaries?: InsertPayload<MemorySummaryRow>[];
  attributes?: InsertPayload<MemoryAttributeRow>[];
};

/**
 * 写入批次：一个 commit 点产生的所有变更打包在一起，同步原子应用。
 * 不是异步队列，不是 mutation queue——直接改内存对象。
 */
export type MemoryWriteBatch = {
  /** 本批次的来源 */
  source: CommitSource;
  /** 要插入的行（ID 和时间戳由 commitBatch 自动填充） */
  inserts?: MemoryInserts;
  /** 要软删除的行：表名 -> 行 ID 列表 */
  expire?: Record<string, string[]>;
  /** 要局部更新的行：表名 -> [{id, ...要改的字段}] */
  updates?: Record<string, Array<{ id: string } & Record<string, unknown>>>;
  /** 推进游标到此索引 */
  advanceCursor?: number;
};

// ── 检索接口 ──

/** 内存过滤查询条件，所有条件 AND 组合 */
export type MemoryQuery<T extends MemoryBaseRow = MemoryBaseRow> = {
  /** 是否只返回未过期行（默认 true） */
  activeOnly?: boolean;
  /** 按来源过滤 */
  source?: CommitSource | CommitSource[];
  /** 按角色 ID 过滤（适用于有 targetId 字段的表） */
  targetId?: string | string[];
  /** 创建时间范围 */
  createdAfter?: string;
  createdBefore?: string;
  /** 来源消息范围重叠过滤 */
  sourceRangeOverlaps?: [number, number];
  /** 自定义过滤谓词 */
  where?: (row: T) => boolean;
  /** 排序方式 */
  orderBy?: 'newest' | 'oldest' | 'importance';
  /** 返回上限 */
  limit?: number;
  /** 跳过前 N 条 */
  offset?: number;
};

/** 检索打分上下文：当前场景信息，用于相关性评分 */
export type MemoryScoringContext = {
  currentTime?: string;
  currentLocation?: string;
  currentTargetIds?: string[];
  currentMainEventId?: string;
  /** 从用户输入或场景提取的关键词 */
  keywords?: string[];
};

/** 打分函数签名：返回数值越高越相关 */
export type MemoryScorer<T extends MemoryBaseRow = MemoryBaseRow> =
  (row: T, ctx: MemoryScoringContext) => number;
