# MemoryDB 配置 UI 和回顶功能 - 实现文档

## 任务概述

1. 在手机摘要页面添加记忆配置界面
2. 添加正文生成完回顶功能

## 实现方案

### 1. 配置存储层（已完成）

文件：`memory-config.ts`
- `loadMemoryConfig()`: 从 localStorage 读取配置
- `saveMemoryConfig()`: 保存配置到 localStorage
- `resetMemoryConfig()`: 重置为默认值
- 默认配置：tokenBudget: 15000, minorWindowSize: 8, majorWindowSize: 5

### 2. 配置读取集成（已完成）

文件：`message-format.ts`
- `buildPrompt()` 中调用 `loadMemoryConfig()` 读取用户配置
- 自动应用到记忆注入

### 3. 配置 UI（需要实现）

#### 在 `phone/render.ts` 中添加配置区域

需要在 `renderSummaryConfigSection()` 渲染器中添加以下内容：

```typescript
function renderMemoryConfigSection(state: AppState): string {
  const config = loadMemoryConfig(); // 从 localStorage 读取
  
  return `
    <section class="phone-summary-config-section">
      <h3>记忆注入配置</h3>
      
      <label class="phone-config-row">
        <span>Token 预算</span>
        <input 
          type="number" 
          value="${config.tokenBudget}" 
          min="5000" 
          max="50000" 
          step="1000"
          data-config-field="tokenBudget"
        />
      </label>
      
      <label class="phone-config-row">
        <span>Minor 摘要窗口</span>
        <input 
          type="number" 
          value="${config.minorWindowSize}" 
          min="3" 
          max="20"
          data-config-field="minorWindowSize"
        />
      </label>
      
      <label class="phone-config-row">
        <span>Major 摘要窗口</span>
        <input 
          type="number" 
          value="${config.majorWindowSize}" 
          min="2" 
          max="10"
          data-config-field="majorWindowSize"
        />
      </label>
      
      <label class="phone-config-row">
        <input 
          type="checkbox" 
          ${config.includeFacts ? 'checked' : ''}
          data-config-field="includeFacts"
        />
        <span>注入关键事实</span>
      </label>
      
      <label class="phone-config-row">
        <input 
          type="checkbox" 
          ${config.includeTasks ? 'checked' : ''}
          data-config-field="includeTasks"
        />
        <span>注入待办任务</span>
      </label>
      
      <label class="phone-config-row">
        <input 
          type="checkbox" 
          ${config.includeSecrets ? 'checked' : ''}
          data-config-field="includeSecrets"
        />
        <span>注入保密事项</span>
      </label>
      
      <label class="phone-config-row">
        <input 
          type="checkbox" 
          ${config.includeImpressions ? 'checked' : ''}
          data-config-field="includeImpressions"
        />
        <span>注入角色印象</span>
      </label>
      
      <div class="phone-config-actions">
        <button data-action="memory-config-save">保存配置</button>
        <button data-action="memory-config-reset">重置默认</button>
      </div>
    </section>
  `;
}
```

#### 在 `index.ts` 中添加事件处理

需要在事件绑定区域添加：

```typescript
// 记忆配置保存
root?.querySelector('[data-action="memory-config-save"]')?.addEventListener('click', () => {
  const tokenBudget = parseInt(
    root?.querySelector<HTMLInputElement>('[data-config-field="tokenBudget"]')?.value ?? '15000'
  );
  const minorWindowSize = parseInt(
    root?.querySelector<HTMLInputElement>('[data-config-field="minorWindowSize"]')?.value ?? '8'
  );
  const majorWindowSize = parseInt(
    root?.querySelector<HTMLInputElement>('[data-config-field="majorWindowSize"]')?.value ?? '5'
  );
  const includeFacts = root?.querySelector<HTMLInputElement>('[data-config-field="includeFacts"]')?.checked ?? true;
  const includeTasks = root?.querySelector<HTMLInputElement>('[data-config-field="includeTasks"]')?.checked ?? true;
  const includeSecrets = root?.querySelector<HTMLInputElement>('[data-config-field="includeSecrets"]')?.checked ?? true;
  const includeImpressions = root?.querySelector<HTMLInputElement>('[data-config-field="includeImpressions"]')?.checked ?? true;

  saveMemoryConfig({
    tokenBudget,
    minorWindowSize,
    majorWindowSize,
    includeFacts,
    includeTasks,
    includeSecrets,
    includeImpressions,
  });

  alert('记忆配置已保存');
  render();
});

// 记忆配置重置
root?.querySelector('[data-action="memory-config-reset"]')?.addEventListener('click', () => {
  if (confirm('确定要重置为默认配置吗？')) {
    resetMemoryConfig();
    alert('已重置为默认配置');
    render();
  }
});
```

### 4. 正文生成完回顶功能（需要实现）

#### 在 `index.ts` 的生成完成回调中添加

在 `submitMessage()` 的 finally 块或成功回调中添加滚动逻辑：

```typescript
// 生成完成后回顶
function scrollToTop() {
  const readerContainer = root?.querySelector('.reader-container');
  if (readerContainer) {
    readerContainer.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// 在 submitMessage 的成功路径添加：
async function submitMessage(...) {
  try {
    // ... 现有生成逻辑
    
    // 生成成功后
    scrollToTop(); // ← 添加这行
    
  } catch (error) {
    // ...
  }
}
```

或者在 `finalizeStreamingText()` 函数末尾添加：

```typescript
function finalizeStreamingText(ctx, text, generationId) {
  // ... 现有逻辑
  
  // 完成后回顶
  scrollToTop();
}
```

## 需要的 CSS 样式

在 `phone/styles.css` 中添加：

```css
.phone-summary-config-section {
  padding: 1rem;
  border-top: 1px solid rgba(0, 0, 0, 0.1);
}

.phone-summary-config-section h3 {
  font-size: 0.9rem;
  font-weight: 600;
  margin-bottom: 0.75rem;
  color: #333;
}

.phone-config-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0;
  gap: 1rem;
}

.phone-config-row input[type="number"] {
  width: 5rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid rgba(0, 0, 0, 0.2);
  border-radius: 0.25rem;
}

.phone-config-row input[type="checkbox"] {
  margin-right: 0.5rem;
}

.phone-config-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
}

.phone-config-actions button {
  flex: 1;
  padding: 0.5rem;
  background: #007aff;
  color: white;
  border: none;
  border-radius: 0.5rem;
  font-size: 0.9rem;
  cursor: pointer;
}

.phone-config-actions button:last-child {
  background: #8e8e93;
}

.phone-config-actions button:active {
  opacity: 0.8;
}
```

## 实施步骤

由于我目前无法直接定位到 `renderSummaryConfigSection` 的具体实现位置，建议：

1. **手动添加配置 UI**：
   - 在 `phone/render.ts` 中找到 `renderSummaryConfigSection` 函数
   - 添加上述配置 UI 代码

2. **手动添加事件处理**：
   - 在 `index.ts` 的事件绑定区域（约 1400-1700 行）
   - 添加上述事件处理代码

3. **添加回顶功能**：
   - 在 `index.ts` 中找到 `finalizeStreamingText` 函数
   - 在末尾添加 `scrollToTop()` 调用

4. **添加 CSS 样式**：
   - 在 `phone/styles.css` 末尾添加上述样式

## 验证

配置生效后：
- 打开手机摘要页面，应该能看到配置界面
- 修改配置并保存，应该保存到 localStorage
- 下次生成时，应该使用新配置
- 生成完成后，页面应该自动滚动到顶部
