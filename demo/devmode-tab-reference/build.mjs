import { build } from "esbuild";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClientPreview } from "../../site/client-preview.build.mjs";

const demo = dirname(fileURLToPath(import.meta.url));
const repo = resolve(demo, "../..");
const target = resolve(process.argv[2] ?? join(repo, "dist/devmode-tab-reference/index.html"));
const stage = await mkdtemp(join(tmpdir(), "jellybot-tab-reference-"));
const stageSite = join(stage, "site");
const clientSource = join(repo, "site/src");
const stageSource = join(stageSite, "src");

function replaceSource(source, before, after) {
  if (!source.includes(before)) throw new Error(`Client preview source changed: ${before}`);
  return source.replace(before, after);
}

function scriptText(source) {
  return source.replace(/<\/script/gi, "<\\/script");
}

try {
  await mkdir(stageSource, { recursive: true });
  await Promise.all([
    symlink(join(repo, "src"), join(stage, "src")),
    symlink(join(repo, "node_modules"), join(stage, "node_modules")),
    symlink(join(clientSource, "client-preview.css"), join(stageSource, "client-preview.css")),
    symlink(join(clientSource, "preview-debug.ts"), join(stageSource, "preview-debug.ts")),
  ]);

  let source = await readFile(join(clientSource, "client-preview.ts"), "utf8");
  source = replaceSource(source,
    "const send=(type:string,detail:Record<string,unknown>={})=>parent.postMessage({source:'larry-client-preview',type,...detail},location.origin);",
    "const send=(_type:string,_detail?:Record<string,unknown>)=>{};");
  source = replaceSource(source, "document.documentElement.dataset.theme='light';",
    "const previewTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; document.documentElement.dataset.theme=previewTheme;");
  source = replaceSource(source, "themeToCss(getTheme('light'))+darkIslandCss('light',null)",
    "themeToCss(getTheme(previewTheme))+darkIslandCss(previewTheme,null)");
  source = replaceSource(source, "files:[sampleWorkspace.path+'/src/App.tsx']",
    "files:['App.tsx','main.ts','app.css'].map(file=>sampleWorkspace.path+'/src/'+file)");
  source = replaceSource(source, "select('new-task');send('ready');", "select('dev');send('ready');");
  await writeFile(join(stageSource, "client-preview.ts"), source);

  await buildClientPreview(stageSite);
  const previewPage = await readFile(join(stageSite, "client-preview.html"), "utf8");
  const previewEntry = /<script type="module" src="([^"]+)"/.exec(previewPage)?.[1];
  if (!previewEntry) throw new Error("Client preview bundle missing");

  const styles = await Promise.all([...previewPage.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)]
    .map(match => readFile(join(stageSite, match[1]), "utf8")));
  const assets = join(stageSite, "assets/client-preview");
  const workerFiles = (await readdir(assets)).filter(file => /^worker-.*\.js$/.test(file));
  const workers = Object.fromEntries(await Promise.all(workerFiles.map(async file => [
    file,
    await readFile(join(assets, file), "utf8"),
  ])));

  const output = await build({
    entryPoints: [join(stageSite, previewEntry)],
    outdir: stage,
    format: "iife",
    bundle: true,
    write: false,
    minify: true,
    target: "es2022",
    define: { "import.meta.url": "document.baseURI" },
  });
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline' 'wasm-unsafe-eval';worker-src blob:;style-src 'unsafe-inline';font-src data:;img-src data: blob:">
<title>Dev Mode · File References</title>
<style>${styles.join("\n")}</style></head>
<body><div id="app"></div>
<script>${scriptText(`{
  const workerSources = ${JSON.stringify(workers)};
  const workerUrls = new Map();
  const PreviewWorker = window.Worker;
  window.Worker = class extends PreviewWorker {
    constructor(url, options) {
      const filename = new URL(url, document.baseURI).pathname.split("/").pop();
      if (Object.hasOwn(workerSources, filename)) {
        if (!workerUrls.has(filename)) {
          workerUrls.set(filename, URL.createObjectURL(new Blob([workerSources[filename]], { type: "text/javascript" })));
        }
        url = workerUrls.get(filename);
        options = { ...options, type: "classic" };
      }
      super(url, options);
    }
  };
}\n${output.outputFiles.find(file => file.path.endsWith(".js")).text}`)}</script>
</body></html>
`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, html);
  console.log(target);
} finally {
  await rm(stage, { recursive: true, force: true });
}
