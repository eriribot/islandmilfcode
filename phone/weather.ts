import type { AppState } from '../types';
import type { WeatherReport, WeatherState } from './types';
import { resolveWeatherOverride } from './weather-overrides';

const STORY_START_DATE = '2012-03-31';

const DETECTIVE_SLOPE = {
  displayLabel: '\u4fa6\u63a2\u5761',
  weatherLabel: '\u4fa6\u63a2\u5761',
  latitude: 35.6404,
  longitude: 139.6516,
  timezone: 'Asia/Tokyo',
};

export type WeatherRequest = {
  key: string;
  date: string;
  locationLabel: string;
  latitude: number;
  longitude: number;
  timezone: string;
};

type OpenMeteoArchiveResponse = {
  daily?: {
    time?: string[];
    weather_code?: Array<number | null>;
    temperature_2m_max?: Array<number | null>;
    temperature_2m_min?: Array<number | null>;
    precipitation_sum?: Array<number | null>;
    wind_speed_10m_max?: Array<number | null>;
  };
};

let weatherRequestId = 0;

export function getDefaultWeatherState(): WeatherState {
  return {
    key: '',
    status: 'idle',
    report: null,
    error: null,
  };
}

export function extractWeatherDate(currentTime: string) {
  const match = currentTime.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!match) return STORY_START_DATE;

  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function resolveStoryLocation(currentLocation: string) {
  const trimmed = currentLocation.trim();
  if (!trimmed) return DETECTIVE_SLOPE;

  // Open-Meteo needs coordinates, while the story UI keeps the current story label.
  return {
    ...DETECTIVE_SLOPE,
    displayLabel: trimmed,
    weatherLabel: trimmed.includes('\u4fa6\u63a2\u5761') ? DETECTIVE_SLOPE.weatherLabel : trimmed,
  };
}

export function resolveWeatherRequest(currentTime: string, currentLocation: string): WeatherRequest {
  const date = extractWeatherDate(currentTime);
  const location = resolveStoryLocation(currentLocation);

  return {
    key: `${date}|${location.weatherLabel}`,
    date,
    locationLabel: location.displayLabel,
    latitude: location.latitude,
    longitude: location.longitude,
    timezone: location.timezone,
  };
}

export function getWeatherRequestUrl(request: WeatherRequest) {
  const params = new URLSearchParams({
    latitude: String(request.latitude),
    longitude: String(request.longitude),
    start_date: request.date,
    end_date: request.date,
    daily: [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_sum',
      'wind_speed_10m_max',
    ].join(','),
    timezone: request.timezone,
  });

  return `https://archive-api.open-meteo.com/v1/archive?${params.toString()}`;
}

export function describeWeatherCode(code: number | null) {
  if (code === null || Number.isNaN(code)) return { label: '\u5929\u6c14\u672a\u77e5', icon: '999' };
  if (code === 0) return { label: '\u6674', icon: '100' };
  if ([1, 2].includes(code)) return { label: '\u6674\u95f4\u591a\u4e91', icon: '101' };
  if (code === 3) return { label: '\u9634', icon: '104' };
  if ([45, 48].includes(code)) return { label: '\u96fe', icon: '501' };
  if ([51, 53, 55, 56, 57].includes(code)) return { label: '\u6bdb\u6bdb\u96e8', icon: '309' };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { label: '\u96e8', icon: '305' };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { label: '\u96ea', icon: '400' };
  if ([95, 96, 99].includes(code)) return { label: '\u96f7\u9635\u96e8', icon: '302' };
  return { label: '\u591a\u4e91', icon: '101' };
}

function pickDailyValue(values: Array<number | null> | undefined) {
  return values?.[0] ?? null;
}

export async function loadWeatherReport(request: WeatherRequest): Promise<WeatherReport> {
  const override = resolveWeatherOverride(request);
  if (override) return override;

  const sourceUrl = getWeatherRequestUrl(request);
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`Open-Meteo request failed: ${response.status}`);

  const data = (await response.json()) as OpenMeteoArchiveResponse;
  const code = pickDailyValue(data.daily?.weather_code);
  const condition = describeWeatherCode(code);

  return {
    source: 'Open-Meteo Archive',
    sourceUrl,
    date: data.daily?.time?.[0] ?? request.date,
    locationLabel: request.locationLabel,
    timezone: request.timezone,
    conditionLabel: condition.label,
    icon: condition.icon,
    temperatureMaxC: pickDailyValue(data.daily?.temperature_2m_max),
    temperatureMinC: pickDailyValue(data.daily?.temperature_2m_min),
    precipitationMm: pickDailyValue(data.daily?.precipitation_sum),
    windSpeedMaxKmh: pickDailyValue(data.daily?.wind_speed_10m_max),
    weatherCode: code,
    fetchedAt: Date.now(),
  };
}

export function refreshWeatherForCurrentState(state: AppState, render: () => void) {
  const request = resolveWeatherRequest(state.statusData.world.currentTime, state.statusData.world.currentLocation);
  if (state.weather.key === request.key && state.weather.status !== 'idle') return;

  const requestId = ++weatherRequestId;
  state.weather = {
    key: request.key,
    status: 'loading',
    report: state.weather.key === request.key ? state.weather.report : null,
    error: null,
  };

  loadWeatherReport(request)
    .then(report => {
      if (requestId !== weatherRequestId) return;
      state.weather = {
        key: request.key,
        status: 'ready',
        report,
        error: null,
      };
      render();
    })
    .catch(error => {
      if (requestId !== weatherRequestId) return;
      state.weather = {
        key: request.key,
        status: 'error',
        report: null,
        error: error instanceof Error ? error.message : '天气源暂时不可用',
      };
      render();
    });
}
