export const PLOT_ROUTE_REVIEW_RUNTIME_FLAG = 'plotRouteReviewEnabled';
export const PLOT_ROUTE_REVIEW_CANCEL_TOKEN_RUNTIME_FLAG = 'plotRouteReviewCancelToken';

export function isPlotRouteReviewEnabled(runtimeFlags: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return runtimeFlags?.[PLOT_ROUTE_REVIEW_RUNTIME_FLAG] !== false;
}

export function getPlotRouteReviewCancelToken(
  runtimeFlags: Readonly<Record<string, unknown>> | null | undefined,
): number {
  const value = Number(runtimeFlags?.[PLOT_ROUTE_REVIEW_CANCEL_TOKEN_RUNTIME_FLAG] ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * 关闭时递增代际令牌，使已经发出的旧复核即使随后重新开启也不能迟到提交。
 * 令牌只隔离路线复核，不影响普通 progress、手机或总结任务。
 */
export function setPlotRouteReviewEnabled(runtimeFlags: Record<string, unknown>, enabled: boolean): number {
  runtimeFlags[PLOT_ROUTE_REVIEW_RUNTIME_FLAG] = enabled;
  if (!enabled) {
    runtimeFlags[PLOT_ROUTE_REVIEW_CANCEL_TOKEN_RUNTIME_FLAG] = getPlotRouteReviewCancelToken(runtimeFlags) + 1;
  }
  return getPlotRouteReviewCancelToken(runtimeFlags);
}

export function isPlotRouteReviewRunCancelled(
  runtimeFlags: Readonly<Record<string, unknown>> | null | undefined,
  startedWithToken: number,
): boolean {
  return !isPlotRouteReviewEnabled(runtimeFlags) || getPlotRouteReviewCancelToken(runtimeFlags) !== startedWithToken;
}
