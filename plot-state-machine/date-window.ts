import type { PlotDateWindow } from './types';

export function extractPlotDate(value: string | undefined): string {
  return String(value ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
}

export function isPlotDateInWindow(value: string | undefined, window: PlotDateWindow): boolean {
  const date = extractPlotDate(value);
  if (!date) return false;
  return date >= window.start && date <= window.end;
}
