import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_PROVIDER_ID } from "../settings/types.js";

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = "JellyBot";
const LEGACY_KEYCHAIN_ACCOUNT = "api-key";

function accountForProvider(providerId: string): string {
  return `api-key:${providerId}`;
}

async function readAccount(account: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      { encoding: "utf8" },
    );
    const key = stdout.trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/**
 * Read API key for a provider from macOS Keychain (main/Node only).
 * Falls back to legacy `api-key` account for the default provider id.
 */
export async function readApiKeyFromKeychain(
  providerId: string = DEFAULT_PROVIDER_ID,
): Promise<string | null> {
  const keyed = await readAccount(accountForProvider(providerId));
  if (keyed) return keyed;
  if (providerId === DEFAULT_PROVIDER_ID) {
    return readAccount(LEGACY_KEYCHAIN_ACCOUNT);
  }
  return null;
}

/** Remove the API key for a provider from Keychain if present. */
export async function deleteApiKeyFromKeychain(
  providerId: string = DEFAULT_PROVIDER_ID,
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Keychain is only available on macOS");
  }
  try {
    await execFileAsync(
      "security",
      [
        "delete-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        accountForProvider(providerId),
      ],
      { encoding: "utf8" },
    );
  } catch {
    // Missing entry is fine
  }
  if (providerId === DEFAULT_PROVIDER_ID) {
    try {
      await execFileAsync(
        "security",
        [
          "delete-generic-password",
          "-s",
          KEYCHAIN_SERVICE,
          "-a",
          LEGACY_KEYCHAIN_ACCOUNT,
        ],
        { encoding: "utf8" },
      );
    } catch {
      // Missing legacy entry is fine
    }
  }
}

