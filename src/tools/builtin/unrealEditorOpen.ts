import type { ToolDefinition, ToolHandler } from "../types.js";
import { openUnrealEditorAsset } from "../../unreal/editorClient.js";

export const unrealEditorOpenDefinition: ToolDefinition = {
  name: "unreal_editor_open",
  description:
    "Open a Blueprint or asset in the connected Unreal Editor. " +
    "Pass assetPath from unreal_editor_find_references. " +
    "Pass graphGuid and nodeGuid from the same hit to select that node. " +
    "With only assetPath, the editor opens the asset.",
  parameters: {
    type: "object",
    properties: {
      assetPath: {
        type: "string",
        description: "Soft object path, for example /Game/Characters/BP_Hero.BP_Hero.",
      },
      graphGuid: {
        type: "string",
        description: "32 hex characters, no dashes. Optional.",
      },
      nodeGuid: {
        type: "string",
        description: "32 hex characters, no dashes. Optional.",
      },
    },
    required: ["assetPath"],
  },
  defaultPermissionLevel: 0,
};

export const unrealEditorOpenHandler: ToolHandler = (args, context) =>
  openUnrealEditorAsset(context.workspacePath, args, context.signal);
