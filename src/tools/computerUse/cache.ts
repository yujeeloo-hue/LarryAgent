import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const COMPUTER_USE_CACHE_DIR_NAME = "ComputerUseCache";

const FALLBACK_CACHE_DIR = join(tmpdir(), "jellybot-computer-use");

let appDataRoot: string | null = null;

export function configureComputerUseCache(root: string | null): void {
  appDataRoot = root;
}

export function computerUseCacheDir(): string {
  return appDataRoot ? join(appDataRoot, COMPUTER_USE_CACHE_DIR_NAME) : FALLBACK_CACHE_DIR;
}

export async function ensureComputerUseCacheDir(): Promise<string> {
  const dir = computerUseCacheDir();
  await mkdir(dir, { recursive: true });
  return dir;
}
