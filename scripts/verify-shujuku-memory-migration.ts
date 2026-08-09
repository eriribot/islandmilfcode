import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDefaultMemoryDB } from '../memorydatabase/defaults';
import type {
  MemoryEntityRow,
  MemoryFactRow,
  MemoryItemRow,
  MemoryPhoneMessageRow,
  MemorySecretRow,
  MemorySummaryRow,
  MemoryTaskRow,
} from '../memorydatabase/types';
import type { PlayerProfile, StatusData } from '../types';
import { getShujukuMemoryTemplate, migrateMemoryDatabaseToShujuku } from '../shujuku/memory-migration';

for (const relativePath of ['index.ts', 'actions/index.ts', 'phone/render.ts', 'state/archive-repository.ts']) {
  const productionSource = readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  if (/from ['"]\.\.?\/.*shujuku\/memory-migration['"]/.test(productionSource)) {
    throw new Error(`contract: production module ${relativePath} must not import the synthetic shujuku migration`);
  }
  if (/\bmigrateMemoryDatabaseToShujuku\b/.test(productionSource)) {
    throw new Error(`contract: production module ${relativePath} must not generate local shujuku tables`);
  }
}

const now = '2026-08-07T00:00:00.000Z';
const base = { id: '', createdAt: now, updatedAt: now, source: 'manual' as const };
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(left: unknown, right: unknown, message: string): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(message);
}
const playerProfile: PlayerProfile = {
  name: '玩家', familyName: '', givenName: '玩家', personality: '冷静', appearance: '短发',
};
const statusData = {
  world: { currentTime: 'Day 1 08:00', currentLocation: '校园>教学楼>天台', mainEvents: {}, currentMainEventId: '' },
  targets: [{
    id: 'char-1', name: '小葵', affinity: 30, obsession: 0, stage: '朋友',
    obsessionStage: '无', titles: {}, outfits: {},
  }],
} as unknown as StatusData;

function makeInput() {
  const memoryDB = createDefaultMemoryDB('migration-contract');
  memoryDB.entities.push(
    { ...base, id: 'p', entityId: 'player', kind: 'player', name: '玩家' } as MemoryEntityRow,
    { ...base, id: 'c', entityId: 'char-1', kind: 'character', name: '小葵' } as MemoryEntityRow,
    { ...base, id: 'c2', entityId: 'char-2', kind: 'character', name: '老师' } as MemoryEntityRow,
  );
  memoryDB.facts.push({ ...base, id: 'f', category: 'event', subject: '小葵', content: '发生了一个事件', relatedEntityIds: ['char-1'] } as MemoryFactRow);
  memoryDB.items.push({ ...base, id: 'i', name: '钥匙', count: 1 } as MemoryItemRow);
  memoryDB.tasks.push({ ...base, id: 't', content: '明天见面', status: 'pending', targetId: 'char-1' } as MemoryTaskRow);
  memoryDB.secrets.push({ ...base, id: 's', subject: '秘密', content: '不得泄露', knownBy: ['char-1'], risk: 'high', revealed: false } as MemorySecretRow);
  memoryDB.summaries.push({ ...base, id: 'sum', level: 'major', range: [1, 2], text: '短摘要' } as MemorySummaryRow);
  memoryDB.summaries.push({
    ...base, id: 'sum-long', level: 'major', range: [3, 20], text: '这是一段用于迁移合同验证的完整纪要。'.repeat(50),
  } as MemorySummaryRow);
  memoryDB.phoneMessages.push({
    ...base, id: 'phone', targetId: 'char-1', role: 'assistant', messageId: 'phone-1', textPreview: '手机内容不得迁移',
  } as MemoryPhoneMessageRow);
  memoryDB.facts.push({ ...base, id: 'expired', category: 'event', subject: '过期', content: '不要出现', expired: true } as MemoryFactRow);
  return { memoryDB, playerProfile, statusData };
}

const first = migrateMemoryDatabaseToShujuku(makeInput());
const second = migrateMemoryDatabaseToShujuku(makeInput());
const template = getShujukuMemoryTemplate();
const sheetKeys = Object.keys(template).filter(key => key.startsWith('sheet_')).sort();
equal(sheetKeys.length, 14, 'contract: migration has all 14 target sheets');
equal(first.tables, second.tables, 'contract: identical input is deterministic');
for (const key of sheetKeys) {
  const sheet = (first.tables as Record<string, { content: unknown[][] }>)[key];
  const expected = (template as Record<string, { content: unknown[][] }>)[key].content[0];
  equal(sheet.content[0], expected, 'contract: headers match reference template for ' + key);
  const ids = sheet.content.slice(1).map(row => row[0]);
  equal(ids, ids.map((_, index) => index + 1), 'contract: row_id is contiguous for ' + key);
}
const serialized = JSON.stringify(first.tables);
equal(serialized.includes('不得泄露'), false, 'contract: secrets never migrate');
equal(serialized.includes('不要出现'), false, 'contract: expired rows never migrate');
equal(serialized.includes('手机内容不得迁移'), false, 'contract: phone messages never migrate');
equal((first.tables.sheet_check_advice as { content: unknown[][] }).content.length, 1, 'contract: check_advice remains header-only');
equal((first.tables.sheet_director_plan as { content: unknown[][] }).content.length, 1, 'contract: director_plan remains header-only');
equal(first.stats.skippedSecrets, 1, 'contract: skipped secret count recorded');
equal(first.stats.skippedPhoneMessages, 1, 'contract: skipped phone count recorded');
equal(first.stats.skippedShortSummaries, 1, 'contract: short summary count recorded');
assert(first.stats.mappedRows.sheet_items >= 1, 'contract: item mapping recorded');
assert(first.stats.mappedRows.sheet_memo >= 1, 'contract: task mapping recorded');
assert(first.stats.mappedRows.sheet_romance_targets >= 1, 'contract: romance target mapping recorded');
assert(first.stats.mappedRows.sheet_important_non_romance >= 1, 'contract: non-romance character mapping recorded');
for (const row of (first.tables.sheet_minutes as { content: unknown[][] }).content.slice(1)) {
  const length = String(row[4]).length;
  assert(length >= 200 && length <= 520, 'contract: story minute length stays within DDL bounds');
}
console.log(JSON.stringify({ ok: true, mappedRows: first.stats.mappedRows, stats: first.stats }, null, 2));
