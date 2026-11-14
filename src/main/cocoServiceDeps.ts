import type { CocoContext, CocoEngine } from "../coco/engine.js";
import type { CocoRepository } from "../coco/repository.js";
import type { CocoToolRuntime } from "../coco/toolRuntime.js";
import type { CocoRule, CocoSettings } from "../coco/types.js";
import type { SessionStore } from "./sessionRuntime.js";

/** Shared capabilities handed to each CoCo service module by the composition root. */
export type CocoServiceDeps = {
  root: string;
  store: SessionStore;
  repository: CocoRepository;
  tools: CocoToolRuntime;
  alive(): boolean;
  /** Lazy: the engine is constructed after the ports that reference it. */
  engine(): CocoEngine;
  context(settings: CocoSettings, rule?: CocoRule): CocoContext;
};

export type CocoUsageFn = (tokens: number, estimated: boolean, id: string) => void;
