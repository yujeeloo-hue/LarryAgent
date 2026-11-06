import type { JsonObject } from "../session/types.js";

const strings = { type: "array", items: { type: "string" } };
const criterion = { type: "object", properties: {
  id: { type: "string" }, description: { type: "string" },
  kind: { type: "string", enum: ["review"], description: "Short description of what done looks like. The verifier judges it; nothing is checked from a file or a command exit code." },
}, required: ["id", "description", "kind"] };
const ruleProperties = {
  name: { type: "string" }, objective: { type: "string" }, mode: { type: "string", enum: ["fixed", "inspection"] },
  scope: { type: "object", properties: { all: { type: "boolean" }, workspaceIds: strings, excludedWorkspaceIds: strings }, required: ["all", "workspaceIds"] },
  enabled: { type: "boolean" }, fullPermissions: { type: "boolean" }, providerId: { type: "string" },
  cadence: { type: "object", description: "Schedule shape, one of: {kind:'minute',n:number} | {kind:'hour',minute:0-59} | {kind:'day',time:'HH:mm'} | {kind:'week',weekdays:[0-6],time:'HH:mm'} (weekdays 0=Sun..6=Sat, e.g. Friday weekly = {kind:'week',weekdays:[5],time:'16:00'}) | {kind:'month',day:1-31,time:'HH:mm'} | {kind:'year',month:1-12,day:1-31,time:'HH:mm'}." },
  acceptance: { type: "array", items: criterion },
};
/** Fields of an existing rule the commander may change; omitted fields stay as they are. */
export const cocoRulePatchSchema: JsonObject = { type: "object", properties: ruleProperties };
/** Shared schema for the commander's tool and background planning. */
export const cocoPlanSchema: JsonObject = {
  type: "object", properties: {
    reply: { type: "string", description: "A brief description of the proposed changes; the conversation reply is written normally after this tool returns." },
    planOnly: { type: "boolean" },
    work: { type: "array", items: { type: "object", properties: {
      key: { type: "string" }, title: { type: "string" }, objective: { type: "string" }, workspaceId: { type: "string" }, priority: { type: "integer", minimum: 0, maximum: 100 }, userPriority: { type: "boolean" }, deadlineAt: { type: "integer" },
      dependsOn: strings, steps: strings, deliverables: strings, acceptance: { type: "array", minItems: 1, items: criterion },
      executionSessionId: { type: "string" }, sessionStrategy: { type: "string", enum: ["continue", "steer", "append"] }, observeSessionId: { type: "string" },
    }, required: ["key", "title", "objective", "workspaceId", "steps", "acceptance"] } },
    activateRuleIds: { ...strings, description: "Existing unconfirmed rules whose original user delegation has been verified. Never activate an explicit plan-only draft or a user-paused rule." },
    changes: { type: "array", items: { type: "object", properties: {
      workId: { type: "string" }, action: { type: "string", enum: ["pause", "resume", "cancel", "priority", "revise"] }, priority: { type: "integer" }, objective: { type: "string" }, steps: strings, acceptance: { type: "array", items: criterion }, answer: { type: "string" },
    }, required: ["workId", "action"] } },
    ruleSuggestions: { type: "array", items: { type: "object", properties: ruleProperties, required: ["name", "objective", "mode", "scope", "enabled", "cadence"] } },
  }, required: ["reply", "work"],
};
