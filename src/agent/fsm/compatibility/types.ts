import type { FSMGraphConfig } from "../types.js";

/** Historical serialized input; the runtime accepts only FSMGraphConfig v2. */
export type LegacyFSMGraphConfig = Omit<FSMGraphConfig, "version"> & { version: 1 };

export type GraphConfigLoadResult = {
  config: FSMGraphConfig;
  migrated: boolean;
  migrations: readonly { from: number; to: number }[];
};
