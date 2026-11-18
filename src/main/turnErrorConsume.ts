import { isTurnErrorMessage } from "../session/turnErrorText.js";
import type { Session } from "../session/types.js";

export function consumeTurnErrorMessage(
  session: Session,
  messageId: string,
): { removed: boolean } {
  const errorIndex = session.messages.findIndex(
    (message) => message.id === messageId && isTurnErrorMessage(message),
  );
  if (errorIndex < 0) return { removed: false };
  session.messages.splice(errorIndex, 1);
  return { removed: true };
}
