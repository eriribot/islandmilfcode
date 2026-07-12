import type { AppState } from '../types';

export function getDebugGameStateText(state: AppState) {
  return JSON.stringify({
    screen: state.activeRunId ? 'game' : 'title',
    activeRunId: state.activeRunId,
    activeSaveId: state.activeSaveId,
    phoneOpen: state.phoneOpen,
    phoneRoute: state.phoneRoute,
    phoneRouteHistory: state.phoneRouteHistory,
    phoneHomePage: state.phoneHomePage,
    phoneTab: state.activeTab,
    generating: state.generating,
    focusedMessageIndex: state.focusedMessageIndex,
    draft: state.draft,
    drawingSettings: state.drawingSettings,
    world: state.statusData.world,
    plot: {
      eventCount: Object.keys(state.plotLibrary.events).length,
      currentEventLoaded: Boolean(
        state.statusData.world.currentMainEventId &&
        state.plotLibrary.events[state.statusData.world.currentMainEventId],
      ),
      sources: state.plotLibrary.sourceEntryNames,
    },
    activeTargetId: state.statusData.activeTargetId,
    targets: state.statusData.targets.map(target => ({
      id: target.id,
      name: target.name,
      affinity: target.affinity,
      stage: target.stage,
    })),
    messageCount: state.uiMessages.length,
  });
}

export function installDebugGlobals(getDebugStateText: () => string) {
  const debugApi = {
    render_game_to_text: getDebugStateText,
    islandmilfcode_debug_state: () => JSON.parse(getDebugStateText()),
  };
  Object.assign(window as any, debugApi);
  Object.assign(globalThis as any, debugApi);

  try {
    if (window.parent && window.parent !== window) {
      (window.parent as any).islandmilfcodeFrame = window;
      Object.assign(window.parent as any, debugApi);
    }
  } catch {
    // Cross-origin/sandboxed iframes cannot expose helpers to the parent window.
  }
}
