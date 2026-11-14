/**
 * Upload card DOM: the live progress zone appended to a running upload_files
 * card, its incremental patch path, and the finished transfer section.
 */

import { ArrowUp, ShieldCheck, TriangleAlert } from "lucide";
import { createCheckBadge } from "../../../ui/checkBadge.js";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import {
  UPLOAD_FILE_LIST_CAP,
  formatUploadBytes,
  formatUploadEta,
  type UploadFinishedStats,
  type UploadLiveState,
} from "./uploadCard.js";
import type { UploadCardInfo } from "./uploadCard.js";

/** Build the live progress zone in its initial (or seeded) state. */
export function createUploadLiveZone(state: UploadLiveState): HTMLElement {
  const zone = document.createElement("div");
  zone.className = "content-card-tool-upload-zone";
  zone.dataset.fileCount = "0";

  if (state.envAtRisk) {
    const warn = document.createElement("div");
    warn.className = "content-card-tool-upload-warn";
    const warnIcon = createLucideIcon(TriangleAlert, { size: 12 });
    warnIcon.classList.add("content-card-tool-upload-warn-icon");
    warn.append(warnIcon);
    warn.appendChild(
      document.createTextNode("--delete is active and .env is not excluded"),
    );
    warn.title =
      "This rsync run could delete or overwrite the remote .env. Consider adding --exclude .env.";
    zone.append(warn);
  }

  const bar = document.createElement("div");
  bar.className = "content-card-tool-upload-bar";
  const fill = document.createElement("div");
  fill.className = "content-card-tool-upload-bar-fill";
  fill.dataset.role = "fill";
  bar.append(fill);

  const line = document.createElement("div");
  line.className = "content-card-tool-upload-line";
  const pct = document.createElement("span");
  pct.className = "content-card-tool-upload-pct";
  pct.dataset.role = "pct";
  const rest = document.createElement("span");
  rest.className = "content-card-tool-upload-rest";
  rest.dataset.role = "rest";
  const meta = document.createElement("span");
  meta.className = "content-card-tool-upload-meta";
  meta.dataset.role = "meta";
  line.append(pct, rest, meta);

  zone.append(bar, line);

  const files = document.createElement("div");
  files.className = "content-card-tool-upload-files";
  files.dataset.role = "files";
  zone.append(files);

  patchUploadLiveZone(zone, state);
  return zone;
}

/**
 * Incrementally patch the live zone (called per tool_live snapshot, already
 * throttled to ~8/s by the emitter). Keeps DOM writes minimal so the run
 * control spinner animation never restarts.
 */
export function patchUploadLiveZone(zone: HTMLElement, state: UploadLiveState): void {
  const fill = zone.querySelector<HTMLElement>('[data-role="fill"]');
  const pct = zone.querySelector<HTMLElement>('[data-role="pct"]');
  const rest = zone.querySelector<HTMLElement>('[data-role="rest"]');
  const meta = zone.querySelector<HTMLElement>('[data-role="meta"]');
  const files = zone.querySelector<HTMLElement>('[data-role="files"]');
  if (!fill || !pct || !rest || !meta || !files) return;

  fill.classList.toggle("is-indeterminate", state.phase === "connecting");
  fill.classList.toggle("is-ok", state.phase === "transferring" && (state.percent ?? 0) >= 100);
  fill.style.width = `${Math.max(0, Math.min(100, state.percent ?? 0)).toFixed(1)}%`;

  if (state.phase === "connecting") {
    pct.textContent = "";
    rest.textContent = "Connecting to remote…";
    meta.textContent = "";
  } else {
    pct.textContent = state.percent !== undefined ? `${Math.round(state.percent)}%` : "";
    if (state.bytesSent !== undefined && state.bytesTotal !== undefined) {
      rest.textContent = `${formatUploadBytes(state.bytesSent)} / ${formatUploadBytes(state.bytesTotal)}`;
    } else if (state.bytesSent !== undefined) {
      rest.textContent = `${formatUploadBytes(state.bytesSent)} sent`;
    } else {
      rest.textContent = "Transferring…";
    }

    const parts: string[] = [];
    if (state.speed) parts.push(state.speed);
    if (state.etaSeconds !== null && state.etaSeconds !== undefined) {
      parts.push(`ETA ${formatUploadEta(state.etaSeconds)}`);
    }
    if (state.filesTotal !== undefined && state.filesTotal > 0) {
      parts.push(`${state.filesDone}/${state.filesTotal} files`);
    } else if (state.filesDone > 0) {
      parts.push(`${state.filesDone} files`);
    }
    meta.textContent = parts.join(" · ");
  }

  // Append only unseen file rows (events carry the full recent window).
  const stickToBottom =
    files.scrollHeight - files.clientHeight - files.scrollTop <= 12;
  const seen = Number(zone.dataset.fileCount ?? "0");
  if (state.recentFiles.length < seen) {
    files.replaceChildren();
    for (const f of state.recentFiles) files.append(createUploadFileRow(f));
  } else {
    for (const f of state.recentFiles.slice(seen)) {
      files.append(createUploadFileRow(f));
    }
  }
  zone.dataset.fileCount = String(state.recentFiles.length);
  while (files.children.length > UPLOAD_FILE_LIST_CAP) {
    files.firstElementChild?.remove();
  }
  if (stickToBottom) files.scrollTop = files.scrollHeight;
}

function createUploadFileRow(
  file: { name: string; bytes: number },
  done = false,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "content-card-tool-upload-file-row";
  // Live rows show the up-arrow; the finished snapshot uses the shared
  // green check badge (same success mark as completed plan steps).
  const icon: HTMLElement | SVGElement = done
    ? createCheckBadge({ size: 12 }, createLucideIcon)
    : createLucideIcon(ArrowUp, { size: 11 });
  icon.classList.add("content-card-tool-upload-file-icon");
  if (done) icon.classList.add("is-done");
  const name = document.createElement("span");
  name.className = "content-card-tool-upload-file-name";
  name.textContent = file.name;
  name.title = file.name;
  const size = document.createElement("span");
  size.className = "content-card-tool-upload-file-size";
  size.textContent = formatUploadBytes(file.bytes);
  row.append(icon, name, size);
  return row;
}

function appendUploadStat(parent: HTMLElement, value: string, label?: string): void {
  const stat = document.createElement("div");
  stat.className = "content-card-tool-upload-stat";
  const valueEl = document.createElement("b");
  valueEl.textContent = value;
  stat.append(valueEl);
  if (label) {
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    stat.append(labelEl);
  }
  parent.append(stat);
}

/**
 * Finished section: labeled stats + optional excludes + file snapshot on
 * success; failure title + stderr tail + resume hint on error.
 */
export function createUploadFinishedSection(input: {
  ok: boolean;
  cancelled: boolean;
  info: UploadCardInfo;
  stats: UploadFinishedStats;
}): HTMLElement {
  const section = document.createElement("section");
  section.className = "content-card-tool-section content-card-tool-upload-section";

  if (input.ok) {
    const files = input.stats.files;
    const bytes = input.stats.bytes;
    const elapsed = input.stats.elapsedSec;
    const stats = document.createElement("div");
    stats.className = "content-card-tool-upload-stats";
    if (files !== null) {
      appendUploadStat(stats, String(files), files === 1 ? "file" : "files");
    }
    if (bytes !== null) {
      appendUploadStat(stats, formatUploadBytes(bytes));
    }
    if (elapsed !== null) {
      appendUploadStat(stats, `${elapsed.toFixed(1)}s`);
    }
    if (bytes !== null && elapsed !== null && elapsed > 0) {
      appendUploadStat(stats, `${formatUploadBytes(bytes / elapsed)}/s`, "avg");
    }
    if (stats.childElementCount > 0) section.append(stats);

    if (input.info.excludes.length > 0) {
      const excludes = document.createElement("div");
      excludes.className = "content-card-tool-upload-excludes";
      const icon = createLucideIcon(ShieldCheck, { size: 12 });
      icon.classList.add("content-card-tool-upload-excludes-icon");
      excludes.append(icon);
      const ex = document.createElement("span");
      ex.textContent = `Excluded: ${input.info.excludes.join(" · ")}`;
      excludes.append(ex);
      section.append(excludes);
    }

    if (input.stats.fileLines.length > 0) {
      const list = document.createElement("div");
      list.className = "content-card-tool-upload-files";
      for (const f of input.stats.fileLines) {
        list.append(createUploadFileRow(f, true));
      }
      section.append(list);
    }
    return section;
  }

  const err = document.createElement("div");
  err.className = "content-card-tool-upload-err";
  err.append(createLucideIcon(TriangleAlert, { size: 14 }));
  const title = document.createElement("span");
  title.className = "content-card-tool-upload-err-title";
  title.textContent = input.cancelled ? "Upload stopped by user" : "Upload failed";
  err.append(title);
  section.append(err);

  if (input.stats.stderrTail.length > 0) {
    const stderr = document.createElement("pre");
    stderr.className = "content-card-tool-upload-err-stderr";
    stderr.textContent = input.stats.stderrTail.join("\n");
    section.append(stderr);
  }

  const hint = document.createElement("p");
  hint.className = "content-card-tool-upload-err-hint";
  hint.textContent =
    "Transferred files stay on the remote; a retry resumes by mtime+size and skips what already matches.";
  section.append(hint);
  return section;
}
