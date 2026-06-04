# Learning from KaiTuoYiShi Repository - Analysis Plan

## Executive Summary

After analyzing the KaiTuoYiShi (Honkai: Star Rail fan project) repository and comparing it with your Saekano tavern helper project, I've identified **6 concrete improvement areas** where KaiTuoYiShi's patterns can strengthen your project. Surprisingly, your memory database and plot management systems are **already more sophisticated** than KaiTuoYiShi's, so the learnings focus on specific subsystems rather than architectural overhauls.

---

## Context: Project Comparison

### KaiTuoYiShi Architecture
- **Type**: Standalone React 19 + TypeScript + Vite app
- **Storage**: IndexedDB for persistent state
- **Scope**: Full game-like UI with panels, inventory, companions, gallery
- **Memory**: 3-tier compression (immediate → short-term → long-term)
- **NPC System**: Normalization layer to merge aliases and reduce duplicates
- **Variable Model**: Independent variable model reads text, outputs structured commands
- **Gallery**: Character-centric visual resource management with anchors/sprites

### Your Saekano Project (Current State)
- **Type**: SillyTavern tavern helper template with MVU framework
- **Storage**: Integrated with SillyTavern's state + custom phone/memory systems
- **Scope**: Character relationship tracking, plot events, phone system, summaries
- **Memory**: **IslandMemoryDB with 11+ tables** (entities, events, facts, relations, impressions, tasks, secrets, items, phoneMessages, summaries, attributes, worldState) - **MORE comprehensive than KaiTuoYiShi**
- **Character System**: Detailed audit rules (英梨梨, 诗羽, 惠, 出海, 美智留) but **no alias normalization**
- **Variable System**: MVU adapter with structured StatusData - **already solid**
- **Plot System**: PlotLibrary with volumes, writing protocols, event routing - **already sophisticated**

---

## Learning Area 1: Character Alias Normalization Layer

### Gap Identified
Your project has comprehensive character audit rules in `relationship.ts` but **lacks systematic alias merging** to prevent AI from creating duplicate character entries with slightly different names.

### What KaiTuoYiShi Does
- **NPC normalization layer** merges aliases before committing to state
- Treats "霞之丘诗羽", "诗羽", "霞诗子", "Utaha" as the same entity
- Reduces duplicate profiles that accumulate over long sessions

### Recommended Implementation

**File**: `variables/character-normalization.ts` (new)

```typescript
type CharacterAliasMap = {
  canonicalId: string;
  canonicalName: string;
  aliases: string[];
};

const CHARACTER_ALIASES: CharacterAliasMap[] = [
  {
    canonicalId: 'utaha',
    canonicalName: '霞之丘诗羽',
    aliases: ['诗羽', '霞诗子', '霞之丘', 'Utaha', 'Kasumigaoka', '学姐'],
  },
  {
    canonicalId: 'eriri',
    canonicalName: '泽村·斯宾塞·英梨梨',
    aliases: ['英梨梨', '柏木英理', '泽村', 'Eriri', 'Sawamura', '英理老师'],
  },
  {
    canonicalId: 'megumi',
    canonicalName: '加藤惠',
    aliases: ['惠', '加藤', 'Megumi', 'Kato'],
  },
  {
    canonicalId: 'izumi',
    canonicalName: '波岛出海',
    aliases: ['出海', '波岛', 'Izumi', 'Hashima'],
  },
  {
    canonicalId: 'michiru',
    canonicalName: '冰堂美智留',
    aliases: ['美智留', '冰堂', 'Michiru', 'Hyodo'],
  },
];

export function normalizeCharacterName(rawName: string): {
  canonicalId: string;
  canonicalName: string;
} | null {
  const trimmed = rawName.trim();
  for (const map of CHARACTER_ALIASES) {
    if (
      map.canonicalName === trimmed ||
      map.aliases.some(alias => alias === trimmed || trimmed.includes(alias))
    ) {
      return {
        canonicalId: map.canonicalId,
        canonicalName: map.canonicalName,
      };
    }
  }
  return null;
}

export function mergeTargetsByAlias(targets: TargetStatus[]): TargetStatus[] {
  const merged = new Map<string, TargetStatus>();
  
  for (const target of targets) {
    const normalized = normalizeCharacterName(target.name);
    const key = normalized?.canonicalId ?? target.id;
    
    if (merged.has(key)) {
      // Merge: keep higher affinity, newer stage, union of titles/outfits
      const existing = merged.get(key)!;
      merged.set(key, {
        ...existing,
        affinity: Math.max(existing.affinity, target.affinity),
        obsession: Math.max(existing.obsession, target.obsession),
        titles: { ...existing.titles, ...target.titles },
        outfits: { ...existing.outfits, ...target.outfits },
      });
    } else {
      merged.set(key, {
        ...target,
        id: normalized?.canonicalId ?? target.id,
        name: normalized?.canonicalName ?? target.name,
      });
    }
  }
  
  return Array.from(merged.values());
}
```

**Integration Point**: `variables/normalize.ts` or `variables/adapter.ts`
- Call `mergeTargetsByAlias()` before committing statusData.targets
- Prevents "英梨梨" and "泽村" from becoming separate entries

**Benefit**: Eliminates the "character split personality" bug where AI treats the same character as multiple people due to name variations.

---

## Learning Area 2: Variable Validation & Error Field Filtering

### Gap Identified
Your `variables/normalize.ts` focuses on time normalization and main event sync, but **lacks comprehensive validation and error field filtering** before state writes.

### What KaiTuoYiShi Does
- Filters error fields, placeholder objects, old field names, prohibited systems
- Validates inventory items, NPC profiles, path state machines
- Provides fallbacks for incomplete/malformed data to prevent UI crashes

### Recommended Implementation

**File**: `variables/validate.ts` (new)

```typescript
import type { StatusData, TargetStatus } from '../types';

/**
 * AI sometimes outputs placeholder/error objects. Filter them before commit.
 */
export function filterInvalidTargets(targets: TargetStatus[]): TargetStatus[] {
  return targets.filter(target => {
    // Reject placeholder names
    if (!target.name || target.name.trim() === '') return false;
    if (/^(角色|人物|目标|Character|Target)\d*$/.test(target.name)) return false;
    if (/^(待定|未知|Unknown|TBD)$/i.test(target.name)) return false;
    
    // Reject error markers
    if (target.name.includes('ERROR') || target.name.includes('错误')) return false;
    
    // Require valid ID
    if (!target.id || target.id.trim() === '') return false;
    
    return true;
  });
}

export function filterInvalidInventoryItems(
  inventory: Record<string, { description: string; count: number }>
): Record<string, { description: string; count: number }> {
  const filtered: Record<string, { description: string; count: number }> = {};
  
  for (const [key, item] of Object.entries(inventory)) {
    // Skip placeholder items
    if (/^(物品|道具|Item)\d*$/.test(key)) continue;
    if (/^(待定|未知|Unknown|TBD)$/i.test(key)) continue;
    
    // Skip invalid counts
    if (typeof item.count !== 'number' || item.count <= 0) continue;
    
    // Skip empty descriptions
    if (!item.description || item.description.trim() === '') continue;
    
    filtered[key] = item;
  }
  
  return filtered;
}

export function validateAndCleanStatusData(data: StatusData): StatusData {
  return {
    ...data,
    targets: filterInvalidTargets(data.targets),
    player: {
      ...data.player,
      inventory: filterInvalidInventoryItems(data.player.inventory),
    },
  };
}
```

**Integration Point**: `variables/adapter.ts` in `applyVariableCommand()`
- Call `validateAndCleanStatusData()` after AI output parsing
- Before writing to `statusData`

**Benefit**: Prevents UI crashes from malformed AI output; keeps state clean.

---

## Learning Area 3: Visual Resource Management System

### Gap Identified
Your `picresource/` directory exists but likely lacks structured character-centric visual asset management with type safety and slot systems.

### What KaiTuoYiShi Does
- **Gallery system** with character anchors, sprite slots, NSFW archive structure
- Each character has: avatar slots, character sprites, scene anchors
- Image archives support generation queue, history, organization
- Rule center for generation templates and style presets

### Recommended Implementation (Lightweight Version)

**File**: `types.ts` (extend existing)

```typescript
export type CharacterVisualSlots = {
  /** 头像 URL */
  avatar?: string;
  /** 立绘 sprites: 表情/姿态变体 */
  sprites?: Record<string, string>; // 'neutral', 'happy', 'angry', 'embarrassed'
  /** 场景锚点：特定场景的角色形象 */
  sceneAnchors?: Record<string, string>; // 'beach', 'uniform', 'casual'
  /** 缩略图（用于手机联系人列表） */
  thumbnail?: string;
};

export type TargetStatus = {
  // ... existing fields
  visualSlots?: CharacterVisualSlots;
};
```

**File**: `picresource/manager.ts` (new)

```typescript
import type { CharacterVisualSlots } from '../types';

const DEFAULT_AVATARS: Record<string, string> = {
  utaha: 'picresource/utaha_avatar.png',
  eriri: 'picresource/eriri_avatar.png',
  megumi: 'picresource/megumi_avatar.png',
  izumi: 'picresource/izumi_avatar.png',
  michiru: 'picresource/michiru_avatar.png',
};

export function getCharacterAvatar(
  targetId: string,
  visualSlots?: CharacterVisualSlots
): string {
  return visualSlots?.avatar ?? DEFAULT_AVATARS[targetId] ?? 'picresource/default.png';
}

export function getCharacterSprite(
  targetId: string,
  emotion: string,
  visualSlots?: CharacterVisualSlots
): string | null {
  return visualSlots?.sprites?.[emotion] ?? null;
}
```

**Integration**: Use in `phone/render.ts` for contact list avatars and chat headers.

**Benefit**: Typed, centralized visual resource management; easy to extend with AI-generated images later.

---

## Learning Area 4: Memory Compression Strategy Refinement

### Your Advantage
Your `IslandMemoryDB` with 11 tables is **MORE sophisticated** than KaiTuoYiShi's described system. You already have entities, events, facts, relations, impressions, tasks, secrets, items, phoneMessages, summaries, attributes, worldState.

### What KaiTuoYiShi Offers
Their **3-tier compression strategy** might offer organizational insights:
- **Immediate memory**: Raw events each turn
- **Short-term memory**: Compressed from immediate
- **Long-term memory**: Only stable facts, main plot turns, relationship changes

### Your Current System
You have `summaries` table with `level: 'minor' | 'major' | 'global'` which is **conceptually equivalent**.

### Recommended Refinement

**File**: `memorydatabase/compression-policy.md` (new documentation)

Document your compression policy explicitly:

```markdown
# Memory Compression Policy

## Three-Tier Strategy

### Minor Summaries (Immediate → Short-term)
- **Trigger**: Every 5-10 messages
- **Coverage**: Recent conversation context
- **Retention**: Keep for 50 messages, then compress to major
- **Content**: Dialogue, minor decisions, emotional beats

### Major Summaries (Short-term → Long-term)
- **Trigger**: Every 50 messages or volume completion
- **Coverage**: Arc-level narrative
- **Retention**: Permanent
- **Content**: Plot turns, relationship milestones, irreversible consequences

### Global Summaries (Long-term → Ultra-compressed)
- **Trigger**: Volume transitions or 200+ messages
- **Coverage**: Multi-volume context
- **Retention**: Permanent
- **Content**: Character arcs, major events, world state changes

## Table-Specific Compression Rules

- **facts**: Never expire; merge duplicates
- **events**: Expire minor events after 100 messages; keep plot-critical forever
- **relations**: Overwrite with `exclusiveGroup`; keep change history in `attributes`
- **impressions**: Decay weight over time; expire when weight < 0.5
- **tasks**: Auto-expire when `deadline` passes and `status != 'done'`
- **secrets**: Never auto-expire; only manual `revealed = true`
```

**No code changes needed** - your system already supports this. Just document the policy.

---

## Learning Area 5: Built-in vs Additional Content Management

### Gap Identified
Your worldbook system loads entries but doesn't have a **built-in vs user-added** distinction with enable/disable toggles for debugging.

### What KaiTuoYiShi Does
- **Built-in world books**: Shipped with the project, can be edited/enabled/disabled
- **Additional books**: User-added custom content
- Enable/disable individual books for rule debugging
- Opening world books injected into IndexedDB on first launch

### Recommended Implementation

**File**: `worldbook/categories.ts` (new)

```typescript
export type WorldbookCategory = 'builtin' | 'additional' | 'debug';

export type CategorizedWorldbook = {
  name: string;
  category: WorldbookCategory;
  enabled: boolean;
  description?: string;
};

// Built-in worldbooks shipped with the project
export const BUILTIN_WORLDBOOKS: CategorizedWorldbook[] = [
  {
    name: '路人女主_角色档案',
    category: 'builtin',
    enabled: true,
    description: '主要角色的0层卡和审计规则',
  },
  {
    name: '剧情事件库',
    category: 'builtin',
    enabled: true,
    description: '各卷剧情事件触发条件',
  },
  {
    name: '关系进度规则',
    category: 'builtin',
    enabled: true,
    description: '好感度/执念度阶段定义',
  },
  {
    name: 'DEBUG_超详细审计',
    category: 'debug',
    enabled: false,
    description: '详细的角色行为审计日志（仅调试）',
  },
];
```

**File**: `worldbook/loader.ts` (extend existing)

```typescript
export async function loadActiveWorldbooks(): Promise<WorldbookEntry[]> {
  const categories = loadWorldbookCategories(); // from localStorage
  const allEntries: WorldbookEntry[] = [];
  
  for (const wb of BUILTIN_WORLDBOOKS) {
    const userOverride = categories.find(c => c.name === wb.name);
    const enabled = userOverride?.enabled ?? wb.enabled;
    
    if (enabled) {
      const entries = await win.getWorldbook?.(wb.name);
      if (entries) allEntries.push(...entries);
    }
  }
  
  return allEntries;
}
```

**UI Integration**: Add a settings panel in phone/render.ts under "app:settings" route to toggle worldbooks.

**Benefit**: Easier debugging by disabling specific rule sets; clearer separation of core vs optional content.

---

## Learning Area 6: Canonical Material Presets

### Gap Identified
Your project has worldbook JSON files but no **preset distribution system** for canonical materials.

### What KaiTuoYiShi Does
- `public/worldbook-presets/` and `public/zhiku-presets/` directories
- Preset resources distributed with build
- Users can import presets into their local knowledge base

### Recommended Implementation

**Directory Structure** (new):
```
src/islandmilfcode/presets/
├── worldbooks/
│   ├── 角色档案_预设.json
│   ├── 剧情事件_第一卷_预设.json
│   ├── 剧情事件_第二卷_预设.json
│   └── 快捷回复选项_预设.json
└── memory-seeds/
    ├── 初始关系_预设.json
    └── 世界状态_预设.json
```

**File**: `presets/loader.ts` (new)

```typescript
export type PresetManifest = {
  id: string;
  name: string;
  version: string;
  description: string;
  type: 'worldbook' | 'memory-seed' | 'plot-events';
  filePath: string;
};

export const AVAILABLE_PRESETS: PresetManifest[] = [
  {
    id: 'character-profiles-v1',
    name: '角色档案预设',
    version: '1.0.0',
    description: '惠/诗羽/英梨梨/出海/美智留的完整0层卡',
    type: 'worldbook',
    filePath: 'presets/worldbooks/角色档案_预设.json',
  },
  {
    id: 'volume1-events',
    name: '第一卷剧情事件',
    version: '1.0.0',
    description: '第一卷所有剧情事件触发条件',
    type: 'plot-events',
    filePath: 'presets/worldbooks/剧情事件_第一卷_预设.json',
  },
];

export async function importPreset(presetId: string): Promise<void> {
  const preset = AVAILABLE_PRESETS.find(p => p.id === presetId);
  if (!preset) throw new Error(`Preset not found: ${presetId}`);
  
  const response = await fetch(preset.filePath);
  const data = await response.json();
  
  // Merge into current worldbook or memory DB
  // Implementation depends on preset type
}
```

**UI Integration**: Add "导入预设" button in settings that shows a list of available presets.

**Benefit**: Easy onboarding for new users; canonical content versioning; easier updates.

---

## Non-Applicable Patterns (Why Your System is Already Better)

### 1. Memory Database Architecture
**KaiTuoYiShi**: Basic 3-tier description  
**Your System**: IslandMemoryDB with 11+ specialized tables  
**Verdict**: ✅ Your system is more sophisticated. No changes needed.

### 2. Variable System
**KaiTuoYiShi**: Independent variable model  
**Your System**: MVU framework with adapter pattern  
**Verdict**: ✅ Your system is more structured. No changes needed.

### 3. Plot Management
**KaiTuoYiShi**: Plot weaving for canonical vs custom tracks  
**Your System**: PlotLibrary with volumes, writing protocols, event routing  
**Verdict**: ✅ Your system is more detailed. No changes needed.

### 4. Phone System
**KaiTuoYiShi**: Independent communication terminal  
**Your System**: phone/ with routes, messages, floating UI, radar charts, music player  
**Verdict**: ✅ Your system is more feature-rich. No changes needed.

---

## Implementation Priority

### P0 (High Impact, Low Effort)
1. **Character Alias Normalization** - Prevents duplicate character bugs
2. **Variable Validation Layer** - Prevents UI crashes from malformed AI output

### P1 (Medium Impact, Medium Effort)
3. **Visual Resource Management** - Structured character asset handling
4. **Built-in vs Additional Content** - Better debugging and modularity

### P2 (Low Impact, Documentation)
5. **Memory Compression Policy Documentation** - No code changes, just document existing strategy
6. **Canonical Material Presets** - Nice-to-have for distribution

---

## Estimated Effort

| Task | Files to Create/Modify | Estimated Lines of Code | Time Estimate |
|------|------------------------|------------------------|---------------|
| Character Alias Normalization | 1 new + 1 modified | ~150 LOC | 2-3 hours |
| Variable Validation Layer | 1 new + 1 modified | ~100 LOC | 1-2 hours |
| Visual Resource Management | 2 new + extend types.ts | ~80 LOC | 2 hours |
| Built-in Content Management | 2 new + 1 modified | ~120 LOC | 2-3 hours |
| Memory Compression Docs | 1 new MD file | N/A | 1 hour |
| Preset System | 2 new + directory structure | ~150 LOC | 3-4 hours |
| **Total** | **~10 files** | **~600 LOC** | **~12-15 hours** |

---

## Conclusion

Your Saekano tavern helper project is **architecturally more sophisticated** than KaiTuoYiShi in memory management, plot routing, and variable handling. The main learnings are in **operational details**:

1. **Character alias normalization** to prevent duplicate entries (highest priority)
2. **Validation/filtering layers** to handle malformed AI output gracefully
3. **Visual asset management** for character-centric resources
4. **Content modularity** with enable/disable toggles for debugging

These are **tactical improvements** to an already strong foundation, not architectural overhauls. Focus on P0 tasks for immediate stability gains.
