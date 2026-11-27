import type { Session } from "../../session/types.js";

export function touch(session: Session, progressText?: string): void {
  session.updatedAt = Date.now();
  if (progressText !== undefined) {
    session.progressText = progressText;
  }
}
