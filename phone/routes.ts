import type { AppState, TabKey } from '../types';
import type { PhoneRoute } from './types';

export function getRouteForTab(tab: TabKey): PhoneRoute {
  if (tab === 'status') return 'app:status';
  if (tab === 'inventory') return 'app:inventory';
  return 'app:summary';
}

export function getTabForRoute(route: PhoneRoute): TabKey | null {
  if (route === 'app:status') return 'status';
  if (route === 'app:inventory') return 'inventory';
  if (route === 'app:summary') return 'summary';
  return null;
}

export function resetPhoneRoute(state: AppState) {
  state.phoneRoute = 'home';
  state.phoneRouteHistory = [];
}

export function navigatePhoneRoute(
  state: AppState,
  route: PhoneRoute,
  hooks: {
    closeReaderContextMenu: (shouldRender: boolean) => void;
    clearNotification: (shouldRender: boolean) => void;
    render: () => void;
  },
) {
  hooks.closeReaderContextMenu(false);
  if (route === state.phoneRoute) return;
  state.phoneRouteHistory = [...state.phoneRouteHistory, state.phoneRoute];
  state.phoneRoute = route;
  const tab = getTabForRoute(route);
  if (tab) {
    state.activeTab = tab;
    if (tab === state.notification?.targetTab) hooks.clearNotification(false);
  }
  hooks.render();
}

export function navigatePhoneBack(
  state: AppState,
  hooks: {
    closeReaderContextMenu: (shouldRender: boolean) => void;
    render: () => void;
  },
) {
  hooks.closeReaderContextMenu(false);
  const previous = state.phoneRouteHistory[state.phoneRouteHistory.length - 1];
  if (previous) {
    state.phoneRoute = previous;
    state.phoneRouteHistory = state.phoneRouteHistory.slice(0, -1);
  } else {
    state.phoneRoute = 'home';
  }
  const tab = getTabForRoute(state.phoneRoute);
  if (tab) state.activeTab = tab;
  hooks.render();
}

export function openPhoneRoute(
  state: AppState,
  hooks: {
    closeReaderContextMenu: (shouldRender: boolean) => void;
    clearNotification: (shouldRender: boolean) => void;
    render: () => void;
  },
  targetRoute?: PhoneRoute,
) {
  hooks.closeReaderContextMenu(false);
  state.phoneOpen = true;
  if (targetRoute) {
    state.phoneRoute = targetRoute;
    state.phoneRouteHistory = targetRoute === 'home' ? [] : ['home'];
  } else {
    resetPhoneRoute(state);
  }
  const tab = getTabForRoute(state.phoneRoute);
  if (tab) {
    state.activeTab = tab;
    if (tab === state.notification?.targetTab) hooks.clearNotification(false);
  }
  hooks.render();
}

export function closePhoneRoute(
  state: AppState,
  hooks: {
    closeReaderContextMenu: (shouldRender: boolean) => void;
    render: () => void;
  },
) {
  if (!state.phoneOpen) return;
  hooks.closeReaderContextMenu(false);
  state.phoneOpen = false;
  resetPhoneRoute(state);
  hooks.render();
}
