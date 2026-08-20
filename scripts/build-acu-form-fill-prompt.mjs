import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const downloads = path.join(process.env.USERPROFILE || process.cwd(), 'Downloads');
const sourcePath = path.resolve(process.argv[2] || path.join(downloads, 'acu-form-fill-prompt (1).json'));
const outputPath = path.resolve(process.argv[3] || path.join(downloads, 'acu-form-fill-prompt-fixed.json'));

const sourceText = fs.readFileSync(sourcePath, 'utf8');
const source = JSON.parse(sourceText);
assert.ok(Array.isArray(source) && source.length > 0, 'contract: form-fill prompt is a non-empty segment array');

function replaceSection(content, startMarker, endMarker, replacement) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end >= 0, `contract: prompt contains section ${startMarker}`);
  return `${content.slice(0, start)}${replacement}${content.slice(end)}`;
}

function replaceSectionIncludingEnd(content, startMarker, endMarker, replacement) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end >= 0, `contract: prompt contains section ${startMarker}`);
  return `${content.slice(0, start)}${replacement}${content.slice(end + endMarker.length)}`;
}

const strictOutput = `## 输出格式（严格执行）

回复内容必须是一个合法 JSON 对象，且只能包含这个 JSON 对象本身；不得输出分析过程、内容包裹标签、Markdown 代码块或任何说明文字。

你必须在内部完成对剧情变化和所有表格 note 的判断，但不要把思考过程写入最终回复。

JSON 根对象只能使用以下结构：
{"format":"table_edit_ops_v1","ops":[]}

ops 只允许 insert、update、delete 三种操作：

insert：{"op":"insert","sheet":"表格名","row":{"字段名":"字段值"}}
update：{"op":"update","sheet":"表格名","where":{"字段名":"定位值"},"set":{"字段名":"新值"}}
delete：{"op":"delete","sheet":"表格名","where":{"字段名":"定位值"}}

没有真实变化时必须输出：
{"format":"table_edit_ops_v1","ops":[]}

### 表选择与行身份
- sheet 必须逐字复制自当前表格数据中的完整表名；禁止输出数字表号、猜测的 sheet 名或把表格位置当作身份。先按当前表格数据中的 [index:表名] 识别目标，再把对应的精确表名写入 sheet；运行时会按当前排序解析表名，因此绝不能假设纪要表固定在任何数字索引。
- row、where、set 的字段名必须逐字复制对应表头；不要使用数字列号。
- insert 不要填写 row_id；系统会分配稳定行号。update/delete 用 where 定位唯一业务行，不要凭空编造行号。
- 当前 Island 基线的纪要表表头为：row_id、编码索引、时间跨度、概览、纪要、重要对话。纪要表的 row_id 与编码索引由运行时维护，除非当前 note 明确要求，否则不要自行分配。
- 纪要表的编码索引必须保持连续的 AMXXXX 格式，时间跨度必须覆盖本轮实际事件并使用 YYYY-MM-DD HH:MM ~ YYYY-MM-DD HH:MM，概览不超过 50 字，纪要 300-500 字，重要对话通常 3 句且最多 5 句。不要硬编码 AM0001，也不要把没有实际事件的互动写成纪要。
- 纪要表只有在本轮正文确实产生了新的、可记录的事件时才插入；普通问候、闲聊、重复状态或没有实际变化时允许并应使用 ops: []。

`;

const strictRules = `## 关键规则
1. 必须逐表阅读当前表格数据中每张表的 note 部分，严格遵守其中的约束。
2. note 的约束优先级最高，高于通用填表经验；禁止跨表重复记录同一事实。
3. 只有能由背景设定、正文数据或当前表格数据直接证明的变化才可写入；不确定时不写入。
4. 普通恋爱互动使用中性、可观察的词语（提议、要求、同意、拒绝、引导、配合、安抚）；不得把正常调情或互动臆测成权力掌控、剥夺反抗、精神支配、屈服等压迫结论。
5. 仅当 op 确实有变化时才输出 insert、update 或 delete；无变化输出空 ops 数组。

`;

const strictFormat = `## JSON 格式要点
- 必须输出合法 JSON 对象，不能在 JSON 前后添加任何说明文字。
- JSON 字符串使用双引号；字段值中的双引号必须按 JSON 规则转义为\\"，换行必须写成\\n。
- sheet、字段名和定位值必须来自当前表格数据，不得引用背景中不存在的表名或字段。
- update/delete 的 where 必须唯一命中一行；无法唯一定位时不要猜，输出空 ops。
- 不要输出 row_id；不要在 row 中填入系统会自动生成的编码索引。

现在开始按此 JSON 格式执行填表任务。`;

const mainIndex = source.findIndex(segment => segment && (segment.mainSlot === 'A' || segment.isMain === true));
assert.ok(mainIndex >= 0, 'contract: source has a main fill instruction segment');

const output = source.map((segment, index) => {
  if (!segment || typeof segment !== 'object') return segment;
  const next = { ...segment };
  if (index === mainIndex) {
    let content = String(segment.content || '');
    content = replaceSection(content, '## 输出格式（严格执行）', '## 关键规则', strictOutput);
    content = replaceSection(content, '## 关键规则', '## 格式要点', strictRules);
    content = replaceSectionIncludingEnd(content, '## 格式要点', '现在开始按此格式执行填表任务。', strictFormat);
    content = content
      .replace(/针对纪要表的额外规则：如果<当前表格数据>里存在纪要表，那么本轮就必须对其进行插入一条新的总结记录。\s*/g, '')
      .replace(/针对纪要表的额外规则：如果<当前表格数据>里存在纪要表，那么本轮就必须对其进行插入一条新的总结记录。/g, '')
      .replace(/0\s*=\s*纪要表/g, '纪要表索引由运行时表名解析，不固定')
      .replace(/tableIndex\s*=\s*0/g, 'tableIndex 由运行时表名解析');
    next.content = content;
  } else if (segment.role === 'assistant' && typeof segment.content === 'string' && /<thought>|<tableEdit>|<content>/i.test(segment.content)) {
    next.content = '收到，我将只返回指定 JSON 对象。';
  }
  return next;
});

const mainContent = String(output[mainIndex].content || '');
assert.match(mainContent, /table_edit_ops_v1/);
assert.match(mainContent, /sheet/);
assert.match(mainContent, /纪要表表头/);
assert.match(mainContent, /ops: \[\]/);
assert.match(mainContent, /\[index:表名\]/);
assert.doesNotMatch(mainContent, /<thought>|<tableEdit>|<content>|insertRow\(|updateRow\(|deleteRow\(/i);
assert.doesNotMatch(mainContent, /0\s*=\s*纪要表|tableIndex|tableId|rowIndex/);
assert.doesNotMatch(mainContent, /本轮就必须对其进行插入一条新的总结记录/);
assert.ok(output.some(segment => segment?.role === 'assistant' && segment.content === '收到，我将只返回指定 JSON 对象。'), 'contract: assistant prefill cannot pollute strict JSON output');

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), output);
assert.equal(fs.readFileSync(sourcePath, 'utf8'), sourceText, 'contract: source prompt remains unchanged');

console.info(`[acu-form-fill-prompt] generated and verified: ${outputPath}`);
