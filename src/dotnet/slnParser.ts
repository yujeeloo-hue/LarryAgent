/**
 * Pure .sln parser — no fs, no DOM. Renderer imports this directly after
 * fetching the .sln text (reuse fs:readTextFile).
 *
 * Format reference (Format Version 12.00, VS2010+ / Rider / msbuild):
 *   Project("{TYPE-GUID}") = "Name", "Rel\Path.csproj", "{PROJ-GUID}"
 *   EndProject
 * Solution folders share the same shape with type GUID 2150E333-… and a
 * ProjectSection(SolutionItems) block listing virtual files:
 *   ProjectSection(SolutionItems) = preProject
 *       file = README.md
 *   EndProjectSection
 * Nesting lives in the Global NestedProjects section:
 *   {CHILD-GUID} = {PARENT-FOLDER-GUID}
 */

export type SlnProjectKind = "project" | "folder";

export type SlnProject = {
  name: string;
  /** Path exactly as written in the .sln (relative, backslash separators). */
  path: string;
  /** Project GUID, normalized to uppercase without braces. */
  guid: string;
  /** Project *type* GUID, normalized to uppercase without braces. */
  typeGuid: string;
  kind: SlnProjectKind;
  /** Virtual files listed in a solution folder's SolutionItems section. */
  solutionItems: string[];
};

export type SlnSolution = {
  /** Projects and solution folders in file order. */
  projects: SlnProject[];
  /** child guid -> parent solution-folder guid. */
  nesting: Map<string, string>;
};

export type SlnTreeNode = {
  name: string;
  kind: SlnProjectKind;
  guid: string;
  project?: SlnProject;
  /** Solution-folder virtual files (resolved lazily by the UI). */
  files: string[];
  children: SlnTreeNode[];
};

export type SlnConfigurationMapping = {
  projectGuid: string;
  solutionConfiguration: string;
  projectConfiguration: string;
  build: boolean;
};

/** Keep ActiveCfg and Build.0 separate: a mapped project need not build by default. */
export function parseSlnConfigurations(text: string): {
  configurations: string[];
  mappings: SlnConfigurationMapping[];
} {
  const configurations: string[] = [];
  const mappings = new Map<string, SlnConfigurationMapping>();
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const start = /^\s*GlobalSection\((\w+)\)/.exec(line);
    if (start) { section = start[1]!; continue; }
    if (/^\s*EndGlobalSection/.test(line)) { section = ""; continue; }
    if (section === "SolutionConfigurationPlatforms") {
      const pair = /^\s*(.+?)\s*=\s*(.+?)\s*$/.exec(line);
      if (pair) configurations.push(pair[1]!);
    }
    if (section !== "ProjectConfigurationPlatforms") continue;
    const match = /^\s*\{([^}]+)\}\.(.+)\.(ActiveCfg|Build\.0)\s*=\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const projectGuid = normalizeGuid(match[1]!);
    const solutionConfiguration = match[2]!;
    const key = `${projectGuid}|${solutionConfiguration}`;
    const mapping = mappings.get(key) ?? { projectGuid, solutionConfiguration, projectConfiguration: match[4]!, build: false };
    if (match[3] === "ActiveCfg") mapping.projectConfiguration = match[4]!;
    else mapping.build = true;
    mappings.set(key, mapping);
  }
  return { configurations, mappings: [...mappings.values()] };
}

/** Solution folder type GUID (shared by all VS versions). */
export const SLN_FOLDER_TYPE_GUID = "2150E333-8FDC-42A3-9474-1A3956D46DE8";

/** Normalize `{guid}` / `guid` to uppercase without braces. */
export function normalizeGuid(raw: string): string {
  return raw.trim().replace(/^\{|\}$/g, "").toUpperCase();
}

const PROJECT_LINE_RE =
  /^Project\("\{([0-9A-Fa-f-]{36})\}"\)\s*=\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"\{([0-9A-Fa-f-]{36})\}"/;

const SOLUTION_ITEMS_SECTION_RE = /^\s*ProjectSection\(SolutionItems\)\s*=/i;
const SECTION_END_RE = /^\s*End(ProjectSection|GlobalSection|Project)\b/i;
const FILE_ENTRY_RE = /^\s*file\s*=\s*(\S.*)$/i;
const NESTED_LINE_RE =
  /^\s*\{([0-9A-Fa-f-]{36})\}\s*=\s*\{([0-9A-Fa-f-]{36})\}/;

const GLOBAL_SECTION_RE = /^\s*GlobalSection\(([A-Za-z]+)\)/;

type ParseState = {
  projects: SlnProject[];
  nesting: Map<string, string>;
  /** Open Project(...) block; closed by EndProject. */
  currentProject: SlnProject | null;
  /** Inside a ProjectSection(SolutionItems) of currentProject. */
  inSolutionItems: boolean;
  /** Inside GlobalSection(NestedProjects). */
  inNestedProjects: boolean;
};

function pushProject(state: ParseState, project: SlnProject): void {
  state.projects.push(project);
}

export function parseSln(text: string): SlnSolution {
  const state: ParseState = {
    projects: [],
    nesting: new Map(),
    currentProject: null,
    inSolutionItems: false,
    inNestedProjects: false,
  };

  // VS writes UTF-8 BOM + CRLF; strip both up front.
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);

  for (const line of lines) {
    const projectMatch = PROJECT_LINE_RE.exec(line);
    if (projectMatch && !state.currentProject) {
      const typeGuid = projectMatch[1]!.toUpperCase();
      const guid = projectMatch[4]!.toUpperCase();
      pushProject(state, {
        name: projectMatch[2] ?? "",
        path: projectMatch[3] ?? "",
        guid,
        typeGuid,
        kind: typeGuid === SLN_FOLDER_TYPE_GUID ? "folder" : "project",
        solutionItems: [],
      });
      state.currentProject = state.projects[state.projects.length - 1] ?? null;
      continue;
    }

    if (state.inSolutionItems) {
      if (SECTION_END_RE.test(line)) {
        state.inSolutionItems = false;
        continue;
      }
      const fileMatch = FILE_ENTRY_RE.exec(line);
      if (fileMatch && state.currentProject) {
        state.currentProject.solutionItems.push(fileMatch[1]!.trim());
      }
      continue;
    }

    if (state.currentProject && SOLUTION_ITEMS_SECTION_RE.test(line)) {
      state.inSolutionItems = true;
      continue;
    }

    if (state.inNestedProjects) {
      if (SECTION_END_RE.test(line)) {
        state.inNestedProjects = false;
        continue;
      }
      const nested = NESTED_LINE_RE.exec(line);
      if (nested) {
        state.nesting.set(normalizeGuid(nested[1]!), normalizeGuid(nested[2]!));
      }
      continue;
    }

    const globalSection = GLOBAL_SECTION_RE.exec(line);
    if (globalSection && globalSection[1]!.toLowerCase() === "nestedprojects") {
      state.inNestedProjects = true;
      continue;
    }

    if (state.currentProject && SECTION_END_RE.test(line)) {
      state.currentProject = null;
    }
  }

  return { projects: state.projects, nesting: state.nesting };
}

/**
 * Nest projects under solution folders per NestedProjects. Roots preserve
 * .sln appearance order; orphans (missing folder / project→project nesting /
 * cycles) are ignored and stay at the root level.
 */
export function buildSlnTree(sln: SlnSolution): SlnTreeNode[] {
  const nodes = new Map<string, SlnTreeNode>();
  for (const project of sln.projects) {
    nodes.set(project.guid, {
      name: project.name,
      kind: project.kind,
      guid: project.guid,
      ...(project.kind === "folder" ? {} : { project }),
      files: project.solutionItems.slice(),
      children: [],
    });
  }

  const childGuids = new Set<string>();
  for (const [childGuid, parentGuid] of sln.nesting) {
    const child = nodes.get(childGuid);
    const parent = nodes.get(parentGuid);
    if (!child || !parent || parent.kind !== "folder") continue;
    if (childGuid === parentGuid) continue;
    // Cycle guard: walk up the would-be parent chain.
    let cursor: string | undefined = parentGuid;
    const seen = new Set<string>();
    while (cursor && nodes.has(cursor) && !seen.has(cursor)) {
      if (cursor === childGuid) break;
      seen.add(cursor);
      cursor = sln.nesting.get(cursor);
    }
    if (cursor === childGuid) continue;
    parent.children.push(child);
    childGuids.add(childGuid);
  }

  // Children display in .sln Project appearance order (VS semantics).
  const order = new Map(sln.projects.map((p, i) => [p.guid, i] as const));
  const sortChildren = (node: SlnTreeNode): void => {
    node.children.sort(
      (a, b) => (order.get(a.guid) ?? 0) - (order.get(b.guid) ?? 0),
    );
    for (const child of node.children) sortChildren(child);
  };

  const roots = sln.projects.flatMap((project) => {
    if (childGuids.has(project.guid)) return [];
    const node = nodes.get(project.guid);
    return node ? [node] : [];
  });
  roots.forEach(sortChildren);
  return roots;
}
