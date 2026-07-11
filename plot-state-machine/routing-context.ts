import type { IslandMemoryDB } from '../memorydatabase/types';
import type { StatusData } from '../types';
import { readActivePlotFlagSnapshots, readActivePlotRouteChoice } from './memory';
import { resolvePlotRoutes } from './resolver';
import type { PlotFlagValueMap, PlotRouteResolution } from './types';
import { V07_PLOT_MACHINE } from './v07';

export type PlotRoutingContext = {
  statusData: StatusData;
  evaluationTime: string;
  v07: {
    flagValues: PlotFlagValueMap;
    resolution: PlotRouteResolution;
  };
};

/**
 * 事件发现层的唯一只读路线桥。这里读取权威 memoryDB，但不复制 choice、
 * 不激活 session，也不把路线字段回写到 StatusData。
 */
export function buildPlotRoutingContext(
  statusData: StatusData,
  db: IslandMemoryDB,
  evaluationTime = statusData.world.currentTime,
): PlotRoutingContext {
  const flagValues = Object.fromEntries(
    readActivePlotFlagSnapshots(db, V07_PLOT_MACHINE.id).map(snapshot => [snapshot.definition.id, snapshot.value]),
  );
  const storedChoice = readActivePlotRouteChoice(db, V07_PLOT_MACHINE.id);
  return {
    statusData,
    evaluationTime,
    v07: {
      flagValues,
      resolution: resolvePlotRoutes(V07_PLOT_MACHINE, flagValues, storedChoice),
    },
  };
}
