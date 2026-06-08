/**
 * 智慧姬插件检测调试工具 v2
 * 深度搜索 SillyTavern 扩展系统
 */

console.log('=== 智慧姬插件检测调试 v2 ===\n');

// 1. 搜索所有全局对象中包含 extension 的属性
console.log('1. 搜索全局对象中的扩展相关属性:');
const extensionProps = [];
for (const key in window) {
  const lowerKey = key.toLowerCase();
  if (lowerKey.includes('extension') || lowerKey.includes('chatu8') || lowerKey.includes('plugin')) {
    try {
      const value = window[key];
      extensionProps.push({ key, type: typeof value, value: Array.isArray(value) ? `Array(${value.length})` : value });
    } catch (e) {
      extensionProps.push({ key, type: 'error', value: e.message });
    }
  }
}
console.table(extensionProps);

// 2. 检查 DOM 中的扩展列表
console.log('\n2. 检查 DOM 中的扩展元素:');
const extensionElements = document.querySelectorAll('[data-extension], .extension, [class*="extension"], [id*="extension"]');
console.log(`  找到 ${extensionElements.length} 个扩展相关元素`);
if (extensionElements.length > 0) {
  console.log('  前 5 个元素:', Array.from(extensionElements).slice(0, 5));
}

// 3. 检查特定的扩展容器
const possibleSelectors = [
  '#extensions_list',
  '#extensions',
  '.extensions-list',
  '[data-extension-name]',
  '.extension-block',
];
console.log('\n3. 检查特定的扩展容器:');
possibleSelectors.forEach(selector => {
  const el = document.querySelector(selector);
  if (el) {
    console.log(`  ${selector}:`, el);
    const children = el.querySelectorAll('[data-extension-name], .extension-block-content, [id*="chatu8"]');
    console.log(`    包含 ${children.length} 个子元素`);
  }
});

// 4. 深度搜索 window 对象
console.log('\n4. 深度搜索 window 对象:');
function deepSearch(obj, path = 'window', maxDepth = 3, currentDepth = 0) {
  if (currentDepth >= maxDepth || !obj || typeof obj !== 'object') return [];
  const results = [];
  try {
    for (const key in obj) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes('extension') || lowerKey.includes('chatu8')) {
        results.push({ path: `${path}.${key}`, value: obj[key] });
      }
      if (currentDepth < maxDepth - 1 && typeof obj[key] === 'object' && obj[key] !== null && obj[key] !== window) {
        results.push(...deepSearch(obj[key], `${path}.${key}`, maxDepth, currentDepth + 1));
      }
    }
  } catch (e) {
    // 跳过访问受限的属性
  }
  return results;
}
const deepResults = deepSearch(window);
console.log('  找到的扩展相关属性:', deepResults.slice(0, 20));

// 5. 检查是否有 manifest 或配置
console.log('\n5. 检查扩展配置:');
const configKeys = ['manifest', 'config', 'settings', 'extensionSettings', 'extension_settings'];
configKeys.forEach(key => {
  if (window[key]) {
    console.log(`  window.${key}:`, window[key]);
  }
});

// 6. 检查 localStorage 和 sessionStorage
console.log('\n6. 检查浏览器存储:');
const storageKeys = Object.keys(localStorage).filter(k =>
  k.toLowerCase().includes('extension') || k.toLowerCase().includes('chatu8')
);
console.log('  localStorage 中的扩展相关键:', storageKeys);
storageKeys.forEach(key => {
  try {
    const value = localStorage.getItem(key);
    console.log(`    ${key}:`, JSON.parse(value));
  } catch (e) {
    console.log(`    ${key}:`, localStorage.getItem(key));
  }
});

// 7. 尝试读取扩展管理界面的 DOM
console.log('\n7. 读取扩展管理界面的扩展列表:');
const extensionBlocks = document.querySelectorAll('.extensions_block, [id*="extensions"], .extension-block');
console.log(`  找到 ${extensionBlocks.length} 个扩展块`);
extensionBlocks.forEach((block, idx) => {
  console.log(`  扩展块 ${idx}:`, {
    id: block.id,
    className: block.className,
    dataset: block.dataset,
    textContent: block.textContent?.substring(0, 100)
  });
});

console.log('\n=== 调试完成 ===');
console.log('请将以上输出截图，特别注意表格和找到的属性路径');
