import { collectWorkspaceFiles } from "../workspaceScan/scanFiles.js";
import type { GlobMatcher } from "./globMatch.js";

export const MAX_CANDIDATE_FILES = 20_000;

export type CandidateFile = {
  absolute: string;
  relative: string;
};

export type CandidateFileList = {
  files: CandidateFile[];
  truncated: boolean;
  source: "git" | "walk";
  aborted: boolean;
};

export async function listCandidateFiles(input: {
  root: string;
  matches?: GlobMatcher | null;
  maxFiles?: number;
  signal?: AbortSignal;
}): Promise<CandidateFileList> {
  const matches = input.matches ?? null;
  const signal = input.signal;
  const collected = await collectWorkspaceFiles({
    root: input.root,
    maxFiles: input.maxFiles ?? MAX_CANDIDATE_FILES,
    ...(matches ? { include: matches } : {}),
    ...(signal ? { shouldStop: () => signal.aborted } : {}),
  });
  return {
    files: collected.files.map((file) => ({ absolute: file.absolute, relative: file.rel })),
    truncated: collected.truncated,
    source: collected.mode,
    aborted: collected.aborted,
  };
}
