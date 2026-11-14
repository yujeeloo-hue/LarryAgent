import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  askVcsCredentials,
  buildSvnAuthArgs,
  isVcsAuthFailure,
} from "../vcs/vcsAuth.js";

const execFileAsync = promisify(execFile);

export type SvnExecResult = {
  stdout: string;
  stderr: string;
};

export class SvnCommandError extends Error {
  readonly stderr: string;
  readonly code: number | null;

  constructor(message: string, opts: { stderr?: string; code?: number | null }) {
    super(message);
    this.name = "SvnCommandError";
    this.stderr = opts.stderr ?? "";
    this.code = opts.code ?? null;
  }
}

/**
 * Run `svn --non-interactive` in `cwd`. Non-interactive keeps credential
 * prompts from hanging the app — auth failures surface as errors instead
 * (handled upstream by `execSvnWithAuth`, which asks the user and retries).
 * Throws {@link SvnCommandError} on non-zero exit (also when `svn` is
 * missing, in which case the message is the spawn error text).
 */
export async function execSvn(
  cwd: string,
  args: string[],
  options?: { maxBuffer?: number },
): Promise<SvnExecResult> {
  const maxBuffer = options?.maxBuffer ?? 16 * 1024 * 1024;

  try {
    const { stdout, stderr } = await execFileAsync(
      "svn",
      ["--non-interactive", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer,
        // Console flash guard on Windows (svn.exe is a console program).
        ...(process.platform === "win32" ? { windowsHide: true } : {}),
      },
    );
    return {
      stdout: typeof stdout === "string" ? stdout : String(stdout),
      stderr: typeof stderr === "string" ? stderr : String(stderr),
    };
  } catch (err) {
    const e = err as {
      message?: string;
      stderr?: string;
      stdout?: string;
      code?: number | string | null;
    };
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : typeof e.message === "string"
          ? e.message
          : String(err);
    const code =
      typeof e.code === "number"
        ? e.code
        : typeof e.code === "string" && /^\d+$/.test(e.code)
          ? Number(e.code)
          : null;
    const detail = stderr.trim() || "svn command failed";
    throw new SvnCommandError(detail, { stderr, code });
  }
}

// ---------------------------------------------------------------------------
// Auth-aware wrapper — ask + save + retry (see src/vcs/vcsAuth.ts)
// ---------------------------------------------------------------------------

/**
 * `svn` execution with interactive credential recovery:
 *  1. run the command (non-interactive, as always);
 *  2. on an auth failure, ask the user for credentials (renderer dialog);
 *  3. retry with `--username/--password --no-auth-cache`.
 *
 * The retry loop is bounded (2 asks) so a wrong password cannot spin the
 * dialog forever. Local-only operations that never authenticate simply
 * pass through — `isVcsAuthFailure` keeps them on the fail-fast path.
 */
export async function execSvnWithAuth(
  cwd: string,
  args: string[],
  opts?: {
    maxBuffer?: number;
    /** Dialog wording — "Annotate", "Update", "Commit"… */
    operation?: string;
    /** Credential cache/store key (defaults to the WC root). */
    cacheKey?: string;
    /** Username prefill for the retry ask after a rejection. */
    defaultUsername?: string;
  },
): Promise<SvnExecResult> {
  const maxBuffer = opts?.maxBuffer ?? 16 * 1024 * 1024;
  let lastAuthError: SvnCommandError | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!lastAuthError) {
        return await execSvn(cwd, args, { maxBuffer });
      }
      const credentials = await askVcsCredentials({
        vcs: "svn",
        operation: opts?.operation ?? "SVN",
        context: cwd,
        detail: lastAuthError.message,
        ...(opts?.defaultUsername !== undefined
          ? { defaultUsername: opts.defaultUsername }
          : {}),
        ...(opts?.cacheKey !== undefined ? { cacheKey: opts.cacheKey } : {}),
      });
      if (!credentials) {
        throw lastAuthError;
      }
      return await execSvn(
        cwd,
        [...args, ...buildSvnAuthArgs(credentials)],
        { maxBuffer },
      );
    } catch (err) {
      if (err instanceof SvnCommandError && isVcsAuthFailure(err.message)) {
        lastAuthError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastAuthError ?? new SvnCommandError("svn command failed", {
    stderr: "",
    code: null,
  });
}
