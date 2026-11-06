/** Subset of DAP bodies used by the minimal session. */

export type DapBreakpoint = {
  id?: number;
  verified: boolean;
  line?: number;
  message?: string;
};

export type DapStackFrame = {
  id: number;
  name: string;
  line: number;
  column: number;
  /** DAP module id; used to load one skipped Engine PDB on frame selection. */
  moduleId?: string | number;
  source?: {
    path?: string;
    name?: string;
    /** Set when the adapter returns disassembly instead of a source file. */
    sourceReference?: number;
  };
};

export type DapModule = {
  id: string | number;
  name: string;
  path?: string;
  symbolStatus?: string;
  symbolFilePath?: string;
};

export type DapThread = {
  id: number;
  name: string;
};

export type DapScope = {
  name: string;
  variablesReference: number;
  expensive?: boolean;
};

export type DapVariable = {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
};

export type DapStoppedEvent = {
  reason?: string;
  description?: string;
  threadId?: number;
  allThreadsStopped?: boolean;
  hitBreakpointIds?: number[];
};

export type DapInitializeBody = {
  supportsConfigurationDoneRequest?: boolean;
};

export type DapSetBreakpointsBody = {
  breakpoints?: DapBreakpoint[];
};

export type DapStackTraceBody = {
  stackFrames?: DapStackFrame[];
  totalFrames?: number;
};

export type DapScopesBody = {
  scopes?: DapScope[];
};

export type DapVariablesBody = {
  variables?: DapVariable[];
};

export type DapEvaluateBody = {
  result: string;
  type?: string;
  variablesReference?: number;
};

/** Response to Larry's `larry/loadModuleSymbols` request. */
export type DapLoadModuleSymbolsBody = {
  moduleName?: string;
  loaded?: boolean;
  alreadyLoaded?: boolean;
  symbolStatus?: string;
  symbolFilePath?: string;
};
