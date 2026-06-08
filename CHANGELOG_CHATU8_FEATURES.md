# 智慧姬插件集成更新日志

## 2026-06-07 更新内容

### 1. 智慧姬插件检测功能

#### 新增文件
- `plugins/chatu8-integration.ts` - 智慧姬插件集成模块
- `plugins/debug-extensions.js` - 扩展检测调试工具

#### 检测机制
实现了多层次的插件检测策略：

**方法 1：全局变量检测**
- 检查 `globalThis.extensions`、`extensionNames`
- 检查 `SillyTavern` 命名空间
- 检查 `getContext()` 返回值

**方法 2：DOM 元素检测**
- 扫描 `[data-extension-name]`、`.extension-block` 等元素
- 检查扩展列表容器
- 在元素文本内容中查找插件名称

**方法 3：事件监听器检测**
- 检查已知的 chatu8 事件

#### 支持的插件名称
- `chatu8`
- `st-chatu8`
- `third-party-chatu8`
- `SillyTavern-Chatu8`
- `third-party/chatu8`

### 2. 修复角色锚定添加问题

#### 问题
点击"+ 添加角色"按钮后，新角色不显示在界面上。

#### 根本原因
`state/store.ts` 中的 `normalizeDrawingSettings` 函数有一行过滤代码：
```typescript
.filter(anchor => anchor.name || anchor.prompt)
```
这会删除所有 name 和 prompt 都为空的角色（即新添加的空角色）。

#### 修复方案
移除了该过滤器，保留所有角色（包括空角色），允许用户逐步填写。

#### 功能改进
- ✅ 可以同时添加多个角色（英梨梨、霞之丘诗羽等）
- ✅ 每个角色都有独立的输入框
- ✅ 可以用删除按钮（×）移除角色

### 3. 新增负面提示词功能

#### 问题背景
智慧姬插件会自动添加默认的 `negative_prompt`，但用户无法自定义。

#### 新增功能

**类型定义 (`types.ts`)**
```typescript
export type DrawingSettings = {
  enabled: boolean;
  qualityPrompt: string;
  negativePrompt: string;  // 新增
  // ...
};
```

**默认值 (`state/store.ts`)**
```typescript
negativePrompt: 'lowres, bad quality, worst quality, jpeg artifacts, very displeasing'
```

**界面 (`phone/render.ts`)**
- 在"画风/质量提示词"下方添加了"负面提示词"输入框
- 用户可以自定义要避免的特征

**请求数据 (`plugins/image-generation.ts`)**
- 将 `negative_prompt` 添加到发送给智慧姬插件的请求数据中
- 格式：`negative_prompt: settings.negativePrompt?.trim() || ''`

### 4. 代码优化

- 改进了扩展检测的鲁棒性
- 添加了详细的调试工具
- 统一了智绘姬和智慧姬的检测逻辑

## 使用说明

### 角色锚定
1. 打开手机界面 → 画图
2. 点击"+ 添加角色"
3. 填写角色名称（如：英梨梨）
4. 填写固定外貌标签（如：blonde twintails, blue eyes, petite body）
5. 可以添加多个角色

### 负面提示词
1. 打开手机界面 → 画图
2. 找到"负面提示词"输入框
3. 填写要避免的特征（如：lowres, bad quality, worst quality）
4. 这些词会自动添加到每次生图请求中

### 调试扩展检测
如果插件检测失败：
1. 打开浏览器开发者工具（F12）
2. 切换到 Console 标签页
3. 复制 `plugins/debug-extensions.js` 的内容并运行
4. 查看输出，找到扩展的实际存储位置

## 技术细节

### 文件修改列表
- ✅ `types.ts` - 添加 negativePrompt 字段
- ✅ `state/store.ts` - 更新默认值和规范化函数
- ✅ `phone/render.ts` - 添加负面提示词输入框，移除过滤空角色
- ✅ `index.ts` - 读取负面提示词控件值
- ✅ `plugins/image-generation.ts` - 发送负面提示词到插件
- ✅ `plugins/chatu8-integration.ts` - 新增智慧姬插件集成
- ✅ `plugins/debug-extensions.js` - 新增调试工具

### API 变更
#### 请求数据结构
```typescript
{
  id: string;
  prompt: string;
  negative_prompt: string;  // 新增
  change: string;
  width: number | null;
  height: number | null;
  source: 'prompt-attr' | 'scene-prompt-llm';
  sceneText?: string;
  generationContext?: string;
  generationWorldBook?: string;
  rawText?: string;
  userInput?: string;
}
```

## 兼容性

- ✅ 向后兼容旧的存档数据
- ✅ 负面提示词有默认值，不影响现有功能
- ✅ 智慧姬插件检测不影响智绘姬插件

## 已知问题

- 扩展检测依赖于 SillyTavern 的实现，可能需要根据实际环境调整
- 如果检测失败，请运行调试脚本并提供输出

## 下一步计划

- [ ] 优化扩展检测逻辑（根据调试脚本的反馈）
- [ ] 添加更多预设的负面提示词模板
- [ ] 考虑添加正面/负面提示词的快速切换功能
