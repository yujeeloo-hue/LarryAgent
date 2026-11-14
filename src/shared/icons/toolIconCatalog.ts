import type { FunctionalIconName } from "./functionalIcons.js";

/** One semantic mapping for tool cards and Thinking hints on both clients. */
export const toolIconCatalog: Record<string, { displayName: string; icon: FunctionalIconName | "MessagesSquare"; expandResultByDefault: boolean }> = {
  "coco_job_input": { "displayName": "Read task evidence", "icon": "FileText", "expandResultByDefault": false },
  "read_coco_context": { "displayName": "Read project context", "icon": "Search", "expandResultByDefault": false },
  "submit_coco_result": { "displayName": "Save check result", "icon": "ListTodo", "expandResultByDefault": false },
  "read_file": {
    "displayName": "Read File",
    "icon": "FileText",
    "expandResultByDefault": false
  },
  "write_file": {
    "displayName": "Write File",
    "icon": "FilePlus",
    "expandResultByDefault": true
  },
  "dev_tasks": {
    "displayName": "Dev Tasks",
    "icon": "ListTodo",
    "expandResultByDefault": false
  },
  "run_dev_task": {
    "displayName": "Run Dev Task",
    "icon": "SquareTerminal",
    "expandResultByDefault": false
  },
  "patch": {
    "displayName": "Patch",
    "icon": "FileDiff",
    "expandResultByDefault": true
  },
  "append_file": {
    "displayName": "Append File",
    "icon": "FilePlus2",
    "expandResultByDefault": true
  },
  "edit_file": {
    "displayName": "Edit File",
    "icon": "FilePenLine",
    "expandResultByDefault": true
  },
  "run_shell": {
    "displayName": "Shell",
    "icon": "SquareTerminal",
    "expandResultByDefault": false
  },
  "exec_command": {
    "displayName": "Shell",
    "icon": "SquareTerminal",
    "expandResultByDefault": false
  },
  "upload_files": {
    "displayName": "Upload Files",
    "icon": "CloudUpload",
    "expandResultByDefault": false
  },
  "list_dir": {
    "displayName": "List Directory",
    "icon": "FolderOpen",
    "expandResultByDefault": false
  },
  "get_workspace_path": {
    "displayName": "Workspace Path",
    "icon": "FolderTree",
    "expandResultByDefault": false
  },
  "get_current_time": {
    "displayName": "Current Time",
    "icon": "Clock",
    "expandResultByDefault": false
  },
  "grep": {
    "displayName": "Search",
    "icon": "Search",
    "expandResultByDefault": false
  },
  "glob": {
    "displayName": "Find Files",
    "icon": "Files",
    "expandResultByDefault": false
  },
  "symbols": {
    "displayName": "Symbols",
    "icon": "Braces",
    "expandResultByDefault": false
  },
  "batch_read": {
    "displayName": "Batch Read",
    "icon": "Files",
    "expandResultByDefault": false
  },
  "batch_search": {
    "displayName": "Batch Search",
    "icon": "ScanSearch",
    "expandResultByDefault": false
  },
  "find_cxx_references": {
    "displayName": "C++ References",
    "icon": "Braces",
    "expandResultByDefault": false
  },
  "ask_user": {
    "displayName": "Ask User",
    "icon": "MessagesSquare",
    "expandResultByDefault": true
  },
  "request_full_permissions": {
    "displayName": "Bypass Permissions",
    "icon": "Shield",
    "expandResultByDefault": true
  },
  "search_tools": {
    "displayName": "Search Tools",
    "icon": "Search",
    "expandResultByDefault": false
  },
  "search_skills": {
    "displayName": "Search Skills",
    "icon": "BookOpen",
    "expandResultByDefault": false
  },
  "tool_describe": {
    "displayName": "Tool Describe",
    "icon": "BookOpen",
    "expandResultByDefault": false
  },
  "tool_call": {
    "displayName": "Tool Call",
    "icon": "Plug",
    "expandResultByDefault": false
  },
  "create_plan": {
    "displayName": "Create Plan",
    "icon": "ListTodo",
    "expandResultByDefault": false
  },
  "write_plan_doc": {
    "displayName": "Write Plan Doc",
    "icon": "FilePenLine",
    "expandResultByDefault": true
  },
  "adopt_plan_doc": {
    "displayName": "Adopt Plan Doc",
    "icon": "FilePenLine",
    "expandResultByDefault": false
  },
  "update_plan": {
    "displayName": "Update Plan",
    "icon": "ListChecks",
    "expandResultByDefault": false
  },
  "complete_plan": {
    "displayName": "Complete Plan",
    "icon": "CircleCheck",
    "expandResultByDefault": false
  },
  "fsm_route": {
    "displayName": "FSM Route",
    "icon": "Route",
    "expandResultByDefault": false
  },
  "fsm_graph": {
    "displayName": "FSM Graph",
    "icon": "Route",
    "expandResultByDefault": false
  },
  "fsm_graph_edit": {
    "displayName": "FSM Graph Edit",
    "icon": "Route",
    "expandResultByDefault": false
  },
  "turn_handoff": {
    "displayName": "Turn Handoff",
    "icon": "Route",
    "expandResultByDefault": false
  },
  "report_step_blocked": {
    "displayName": "Step Blocked",
    "icon": "ListChecks",
    "expandResultByDefault": true
  },
  "read_image": {
    "displayName": "Read Image",
    "icon": "Image",
    "expandResultByDefault": false
  },
  "display_image": {
    "displayName": "Display Image",
    "icon": "Image",
    "expandResultByDefault": false
  },
  "generate_image": {
    "displayName": "Generate Image",
    "icon": "ImagePlus",
    "expandResultByDefault": false
  },
  "capture_app_window": {
    "displayName": "Capture App Window",
    "icon": "Camera",
    "expandResultByDefault": false
  },
  "convert_to_pdf": {
    "displayName": "Convert to PDF",
    "icon": "FileDown",
    "expandResultByDefault": false
  },
  "display_pdf": {
    "displayName": "Display PDF",
    "icon": "FileText",
    "expandResultByDefault": false
  },
  "present_demo": {
    "displayName": "Present Demo",
    "icon": "Monitor",
    "expandResultByDefault": true
  },
  "create_mcp_server": {
    "displayName": "Create MCP",
    "icon": "Plug",
    "expandResultByDefault": false
  },
  "update_mcp_server": {
    "displayName": "Update MCP",
    "icon": "Pencil",
    "expandResultByDefault": false
  },
  "delete_mcp_server": {
    "displayName": "Delete MCP",
    "icon": "Trash2",
    "expandResultByDefault": false
  },
  "create_skill": {
    "displayName": "Create Skill",
    "icon": "BookOpen",
    "expandResultByDefault": false
  },
  "update_skill": {
    "displayName": "Update Skill",
    "icon": "Pencil",
    "expandResultByDefault": false
  },
  "delete_skill": {
    "displayName": "Delete Skill",
    "icon": "Trash2",
    "expandResultByDefault": false
  },
  "read_skill": {
    "displayName": "Read Skill",
    "icon": "BookMarked",
    "expandResultByDefault": false
  },
  "write_skill_file": {
    "displayName": "Write Skill File",
    "icon": "FilePlus2",
    "expandResultByDefault": false
  },
  "patch_skill": {
    "displayName": "Patch Skill",
    "icon": "FileDiff",
    "expandResultByDefault": false
  },
  "merge_skills": {
    "displayName": "Merge Skills",
    "icon": "Layers",
    "expandResultByDefault": false
  },
  "deprecate_skill": {
    "displayName": "Deprecate Skill",
    "icon": "Archive",
    "expandResultByDefault": false
  },
  "install_skill": {
    "displayName": "Install Skill",
    "icon": "PackagePlus",
    "expandResultByDefault": false
  },
  "read_user_memory": {
    "displayName": "Read User Memory",
    "icon": "Brain",
    "expandResultByDefault": false
  },
  "update_user_memory": {
    "displayName": "Update User Memory",
    "icon": "BrainCircuit",
    "expandResultByDefault": false
  },
  "read_project_memory": {
    "displayName": "Read Project Memory",
    "icon": "FolderKanban",
    "expandResultByDefault": false
  },
  "update_project_memory": {
    "displayName": "Update Project Memory",
    "icon": "NotebookPen",
    "expandResultByDefault": false
  },
  "search_session_history": {
    "displayName": "Session History",
    "icon": "History",
    "expandResultByDefault": false
  },
  "dispatch_subagent": {
    "displayName": "Dispatch Subagent",
    "icon": "Bot",
    "expandResultByDefault": false
  },
  "subagent_batch_result": {
    "displayName": "Subagent Batch",
    "icon": "Bot",
    "expandResultByDefault": false
  },
  "await_subagent": {
    "displayName": "Subagent Task Summary",
    "icon": "Summary",
    "expandResultByDefault": false
  },
  "get_subagent_status": {
    "displayName": "Subagent Status",
    "icon": "Activity",
    "expandResultByDefault": false
  },
  "list_subagents": {
    "displayName": "List Subagents",
    "icon": "List",
    "expandResultByDefault": false
  },
  "stop_subagent": {
    "displayName": "Stop Subagent",
    "icon": "CircleStop",
    "expandResultByDefault": false
  },
  "loops": {
    "displayName": "Loops",
    "icon": "Repeat",
    "expandResultByDefault": false
  },
  "notify": {
    "displayName": "Notify",
    "icon": "Bell",
    "expandResultByDefault": false
  }
};
