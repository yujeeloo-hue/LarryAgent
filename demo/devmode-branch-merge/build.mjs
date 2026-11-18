import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const postcss = require('postcss');
const directory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(directory, '../..');
const read = relative => fs.readFileSync(path.join(repo, relative), 'utf8');
const cssResult = esbuild.buildSync({
  stdin: {contents: '@import "./src/renderer/src/styles/tokens.css"; @import "./src/renderer/src/devmode/devmode.css"; @import "./src/renderer/src/devmode/collaborative.css";', loader: 'css', resolveDir: repo},
  bundle: true, write: false, minify: true, loader: {'.woff2': 'dataurl'}
});
const stylesheet = postcss.parse(cssResult.outputFiles[0].text);
function selectors(text) {
  const parts = []; let start = 0, level = 0, quote = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) { if (character === quote && text[index - 1] !== '\\') quote = ''; continue; }
    if (character === '"' || character === "'") quote = character;
    if (character === '(' || character === '[') level++;
    if (character === ')' || character === ']') level--;
    if (character === ',' && !level) { parts.push(text.slice(start,index)); start = index + 1; }
  }
  parts.push(text.slice(start)); return parts;
}
stylesheet.walkRules(rule => {
  if (rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
  rule.selector = selectors(rule.selector).map(selector => {
    selector = selector.trim();
    if (/^(html|body|#app)$/.test(selector)) return '#jelly-merge-demo';
    return selector.includes(':root') ? selector.replace(/:root/g, '#jelly-merge-demo') : '#jelly-merge-demo ' + selector;
  }).join(',');
});
const script = esbuild.buildSync({entryPoints: [path.join(directory, 'demo.ts')], bundle: true, write: false, minify: true, format: 'iife', platform: 'browser'}).outputFiles[0].text;
const markup = fs.readFileSync(path.join(directory, 'mockup.html'), 'utf8');
const fragment = '<style>/* Production Dev Mode styles; scoped only for this demo. */\n' + stylesheet.toString() + '</style>\n' + markup + '\n<script>' + script.replace(/<\/script/gi, '<\\/script') + '</script>\n';
if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), fragment);
const standalone = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'">
<title>JellyBot Dev Mode · AI Merge / Commit Demo</title>
<style>html{color-scheme:light dark;background:light-dark(#f8fafc,#141414)}body{margin:0;padding:24px 16px}main{max-width:1120px;margin:auto}@media(max-width:500px){body{padding:10px}}</style>
</head><body><main>${fragment}</main></body></html>`;
fs.writeFileSync(path.join(directory, 'index.html'), standalone);
console.log(JSON.stringify({fragmentBytes: Buffer.byteLength(fragment), productionStyles: ['tokens.css', 'devmode.css', 'collaborative.css'], productionComponents: ['CommitDialogView', 'createDevModeIcon', 'getTheme'], output: path.join(directory, 'index.html')}));
