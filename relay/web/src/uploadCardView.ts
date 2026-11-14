/**
 * Upload card DOM — web port of the desktop uploadCardView.ts: the live
 * progress zone appended to a running upload_files card, its incremental
 * patch path, and the finished transfer section. Class names match the Mac
 * content-cards family so styles port 1:1.
 */
import { icon } from "./icons.js";
import { el } from "./render.js";
import { checkBadge } from "./checkBadge.js";
import {
  UPLOAD_FILE_LIST_CAP,
  formatUploadBytes,
  formatUploadEta,
  type UploadCardInfo,
  type UploadFinishedStats,
  type UploadLiveFile,
  type UploadLiveState,
} from "./uploadCard.js";

/** Summary-row hint: src → dest. Transfer stats live in the card body. */
export function uploadCardHint(info: UploadCardInfo): string {
  return `${info.src} → ${info.dest}`;
}

/** Build the live progress zone in its initial (or seeded) state. */
export function createUploadLiveZone(state: UploadLiveState): HTMLElement {
  const zone = el("div", { class: "content-card-tool-upload-zone" });
  zone.dataset.fileCount = "0";

  if (state.envAtRisk) {
    zone.append(
      el("div", {
        class: "content-card-tool-upload-warn",
        title: "This rsync run could delete or overwrite the remote .env. Consider adding --exclude .env.",
      },
        el("span", { class: "content-card-tool-upload-warn-icon" }, icon("warn", 12)),
        "--delete is active and .env is not excluded",
      ),
    );
  }

  const bar = el("div", { class: "content-card-tool-upload-bar" },
    el("div", { class: "content-card-tool-upload-bar-fill", "data-role": "fill" }));
  const line = el("div", { class: "content-card-tool-upload-line" },
    el("span", { class: "content-card-tool-upload-pct", "data-role": "pct" }),
    el("span", { class: "content-card-tool-upload-rest", "data-role": "rest" }),
    el("span", { class: "content-card-tool-upload-meta", "data-role": "meta" }));
  const files = el("div", { class: "content-card-tool-upload-files", "data-role": "files" });
  zone.append(bar, line, files);

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
  // Live rows show the up-arrow; the finished snapshot uses the shared green
  // check badge (same success mark as completed plan steps).
  const iconEl: HTMLElement = done
    ? checkBadge(12)
    : el("span", {}, icon("arrowUp", 11));
  iconEl.classList.add("content-card-tool-upload-file-icon");
  if (done) iconEl.classList.add("is-done");
  return el("div", { class: "content-card-tool-upload-file-row" },
    iconEl,
    el("span", { class: "content-card-tool-upload-file-name", title: file.name }, file.name),
    el("span", { class: "content-card-tool-upload-file-size" }, formatUploadBytes(file.bytes)),
  );
}

function appendUploadStat(parent: HTMLElement, value: string, label?: string): void {
  parent.append(el("div", { class: "content-card-tool-upload-stat" },
    el("b", {}, value),
    ...(label ? [el("span", {}, label)] : []),
  ));
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
  const section = el("section", {
    class: "content-card-tool-section content-card-tool-upload-section",
  });

  if (input.ok) {
    const stats = el("div", { class: "content-card-tool-upload-stats" });
    if (input.stats.files !== null) {
      appendUploadStat(stats, String(input.stats.files), input.stats.files === 1 ? "file" : "files");
    }
    if (input.stats.bytes !== null) {
      appendUploadStat(stats, formatUploadBytes(input.stats.bytes));
    }
    if (input.stats.elapsedSec !== null) {
      appendUploadStat(stats, `${input.stats.elapsedSec.toFixed(1)}s`);
    }
    if (input.stats.bytes !== null && input.stats.elapsedSec !== null && input.stats.elapsedSec > 0) {
      appendUploadStat(stats, `${formatUploadBytes(input.stats.bytes / input.stats.elapsedSec)}/s`, "avg");
    }
    if (stats.childElementCount > 0) section.append(stats);

    if (input.info.excludes.length > 0) {
      section.append(el("div", { class: "content-card-tool-upload-excludes" },
        el("span", { class: "content-card-tool-upload-excludes-icon" }, icon("shieldCheck", 12)),
        el("span", {}, `Excluded: ${input.info.excludes.join(" · ")}`),
      ));
    }

    if (input.stats.fileLines.length > 0) {
      const list = el("div", { class: "content-card-tool-upload-files" });
      for (const f of input.stats.fileLines) {
        list.append(createUploadFileRow(f, true));
      }
      section.append(list);
    }
    return section;
  }

  section.append(el("div", { class: "content-card-tool-upload-err" },
    icon("warn", 14),
    el("span", { class: "content-card-tool-upload-err-title" },
      input.cancelled ? "Upload stopped by user" : "Upload failed"),
  ));

  if (input.stats.stderrTail.length > 0) {
    section.append(el("pre", { class: "content-card-tool-upload-err-stderr" },
      input.stats.stderrTail.join("\n")));
  }

  section.append(el("p", { class: "content-card-tool-upload-err-hint" },
    "Transferred files stay on the remote; a retry resumes by mtime+size and skips what already matches."));
  return section;
}
