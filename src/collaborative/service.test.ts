import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { CollaborativeService, repositoryPath } from "./service.js";
const exec = promisify(execFile);
const command = async (cwd: string, tool: string, args: string[]) => (await exec(tool, args, { cwd, windowsHide: true })).stdout.trim();
const missing = async (path: string) => { try { await access(path); return false; } catch { return true; } };
async function fixture(prefix: string): Promise<string> {
  const parent = join(process.cwd(), "tmp", "collaborative-tests");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, prefix));
}

test("Git browsing stays virtual; sparse edits and explicit commits leave main HEAD, index and dirty files unchanged", async () => {
  const temp = await fixture("git-");
  const root = join(temp, "main"), checkout = join(temp, "shadow");
  await mkdir(root);
  const git = (args: string[]) => command(root, "git", args);
  await git(["init", "-b", "main"]); await git(["config", "user.name", "Test"]); await git(["config", "user.email", "test@example.com"]);
  await mkdir(join(root, "Source"));
  await writeFile(join(root, "Source", "one file.ts"), "export const version = 1;\n");
  await writeFile(join(root, "Source", "other.ts"), "other\n"); await writeFile(join(root, "README.md"), "readme\n");
  await writeFile(join(root, "Asset.uasset"), Buffer.from([1, 0, 2]));
  await git(["add", "."]); await git(["commit", "-m", "initial"]);
  await git(["branch", "release"]); await git(["update-ref", "refs/remotes/origin/release", "release"]);
  await writeFile(join(root, "Source", "other.ts"), "keep dirty local edits\n");
  const head = await git(["rev-parse", "HEAD"]), index = await readFile(join(root, ".git", "index"));
  const service = new CollaborativeService(join(temp, "settings.json"), { merge: async input => {
    assert(input.source.includes("version = 1")); assert(input.target.includes("version = 1"));
    return "export const version = 3;\n";
  } });
  const repositories = (await service.execute({ op: "scan", workspacePath: root })).repositories!;
  const repositoryId = repositories[0]!.id;
  const request = { workspacePath: root, repositoryId };
  await assert.rejects(service.execute({ ...request, op: "bind", branch: "missing", directory: checkout }));
  await assert.rejects(service.execute({ ...request, op: "bind", branch: "release", directory: join(root, "shadow") }), /outside/);
  await service.execute({ ...request, op: "bind", branch: "origin/release", directory: checkout });
  assert.equal((await service.execute({ ...request, op: "exists", path: "Source/one file.ts" })).exists, true);
  assert.equal((await service.execute({ ...request, op: "exists", path: "Source/local-only.ts" })).exists, false);
  assert.equal((await service.execute({ ...request, op: "exists", path: "Source" })).exists, false);
  assert(await missing(checkout), "matching a branch version does not create a checkout");
  await assert.rejects(service.execute({ ...request, op: "materialize", path: "Source" }), /file.*directory/);
  assert((await service.execute({ ...request, op: "read", path: "Asset.uasset" })).file!.binary);
  await assert.rejects(service.execute({ ...request, op: "read", path: "Missing.uasset" }));
  const entries = (await service.execute({ ...request, op: "list", path: "Source" })).entries!;
  assert.equal(entries.length, 2); assert(entries.every(e => !e.materialized));
  const file = (await service.execute({ ...request, op: "read", path: "Source/one file.ts" })).file!;
  assert(file.content.includes("version = 1")); assert(await missing(checkout));
  const proposal = (await service.execute({ ...request, op: "merge-preview", path: file.path })).proposal!;
  assert(proposal.content.includes("version = 3")); assert(await missing(checkout), "preview never creates a checkout");
  const saved = (await service.execute({ ...request, op: "save", path: file.path, expectedHash: file.hash, content: "export const version = 2;\n" })).file!;
  assert(saved.materialized); assert(await missing(join(checkout, "Source", "other.ts"))); assert(await missing(join(checkout, "README.md")));
  assert.deepEqual((await service.execute({ ...request, op: "changes" })).paths, [file.path]);
  await assert.rejects(service.execute({ ...request, op: "save", path: file.path, expectedHash: file.hash, content: "stale" }), /changed/);
  await assert.rejects(service.execute({ ...request, op: "merge-apply", path: file.path, expectedHash: proposal.expectedHash, content: proposal.content }), /changed/);
  await assert.rejects(service.execute({ ...request, op: "release", path: file.path, expectedHash: saved.hash }), /confirm discard/);
  await assert.rejects(service.execute({ ...request, op: "commit", message: "" }), /message/);
  const commit = await service.execute({ ...request, op: "commit", message: "update shadow only", paths: [file.path] });
  assert(commit.commit?.shortHash); assert.deepEqual((await service.execute({ ...request, op: "changes" })).paths, []);
  assert.equal(await git(["rev-parse", "HEAD"]), head); assert.equal(await git(["branch", "--show-current"]), "main");
  assert.deepEqual(await readFile(join(root, ".git", "index")), index); assert.equal(await readFile(join(root, "Source", "other.ts"), "utf8"), "keep dirty local edits\n");
  assert.equal(await readFile(join(root, "Source", "one file.ts"), "utf8"), file.content);
  const reopened = new CollaborativeService(join(temp, "settings.json"));
  assert.equal((await reopened.execute({ op: "state", workspacePath: root })).repositories![0]!.binding!.directory, checkout);
  const otherRequest = { workspacePath: root, repositoryId: (await reopened.execute({ op: "state", workspacePath: root })).repositories![0]!.id };
  await assert.rejects(reopened.execute({ ...otherRequest, op: "read", path: "../outside" }));
  await reopened.execute({ ...request, op: "release", path: file.path, expectedHash: saved.hash });
  assert(await missing(join(checkout, "Source", "one file.ts")));
  const virtual = (await reopened.execute({ ...request, op: "read", path: file.path })).file!;
  assert.equal(virtual.materialized, false); assert(virtual.content.includes("version = 2"));
  const again = (await reopened.execute({ ...request, op: "materialize", path: file.path })).file!;
  assert(again.materialized); assert(await missing(join(checkout, "README.md")));
});

test("SVN shallow checkout materializes and adds files on the selected branch", async t => {
  try { await command(tmpdir(), "svnadmin", ["--version", "--quiet"]); } catch { t.skip("svnadmin is unavailable"); return; }
  const temp = await fixture("svn-"), repository = join(temp, "repository"), root = join(temp, "main"), checkout = join(temp, "shadow");
  await command(temp, "svnadmin", ["create", repository]);
  const url = pathToFileURL(repository).href;
  const svn = (args: string[]) => command(temp, "svn", ["--non-interactive", ...args]);
  await svn(["mkdir", url + "/trunk", url + "/branches", "-m", "initialize"]);
  await svn(["checkout", url + "/trunk", root]); await mkdir(join(root, "Source"));
  await writeFile(join(root, "Source", "one.cpp"), "int value = 1;\n"); await writeFile(join(root, "Source", "two.cpp"), "other\n");
  await svn(["add", join(root, "Source")]); await svn(["commit", root, "-m", "source"]);
  await svn(["copy", url + "/trunk", url + "/branches/release", "-m", "branch"]);
  const service = new CollaborativeService(join(temp, "settings.json"));
  const repositoryId = (await service.execute({ workspacePath: root, op: "scan" })).repositories![0]!.id, request = { workspacePath: root, repositoryId };
  await service.execute({ ...request, op: "bind", branch: url + "/branches/release", directory: checkout });
  assert.equal((await service.execute({ ...request, op: "exists", path: "Source/one.cpp" })).exists, true);
  assert.equal((await service.execute({ ...request, op: "exists", path: "Source/missing.cpp" })).exists, false);
  assert.equal((await service.execute({ ...request, op: "exists", path: "Source" })).exists, false);
  const file = (await service.execute({ ...request, op: "read", path: "Source/one.cpp" })).file!;
  assert(await missing(checkout));
  await service.execute({ ...request, op: "save", path: file.path, expectedHash: file.hash, content: "int value = 2;\n" });
  assert(await missing(join(checkout, "Source", "two.cpp")));
  await service.execute({ ...request, op: "commit", message: "branch fix" });
  assert.equal(await svn(["cat", url + "/branches/release/Source/one.cpp"]), "int value = 2;");
  assert.equal(await svn(["cat", url + "/trunk/Source/one.cpp"]), "int value = 1;");
  const editorDrafts = { left: { savedContent: file.content, content: "int value = 4;\n" }, right: { savedContent: "int value = 2;\n", content: "int value = 5;\n" } };
  const scoped = { ...request, path: file.path, editorDrafts };
  const files = (await service.execute({ ...scoped, op: "editor-commit-files" })).commitFiles!;
  assert.deepEqual(files.map(item => [item.side, item.changed, item.unavailable]), [["left", true, undefined], ["right", true, undefined]]);
  for (const selected of files) {
    const result = await service.execute({ ...scoped, op: "editor-commit", message: "Update selected branch", commitFiles: [selected] });
    assert(result.commit?.shortHash, result.commitError);
  }
  assert.equal(await svn(["cat", url + "/trunk/Source/one.cpp"]), "int value = 4;");
  assert.equal(await svn(["cat", url + "/branches/release/Source/one.cpp"]), "int value = 5;");
  const saved = (await service.execute({ ...request, op: "read", path: file.path })).file!;
  await service.execute({ ...request, op: "release", path: file.path, expectedHash: saved.hash });
  assert(await missing(join(checkout, "Source", "one.cpp")));
  assert((await service.execute({ ...request, op: "list", path: "Source" })).entries!.every(e => !e.materialized));

  const newPath = "Source/Nested/new.cpp";
  await mkdir(join(root, "Source", "Nested"));
  await writeFile(join(root, newPath), "new file\n");
  const addition = { ...request, path: newPath };
  const additions = (await service.execute({ ...addition, op: "editor-commit-files" })).commitFiles!;
  assert.deepEqual(additions.map(item => [item.side, item.added, item.unavailable]), [["left", true, undefined], ["right", true, undefined]]);
  for (const item of additions) {
    const result = await service.execute({ ...addition, op: "editor-commit", message: "Add new source file", commitFiles: [item] });
    assert(result.commit?.shortHash, result.commitError);
  }
  assert.equal(await svn(["cat", url + "/branches/release/" + newPath]), "new file");
  assert.equal(await svn(["cat", url + "/trunk/" + newPath]), "new file");
});

test("Editor merge includes both unsaved drafts and editor commits affect only the selected Git file and ref", async () => {
  const temp = await fixture("editor-"), root = join(temp, "working"), checkout = join(temp, "collaborative");
  await mkdir(root);
  const git = (args: string[]) => command(root, "git", args);
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Test"]); await git(["config", "user.email", "test@example.com"]);
  const path = "app.ts";
  const base = "export const base = true;\n";
  await writeFile(join(root, path), base);
  await writeFile(join(root, "unrelated.txt"), "base\n");
  await git(["add", "."]); await git(["commit", "-m", "initial"]); await git(["branch", "release"]);
  const leftContent = base + "export const source = 'left draft';\n";
  const rightContent = base + "export const target = 'right draft';\n";
  const merged = leftContent + "export const target = 'right draft';\n";
  let generatedContext = "";
  const service = new CollaborativeService(join(temp, "settings.json"), {
    merge: async input => {
      assert.equal(input.base, base); assert.equal(input.source, leftContent); assert.equal(input.target, rightContent);
      return merged;
    },
    generateCommitMessage: async (_workspace, context) => { generatedContext = context.diff; return { source: "llm", message: "Merge loopback preferences" }; },
  });
  const repositoryId = (await service.execute({ workspacePath: root, op: "scan" })).repositories![0]!.id;
  const request = { workspacePath: root, repositoryId, path };
  await service.execute({ ...request, op: "bind", branch: "release", directory: checkout });
  const editorDrafts = { left: { content: leftContent, savedContent: base }, right: { content: rightContent, savedContent: base } };
  const proposal = (await service.execute({ ...request, op: "editor-merge-preview", editorDrafts })).proposal!;
  assert.equal(proposal.content, merged);
  assert.equal(await readFile(join(root, path), "utf8"), base);
  assert(await missing(checkout), "preparing a merge never materializes the right branch");

  editorDrafts.right.content = merged;
  const scoped = { ...request, editorDrafts };
  const files = (await service.execute({ ...scoped, op: "editor-commit-files" })).commitFiles!;
  assert.deepEqual(files.map(file => [file.side, file.branch, file.diskPath, file.changed]), [
    ["left", "main", join(root, path), true], ["right", "release", join(checkout, path), true],
  ]);
  const right = files[1]!;
  await service.execute({ ...scoped, op: "editor-commit-message", commitFiles: [right] });
  assert.match(generatedContext, /Collaborative checkout · release/);
  assert.match(generatedContext, /\+export const target/);
  assert.doesNotMatch(generatedContext, /Working copy · main/);
  assert(await missing(checkout), "generating a message never saves a draft");

  await writeFile(join(root, "unrelated.txt"), "preserve staged change\n");
  await git(["add", "unrelated.txt"]);
  const rightCommit = await service.execute({ ...scoped, op: "editor-commit", message: "Merge into release", commitFiles: [right] });
  assert(rightCommit.commit?.shortHash, rightCommit.commitError);
  assert.equal(await git(["show", "release:app.ts"]), merged.trimEnd());
  assert.equal(await git(["show", "main:app.ts"]), base.trimEnd());
  await writeFile(join(root, path), "external edit\n");
  await assert.rejects(service.execute({ ...scoped, op: "editor-commit", message: "Stale commit", commitFiles: [files[0]!] }), /changed on disk/);
  assert.equal(await readFile(join(root, path), "utf8"), "external edit\n");
  await writeFile(join(root, path), base);

  await git(["config", "commit.gpgsign", "true"]);
  await git(["config", "gpg.program", join(temp, "missing-gpg")]);
  const failed = await service.execute({ ...scoped, op: "editor-commit", message: "Save source changes", commitFiles: [files[0]!] });
  assert.equal(failed.draftSaved, true);
  assert.match(failed.commitError!, /git commit failed/);
  assert.equal(await readFile(join(root, path), "utf8"), leftContent);
  await git(["config", "commit.gpgsign", "false"]);
  const retry = { ...request, op: "editor-commit" as const, message: "Save source changes", commitFiles: failed.commitFiles! };
  await writeFile(join(root, path), "external edit after failed commit\n");
  await assert.rejects(service.execute(retry), /file or branch changed/);
  await writeFile(join(root, path), leftContent);
  const leftCommit = await service.execute(retry);
  assert(leftCommit.commit?.shortHash, leftCommit.commitError);
  assert.equal(await git(["show", "main:app.ts"]), leftContent.trimEnd());
  assert.equal(await git(["diff", "--cached", "--name-only"]), "unrelated.txt");
  assert.equal(await git(["show", "main:unrelated.txt"]), "base");
});

test("a local-only file appears in the collaborative tree and commits as an addition to the target branch", async () => {
  const temp = await fixture("add-"), root = join(temp, "working"), checkout = join(temp, "shadow");
  const path = "Source/Nested/new.ts";
  await mkdir(join(root, "Source", "Nested"), { recursive: true });
  const git = (args: string[]) => command(root, "git", args);
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.com"]);
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await git(["add", ".gitignore"]);
  await git(["commit", "-m", "initial"]);
  await git(["branch", "release"]);

  await writeFile(join(root, path), "export const value = 1;\n");
  await git(["add", "--", path]);
  await git(["commit", "-m", "add file on main"]);
  await writeFile(join(root, "Source", "Nested", "other.ts"), "unrelated\n");
  await writeFile(join(root, "Source", "Nested", "ignored.txt"), "ignored\n");

  let generatedDiff = "";
  const service = new CollaborativeService(join(temp, "settings.json"), {
    generateCommitMessage: async (_workspace, context) => { generatedDiff = context.diff; return { source: "llm", message: "Add source file" }; },
  });
  const repositoryId = (await service.execute({ workspacePath: root, op: "scan" })).repositories![0]!.id;
  const request = { workspacePath: root, repositoryId };
  await service.execute({ ...request, op: "bind", branch: "release", directory: checkout });
  const list = (path: string) => service.execute({ ...request, path, op: "list", includeWorkingCopy: true });
  assert((await list("")).entries?.some(entry => entry.name === "Source" && entry.directory && entry.localOnly));
  assert.deepEqual((await list("Source/Nested")).entries?.map(entry => [entry.name, entry.localOnly]), [["new.ts", true], ["other.ts", true]]);

  const sourceDraft = { savedContent: "export const value = 1;\n", content: "export const value = 2;\n" };
  const scoped = { ...request, path, editorDrafts: { left: sourceDraft } };
  const files = (await service.execute({ ...scoped, op: "editor-commit-files" })).commitFiles!;
  const [left, right] = files;
  assert.deepEqual(files.map(file => [file.side, file.changed, file.added, file.unavailable]), [
    ["left", true, undefined, undefined], ["right", true, true, undefined],
  ]);
  await service.execute({ ...scoped, op: "editor-commit-message", commitFiles: [right!] });
  assert.match(generatedDiff, /\+export const value = 2;/);
  assert(await missing(checkout));

  await writeFile(join(root, path), "external edit\n");
  await assert.rejects(service.execute({ ...scoped, op: "editor-commit", message: "Add source file", commitFiles: [right!] }), /changed on disk/);
  assert(await missing(checkout));
  await writeFile(join(root, path), sourceDraft.savedContent);

  const leftCommit = await service.execute({ ...scoped, op: "editor-commit", message: "Update source file", commitFiles: [left!] });
  assert(leftCommit.commit?.shortHash, leftCommit.commitError);
  const rightCommit = await service.execute({ ...request, path, op: "editor-commit", message: "Add source file", commitFiles: [right!] });
  assert(rightCommit.commit?.shortHash, rightCommit.commitError);
  assert.equal(await git(["show", `release:${path}`]), sourceDraft.content.trimEnd());
  assert.equal(await git(["diff-tree", "--no-commit-id", "--name-status", "-r", "release"]), `A\t${path}`);
  assert.equal(await git(["diff-tree", "--no-commit-id", "--name-status", "-r", "main"]), `M\t${path}`);
  assert(await missing(join(checkout, "Source", "Nested", "other.ts")));
  assert.equal((await list("Source/Nested")).entries?.find(entry => entry.path === path)?.localOnly, undefined);
});

test("relative paths reject traversal, metadata and Windows alternate streams", () => {
  for (const p of ["../secret", ".git/config", "x/../../y", "x\\y", "C:/x", "x:stream", "x\nother", "x//y"]) assert.throws(() => repositoryPath(p));
  assert.equal(repositoryPath("Source/valid file.cpp"), "Source/valid file.cpp");
});

test("repository scanning includes nested SVN, Git worktree markers and an external engine root", async () => {
  const temp = await fixture("mixed-"), workspace = join(temp, "NF"), engine = join(temp, "UE");
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(join(workspace, "Game", ".svn"), { recursive: true });
  await mkdir(join(workspace, "Plugins", "PluginA"), { recursive: true });
  await writeFile(join(workspace, "Plugins", "PluginA", ".git"), "gitdir: an-existing-worktree");
  await mkdir(join(engine, ".git"), { recursive: true });
  const settingsFile = join(temp, "settings.json");
  const legacy = new CollaborativeService(settingsFile, { extraRoots: async () => [engine] });
  await legacy.execute({ workspacePath: workspace, op: "scan" });
  await legacy.execute({ workspacePath: workspace, op: "enable", enabled: true });
  const service = new CollaborativeService(settingsFile, { extraRoots: async () => [engine], workspaceId: () => "nf-workspace" });
  const state = await service.execute({ workspacePath: workspace, op: "state" });
  assert.equal(state.enabled, true, "workspace-ID storage preserves existing preferences");
  const repositories = state.repositories!;
  assert.deepEqual(repositories.map(r => [r.name, r.kind]).sort(), [["Game", "svn"], ["NF", "git"], ["PluginA", "git"], ["UE", "git"]]);
  assert.equal(new Set(repositories.map(r => r.id)).size, 4);
  assert(JSON.parse(await readFile(settingsFile, "utf8")).workspaces["workspace:nf-workspace"]);
});

test("a branch already checked out elsewhere fails without switching the main working copy", async () => {
  const temp = await fixture("occupied-"), root = join(temp, "main"), checkout = join(temp, "shadow");
  await mkdir(root); const git = (args: string[]) => command(root, "git", args);
  await git(["init", "-b", "main"]); await git(["config", "user.name", "Test"]); await git(["config", "user.email", "test@example.com"]);
  await writeFile(join(root, "file.txt"), "original"); await git(["add", "."]); await git(["commit", "-m", "initial"]);
  const service = new CollaborativeService(join(temp, "settings.json"));
  const repositoryId = (await service.execute({ workspacePath: root, op: "scan" })).repositories![0]!.id, request = { workspacePath: root, repositoryId };
  await service.execute({ ...request, op: "bind", branch: "main", directory: checkout });
  await assert.rejects(service.execute({ ...request, op: "materialize", path: "file.txt" }), /already (?:checked out|used by worktree)/);
  assert.equal(await git(["branch", "--show-current"]), "main"); assert(await missing(join(checkout, "file.txt")));
});
