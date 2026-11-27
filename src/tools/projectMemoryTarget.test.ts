import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolReturnCode } from "../session/returnCodes.js";
import { projectMemoryWorkspace } from "./projectMemoryTarget.js";

test("project memory tools use the session workspace unless CoCo targets another project", () => {
  assert.equal(projectMemoryWorkspace({}, { workspacePath: "/work/app", fullPermissionsEnabled: false }), "/work/app");
  const refused = projectMemoryWorkspace({ workspace_id: "site" }, { workspacePath: "/work/app", fullPermissionsEnabled: false });
  assert.equal(typeof refused !== "string" && refused.returnCode, ToolReturnCode.InvalidArguments);
  const coco = { workspacePath: "/home/coco", fullPermissionsEnabled: false, cocoProjectPath: (id: string) => { if (id !== "site") throw new Error("This project is excluded or unavailable"); return "/work/site"; } };
  assert.equal(projectMemoryWorkspace({ workspace_id: "site" }, coco), "/work/site");
  const excluded = projectMemoryWorkspace({ workspace_id: "secret" }, coco);
  assert.equal(typeof excluded !== "string" && excluded.returnCode, ToolReturnCode.NotFound);
  const none = projectMemoryWorkspace({}, { workspacePath: "", fullPermissionsEnabled: false });
  assert.equal(typeof none !== "string" && none.returnCode, ToolReturnCode.NotFound);
});
