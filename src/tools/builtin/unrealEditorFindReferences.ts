import type { ToolDefinition, ToolHandler } from "../types.js";
import { findUnrealEditorReferences } from "../../unreal/editorClient.js";

export const unrealEditorFindReferencesDefinition: ToolDefinition = {
  name: "unreal_editor_find_references",
  description:
    "Find Blueprint references to a C++ class or function through a connected Unreal Editor " +
    "that speaks the unreal-editor protocol (call nodes, event overrides, and Blueprint subclasses). " +
    "This does not search C++ translation units; use find_cxx_references for those. " +
    "Requires the editor to be open on this workspace's .uproject. " +
    "Each hit includes assetPath and, when the reference is a node, graphGuid and nodeGuid " +
    "to pass to unreal_editor_open.",
  parameters: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        description: '"function" or "class".',
      },
      className: {
        type: "string",
        description: "C++ class name, for example AMyCharacter.",
      },
      name: {
        type: "string",
        description: "C++ function identifier. Required when kind is function.",
      },
      module: {
        type: "string",
        description: "Unreal module name, for example NFGame.",
      },
      limit: {
        type: "integer",
        description: "Maximum hits to return, from 1 to 200. Default 100.",
      },
    },
    required: ["kind", "className"],
  },
  defaultPermissionLevel: 0,
};

export const unrealEditorFindReferencesHandler: ToolHandler = (args, context) =>
  findUnrealEditorReferences(context.workspacePath, args, context.signal);
