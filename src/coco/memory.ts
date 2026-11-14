/** COCO_MEMORY.md structure. Pure: no I/O. */

export const COCO_MEMORY_FILENAME = "COCO_MEMORY.md";
export const COCO_MEMORY_SOFT_CAP = 10_000;
/** Deterministic fallback trims to this fraction of the cap so the next write does not re-trigger at once. */
export const COCO_MEMORY_FALLBACK_RATIO = 0.8;

export const COCO_MEMORY_SECTIONS = ["projects", "focus", "open_items", "work_log"] as const;
export type CocoMemorySection = (typeof COCO_MEMORY_SECTIONS)[number];
export const COCO_MEMORY_HEADINGS: Record<CocoMemorySection, string> = {
  projects: "Projects",
  focus: "Focus",
  open_items: "Open items",
  work_log: "Work log",
};

const TITLE = "# CoCo memory";

/** Each entry is one bullet plus any continuation lines, without the trailing newline. */
export type CocoMemoryDoc = Record<CocoMemorySection, string[]>;

export type CocoMemoryArchiveEntry = { section: CocoMemorySection; text: string };

export function isCocoMemorySection(value: unknown): value is CocoMemorySection {
  return typeof value === "string" && (COCO_MEMORY_SECTIONS as readonly string[]).includes(value);
}

const headingToSection = (line: string): CocoMemorySection | undefined => {
  const match = /^##\s+(.+?)\s*$/.exec(line);
  if (!match) return undefined;
  const title = match[1]!.toLowerCase();
  return COCO_MEMORY_SECTIONS.find(id => COCO_MEMORY_HEADINGS[id].toLowerCase() === title);
};

/** Split text into bullet entries; non-bullet lines continue the previous entry. */
export function toEntries(text: string): string[] {
  const entries: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/u, "");
    if (!line.trim()) continue;
    if (/^\s*[-*]\s+/.test(line) || entries.length === 0) entries.push(line.trim().replace(/^[*]\s+/, "- ").replace(/^(?!- )/, "- "));
    else entries[entries.length - 1] += `\n${line}`;
  }
  return entries;
}

export function emptyCocoMemory(): CocoMemoryDoc {
  return { projects: [], focus: [], open_items: [], work_log: [] };
}

/** Lines outside the four known sections land in Focus so nothing a user wrote is silently lost. */
export function parseCocoMemory(body: string): CocoMemoryDoc {
  const doc = emptyCocoMemory();
  let current: CocoMemorySection | undefined;
  const buffers: Record<CocoMemorySection, string[]> = { projects: [], focus: [], open_items: [], work_log: [] };
  const stray: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const section = headingToSection(line);
    if (section) { current = section; continue; }
    if (/^#\s/.test(line) || /^##\s/.test(line)) { current = undefined; continue; }
    (current ? buffers[current] : stray).push(line);
  }
  for (const id of COCO_MEMORY_SECTIONS) doc[id] = toEntries(buffers[id].join("\n"));
  doc.focus.push(...toEntries(stray.join("\n")));
  return doc;
}

export function formatCocoMemory(doc: CocoMemoryDoc): string {
  const parts = [TITLE];
  for (const id of COCO_MEMORY_SECTIONS) {
    parts.push("", `## ${COCO_MEMORY_HEADINGS[id]}`);
    if (doc[id].length) parts.push("", ...doc[id]);
  }
  return `${parts.join("\n")}\n`;
}

const hasLeadingDate = (entry: string): boolean => /^- \d{4}-\d{2}-\d{2}/.test(entry);
/** `- [status] id: text` → `id`. */
const openItemId = (entry: string): string | undefined => /^- \[[^\]]+\]\s*([^\s:]+):/.exec(entry)?.[1];

/**
 * Merge appends entries to the section; replace swaps the section body.
 * Merging an Open item whose id already exists replaces that item in place.
 * Work log entries without a leading date get `stamp` (`YYYY-MM-DD HH:mm`).
 * Returns the entries that left the file so callers can archive them.
 */
export function applyCocoMemoryUpdate(body: string, input: { section: CocoMemorySection; content: string; mode: "merge" | "replace"; stamp: string }): { body: string; removed: CocoMemoryArchiveEntry[] } {
  const doc = parseCocoMemory(body);
  let entries = toEntries(input.content);
  if (input.section === "work_log") entries = entries.map(e => hasLeadingDate(e) ? e : e.replace(/^- /, `- ${input.stamp} · `));
  if (input.mode === "replace") {
    const removed = doc[input.section].filter(e => !entries.includes(e)).map(text => ({ section: input.section, text }));
    doc[input.section] = entries;
    return { body: formatCocoMemory(doc), removed };
  }
  const removed: CocoMemoryArchiveEntry[] = [];
  let current = doc[input.section];
  for (const entry of entries) {
    if (current.includes(entry)) continue;
    const id = input.section === "open_items" ? openItemId(entry) : undefined;
    const index = id ? current.findIndex(e => openItemId(e) === id) : -1;
    if (index === -1) { current = [...current, entry]; continue; }
    removed.push(...current.filter(e => openItemId(e) === id).map(text => ({ section: input.section, text })));
    current = [...current.slice(0, index).filter(e => openItemId(e) !== id), entry, ...current.slice(index + 1).filter(e => openItemId(e) !== id)];
  }
  doc[input.section] = current;
  return { body: formatCocoMemory(doc), removed };
}

const projectMarker = (path: string): string => ` — ${path}`;
const isProjectEntry = (entry: string, path: string): boolean => entry.includes(`${projectMarker(path)} —`) || entry.endsWith(projectMarker(path));

/** One Projects line per project path (`- Name — /abs/path — summary`); returns the superseded line(s). */
export function upsertProjectEntry(body: string, project: { name: string; path: string; line: string }): { body: string; removed: CocoMemoryArchiveEntry[] } {
  const doc = parseCocoMemory(body);
  const entry = `- ${project.name.trim()}${projectMarker(project.path)} — ${project.line.replace(/\s+/g, " ").trim()}`;
  const removed = doc.projects.filter(e => isProjectEntry(e, project.path) && e !== entry).map(text => ({ section: "projects" as const, text }));
  const index = doc.projects.findIndex(e => isProjectEntry(e, project.path));
  const rest = doc.projects.filter(e => !isProjectEntry(e, project.path));
  doc.projects = index === -1 ? [...rest, entry] : [...rest.slice(0, index), entry, ...rest.slice(index)];
  return { body: formatCocoMemory(doc), removed };
}

export function removeProjectEntry(body: string, path: string): { body: string; removed: CocoMemoryArchiveEntry[] } {
  const doc = parseCocoMemory(body);
  const removed = doc.projects.filter(e => isProjectEntry(e, path)).map(text => ({ section: "projects" as const, text }));
  doc.projects = doc.projects.filter(e => !isProjectEntry(e, path));
  return { body: formatCocoMemory(doc), removed };
}

/** Entries present in `before` but absent from `after` (compared per section, whitespace-insensitive). */
export function droppedEntries(before: string, after: string): CocoMemoryArchiveEntry[] {
  const a = parseCocoMemory(before), b = parseCocoMemory(after);
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
  const kept = new Set(COCO_MEMORY_SECTIONS.flatMap(id => b[id].map(norm)));
  return COCO_MEMORY_SECTIONS.flatMap(id => a[id].filter(e => !kept.has(norm(e))).map(text => ({ section: id, text })));
}

const isClosedItem = (entry: string): boolean => /^- \[(done|closed|cancelled)\]/i.test(entry);

/**
 * Deterministic fallback: drop oldest Work log entries, then closed Open items,
 * then oldest Focus entries, until the body fits `budget`. Projects and live
 * Open items are never dropped here.
 */
export function trimCocoMemory(body: string, budget: number): { body: string; removed: CocoMemoryArchiveEntry[] } {
  const doc = parseCocoMemory(body);
  const removed: CocoMemoryArchiveEntry[] = [];
  const over = (): boolean => formatCocoMemory(doc).length > budget;
  while (over() && doc.work_log.length) removed.push({ section: "work_log", text: doc.work_log.shift()! });
  for (let i = 0; over() && i < doc.open_items.length;) {
    if (isClosedItem(doc.open_items[i]!)) removed.push({ section: "open_items", text: doc.open_items.splice(i, 1)[0]! });
    else i++;
  }
  while (over() && doc.focus.length) removed.push({ section: "focus", text: doc.focus.shift()! });
  return { body: formatCocoMemory(doc), removed };
}

/** A consolidated body is usable only if it keeps the four sections, fits the cap and keeps every live Open item. */
export function acceptConsolidated(before: string, candidate: string, cap: number): boolean {
  if (!candidate.trim() || candidate.length > cap) return false;
  const headings = COCO_MEMORY_SECTIONS.every(id => new RegExp(`^##\\s+${COCO_MEMORY_HEADINGS[id]}\\s*$`, "mi").test(candidate));
  if (!headings) return false;
  const live = parseCocoMemory(before).open_items.filter(e => !isClosedItem(e));
  const after = new Set(parseCocoMemory(candidate).open_items.map(e => e.replace(/\s+/g, " ").trim()));
  return live.every(e => after.has(e.replace(/\s+/g, " ").trim()));
}
