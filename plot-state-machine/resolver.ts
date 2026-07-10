import type { PlotFlagValueMap, PlotMachineDefinition, PlotRouteId, PlotRouteResolution } from './types';

export function resolvePlotRoutes(
  machine: PlotMachineDefinition,
  flagValues: PlotFlagValueMap,
  storedChoice?: string | null,
): PlotRouteResolution {
  const routes = machine.routes.map(route => {
    const missingFlagIds = route.requiredFlagIds.filter(flagId => flagValues[flagId] !== 'yes');
    return {
      id: route.id,
      label: route.label,
      eligible: missingFlagIds.length === 0,
      missingFlagIds,
    };
  });
  const eligibleRouteIds = routes.filter(route => route.eligible).map(route => route.id);
  const knownChoice = machine.routes.some(route => route.id === storedChoice) ? (storedChoice as PlotRouteId) : null;
  const choice = knownChoice && eligibleRouteIds.includes(knownChoice) ? knownChoice : null;

  return {
    machineId: machine.id,
    routes,
    eligibleRouteIds,
    choice,
    rejectedChoice: storedChoice && !choice ? storedChoice : null,
  };
}
