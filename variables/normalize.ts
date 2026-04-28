import type { ProgressUpdate } from '../message-format';
import type { StatusData } from '../types';
import { affinityStage, clamp } from './format';

export { defaultStatusData, defaultTarget } from './defaults';
export {
  affinityStage,
  clamp,
  dependencyStage,
  formatDate,
  formatTime,
  getInventoryIcon,
} from './format';
export { normalizeStatusData, serializeStatusData } from './legacy';

const MAX_RECENT_EVENTS = 5;

export function applyProgressUpdate(statusData: StatusData, update: ProgressUpdate): void {
  if (update.time) {
    statusData.world.currentTime = update.time;
  }
  if (update.location) {
    statusData.world.currentLocation = update.location;
  }

  if (update.affinityDelta !== undefined && update.affinityDelta !== 0) {
    const target = statusData.targets.find(t => t.id === statusData.activeTargetId);
    if (target) {
      target.affinity = clamp((target.affinity ?? 50) + update.affinityDelta, 0, 100);
      target.stage = affinityStage(target.affinity);
    }
  }

  if (Object.keys(update.outfitChanges).length) {
    const target = statusData.targets.find(t => t.id === statusData.activeTargetId);
    if (target) {
      for (const [part, desc] of Object.entries(update.outfitChanges)) {
        target.outfits[part] = desc;
      }
    }
  }

  if (Object.keys(update.events).length) {
    const merged = { ...update.events, ...statusData.world.recentEvents };
    const entries = Object.entries(merged).slice(0, MAX_RECENT_EVENTS);
    statusData.world.recentEvents = Object.fromEntries(entries);
  }

  for (const item of update.itemsGained) {
    const existing = statusData.player.inventory[item.name];
    if (existing) {
      existing.count += item.count;
      if (item.description) existing.description = item.description;
    } else {
      statusData.player.inventory[item.name] = {
        description: item.description || '暂无描述',
        count: item.count,
      };
    }
  }

  for (const name of update.itemsLost) {
    delete statusData.player.inventory[name];
  }
}
