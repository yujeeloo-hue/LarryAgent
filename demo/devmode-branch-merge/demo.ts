import { CommitDialogView } from '../../src/renderer/src/devmode/CommitDialogView';
import { createDevModeIcon } from '../../src/renderer/src/devmode/launchIcon';
import { getTheme } from '../../src/renderer/src/state/theme';
import { createLucideIcon, Terminal, ChevronUp } from '../../src/renderer/src/ui/originalIcons';
import { GitBranch, Hammer } from 'lucide';

const root = document.getElementById('jelly-merge-demo')!;
const q = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
const qa = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const host = (window as any).openai;
const names = { left: 'main', right: 'feature/preview' };
const hashes = { left: 'c3a91b2', right: 'a71f04d' };
type Side = keyof typeof names;
const sides: Side[] = ['left', 'right'];
let merged = false, merging = false, theme = 'dark', dialog: CommitDialogView | null = null;
let generation = 0, submitting = false, draft = '', completed = false;
const committed = { left: false, right: false };
const selected = { left: true, right: true };
const commonStart = ['export function toChromePageUrl(', '  raw: string,', '): string {', '  try {', '    const url = new URL(raw);'];
const source = ['    // 扩展本机地址识别', '    const loopback = [', '      "0.0.0.0", "::", "[::]",', '      "::1", "[::1]",', '    ];', '    if (loopback.includes(url.hostname)) {', '      url.hostname = "127.0.0.1";', '    }'];
const target = ['    // 仅允许 HTTP / HTTPS', '    if (!/^https?:$/.test(url.protocol)) {', '      return raw;', '    }'];
const commonEnd = ['    return url.href;', '  } catch {', '    return raw;', '  }', '}'];
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function paint(line: string) {
  if (line.trim().startsWith('//')) return '<span class="jm-comment">' + escape(line) + '</span>';
  return line.split(/("[^"]*")/g).map((part, index) => index % 2 ? '<span class="jm-str">' + escape(part) + '</span>' : escape(part).replace(/\b(export|function|const|try|catch|if|return|new)\b/g, '<span class="jm-kw">$1</span>').replace(/\b(string)\b/g, '<span class="jm-type">$1</span>')).join('');
}
function renderCode(integrated = merged) {
  const left: { text: string | null; kind?: string }[] = commonStart.map(text => ({text}));
  const right: { text: string | null; kind?: string }[] = commonStart.map(text => ({text}));
  if (integrated) {
    left.push(...target.map(() => ({text: null, kind: 'jm-gap'})));
    right.push(...target.map(text => ({text, kind: 'jm-added'})));
    left.push(...source.map(text => ({text})));
    right.push(...source.map(text => ({text, kind: 'jm-landed'})));
  } else {
    left.push(...source.map(text => ({text, kind: 'jm-removed'})));
    right.push(...target.map(text => ({text, kind: 'jm-added'})));
    right.push(...Array.from({length: source.length - target.length}, () => ({text: null, kind: 'jm-gap'})));
  }
  left.push(...commonEnd.map(text => ({text}))); right.push(...commonEnd.map(text => ({text})));
  for (const [side, lines] of [['left', left], ['right', right]] as const) {
    let number = 0;
    q('.jm-' + side + '-code').innerHTML = lines.map(row => '<div class="jm-row ' + (row.kind || '') + '"><span class="jm-number">' + (row.text === null ? '' : ++number) + '</span><code>' + (row.text === null ? '&nbsp;' : paint(row.text)) + '</code></div>').join('');
  }
}
function setStatus(text: string) { q('.jm-status-text').textContent = text; }
function update() {
  q<HTMLButtonElement>('.jm-merge').disabled = merging || !!dialog;
  q<HTMLButtonElement>('.jm-open-commit').disabled = merging || !!dialog;
  q('.jm-merge').textContent = merging ? 'Merging…' : 'AI Merge';
  q('.jm-merge').setAttribute('data-tooltip', merged ? 'Replay demo: merge left into right' : 'Merge left into right');
  q('.jm-left-lock').hidden = !merging; q('.jm-right-lock').hidden = !merging;
}
function applyTheme(value: string) {
  theme = value === 'light' ? 'light' : 'dark';
  root.dataset.theme = theme;
  const tokens = getTheme(theme).tokens;
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
  qa('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme)));
}
function saveState() {
  host?.setWidgetState?.({modelContent: {demo: 'JellyBot Dev Mode exact UI', merged, theme, committed: {...committed}, selected: {...selected}}, privateContent: {message: draft.slice(0, 4000)}})?.catch(() => {});
}
function restore(saved: any) {
  if (!saved || merging || dialog || saved.modelContent?.demo !== 'JellyBot Dev Mode exact UI') return;
  const state = saved.modelContent;
  merged = state.merged === true; draft = saved.privateContent?.message || '';
  for (const side of sides) { committed[side] = state.committed?.[side] === true; selected[side] = state.selected?.[side] !== false; }
  applyTheme(state.theme); renderCode(); update();
}
function progress(index: number, title: string, subtitle: string) {
  q('.jm-progress-step').textContent = index + ' / 4';
  q('.jm-progress-text').textContent = title; q('.jm-progress-sub').textContent = subtitle;
}
async function merge() {
  if (merging || dialog) return;
  merging = true; renderCode(false); root.setAttribute('aria-busy', 'true'); update();
  for (const side of sides) q('.jm-' + side).inert = true;
  q('.jm-panes').classList.add('is-busy'); q('.jm-freeze').hidden = false; q('.jm-progress').hidden = false;
  setStatus('AI Merge · main → feature/preview · Editors locked');
  try {
    progress(1, 'Analyzing both versions…', 'Both editors are locked during the merge.'); await pause(650);
    progress(2, 'Merging changes…', 'Combining loopback handling with protocol validation.'); await pause(1000);
    progress(3, 'Checking the merge result…', 'Verifying that both changes work together.'); await pause(600);
    progress(4, 'Applying the merge…', 'Updating the collaborative branch.'); await pause(450);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    q('.jm-progress').hidden = true;
    q('.jm-panes').classList.remove('is-busy');
    renderCode(true);
    if (!reduced) await Promise.all(qa('.jm-right .jm-landed').map((row, index) => row.animate([
      {opacity: 0, backgroundColor: 'rgba(var(--accent-rgb), .22)'},
      {opacity: 1, backgroundColor: '#3fb95021'},
      {opacity: 1, backgroundColor: 'transparent'}
    ], {duration: 800, delay: index * 45, easing: 'ease-out', fill: 'backwards'}).finished.catch(() => {})));
    merged = true; committed.right = false;
    setStatus('Merge complete · Left → right · Protocol validation preserved · Not committed');
  } finally {
    merging = false; root.removeAttribute('aria-busy');
    for (const side of sides) q('.jm-' + side).inert = false;
    q('.jm-panes').classList.remove('is-busy'); q('.jm-freeze').hidden = true; q('.jm-progress').hidden = true;
    update(); saveState();
  }
}

function activeSides() { return sides.filter(side => selected[side] && !committed[side]); }
function closeDialog() {
  if (!dialog || submitting) return;
  generation++; draft = dialog.getMessage(); dialog.destroy(); dialog = null;
  q('.jm-panes').inert = false; update(); q<HTMLButtonElement>('.jm-open-commit').focus(); saveState();
}
function syncSelection() {
  if (!dialog) return;
  const count = activeSides().length;
  q('.jm-selection-count').textContent = count + ' file' + (count === 1 ? '' : 's') + ' · ' + count + ' branch' + (count === 1 ? '' : 'es');
  const button = q<HTMLButtonElement>('.jm-confirm');
  if (!completed) button.disabled = submitting || !count || !q<HTMLTextAreaElement>('#jm-message').value.trim();
  q<HTMLButtonElement>('.jm-ai-button').disabled = submitting || !count;
}
function setBranchStatus(side: Side, text: string, success = false) {
  const el = q('[data-side="' + side + '"] .jm-card-state'); el.textContent = text;
  el.style.color = success ? 'var(--success-text)' : 'var(--vcs-modified)';
}
async function generate() {
  const view = dialog, chosen = activeSides(); if (!view || !chosen.length) return;
  const token = ++generation; view.setBusy('generate');
  qa('.jm-branch-meta input').forEach(el => (el as HTMLInputElement).disabled = true);
  view.setStatus('AI is reading the selected file changes…');
  await pause(600); if (token !== generation || dialog !== view) return;
  const includesSource = chosen.includes('left') || chosen.includes('right') && merged;
  const includesTarget = chosen.includes('right');
  const text = 'fix(web): ' + (includesSource && includesTarget ? 'improve dev server URL handling' : includesSource ? 'normalize loopback hosts' : 'validate dev server URL protocols') + '\n\n' + [includesSource ? '- Normalize loopback hosts to 127.0.0.1' : '', includesTarget ? '- Preserve HTTP / HTTPS protocol validation' : '', '- Keep the original URL as the fallback'].filter(Boolean).join('\n');
  for (let i = 0; i < text.length; i += 10) {
    if (token !== generation || dialog !== view) return;
    q<HTMLTextAreaElement>('#jm-message').value = text.slice(0, i + 10); await pause(22);
  }
  if (token !== generation || dialog !== view) return;
  draft = text; view.setMessage(text); view.setBusy(null);
  for (const side of sides) q<HTMLInputElement>('#jm-check-' + side).disabled = committed[side];
  view.setStatus('AI draft ready. Review or edit before committing.'); syncSelection(); saveState();
}
async function submit(text: string) {
  if (completed) { closeDialog(); return; }
  const view = dialog, chosen = activeSides(); if (!view || submitting || !chosen.length || !text.trim()) return;
  submitting = true; view.setBusy('commit'); qa('.jm-branch-meta input').forEach(el => (el as HTMLInputElement).disabled = true);
  view.setStatus('Committing each selected file to its own branch…');
  for (const side of chosen) {
    setBranchStatus(side, 'Committing…'); await pause(650);
    committed[side] = true; setBranchStatus(side, '✓ ' + hashes[side], true);
  }
  submitting = false; completed = true; view.setBusy(null);
  q('.devmode-commit-title').textContent = 'Committed · JellyBot · GIT';
  q<HTMLTextAreaElement>('#jm-message').readOnly = true;
  q('.jm-generate-row').hidden = true; q('.jm-cancel').hidden = true;
  q<HTMLButtonElement>('.jm-confirm').textContent = 'Done'; q<HTMLButtonElement>('.jm-confirm').disabled = false;
  qa('.jm-branch-meta input').forEach(el => (el as HTMLInputElement).disabled = true);
  view.setStatus('Demo complete · Simulated commits only. No repository changes.');
  setStatus('Demo committed · ' + chosen.map(side => names[side] + ' ' + hashes[side]).join(' · '));
  draft = text; q<HTMLButtonElement>('.jm-confirm').focus(); saveState();
}
function openCommit() {
  if (dialog || merging) return;
  completed = false;
  const view = new CommitDialogView({title: 'Commit · JellyBot · GIT', files: [], handlers: {onGenerate: () => { void generate(); }, onCommit: text => { void submit(text); }, onCancel: closeDialog}});
  dialog = view; view.root.classList.add('jm-backdrop'); q('.jm-modal-host').append(view.root);
  const panel = view.root.querySelector<HTMLElement>('.devmode-commit')!;
  panel.setAttribute('aria-describedby', 'jm-commit-description');
  const count = document.createElement('span'); count.className = 'jm-selection-count'; panel.querySelector('.devmode-commit-header')!.append(count);
  const list = panel.querySelector<HTMLElement>('.devmode-commit-files')!; list.classList.add('jm-branch-files');
  for (const side of sides) {
    if (committed[side]) selected[side] = false;
    const row = document.createElement('div'); row.className = 'jm-branch-file'; row.dataset.side = side;
    row.innerHTML = '<div class="jm-branch-meta"><input type="checkbox" id="jm-check-' + side + '" aria-label="Commit ' + names[side] + '"><label for="jm-check-' + side + '"><span>' + (side === 'left' ? 'Left' : 'Right') + '</span><span class="jm-branch-name">' + names[side] + '</span></label><span class="jm-card-state">Modified</span></div><div class="jm-file-path">E:/YouYeeOpenSource/' + (side === 'left' ? 'JellyBot' : 'JellyBot-preview') + '/src/web/devServerUrl.ts</div>';
    row.querySelector('label')!.insertBefore(createLucideIcon(GitBranch, {size: 12}), row.querySelector('.jm-branch-name'));
    list.append(row);
    const checkbox = q<HTMLInputElement>('#jm-check-' + side); checkbox.checked = selected[side]; checkbox.disabled = committed[side];
    checkbox.addEventListener('change', () => { selected[side] = checkbox.checked; syncSelection(); view.setStatus('Selection changed. Regenerate the message if needed.'); saveState(); });
    if (committed[side]) setBranchStatus(side, '✓ ' + hashes[side], true);
  }
  const textarea = panel.querySelector<HTMLTextAreaElement>('textarea')!; textarea.id = 'jm-message'; textarea.setAttribute('aria-label', 'Commit message');
  const generateRow = document.createElement('div'); generateRow.className = 'jm-generate-row';
  const label = document.createElement('label'); label.htmlFor = 'jm-message'; label.textContent = 'Commit message';
  const generateButton = panel.querySelector<HTMLButtonElement>('.is-generate')!; generateButton.classList.add('jm-ai-button'); generateButton.setAttribute('aria-label', 'AI Generate commit message');
  generateRow.append(label, generateButton); textarea.before(generateRow);
  const cancel = panel.querySelectorAll<HTMLButtonElement>('.devmode-commit-actions button')[0]; cancel.classList.add('jm-cancel');
  panel.querySelector('.is-primary')!.classList.add('jm-confirm');
  const description = panel.querySelector<HTMLElement>('.devmode-commit-status')!; description.id = 'jm-commit-description'; description.setAttribute('role', 'status'); description.setAttribute('aria-live', 'polite');
  view.setMessage(draft); view.setStatus('Demo · Commit selected files to their own branches.'); syncSelection();
  textarea.addEventListener('input', () => { draft = textarea.value; syncSelection(); saveState(); });
  view.root.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusable = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled),textarea,input:not(:disabled)')].filter(el => el.getClientRects().length);
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
  });
  q('.jm-panes').inert = true; update(); textarea.focus();
}

for (const button of qa('[data-launch]')) button.append(createDevModeIcon(button.dataset.launch as any));
const icons = {Terminal, Hammer, ChevronUp};
for (const node of qa('[data-icon]')) node.replaceWith(createLucideIcon(icons[node.dataset.icon as keyof typeof icons], {size: 12}));
q('.jm-merge').addEventListener('click', () => { void merge(); });
q('.jm-open-commit').addEventListener('click', openCommit);
for (const button of qa('[data-theme-choice]')) button.addEventListener('click', () => { applyTheme(button.dataset.themeChoice!); saveState(); });
window.addEventListener('openai:set_globals', (event: any) => restore(event.detail?.globals?.widgetState));
applyTheme(document.documentElement.dataset.theme || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
renderCode(); update(); restore(host?.widgetState);
