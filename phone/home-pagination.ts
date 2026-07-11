export const PHONE_HOME_APPS_PER_PAGE = 9;

export function getPhoneHomePageCount(appCount: number): number {
  const normalizedCount = Number.isFinite(appCount) ? Math.max(0, Math.trunc(appCount)) : 0;
  return Math.max(1, Math.ceil(normalizedCount / PHONE_HOME_APPS_PER_PAGE));
}

export function clampPhoneHomePageToCount(page: number, pageCount: number): number {
  const normalizedPageCount = Number.isFinite(pageCount) ? Math.max(1, Math.trunc(pageCount)) : 1;
  const normalizedPage = Number.isFinite(page) ? Math.trunc(page) : 0;
  return Math.min(Math.max(0, normalizedPage), normalizedPageCount - 1);
}

export function clampPhoneHomePage(page: number, appCount: number): number {
  return clampPhoneHomePageToCount(page, getPhoneHomePageCount(appCount));
}

export function getPhoneHomePageItems<T>(items: readonly T[], page: number) {
  const activePage = clampPhoneHomePage(page, items.length);
  const pageCount = getPhoneHomePageCount(items.length);
  const start = activePage * PHONE_HOME_APPS_PER_PAGE;
  return {
    activePage,
    pageCount,
    items: items.slice(start, start + PHONE_HOME_APPS_PER_PAGE),
  };
}
