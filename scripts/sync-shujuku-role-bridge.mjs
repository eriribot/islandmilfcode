import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'shujuku', 'IslandMilfCode数据库转发桥.js');
const importPath = path.join(root, 'shujuku', '导入到酒馆中', 'IslandMilfCode数据库转发桥.json');
const source = fs.readFileSync(sourcePath, 'utf8');

// Keep the imported role script as a generated copy of the maintained source.
const removedSurface = ['planLogical' + 'Turn', 'updateLogical' + 'Turn', 'cancelLogical' + 'Turn'];
if (removedSurface.some(name => source.includes(name))) {
  throw new Error('角色脚本桥仍包含已删除的逻辑回合接口');
}

const imported = JSON.parse(fs.readFileSync(importPath, 'utf8'));
imported.content = source;
imported.info = '绑定当前角色卡。用完整归档时间线临时构造虚拟 chat[]，执行 shujuku 包装生成与 triggerUpdate；结果由 IslandMilfCode 状态接住，不创建宿主聊天楼层。';
fs.writeFileSync(importPath, `${JSON.stringify(imported, null, 2)}\n`, 'utf8');

const readBack = JSON.parse(fs.readFileSync(importPath, 'utf8'));
if (readBack.content !== source) throw new Error('导入 JSON 与维护中的桥源码不一致');
console.info('[shujuku-role-bridge] table and virtual-turn relay source synchronized');
