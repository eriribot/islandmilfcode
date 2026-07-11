import {
  PHONE_HOME_APPS_PER_PAGE,
  clampPhoneHomePage,
  clampPhoneHomePageToCount,
  getPhoneHomePageCount,
  getPhoneHomePageItems,
} from '../phone/home-pagination';

function assertEqual<T>(actual: T, expected: T, contract: string) {
  if (Object.is(actual, expected)) return;
  throw new Error(`${contract}: expected ${String(expected)}, received ${String(actual)}`);
}

function assertJsonEqual(actual: unknown, expected: unknown, contract: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) return;
  throw new Error(`${contract}: expected ${expectedJson}, received ${actualJson}`);
}

const apps = Array.from({ length: 12 }, (_, index) => `app-${index + 1}`);
const firstPage = getPhoneHomePageItems(apps, 0);
const secondPage = getPhoneHomePageItems(apps, 1);
const deepSeekApps = Array.from({ length: 13 }, (_, index) => `app-${index + 1}`);
const deepSeekSecondPage = getPhoneHomePageItems(deepSeekApps, 1);

assertEqual(PHONE_HOME_APPS_PER_PAGE, 9, 'contract: the phone home screen shows a fixed 3 x 3 app grid');
assertEqual(getPhoneHomePageCount(apps.length), 2, 'contract: twelve apps produce two home-screen pages');
assertJsonEqual(firstPage.items, apps.slice(0, 9), 'contract: the first page preserves the first nine app positions');
assertJsonEqual(secondPage.items, apps.slice(9), 'contract: the second page contains the remaining apps');
assertJsonEqual(
  [...firstPage.items, ...secondPage.items],
  apps,
  'contract: pagination preserves application order without dropping or duplicating entries',
);
assertEqual(clampPhoneHomePage(-4, apps.length), 0, 'contract: negative page indexes clamp to the first page');
assertEqual(clampPhoneHomePage(99, apps.length), 1, 'contract: oversized page indexes clamp to the last page');
assertEqual(clampPhoneHomePage(Number.NaN, apps.length), 0, 'contract: invalid page indexes recover to the first page');
assertEqual(clampPhoneHomePageToCount(4, 2), 1, 'contract: event handlers cannot move beyond the last rendered page');
assertEqual(getPhoneHomePageCount(0), 1, 'contract: an empty app list still has one stable home-screen page');
assertEqual(getPhoneHomePageCount(deepSeekApps.length), 2, 'contract: enabling the thirteenth app still uses two pages');
assertJsonEqual(
  deepSeekSecondPage.items,
  deepSeekApps.slice(9),
  'contract: the DeepSeek home page keeps all four trailing apps in their original order',
);

console.info('[phone-home-pagination] 12 contracts passed');
