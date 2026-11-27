
import type { JsonObject } from "../session/types.js";

export type NotificationCenterEvent = {
  eventName: string;
  params: JsonObject;
  sender: unknown;
};

export type NotificationCenterListener = (event: NotificationCenterEvent) => void;

const listeners = new Set<NotificationCenterListener>();

export function postNotification(event: NotificationCenterEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err) {
      console.error("[notification-center] listener threw", err);
    }
  }
}

export function addNotificationListener(
  listener: NotificationCenterListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
