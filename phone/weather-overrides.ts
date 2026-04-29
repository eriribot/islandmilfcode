import type { WeatherReport } from './types';
import type { WeatherRequest } from './weather';

type WeatherOverride = {
  date: string;
  locationIncludes: string;
  conditionLabel: string;
  icon: string;
  weatherCode: number | null;
  temperatureMaxC?: number | null;
  temperatureMinC?: number | null;
  precipitationMm?: number | null;
  windSpeedMaxKmh?: number | null;
};

const WEATHER_OVERRIDES: WeatherOverride[] = [
  {
    date: '2012-03-31',
    locationIncludes: '侦探坡',
    conditionLabel: '晴',
    icon: '100',
    weatherCode: 0,
    temperatureMaxC: 24,
    temperatureMinC: 18,
    precipitationMm: 0,
    windSpeedMaxKmh: 11,
  },
];

export function resolveWeatherOverride(request: WeatherRequest): WeatherReport | null {
  const override = WEATHER_OVERRIDES.find(
    item => item.date === request.date && request.locationLabel.includes(item.locationIncludes),
  );

  if (!override) return null;

  // 这里优先写作品内确认的天气；以后补模板时，只要往 WEATHER_OVERRIDES 里追加日期和地点即可。
  return {
    source: 'Story Weather Override',
    sourceUrl: `story-weather://${override.date}/${encodeURIComponent(override.locationIncludes)}`,
    date: request.date,
    locationLabel: request.locationLabel,
    timezone: request.timezone,
    conditionLabel: override.conditionLabel,
    icon: override.icon,
    temperatureMaxC: override.temperatureMaxC ?? null,
    temperatureMinC: override.temperatureMinC ?? null,
    precipitationMm: override.precipitationMm ?? null,
    windSpeedMaxKmh: override.windSpeedMaxKmh ?? null,
    weatherCode: override.weatherCode,
    fetchedAt: Date.now(),
  };
}
