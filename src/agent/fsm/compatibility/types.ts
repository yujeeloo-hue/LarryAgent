import type { FSMGraphConfig } from "../types.js";

export type LegacyFSMGraphConfig = Omit<FSMGraphConfig, "version"> & { version: 1 };

export type GraphConfigLoadResult = {
  config: FSMGraphConfig;
  migrated: boolean;
  migrations: readonly { from: number; to: number }[];
};
