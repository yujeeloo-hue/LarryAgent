import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  KNOWLEDGE_BODY_MAX_CHARS,
  KNOWLEDGE_CATEGORY_DESCRIPTION_MAX_CHARS,
  KNOWLEDGE_CATEGORY_FILE,
  KNOWLEDGE_FRESHNESS_INTERVAL_MS,
  KNOWLEDGE_KEYWORD_MAX_CHARS,
  KNOWLEDGE_KEYWORDS_MAX,
  KNOWLEDGE_KEYWORDS_MIN,
  KNOWLEDGE_PATCH_EDITS_MAX,
  KNOWLEDGE_SUMMARY_MAX_CHARS,
  KNOWLEDGE_TITLE_MAX_CHARS,
  isValidKnowledgeCategory,
  isValidKnowledgeSlug,
  slugFromTitle,
  splitKnowledgeId,
} from "./limits.js";
import {
  parseFrontmatter,
  readKnowledgeFrontmatter,
  serializeKnowledgeDoc,
  type KnowledgeFrontmatter,
} from "./parseDoc.js";
import { KnowledgeSearchIndex } from "./searchIndex.js";
import type {
  KnowledgeCategory,
  KnowledgeDeleteResult,
  KnowledgeDoc,
  KnowledgeLayer,
  KnowledgeListSnapshot,
  KnowledgeMutationResult,
  KnowledgePatchInput,
  KnowledgeSearchResult,
  KnowledgeWriteInput,
} from "./types.js";

export type KnowledgeBaseConfig = {
  builtinDir: string;
  userDir: string;
};

type LayerCategory = { id: string; title: string; description: string };

type LayerDoc = {
  id: string;
  category: string;
  slug: string;
  front: KnowledgeFrontmatter;
  body: string;
  filePath: string;
};

type LoadedLayer = {
  categories: Map<string, LayerCategory>;
  docs: Map<string, LayerDoc>;
};

type State = {
  signature: string;
  docs: Map<string, KnowledgeDoc>;
  categories: Map<string, KnowledgeCategory>;
  guides: Map<string, KnowledgeDoc>;
  index: KnowledgeSearchIndex;
};

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

function warn(message: string): void {
  console.warn(`[knowledge] ${message}`);
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function listMarkdown(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function statKey(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "-";
  }
}

function layerSignature(root: string): string {
  if (!existsSync(root)) return `${root}=absent`;
  const parts = [`${root}=${statKey(root)}`];
  for (const category of listDirs(root)) {
    const dir = join(root, category);
    parts.push(`${category}=${statKey(dir)}`);
    for (const file of listMarkdown(dir)) parts.push(`${category}/${file}=${statKey(join(dir, file))}`);
  }
  return parts.join("|");
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    warn(`failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function loadLayer(root: string, layer: KnowledgeLayer): LoadedLayer {
  const categories = new Map<string, LayerCategory>();
  const docs = new Map<string, LayerDoc>();
  for (const category of listDirs(root)) {
    if (!isValidKnowledgeCategory(category)) {
      warn(`skipped ${layer} category with invalid name: ${category}`);
      continue;
    }
    const dir = join(root, category);
    for (const file of listMarkdown(dir)) {
      const filePath = join(dir, file);
      const raw = readText(filePath);
      if (raw === null) continue;
      const parsed = parseFrontmatter(raw);
      if (file === KNOWLEDGE_CATEGORY_FILE) {
        const title = typeof parsed.fields.title === "string" ? parsed.fields.title.trim() : "";
        const description =
          typeof parsed.fields.description === "string" ? parsed.fields.description.trim() : parsed.body.trim();
        categories.set(category, { id: category, title: title || category, description });
        continue;
      }
      const slug = file.slice(0, -3);
      if (!isValidKnowledgeSlug(slug)) {
        warn(`skipped ${layer} doc with invalid file name: ${category}/${file}`);
        continue;
      }
      const front = readKnowledgeFrontmatter(parsed.fields);
      if (!parsed.hasFrontmatter || !front.title || !front.summary || front.keywords.length === 0) {
        warn(`skipped ${layer} doc ${category}/${slug}: frontmatter needs title, summary and keywords`);
        continue;
      }
      if (front.category && front.category !== category) {
        warn(`${layer} doc ${category}/${slug} declares category ${front.category}; using folder name`);
      }
      docs.set(`${category}/${slug}`, {
        id: `${category}/${slug}`,
        category,
        slug,
        front: { ...front, category },
        body: parsed.body,
        filePath,
      });
    }
  }
  return { categories, docs };
}

function toDoc(entry: LayerDoc, source: KnowledgeDoc["source"], builtin?: LayerDoc): KnowledgeDoc {
  const version = entry.front.version ?? 1;
  const doc: KnowledgeDoc = {
    id: entry.id,
    category: entry.category,
    slug: entry.slug,
    title: entry.front.title,
    summary: entry.front.summary,
    keywords: entry.front.keywords,
    relatedTools: entry.front.relatedTools,
    guideFor: entry.front.guideFor.filter((name) => TOOL_NAME_RE.test(name)),
    version,
    updatedAt: entry.front.updatedAt ?? "",
    body: entry.body,
    source,
    stale: false,
    filePath: entry.filePath,
  };
  if (source === "override" && builtin) {
    const baseVersion = entry.front.baseVersion ?? 0;
    const builtinVersion = builtin.front.version ?? 1;
    doc.baseVersion = baseVersion;
    doc.builtinVersion = builtinVersion;
    doc.stale = builtinVersion > baseVersion;
  }
  return doc;
}

function emptyState(): State {
  return {
    signature: "",
    docs: new Map(),
    categories: new Map(),
    guides: new Map(),
    index: new KnowledgeSearchIndex([]),
  };
}

function buildState(config: KnowledgeBaseConfig, signature: string): State {
  const builtin = loadLayer(config.builtinDir, "builtin");
  const user = loadLayer(config.userDir, "user");
  const docs = new Map<string, KnowledgeDoc>();
  for (const entry of builtin.docs.values()) {
    if (entry.front.version === undefined) warn(`builtin doc ${entry.id} has no version; assuming 1`);
    docs.set(entry.id, toDoc(entry, "builtin"));
  }
  for (const entry of user.docs.values()) {
    const base = builtin.docs.get(entry.id);
    docs.set(entry.id, toDoc(entry, base ? "override" : "user", base));
  }

  const categories = new Map<string, KnowledgeCategory>();
  const addCategory = (category: LayerCategory, layer: KnowledgeLayer) => {
    if (categories.has(category.id)) return;
    categories.set(category.id, { ...category, layer, docCount: 0 });
  };
  for (const category of builtin.categories.values()) addCategory(category, "builtin");
  for (const category of user.categories.values()) addCategory(category, "user");
  for (const doc of docs.values()) {
    if (!categories.has(doc.category)) {
      categories.set(doc.category, {
        id: doc.category,
        title: doc.category,
        description: "",
        layer: doc.source === "builtin" ? "builtin" : "user",
        docCount: 0,
      });
    }
    categories.get(doc.category)!.docCount += 1;
  }

  const sorted = [...docs.values()].sort((a, b) => a.id.localeCompare(b.id));
  const guides = new Map<string, KnowledgeDoc>();
  const ranked = [
    ...sorted.filter((doc) => doc.source !== "builtin"),
    ...sorted.filter((doc) => doc.source === "builtin"),
  ];
  for (const doc of ranked) {
    for (const tool of doc.guideFor) {
      const existing = guides.get(tool);
      if (existing) {
        if (existing.id !== doc.id) warn(`tool ${tool} has several guides; using ${existing.id}, ignoring ${doc.id}`);
        continue;
      }
      guides.set(tool, doc);
    }
  }

  return { signature, docs: new Map(sorted.map((doc) => [doc.id, doc])), categories, guides, index: new KnowledgeSearchIndex(sorted) };
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function cleanKeywords(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    const keyword = value.replace(/\s+/g, " ").trim();
    if (!keyword || seen.has(keyword.toLowerCase())) continue;
    seen.add(keyword.toLowerCase());
    out.push(keyword);
  }
  return out;
}

function validateKeywords(keywords: readonly string[]): string | null {
  if (keywords.length < KNOWLEDGE_KEYWORDS_MIN || keywords.length > KNOWLEDGE_KEYWORDS_MAX) {
    return `keywords must list ${KNOWLEDGE_KEYWORDS_MIN}–${KNOWLEDGE_KEYWORDS_MAX} distinct terms (got ${keywords.length}).`;
  }
  const long = keywords.find((k) => k.length > KNOWLEDGE_KEYWORD_MAX_CHARS);
  return long ? `keyword ${JSON.stringify(long)} is longer than ${KNOWLEDGE_KEYWORD_MAX_CHARS} characters.` : null;
}

function validateSummary(summary: string): string | null {
  if (!summary) return "summary is required.";
  return summary.length > KNOWLEDGE_SUMMARY_MAX_CHARS
    ? `summary is ${summary.length} characters; keep it within ${KNOWLEDGE_SUMMARY_MAX_CHARS}.`
    : null;
}

function validateBody(body: string): string | null {
  if (!body.trim()) return "content is required.";
  return body.length > KNOWLEDGE_BODY_MAX_CHARS
    ? `content is ${body.length} characters; the limit is ${KNOWLEDGE_BODY_MAX_CHARS}. Split it into several docs.`
    : null;
}

function validateTools(names: readonly string[]): string | null {
  for (const name of names) {
    if (name.startsWith("mcp__")) return `MCP tools cannot have knowledge guides (${name}).`;
    if (!TOOL_NAME_RE.test(name)) return `invalid tool name ${JSON.stringify(name)}.`;
  }
  return null;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

export class KnowledgeStore {
  private config: KnowledgeBaseConfig | null = null;
  private state: State = emptyState();
  private checkedAt = 0;

  configure(config: KnowledgeBaseConfig | null): void {
    this.config = config;
    this.state = emptyState();
    this.checkedAt = 0;
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  invalidate(): void {
    this.checkedAt = 0;
    this.state = { ...this.state, signature: "" };
  }

  private fresh(): State {
    const config = this.config;
    if (!config) return this.state;
    const now = Date.now();
    if (this.state.signature && now - this.checkedAt < KNOWLEDGE_FRESHNESS_INTERVAL_MS) return this.state;
    this.checkedAt = now;
    const signature = `${layerSignature(config.builtinDir)}#${layerSignature(config.userDir)}`;
    if (signature !== this.state.signature) this.state = buildState(config, signature);
    return this.state;
  }

  listDocs(): KnowledgeDoc[] {
    return [...this.fresh().docs.values()];
  }

  listCategories(): KnowledgeCategory[] {
    return [...this.fresh().categories.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  getDoc(id: string): KnowledgeDoc | null {
    const parsed = splitKnowledgeId(id);
    if (!parsed) return null;
    return this.fresh().docs.get(`${parsed.category}/${parsed.slug}`) ?? null;
  }

  getBuiltinDoc(id: string): KnowledgeDoc | null {
    const config = this.config;
    const parsed = splitKnowledgeId(id);
    if (!config || !parsed) return null;
    const entry = loadLayer(config.builtinDir, "builtin").docs.get(`${parsed.category}/${parsed.slug}`);
    return entry ? toDoc(entry, "builtin") : null;
  }

  guideFor(toolName: string): KnowledgeDoc | null {
    return this.fresh().guides.get(toolName) ?? null;
  }

  guideMap(): ReadonlyMap<string, KnowledgeDoc> {
    return this.fresh().guides;
  }

  search(input: { query?: string; category?: string; limit: number }): KnowledgeSearchResult {
    return this.fresh().index.search({
      query: input.query ?? "",
      ...(input.category ? { category: input.category } : {}),
      limit: input.limit,
    });
  }

  snapshot(): KnowledgeListSnapshot {
    const state = this.fresh();
    return {
      categories: this.listCategories().map((category) => ({
        id: category.id,
        title: category.title,
        description: category.description,
        docs: [...state.docs.values()]
          .filter((doc) => doc.category === category.id)
          .map((doc) => ({
            id: doc.id,
            category: doc.category,
            title: doc.title,
            summary: doc.summary,
            keywords: doc.keywords,
            source: doc.source,
            stale: doc.stale,
            version: doc.version,
            updatedAt: doc.updatedAt,
          })),
      })),
    };
  }

  write(input: KnowledgeWriteInput): KnowledgeMutationResult {
    const config = this.config;
    if (!config) return { ok: false, code: "invalid", message: "The knowledge base is not available in this host." };
    const category = input.category.trim();
    let slug = input.slug?.trim() ?? "";
    if (input.id?.trim()) {
      const parsed = splitKnowledgeId(input.id);
      if (!parsed) return { ok: false, code: "invalid", message: `Invalid id ${JSON.stringify(input.id)}; use "category/slug".` };
      if (category && category !== parsed.category) {
        return { ok: false, code: "invalid", message: `id ${input.id} is in category ${parsed.category}, not ${category}.` };
      }
      slug = parsed.slug;
    }
    const categoryId = input.id?.trim() ? splitKnowledgeId(input.id)!.category : category;
    if (!isValidKnowledgeCategory(categoryId)) {
      return { ok: false, code: "invalid", message: `Invalid category ${JSON.stringify(categoryId)}; use lowercase kebab-case.` };
    }
    const title = input.title.replace(/\s+/g, " ").trim();
    if (!title) return { ok: false, code: "invalid", message: "title is required." };
    if (title.length > KNOWLEDGE_TITLE_MAX_CHARS) {
      return { ok: false, code: "invalid", message: `title is longer than ${KNOWLEDGE_TITLE_MAX_CHARS} characters.` };
    }
    if (!slug) slug = slugFromTitle(title);
    if (!isValidKnowledgeSlug(slug)) {
      return { ok: false, code: "invalid", message: `Invalid slug ${JSON.stringify(slug)}; use lowercase letters, digits, "-" or "_".` };
    }
    const summary = input.summary.replace(/\s+/g, " ").trim();
    const keywords = cleanKeywords(input.keywords);
    const body = input.content.replace(/\r\n/g, "\n").replace(/\s+$/, "");
    const relatedTools = cleanKeywords(input.relatedTools ?? []);
    const guideFor = cleanKeywords(input.guideFor ?? []);
    const problem =
      validateSummary(summary) ??
      validateKeywords(keywords) ??
      validateBody(body) ??
      validateTools(relatedTools) ??
      validateTools(guideFor);
    if (problem) return { ok: false, code: "invalid", message: problem };

    const state = this.fresh();
    if (!state.categories.has(categoryId)) {
      const description = input.categoryDescription?.replace(/\s+/g, " ").trim() ?? "";
      if (!description) {
        return {
          ok: false,
          code: "invalid",
          message: `Category ${categoryId} does not exist. Pick an existing category (search_knowledge with no query lists them) or pass category_description to create it.`,
        };
      }
      if (description.length > KNOWLEDGE_CATEGORY_DESCRIPTION_MAX_CHARS) {
        return {
          ok: false,
          code: "invalid",
          message: `category_description is longer than ${KNOWLEDGE_CATEGORY_DESCRIPTION_MAX_CHARS} characters.`,
        };
      }
      mkdirSync(join(config.userDir, categoryId), { recursive: true });
      writeAtomic(
        join(config.userDir, categoryId, KNOWLEDGE_CATEGORY_FILE),
        `---\ntitle: ${categoryId}\ndescription: "${description.replace(/"/g, '\\"')}"\n---\n`,
      );
    }

    const id = `${categoryId}/${slug}`;
    const existing = state.docs.get(id);
    const builtin = existing?.source === "builtin" ? existing : existing?.source === "override" ? this.getBuiltinDoc(id) : null;
    const front: KnowledgeFrontmatter = {
      title,
      category: categoryId,
      summary,
      keywords,
      relatedTools,
      guideFor,
      version: existing && existing.source !== "builtin" ? existing.version + 1 : 1,
      updatedAt: new Date().toISOString(),
      ...(builtin ? { baseVersion: builtin.version } : {}),
    };
    this.persist(id, front, body);
    const doc = this.getDoc(id);
    if (!doc) return { ok: false, code: "invalid", message: `Wrote ${id} but could not load it back.` };
    return { ok: true, doc, created: !existing || existing.source === "builtin" };
  }

  patch(input: KnowledgePatchInput): KnowledgeMutationResult {
    if (!this.config) return { ok: false, code: "invalid", message: "The knowledge base is not available in this host." };
    const doc = this.getDoc(input.id);
    if (!doc) return { ok: false, code: "not_found", message: `No knowledge doc ${JSON.stringify(input.id)}.` };
    if (input.edits.length > KNOWLEDGE_PATCH_EDITS_MAX) {
      return { ok: false, code: "invalid", message: `At most ${KNOWLEDGE_PATCH_EDITS_MAX} edits per call.` };
    }
    let body = doc.body;
    for (const [index, edit] of input.edits.entries()) {
      if (!edit.oldString) return { ok: false, code: "invalid", message: `edits[${index}].old_string is empty.` };
      const count = countOccurrences(body, edit.oldString);
      if (count !== 1) {
        return {
          ok: false,
          code: "invalid",
          message:
            count === 0
              ? `edits[${index}].old_string was not found in ${doc.id}. read_knowledge it again and copy the text exactly.`
              : `edits[${index}].old_string matches ${count} places in ${doc.id}; include more surrounding text.`,
        };
      }
      body = body.replace(edit.oldString, () => edit.newString);
    }
    const summary = input.summary !== undefined ? input.summary.replace(/\s+/g, " ").trim() : doc.summary;
    const keywords = input.keywords !== undefined ? cleanKeywords(input.keywords) : doc.keywords;
    const problem =
      validateSummary(summary) ?? (input.keywords !== undefined ? validateKeywords(keywords) : null) ?? validateBody(body);
    if (problem) return { ok: false, code: "invalid", message: problem };
    const front: KnowledgeFrontmatter = {
      title: doc.title,
      category: doc.category,
      summary,
      keywords,
      relatedTools: doc.relatedTools,
      guideFor: doc.guideFor,
      version: doc.source === "builtin" ? 1 : doc.version + 1,
      updatedAt: new Date().toISOString(),
      ...(doc.source === "builtin"
        ? { baseVersion: doc.version }
        : doc.baseVersion !== undefined
          ? { baseVersion: doc.baseVersion }
          : {}),
    };
    this.persist(doc.id, front, body);
    const next = this.getDoc(doc.id);
    if (!next) return { ok: false, code: "invalid", message: `Patched ${doc.id} but could not load it back.` };
    return { ok: true, doc: next, created: doc.source === "builtin" };
  }

  delete(id: string): KnowledgeDeleteResult {
    if (!this.config) return { ok: false, code: "invalid", message: "The knowledge base is not available in this host." };
    const doc = this.getDoc(id);
    if (!doc) return { ok: false, code: "not_found", message: `No knowledge doc ${JSON.stringify(id)}.` };
    if (doc.source === "builtin") {
      return { ok: false, code: "denied", message: `${doc.id} is a built-in doc and cannot be deleted. Patch it to correct it.` };
    }
    rmSync(doc.filePath, { force: true });
    this.invalidate();
    return { ok: true, id: doc.id, reverted: doc.source === "override" };
  }

  revertToBuiltin(id: string): KnowledgeDeleteResult {
    const doc = this.getDoc(id);
    if (!doc) return { ok: false, code: "not_found", message: `No knowledge doc ${JSON.stringify(id)}.` };
    if (doc.source !== "override") {
      return { ok: false, code: "invalid", message: `${doc.id} is not an override of a built-in doc.` };
    }
    return this.delete(id);
  }

  private persist(id: string, front: KnowledgeFrontmatter, body: string): void {
    const config = this.config!;
    const { category, slug } = splitKnowledgeId(id)!;
    const dir = join(config.userDir, category);
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, `${slug}.md`), serializeKnowledgeDoc(front, body));
    this.invalidate();
  }
}

export const knowledgeBase = new KnowledgeStore();

export function configureKnowledgeBase(config: KnowledgeBaseConfig | null): void {
  knowledgeBase.configure(config);
}
