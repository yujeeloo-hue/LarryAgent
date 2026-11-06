export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogSource = "main" | "renderer";

export type LogEntry = {
  id: string;
  ts: number;
  level: LogLevel;
  source: LogSource;
  message: string;
};

export type ProcessMetrics = {
  cpuPercent: number;
  memoryMB: number;
};
