import type { CollaborativeRequest, CollaborativeResult } from "../shared/collaborative.js";
export type CollaborativePort = (request: CollaborativeRequest) => Promise<CollaborativeResult>;
let port: CollaborativePort | null = null;
export function configureCollaborativePort(value: CollaborativePort): void { port = value; }
export function requestCollaborative(request: CollaborativeRequest): Promise<CollaborativeResult> {
  if (!port) return Promise.reject(new Error("Collaborative Branch Project requires a desktop session"));
  return port(request);
}
