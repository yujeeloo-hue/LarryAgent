/**
 * notify tool — port type shared by the builtin and tests.
 *
 * The notification hub lives in the main process (`main/appNotify.ts`,
 * electron-importing), so the tool reaches it through a structural port on
 * ToolExecuteContext — the same pattern as loops / fsmGraphLibrary /
 * turnHandoff. `appNotify` is assignable to {@link NotifyToolPort} by
 * shape (locked by a compile-time check in builtin/notify.test.ts).
 */

/** Input the notification hub accepts (mirror of appNotify's signature). */
export interface NotifyToolInput {
  title: string;
  body: string;
  /** Session the notification jumps to when clicked (toast/popup/bell). */
  sessionId?: string;
  /**
   * File the notification in the bell inbox (message center) as unread
   * until clicked. Absent/false = transient toast/popup only.
   */
  inbox?: boolean;
}

/**
 * Capability surface the notify builtin needs. Shape-compatible with
 * main/appNotify.ts `appNotify`.
 */
export type NotifyToolPort = (input: NotifyToolInput) => void;
