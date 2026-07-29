import type { TavernWindow } from '../types';

export type HostLifecycleEventName =
  | 'MESSAGE_UPDATED'
  | 'MESSAGE_SWIPED'
  | 'CHAT_CHANGED'
  | 'WORLDINFO_UPDATED';

export type HostLifecycleDiagnostic = {
  sequence: number;
  observedAt: string;
  event: HostLifecycleEventName;
  hostEventType: string;
  activeSaveId: string | null;
  browserRevision: number;
  plotEventCount: number;
  mainEventCount: number;
  summary: string;
};

type SetupOptions = {
  getActiveSaveId: () => string | null;
  getBrowserRevision: () => number;
  getPlotEventCount: () => number;
  getMainEventCount: () => number;
  onWorldInfoUpdated: () => Promise<void> | void;
  onChatChanged: () => Promise<void> | void;
};

const MAX_DIAGNOSTICS = 160;
const diagnostics: HostLifecycleDiagnostic[] = [];
let sequence = 0;
let activeStop: (() => void) | null = null;

function summarizeArgs(args: unknown[]) {
  return args.slice(0, 3).map(value => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).slice(0, 120);
    if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).slice(0, 8).join(',');
    return String(value ?? '');
  }).join(' | ');
}

export function getHostLifecycleDiagnostics(): HostLifecycleDiagnostic[] {
  return diagnostics.map(item => ({ ...item }));
}

export function setupHostLifecycle(win: TavernWindow, options: SetupOptions): () => void {
  activeStop?.();
  const stops: Array<() => void> = [];
  let refreshTimer: number | null = null;
  const eventMaps = [win.tavern_events, win.iframe_events].filter(Boolean) as Array<Record<string, string>>;
  const aliases: Record<HostLifecycleEventName, string[]> = {
    MESSAGE_UPDATED: ['MESSAGE_UPDATED', 'MESSAGE_EDITED'],
    MESSAGE_SWIPED: ['MESSAGE_SWIPED'],
    CHAT_CHANGED: ['CHAT_CHANGED'],
    WORLDINFO_UPDATED: ['WORLDINFO_UPDATED'],
  };

  const resolveTypes = (event: HostLifecycleEventName) => {
    const types = new Set<string>();
    for (const alias of aliases[event]) {
      eventMaps.forEach(map => {
        if (typeof map[alias] === 'string') types.add(map[alias]);
      });
      types.add(alias);
    }
    return [...types];
  };

  const record = (event: HostLifecycleEventName, hostEventType: string, args: unknown[]) => {
    diagnostics.push({
      sequence: ++sequence,
      observedAt: new Date().toISOString(),
      event,
      hostEventType,
      activeSaveId: options.getActiveSaveId(),
      browserRevision: options.getBrowserRevision(),
      plotEventCount: options.getPlotEventCount(),
      mainEventCount: options.getMainEventCount(),
      summary: summarizeArgs(args),
    });
    if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTICS);
  };

  const scheduleControlledRefresh = (callback: () => Promise<void> | void) => {
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      Promise.resolve(callback()).catch(error => console.warn('[host-lifecycle] refresh callback failed:', error));
    }, 500);
  };

  if (typeof win.eventOn === 'function') {
    (Object.keys(aliases) as HostLifecycleEventName[]).forEach(event => {
      resolveTypes(event).forEach(hostEventType => {
        try {
          const subscription = win.eventOn?.(hostEventType, (...args: unknown[]) => {
            try {
              record(event, hostEventType, args);
              // Message edits/swipes are observations only. They never infer a
              // project rollback, image commit, timeline truncation or GC.
              if (event === 'WORLDINFO_UPDATED') scheduleControlledRefresh(options.onWorldInfoUpdated);
              else if (event === 'CHAT_CHANGED') scheduleControlledRefresh(options.onChatChanged);
            } catch (error) {
              console.warn('[host-lifecycle] listener isolated an error:', error);
            }
          });
          if (subscription?.stop) stops.push(() => subscription.stop());
        } catch (error) {
          console.warn('[host-lifecycle] event subscription unavailable:', hostEventType, error);
        }
      });
    });
  }

  const debugScope = win as TavernWindow & { islandmilfcode_host_diagnostics?: () => HostLifecycleDiagnostic[] };
  debugScope.islandmilfcode_host_diagnostics = getHostLifecycleDiagnostics;
  activeStop = () => {
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    stops.forEach(stop => {
      try { stop(); } catch { /* isolated host cleanup */ }
    });
    if (debugScope.islandmilfcode_host_diagnostics === getHostLifecycleDiagnostics) {
      delete debugScope.islandmilfcode_host_diagnostics;
    }
    activeStop = null;
  };
  return activeStop;
}
