/**
 * New-workspace template registry (pure — no Electron imports).
 *
 * A template manifest drives the whole flow: the renderer menu/file-tree
 * preview comes from `listWorkspaceTemplateInfos()`, and the files actually
 * written on disk come from `buildTemplateFiles()`. Mac App / iOS App will
 * join this registry later — the renderer renders whatever is listed, so new
 * entries need no UI changes.
 *
 * Rules (user-confirmed):
 * - Web + Node = ETHub-style: single package, `server.js` serves `public/`,
 *   no frontend build step; tasks.json carries `run` only.
 * - Electron = electron-vite shell (main/preload/renderer) with build+run.
 * - Unreal = docs + task config only (.uproject / Source stay yours; the UBT
 *   build task is auto-injected by devTaskResolve when it sees a .uproject).
 * - git init / npm install run only for non-Unreal templates and only when
 *   `.git` / `node_modules` are absent (detection lives in workspaceInit).
 */
import type { ProjectDocId, ProjectMemorySectionId } from "../projectMemory/types.js";
import {
  PROJECT_DOC_FILENAMES,
  PROJECT_DOC_RULES,
  PROJECT_DOC_TITLES,
  PROJECT_MEMORY_SECTION_HEADINGS,
} from "../projectMemory/types.js";
import { canonicalDocsGuideSection, synthesizeRecentSection } from "../projectMemory/sections.js";

export type WorkspaceTemplateId = "web-node" | "electron" | "unreal" | "blank";

/** Icon ids understood by the renderer icon module (`newWorkspaceIcons.ts`). */
export type WorkspaceTemplateIconId = "globe" | "atom" | "unreal" | "file";

/** One line of the file-tree preview shown in the create dialog. */
export type TemplateTreeLine = {
  /** Leading spaces (already resolved — renderer renders verbatim). */
  text: string;
  kind: "dir" | "cfg" | "plain" | "note";
};

export type WorkspaceTemplateInfo = {
  id: WorkspaceTemplateId;
  name: string;
  /** One-line description under the menu item label. */
  desc: string;
  iconId: WorkspaceTemplateIconId;
  /** Stack chips in the create dialog. */
  stack: string[];
  /** Whether git init / npm install apply (non-Unreal). */
  hasDeps: boolean;
  /** File-tree preview lines (dirs from the template root). */
  tree: TemplateTreeLine[];
};

export type TemplateFile = {
  /** Path relative to the workspace root, POSIX separators. */
  path: string;
  content: string;
};

const COMMON_STACK_NODE = ["Node", "Express", "static web", "no build step"];

const TEMPLATES: Record<Exclude<WorkspaceTemplateId, "blank">, WorkspaceTemplateInfo> = {
  "web-node": {
    id: "web-node",
    name: "Web + Node Server",
    desc: "Express server + static web client · ETHub-style",
    iconId: "globe",
    stack: COMMON_STACK_NODE,
    hasDeps: true,
    tree: [
      { text: "package.json", kind: "cfg" },
      { text: "server.js — Express :8787, serves public/", kind: "cfg" },
      { text: ".larry/tasks.json — run (no build step)", kind: "cfg" },
      { text: "PROJECT.md · README.md · .gitignore", kind: "plain" },
      { text: "docs/plans/", kind: "dir" },
      { text: "public/", kind: "dir" },
      { text: "  index.html · app.js · style.css", kind: "plain" },
      { text: "src/", kind: "dir" },
      { text: "  routes.js — /api/health example", kind: "plain" },
    ],
  },
  electron: {
    id: "electron",
    name: "Electron",
    desc: "electron-vite · main / preload / renderer",
    iconId: "atom",
    stack: ["Electron", "electron-vite", "TypeScript"],
    hasDeps: true,
    tree: [
      { text: "package.json", kind: "cfg" },
      { text: "electron.vite.config.ts", kind: "cfg" },
      { text: "tsconfig.json", kind: "cfg" },
      { text: ".larry/tasks.json — build · run", kind: "cfg" },
      { text: "PROJECT.md · README.md · .gitignore", kind: "plain" },
      { text: "docs/plans/", kind: "dir" },
      { text: "src/main/index.ts — BrowserWindow shell", kind: "plain" },
      { text: "src/preload/index.ts", kind: "plain" },
      { text: "src/renderer/", kind: "dir" },
      { text: "  index.html · src/main.ts · style.css", kind: "plain" },
    ],
  },
  unreal: {
    id: "unreal",
    name: "Unreal",
    desc: "Docs + task config only — for an existing UE project",
    iconId: "unreal",
    stack: ["UE 5.x", "docs + config only"],
    hasDeps: false,
    tree: [
      { text: ".larry/tasks.json — UBT build auto-injected · run", kind: "cfg" },
      { text: "PROJECT.md · README.md · .gitignore", kind: "plain" },
      { text: "docs/plans/", kind: "dir" },
      { text: ".uproject / Source stay yours — nothing generated", kind: "note" },
    ],
  },
};

const BLANK_INFO: WorkspaceTemplateInfo = {
  id: "blank",
  name: "Blank Project",
  desc: "Register an existing folder — no files written",
  iconId: "file",
  stack: [],
  hasDeps: false,
  tree: [],
};

/** Menu order; `blank` renders below a separator. */
export function listWorkspaceTemplateInfos(): WorkspaceTemplateInfo[] {
  return [TEMPLATES["web-node"], TEMPLATES.electron, TEMPLATES.unreal, BLANK_INFO];
}

export function getWorkspaceTemplateInfo(
  id: WorkspaceTemplateId,
): WorkspaceTemplateInfo {
  if (id === "blank") return BLANK_INFO;
  return TEMPLATES[id];
}

export function isWorkspaceTemplateId(v: unknown): v is WorkspaceTemplateId {
  return (
    v === "web-node" || v === "electron" || v === "unreal" || v === "blank"
  );
}

/** npm package name from a display name ("My Cool App" → "my-cool-app"). */
export function workspaceSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "my-app";
}

function render(body: string, vars: { name: string; slug: string }): string {
  return body.replaceAll("{{name}}", vars.name).replaceAll("{{slug}}", vars.slug);
}

function file(path: string, content: string, vars: { name: string; slug: string }): TemplateFile {
  return { path, content: render(content, vars) };
}

/* ------------------------------------------- common file contents */

const MEMORY_DOCS_GITIGNORE = `# Agent project memory view (derived; local)
PROJECT.md

# Local demo scratch (docs/demo/<topic>/)
docs/demo/
`;

const NODE_GITIGNORE = `node_modules/
out/
dist/
.env
.DS_Store
npm-debug.log*

${MEMORY_DOCS_GITIGNORE}`;

const UE_GITIGNORE = `# Unreal Engine
Binaries/*
Intermediate/*
Saved/*
DerivedDataCache/*
Build/*
!Build/*/
!.gitignore

# IDE
.vs/
.vscode/
.idea/
*.sln
*.suo
*.opensdf
*.sdf
*.VC.db

# OS
.DS_Store

${MEMORY_DOCS_GITIGNORE}`;

function projectMd(name: string, overview: string): string {
  const heading = (id: ProjectMemorySectionId) =>
    `## ${PROJECT_MEMORY_SECTION_HEADINGS[id]}`;
  const worklogBody = "- Workspace initialized from the template.";
  return [
    `# ${name}`,
    "",
    heading("basics"),
    "",
    overview,
    "",
    heading("structure"),
    "",
    "_To be filled as the project grows._",
    "",
    heading("conventions"),
    "",
    "_To be filled as the project grows._",
    "",
    heading("docs_guide"),
    "",
    canonicalDocsGuideSection(),
    "",
    heading("recent"),
    "",
    synthesizeRecentSection({
      worklogBody,
      handoffBody: "",
      pitfallsBody: "",
    }),
    "",
  ].join("\n");
}

/** A docs/ memory file: canonical title + rule header, optional first body. */
function docsMemoryFile(
  doc: ProjectDocId,
  firstBody?: string,
): string {
  const header = `# ${PROJECT_DOC_TITLES[doc]}\n\n> ${PROJECT_DOC_RULES[doc]}\n`;
  return firstBody ? `${header}\n${firstBody}\n` : `${header}\n`;
}

/** The five docs/ memory files every scaffolded workspace starts with. */
function docsMemoryFiles(templateName: string): { path: string; content: string }[] {
  return (Object.keys(PROJECT_DOC_FILENAMES) as ProjectDocId[]).map((doc) => ({
    path: `docs/${PROJECT_DOC_FILENAMES[doc]}`,
    content:
      doc === "worklog"
        ? docsMemoryFile(doc, `- Workspace initialized from the ${templateName} template.`)
        : docsMemoryFile(doc),
  }));
}

function docsPlansReadme(name: string): string {
  return `# Plans — ${name}\n\nPlan documents (designs, handoffs) live in this folder.\n`;
}

function tasksJson(tasks: Record<string, string>): string {
  const entries = Object.entries(tasks)
    .map(([id, command]) => `    "${id}": { "command": ${JSON.stringify(command)} }`)
    .join(",\n");
  return `{\n  "version": 1,\n  "tasks": ${entries ? `{\n${entries}\n  }` : `{}`}\n}\n`;
}

/* ------------------------------------------- web-node (ETHub-style) */

const WEB_SERVER = `import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { healthRouter } from "./src/routes.js";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use("/api", healthRouter);
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT ?? 8787);
app.listen(PORT, () => {
  console.log(\`{{name}} listening on http://127.0.0.1:\${PORT}\`);
});
`;

const WEB_ROUTES = `import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});
`;

const WEB_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{name}}</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main>
    <h1>{{name}}</h1>
    <p id="status">checking server…</p>
  </main>
  <script type="module" src="/app.js"></script>
</body>
</html>
`;

const WEB_APP_JS = `const status = document.getElementById("status");
try {
  const res = await fetch("/api/health");
  const data = await res.json();
  status.textContent = data.ok ? "server up" : "server error";
} catch {
  status.textContent = "server unreachable";
}
`;

const WEB_STYLE_CSS = `:root { color-scheme: light dark; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: system-ui, sans-serif;
}
`;

const WEB_PACKAGE_JSON = `{
  "name": "{{slug}}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "express": "^4.21.2"
  }
}
`;

/* ------------------------------------------- electron (electron-vite) */

const ELECTRON_PACKAGE_JSON = `{
  "name": "{{slug}}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview"
  },
  "devDependencies": {
    "electron": "^33.2.0",
    "electron-vite": "^2.3.0",
    "typescript": "^5.6.3",
    "vite": "^5.4.11"
  }
}
`;

const ELECTRON_VITE_CONFIG = `import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {},
  preload: {},
  renderer: {},
});
`;

const ELECTRON_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["electron-vite/node"]
  },
  "include": ["src"]
}
`;

const ELECTRON_MAIN = `import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    title: "{{name}}",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
`;

const ELECTRON_PRELOAD = `import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("app", {
  version: process.env.npm_package_version ?? null,
});
`;

const ELECTRON_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{name}}</title>
  <link rel="stylesheet" href="/src/style.css">
</head>
<body>
  <main>
    <h1>{{name}}</h1>
    <p id="status">renderer ready</p>
  </main>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
`;

const ELECTRON_RENDERER_MAIN = `const status = document.getElementById("status");
const version = (window as { app?: { version: string | null } }).app?.version;
if (status && version) status.textContent = \`v\${version}\`;
`;

const ELECTRON_STYLE = `body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: system-ui, sans-serif;
}
`;

/* ------------------------------------------- README blurbs */

function readme(name: string, template: WorkspaceTemplateInfo, quickstart: string[]): string {
  return [
    `# ${name}`,
    "",
    `Created from the **${template.name}** template (${template.stack.join(" · ")}).`,
    "",
    "## Quickstart",
    "",
    ...quickstart.map((l) => l || ""),
    "",
    "Dev tasks (`.larry/tasks.json`) drive the Dev Mode Build/Run buttons.",
    "",
  ].join("\n");
}

/* ------------------------------------------- public API */

/**
 * Files each template writes. `blank` writes nothing; contents are rendered
 * with the workspace display name + slug. Paths are relative, POSIX-style.
 */
export function buildTemplateFiles(
  id: WorkspaceTemplateId,
  name: string,
): TemplateFile[] {
  const vars = { name: name.trim() || "MyApp", slug: workspaceSlug(name) };
  const n = vars.name;
  const info = getWorkspaceTemplateInfo(id);

  if (id === "blank") return [];

  const common: TemplateFile[] = [
    file("PROJECT.md", projectMd(n, `${n} — created from the ${info.name} template.`), vars),
    ...docsMemoryFiles(info.name).map((f) => file(f.path, f.content, vars)),
    file("docs/plans/README.md", docsPlansReadme(n), vars),
  ];

  if (id === "web-node") {
    return [
      ...common,
      file("package.json", WEB_PACKAGE_JSON, vars),
      file("server.js", WEB_SERVER, vars),
      file("src/routes.js", WEB_ROUTES, vars),
      file("public/index.html", WEB_INDEX_HTML, vars),
      file("public/app.js", WEB_APP_JS, vars),
      file("public/style.css", WEB_STYLE_CSS, vars),
      file(".larry/tasks.json", tasksJson({ run: "node server.js" }), vars),
      file("README.md", readme(n, info, ["```bash", "npm install", "npm run dev", "```"]), vars),
      file(".gitignore", NODE_GITIGNORE, vars),
    ];
  }

  if (id === "electron") {
    return [
      ...common,
      file("package.json", ELECTRON_PACKAGE_JSON, vars),
      file("electron.vite.config.ts", ELECTRON_VITE_CONFIG, vars),
      file("tsconfig.json", ELECTRON_TSCONFIG, vars),
      file("src/main/index.ts", ELECTRON_MAIN, vars),
      file("src/preload/index.ts", ELECTRON_PRELOAD, vars),
      file("src/renderer/index.html", ELECTRON_INDEX_HTML, vars),
      file("src/renderer/src/main.ts", ELECTRON_RENDERER_MAIN, vars),
      file("src/renderer/src/style.css", ELECTRON_STYLE, vars),
      file(".larry/tasks.json", tasksJson({ build: "npm run build", run: "npm run dev" }), vars),
      file("README.md", readme(n, info, ["```bash", "npm install", "npm run dev", "```"]), vars),
      file(".gitignore", NODE_GITIGNORE, vars),
    ];
  }

  // unreal — docs + config only
  return [
    ...common,
    file(
      ".larry/tasks.json",
      tasksJson({}),
      vars,
    ),
    file(
      "README.md",
      readme(n, info, [
        "Drop (or create) your `.uproject` in this folder — the UBT build",
        "task is picked up automatically; configure `run` in `.larry/tasks.json`",
        "when you want an editor launcher.",
      ]),
      vars,
    ),
    file(".gitignore", UE_GITIGNORE, vars),
  ];
}
