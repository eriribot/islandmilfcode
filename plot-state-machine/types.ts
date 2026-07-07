import type { IslandMemoryDB } from '../memorydatabase/types';

export type PlotMachineId = 'v07';

export type PlotFlagValue = 'yes' | 'no';

export type PlotFlagDefinition = {
  id: string;
  storageKey: `plotFlag.${string}`;
  earliestDate: string;
  label: string;
  yesMeaning: string;
  noMeaning: string;
};

export type PlotMachineDefinition = {
  id: PlotMachineId;
  targetId: string;
  title: string;
  flags: readonly PlotFlagDefinition[];
};

export type PlotFlagDelta = {
  machineId: PlotMachineId;
  flagId: string;
  storageKey: `plotFlag.${string}`;
  value: PlotFlagValue;
};

export type PlotFlagSnapshot = {
  definition: PlotFlagDefinition;
  value: PlotFlagValue;
};

export type PlotFlagCommitContext = {
  db: IslandMemoryDB;
  currentTime?: string;
  sourceRange?: [number, number];
};
