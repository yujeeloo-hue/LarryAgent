import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitExecResult = {
  stdout: string;
  stderr: string;
};

export class GitCommandError extends Error {
  readonly stderr: string;
  readonly code: number | null;

  constructor(message: string, opts: { stderr?: string; code?: number | null }) {
    super(message);
    this.name = "GitCommandError";
    this.stderr = opts.stderr ?? "";
    this.code = opts.code ?? null;
  }
}

function runGitWithStdin(
  cwd: string,
  args: string[],
  input: string,
  maxBuffer: number,
  env?: Record<string, string>,
): Promise<GitExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Console flash guard on Windows (git.exe is a console program).
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (err: Error | null, result?: GitExecResult) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(result!);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        child.kill("SIGTERM");
        finish(
          new GitCommandError("git stdout exceeded maxBuffer", {
            stderr,
            code: null,
          }),
        );
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      finish(
        new GitCommandError(err.message, { stderr, code: null }),
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish(null, { stdout, stderr });
        return;
      }
      const detail = stderr.trim() || `git exited with code ${code ?? "?"}`;
      finish(new GitCommandError(detail, { stderr, code }));
    });

    child.stdin.end(input, "utf8");
  });
}

/**
 * Run `git` in `cwd`. Throws {@link GitCommandError} on non-zero exit.
 */
export async function execGit(
  cwd: string,
  args: string[],
  options?: {
    input?: string;
    maxBuffer?: number;
    env?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<GitExecResult> {
  const maxBuffer = options?.maxBuffer ?? 16 * 1024 * 1024;
  if (options?.input !== undefined) {
    return runGitWithStdin(cwd, args, options.input, maxBuffer, options.env);
  }

  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer,
      env: options?.env ? { ...process.env, ...options.env } : process.env,
      ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
      // Console flash guard on Windows (git.exe is a console program).
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    });
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
    const detail = stderr.trim() || "git command failed";
    throw new GitCommandError(detail, { stderr, code });
  }
}
