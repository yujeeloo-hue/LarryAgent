/** App-global durable user profile (`{userData}/user-memory.json`). */

export const USER_MEMORY_FILENAME = "user-memory.json";

/** Soft target for the living profile markdown (chars): prompt guidance
 * only; the profile is never hard-truncated. */
export const USER_MEMORY_PROFILE_MAX_CHARS = 5_000;

export type UserMemoryStore = {
  version: 1;
  updatedAt: number;
  /** Living markdown profile about the user. */
  profile: string;
};

export type UserMemorySnapshot = {
  profile: string;
  updatedAt: number;
  empty: boolean;
};

export function emptyUserMemoryStore(): UserMemoryStore {
  return {
    version: 1,
    updatedAt: 0,
    profile: "",
  };
}

