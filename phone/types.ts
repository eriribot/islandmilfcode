export type PhoneRoute = 'home' | 'app:reader' | 'app:summary' | 'app:status' | 'app:inventory' | 'app:settings';

export type FloatingPhonePosition = {
  x: number;
  y: number;
};

export type WeatherReport = {
  source: 'Open-Meteo Archive';
  sourceUrl: string;
  date: string;
  locationLabel: string;
  timezone: string;
  conditionLabel: string;
  icon: string;
  temperatureMaxC: number | null;
  temperatureMinC: number | null;
  precipitationMm: number | null;
  windSpeedMaxKmh: number | null;
  weatherCode: number | null;
  fetchedAt: number;
};

export type WeatherState = {
  key: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  report: WeatherReport | null;
  error: string | null;
};
