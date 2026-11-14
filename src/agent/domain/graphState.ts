import type { RoleKind } from "../roles/types.js";

export type StepPhase = "idle" | "working" | "awaiting_verify";
export type VerifyResult = "pass" | "fail" | null;

export type StepFsmPatch = {
  stepPhase?: StepPhase;
  currentStepId?: string | null;
  pendingVerifyStepIds?: string[];
  verifyResult?: VerifyResult;
  planDocPath?: string | null;
};

export type StepFsmSnapshot = {
  activeRole: RoleKind;
  stepPhase: StepPhase;
  currentStepId: string | null;
  pendingVerifyStepIds: string[];
  verifyResult: VerifyResult;
  planDocPath: string | null;
};
