# 姓名拆分功能说明

## 问题背景

之前AI会把"八云"这样的双字姓氏错误地处理成"姓八"+"名云"，导致称呼错误。

## 解决方案

### 1. 新建角色时

在角色创建界面新增了**姓氏**和**名字**的独立输入字段（可选）：

- **主角名**：必填，完整姓名（如"八云紫"）
- **姓氏（可选）**：单独填写姓氏（如"八云"）
- **名字（可选）**：单独填写名字（如"紫"）

**推荐做法**：
- 对于双字姓（八云、司马、欧阳、上杉等），建议填写姓氏和名字字段
- 对于单字姓（李、王、张等），可以不填，系统会自动拆分

### 2. 旧存档兼容

旧存档会自动使用原有的姓名拆分逻辑：
- 如果名字中有空格，第一部分为姓，其余为名
- 如果是2-4个中文字符：
  - 4字及以上：前2字为姓
  - 2-3字：前1字为姓
- 其他情况：全名作为姓和名

**注意**：旧存档中的双字姓可能仍会被错误拆分，建议玩家在手机界面编辑玩家档案时手动添加 `familyName` 和 `givenName` 字段。

## 技术实现

### 修改的文件

1. **types.ts** - 扩展 `PlayerProfile` 类型，增加 `familyName` 和 `givenName` 字段
2. **relationship.ts** - 修改 `splitPlayerName` 函数，优先使用显式提供的姓名
3. **title/render.ts** - 角色创建界面增加姓名输入字段
4. **title/events.ts** - 事件处理增加姓名字段传递
5. **state/saves.ts** - 存档系统支持姓名字段存储

### 数据结构

```typescript
type PlayerProfile = {
  name: string;           // 完整姓名（必填）
  familyName?: string;    // 姓氏（可选，优先使用）
  givenName?: string;     // 名字（可选，优先使用）
  gender?: string;
  personality: string;
  appearance: string;
  className?: string;
  stats?: PlayerStats;
  difficulty?: Difficulty;
}
```

### 姓名拆分逻辑

```typescript
function splitPlayerName(name: string, explicitFamily?: string, explicitGiven?: string) {
  // 1. 优先使用显式提供的姓名
  if (explicitFamily && explicitGiven) {
    return {
      fullName: name,
      familyName: explicitFamily,
      givenName: explicitGiven,
    };
  }
  
  // 2. 回退到自动拆分逻辑（兼容旧存档）
  // ...
}
```

## 示例

### 正确处理双字姓

**输入**：
- 主角名：八云紫
- 姓氏：八云
- 名字：紫

**AI提示词中的拆分结果**：
```
当前玩家姓名拆分参考：姓氏="八云"，名字="紫"，全名="八云紫"；
示例称呼为"八云君"或"紫君"。
```

### 自动拆分（不填姓名字段）

**输入**：
- 主角名：加藤惠
- 姓氏：（空）
- 名字：（空）

**AI提示词中的拆分结果**：
```
当前玩家姓名拆分参考：姓氏="加藤"，名字="惠"，全名="加藤惠"；
示例称呼为"加藤君"或"惠君"。
```

## 测试建议

1. 创建新角色，测试双字姓（八云、司马、欧阳）
2. 创建新角色，测试单字姓（李、王、张）
3. 加载旧存档，验证兼容性
4. 观察AI在对话中的称呼是否正确

## 未来改进

可以考虑：
1. 在手机界面的玩家档案编辑中增加姓名字段编辑功能
2. 提供常见双字姓的自动识别列表
3. 存档迁移工具，自动修正旧存档中的姓名拆分
