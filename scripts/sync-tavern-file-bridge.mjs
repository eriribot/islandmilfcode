import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'savesolt', 'IslandMilfCode本机存档桥.js');
const importPath = path.join(root, 'savesolt', '导入到酒馆中', 'IslandMilfCode本机存档桥.json');
const imported = JSON.parse(fs.readFileSync(importPath, 'utf8'));
imported.content = fs.readFileSync(sourcePath, 'utf8');
fs.writeFileSync(importPath, `${JSON.stringify(imported, null, 2)}\n`, 'utf8');
console.info('[tavern-file-bridge] import JSON synchronized');
