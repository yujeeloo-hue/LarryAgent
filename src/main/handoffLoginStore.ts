import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComputerLoginIdentity } from "../shared/computerLogins.js";

export type HandoffLoginCipher = {
  available(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
};

type LoginIdentity = ComputerLoginIdentity;
type LoginFile = { identity: string; passwordCiphertext: string };

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameSite(origin: string): string | null {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

export function createHandoffLoginStore(root: string, cipher: HandoffLoginCipher) {
  const vault = join(root, "handoff-logins");
  const directory = (origin: string) => join(vault, hash(origin));
  const isHash = (value: string) => /^[0-9a-f]{64}$/.test(value);
  async function read(siteHash: string, file: string): Promise<(LoginIdentity & LoginFile) | null> {
    try {
      const stored = JSON.parse(await readFile(join(vault, siteHash, file), "utf8")) as LoginFile;
      const entry = JSON.parse(await cipher.decrypt(Buffer.from(stored.identity, "base64"))) as LoginIdentity;
      return typeof entry?.origin === "string" && sameSite(entry.origin) === entry.origin && hash(entry.origin) === siteHash &&
        typeof entry.account === "string" && hash(entry.account) === file &&
        typeof stored.passwordCiphertext === "string"
        ? { ...stored, origin: entry.origin, account: entry.account }
        : null;
    } catch {
      return null;
    }
  }

  async function available(): Promise<boolean> {
    try { return await cipher.available(); }
    catch { return false; }
  }

  return {
    available,
    async list(): Promise<LoginIdentity[]> {
      if (!(await available())) return [];
      const sites = await readdir(vault).catch(() => []);
      const entries = (await Promise.all(sites.filter(isHash).map(async site => {
        const accounts = await readdir(join(vault, site)).catch(() => []);
        return Promise.all(accounts.filter(isHash).map(file => read(site, file)));
      }))).flat();
      return entries.flatMap(entry => entry ? [{ origin: entry.origin, account: entry.account }] : [])
        .sort((left, right) => left.origin.localeCompare(right.origin) || left.account.localeCompare(right.account));
    },
    async accounts(site: string): Promise<string[]> {
      const origin = sameSite(site);
      if (!origin || !(await available())) return [];
      const files = await readdir(directory(origin)).catch(() => []);
      const entries = await Promise.all(files.filter(isHash).map(file => read(hash(origin), file)));
      return entries.flatMap(entry => entry ? [entry.account] : []).sort();
    },
    async use(site: string, account: string, fill: (password: string) => Promise<boolean>): Promise<boolean> {
      const origin = sameSite(site);
      if (!origin || !(await available())) return false;
      const entry = await read(hash(origin), hash(account));
      if (entry?.account !== account) return false;
      try {
        const secret = JSON.parse(await cipher.decrypt(Buffer.from(entry.passwordCiphertext, "base64"))) as LoginIdentity & { value: string };
        if (secret.origin !== origin || secret.account !== account || typeof secret.value !== "string" ||
            !secret.value || secret.value.length > 4096) return false;
        return await fill(secret.value);
      } catch {
        return false;
      }
    },
    async remember(site: string, account: string, password: string, overwrite = true): Promise<boolean> {
      const origin = sameSite(site);
      if (!origin || !account || account.length > 512 || !password || password.length > 4096 || !(await available())) return false;
      const dir = directory(origin);
      const temporary = join(dir, `.${randomUUID()}.tmp`);
      try {
        const identity = await cipher.encrypt(JSON.stringify({ origin, account }));
        const secret = await cipher.encrypt(JSON.stringify({ origin, account, value: password }));
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify({
          identity: identity.toString("base64"),
          passwordCiphertext: secret.toString("base64"),
        }), { mode: 0o600, flag: "wx" });
        if (overwrite) await rename(temporary, join(dir, hash(account)));
        else await link(temporary, join(dir, hash(account)));
        return true;
      } catch {
        return false;
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    },
    async remove(site: string, account: string): Promise<boolean> {
      const origin = sameSite(site);
      if (!origin || !(await available()) || (await read(hash(origin), hash(account)))?.account !== account) return false;
      try {
        await rm(join(directory(origin), hash(account)));
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type HandoffLoginStore = ReturnType<typeof createHandoffLoginStore>;

export type SafeStorageLike = {
  isEncryptionAvailable?: () => boolean;
  encryptString?: (plainText: string) => Buffer;
  decryptString?: (encrypted: Buffer) => string;
  isAsyncEncryptionAvailable?: () => Promise<boolean>;
  encryptStringAsync?: (plainText: string) => Promise<Buffer>;
  decryptStringAsync?: (encrypted: Buffer) => Promise<{ result: string }>;
};

export function createSafeStorageHandoffCipher(
  storage: SafeStorageLike,
  platform: NodeJS.Platform = process.platform,
): HandoffLoginCipher {
  let asyncMode: Promise<boolean> | null = null;
  const useAsync = (): Promise<boolean> => {
    if (!storage.isAsyncEncryptionAvailable || !storage.encryptStringAsync || !storage.decryptStringAsync) {
      return Promise.resolve(false);
    }
    if (!asyncMode) {
      asyncMode = storage.isAsyncEncryptionAvailable().then(value => value === true).catch(() => false);
    }
    return asyncMode;
  };
  const useSync = (): boolean => platform !== "darwin"
    && storage.isEncryptionAvailable?.() === true
    && typeof storage.encryptString === "function"
    && typeof storage.decryptString === "function";

  return {
    available: async () => (await useAsync()) || useSync(),
    encrypt: async value => {
      if (await useAsync()) return storage.encryptStringAsync!(value);
      if (useSync()) return storage.encryptString!(value);
      throw new Error("handoff login encryption is unavailable");
    },
    decrypt: async value => {
      if (await useAsync()) return (await storage.decryptStringAsync!(value)).result;
      if (useSync()) return storage.decryptString!(value);
      throw new Error("handoff login encryption is unavailable");
    },
  };
}
