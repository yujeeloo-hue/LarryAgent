export const ToolReturnCode = {
  Success: 0,
  GenericFailure: 1,
  PermissionDenied: 2,
  NotFound: 3,
  Timeout: 4,
  InvalidArguments: 5,
  Cancelled: 6,
} as const;

export type ToolReturnCodeValue =
  (typeof ToolReturnCode)[keyof typeof ToolReturnCode];

