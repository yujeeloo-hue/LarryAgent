
export const USER_MEMORY_FILENAME = "user-memory.json";

export const USER_MEMORY_PROFILE_MAX_CHARS = 5_000;

export type UserMemoryStore = {
  version: 1;
  updatedAt: number;
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

