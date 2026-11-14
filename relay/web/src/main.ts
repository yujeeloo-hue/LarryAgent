import { demoQueueFingerprint, type DemoCardState } from "../../../src/session/demoCardState.js";
/**
 * App controller: login → shell (sidebar/topbar/views) → relay wiring.
 */
import "./style.css";
import "./token-hub.css";
import trayDogHeadUrl from "../../../resources/tray/dogHead-master-256.png?url";
import securityShieldUrl from "./assets/security-shield.svg?url";
import agentArtworkUrl from "../../../src/renderer/src/assets/setting-categories/agent.svg?url";
import settingsArtworkUrl from "../../../src/shared/icons/svg/Settings.svg?url";
import devicesArtworkUrl from "./assets/card-header/devices.svg?url";
import { createRemoteBrand } from "./remoteBrand.js";
import { connectionStatus } from "./connectionStatus.js";
import { RelayClient } from "./client.js";
import { icon } from "./icons.js";
import { cardHeaderIcon } from "./cardHeaderIcons.js";
import { installKeyboardInset } from "./keyboardInset.js";
import { installMobileBackGesture } from "./mobileBackGesture.js";
import { installStandaloneZoomLock } from "./standaloneZoom.js";
import { CocoController } from "./CocoController.js";
import { CocoView } from "./CocoView.js";
import { cocoIcon } from "./cocoIcons.js";
import { mountLoginFire } from "./loginFire.js";
import { createPlanReviewSync, type PlanReviewSync } from "./planReview.js";
import {
  buildComposerLoading,
  buildNewTaskPanel,
  ChatLiveStream,
  cocoEntryState,
  deviceCocoReady,
  el,
  isAgentdDevice,
  supportsExec,
  supportsMaintenance,
  supportsReboot,
  isMaintenanceTickOnly,
  patchMaintenanceLive,
  relTime,
  renderConversation,
  renderDevicesViewBody,
  renderManageCards,
  renderSessionList,
  renderSidebarFooter,
  statusPill,
} from "./render.js";
import type { CocoEntryState, DeviceMaintenancePanel, NewTaskWorkspaceOption } from "./render.js";
import { buildDemoScan, submitDemoConfirm } from "./demoCard.js";
import {
  maintenanceChannel,
  releaseMatchesChannel,
  type MaintenanceChannel,
} from "./maintenanceChannel.js";
import {
  applyDraftPatch,
  draftFor,
  parseMaintStore,
  withDraft,
  type MaintDraft,
  type MaintStore,
} from "./maintenanceDraft.js";
import {
  MaintenanceReleaseChecker,
  canFillMaintenanceRelease,
  type MaintenanceCheckTarget,
  type MaintenanceRelease,
} from "./maintenanceAutoCheck.js";
import { isComposerReasoningEffort } from "./types.js";
import { initTheme } from "./theme.js";
import { buildPlansByCreateToolCallId, type PlanSnapshot } from "./planCards.js";
import { RenderRelevance } from "./sessionRenderState.js";
import { sessionLoadErrorView } from "./sessionLoadError.js";
import { pickDefaultDevice, pickRecentActivityDevice, pickRecentRunningDevice } from "./defaultDevice.js";
import { pickDefaultProject as pickDefaultProjectRule, pickDefaultSession } from "./defaultProject.js";
import {
  pillFilesFromParts,
  pillStepState,
  pillTextFromParts,
} from "../../../src/renderer/src/devmode/contextPill.js";
import type {
  AuditEntry,
  ComposerOptions,
  ComposerReasoningEffort,
  ConsoleStreamEvent,
  DeviceExecResult,
  DeviceSummary,
  EnqueuePromptResponse,
  KeySummary,
  PromptLogEntry,
  PromptQueueMutationResponse,
  RemoteAttachmentDraft,
  ServerInfo,
  Session,
  SessionSummary,
  StartTurnResponse,
  StreamEvent,
} from "./types.js";
import type { PendingAskSnapshot } from "./toolCards.js";
import { isAnimatedProgressText } from "../../../src/renderer/src/screens/conversation/turnProgress.js";
import {
  isConversationCardVisible,
} from "../../../src/renderer/src/screens/conversation/turnDisplay.js";
import { unwrapToolCallBridge } from "./toolCards.js";
import { initOverlayScrollbars } from "./overlayScroll.js";
import { openSheetPanel, syncMenuScrim } from "./mobileNav.js";
import { createFilesPanel } from "./filesPanel.js";
import {
  buildComposerToolbar,
  type ComposerAttachmentItem,
  type ComposerToolbar,
} from "./composerControls.js";
import { PromptQueueView, queuedPromptToViewItem } from "./promptQueue.js";
import { resolveComposerSubmitAction } from "./promptQueueGesture.js";
import { createComposerProbeStore } from "./composerProbe.js";
import {
  buildContextGauge,
  gaugeValueFromSessionContextUsage,
  gaugeValueFromStreamEvent,
  shouldAcceptGaugeTokens,
  type ContextGauge,
  type ContextGaugeValue,
} from "./contextGauge.js";
import { TokenHubController } from "./TokenHubController.js";
import { buildDeviceProviderCard, captureTokenHubViewPosition, openAddProviderWizard, renderTokenHubView, syncTokenHubProviderOrder } from "./TokenHubView.js";
import { McpHubController } from "./McpHubController.js";
import { buildDeviceMcpCard, captureMcpHubViewPosition, openAddServerDialog, repaintDeviceMcpCard, repaintMcpHubCard, renderMcpHubView, syncMcpHubServerOrder } from "./McpHubView.js";
import { SkillHubController } from "./SkillHubController.js";
import { buildDeviceSkillCard, captureSkillHubViewPosition, openAddSkillDialog, repaintDeviceSkillCard, repaintSkillHubCard, renderSkillHubView, syncSkillHubOrder } from "./SkillHubView.js";
import "../../../src/renderer/src/styles/action-buttons.css";
import "./mobile.css";

const KEY_STORAGE = "larryRemote.sessionToken";
const app = document.getElementById("app")!;

// Font routing: Apple devices keep the native SF stacks (html.mac rules in
// style.css) and never fetch the bundled webfonts; everything else renders
// with Inter / JetBrains Mono.
document.documentElement.classList.toggle(
  "mac",
  /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent),
);

// Relay always uses Light, including visits with a legacy Dark preference.
initTheme();

/** Reuse the system tray's high-resolution dog head; Vite versions its URL. */
function brandIcon(size: number): HTMLElement {
  return el("img", {
    src: trayDogHeadUrl,
    class: "tray-brand-icon",
    alt: "",
    style: `width:${size}px;height:${size}px;display:block`,
  });
}

/** External SVG images isolate their masks from hidden/repeated page heads. */
function transportShield(): HTMLElement {
  return el("span", { class: "e2ee-badge", role: "img" },
    el("img", { class: "transport-shield", src: securityShieldUrl, alt: "", width: "14", height: "14" }),
    el("span", { class: "transport-shield-state", "aria-hidden": "true",
      style: `--shield-source:url("${securityShieldUrl}")` }),
    el("span", { class: "transport-shield-error", "aria-hidden": "true" }, icon("shieldOff", 14)));
}

function shellEntryIcon(name: "devices" | "manage", size: number): HTMLElement {
  return el("span", { class: "shell-entry-icon", "aria-hidden": "true",
    "data-shell-icon": name,
    style: `width:${size}px;height:${size}px;--shell-icon-source:url("${name === "devices" ? devicesArtworkUrl : settingsArtworkUrl}")`,
  });
}

function emptyAgentIcon(): HTMLElement {
  return el("img", { class: "empty-agent-artwork", src: agentArtworkUrl, alt: "", width: "28", height: "28" });
}

interface AppRefs {
  sidebar: HTMLElement;
  sessionCol: HTMLElement;
  newTaskView: HTMLElement;
  convView: HTMLElement;
  manageView: HTMLElement;
  memoryView: HTMLElement;
  devicesView: HTMLElement;
  cocoView: HTMLElement;
  mainEmpty: HTMLElement;
  /** Mobile push-navigation layer (≤768px): selector row, sheets, FAB. */
  layout: HTMLElement;
  mobileHead: HTMLElement;
  devSelectBtn: HTMLButtonElement;
  projSelectBtn: HTMLButtonElement;
  devDot: HTMLElement;
  devName: HTMLElement;
  projIcon: HTMLElement;
  projName: HTMLElement;
  deviceSheet: HTMLElement;
  projectSheet: HTMLElement;
  devPickerSheet: HTMLElement;
  /** CoCo device sheet — only shown when the tap can't pick a target alone. */
  cocoSheet: HTMLElement;
  /** Home selector-row CoCo tile (phones have no sidebar device row). */
  mCocoBtn: HTMLButtonElement;
  mobileFab: HTMLButtonElement;
  mRefreshBtn: HTMLButtonElement;
  /** Conversation-view nodes owned by renderConvView — queried once, not
   * re-searched from the DOM on every stream event. */
  /** Live status line inside the mobile run pill (steer zone). */
  convRunStatus: HTMLElement | null;
  /** Composer card of the mounted conversation view (running border glow). */
  convComposerCard: HTMLElement | null;
  /** Mobile run capsule of the mounted view (running zebra stripes). */
  convRunPill: HTMLElement | null;
  /** Conversation header of the mounted view (mobile live strip host). */
  convHead: HTMLElement | null;
  /** Live strip rows in the mobile header (single-line ContextPill). */
  convLive: {
    root: HTMLElement;
    promptRow: HTMLElement;
    promptText: HTMLElement;
    files: HTMLElement;
    taskRow: HTMLElement;
    dots: HTMLElement;
    step: HTMLElement;
    timer: HTMLElement;
    progRow: HTMLElement;
    progLabel: HTMLElement;
  } | null;
  /** Context usage rings on the composer buttons (null outside a session). */
  convGauge: ContextGauge | null;
  /** Composer textarea of the mounted conversation view (null elsewhere). */
  convComposer: HTMLTextAreaElement | null;
}

let client: RelayClient | null = null;
let sessionToken = "";
let devices: DeviceSummary[] = [];
let selectedDeviceId: string | null = null;

// ── Device maintenance (agentd restart/update/reboot) ────────
/** Per-device deviceStatus snapshots (Refresh button); survives re-renders. */
const maintStatus = new Map<string, DeviceMaintenancePanelStatus>();
/**
 * Update draft, mirrored to localStorage so it survives reloads.
 *
 * `source` / `sha256` / `version` are kept PER RELEASE CHANNEL (see
 * maintenanceDraft.ts): the manifest's mac / win / agentd entries move
 * independently, so one shared draft carried a fetched package and version
 * from one platform into another platform's Maintenance card. The manifest URL
 * is platform-independent and stays global.
 */
const MAINT_FORM_KEY = "jbMaintForm";

let maintStore: MaintStore = parseMaintStore(readMaintStorage());
const maintEditedChannels = new Set<MaintenanceChannel>();
const maintReleaseChecker = new MaintenanceReleaseChecker((target) =>
  client!.request<MaintenanceRelease | null>(target.deviceId, "checkUpdate", { manifestUrl: target.manifestUrl }),
);
let maintAutoCheckTimer: number | null = null;
/** Ack-pending maintenance action, disables the buttons until it settles. */
let maintPending: string | null = null;
/** Raw-log <details> open state — progress pushes re-render every ~2s, so
 *  the toggle must live here to survive them. */
let maintLogOpen = false;
const maintOpenSections = new Map<string, NonNullable<DeviceMaintenancePanel["openSections"]>>();
/** Run-command draft (in-memory only — commands can carry secrets). */
let execCommand = "";
/** Latest deviceExec outcome per device; survives re-renders, not reloads. */
const execLast = new Map<string, DeviceExecResult & { command: string; ts: number }>();

type DeviceMaintenancePanelStatus = NonNullable<
  Parameters<typeof renderDevicesViewBody>[0]["maintenance"]
>["status"];

function readMaintStorage(): string | null {
  try {
    return localStorage.getItem(MAINT_FORM_KEY);
  } catch {
    return null; // private mode
  }
}

function saveMaintStore(): void {
  try {
    localStorage.setItem(MAINT_FORM_KEY, JSON.stringify(maintStore));
  } catch {
    /* private mode — keep the in-memory draft */
  }
}

/** Draft for the device's channel — never shared across platforms. */
function maintDraftFor(channel: MaintenanceChannel | null): MaintDraft {
  return draftFor(maintStore, channel);
}

// Remote Files pane (desktop Detail → Files mirror): conversation file list
// + read-only text previews. Deps are lazy closures over the module-level
// client/selectedDeviceId lets, so construction never races login.
const filesPanel = createFilesPanel({
  loadSession: (sessionId) =>
    client && selectedDeviceId
      ? client.request<unknown>(selectedDeviceId, "getSession", { sessionId })
      : Promise.reject(new Error("Not connected")),
  deviceRequest: (action, payload) =>
    client && selectedDeviceId
      ? client.request<never>(selectedDeviceId, action, payload)
      : Promise.reject(new Error("Not connected")),
});
let sessions: SessionSummary[] = [];
let currentSession: Session | null = null;
let live: ChatLiveStream | null = null;
/** Live pending ask for the open session (mirrors session.pendingUserAsk). */
let livePendingAsk: PendingAskSnapshot | null = null;
/**
 * Latest context-usage reading for the open session (provider-only; null =
 * no reading yet → gauge hidden). Survives view rebuilds so a snapshot
 * reload never flickers the gauge away mid-turn.
 */
let liveContextUsage: ContextGaugeValue | null = null;
/** Tools whose cards the desktop Tools screen hides (per device snapshot). */
/**
 * Render-relevance fingerprint of the snapshot behind the CURRENT conv view
 * DOM (null = view is fresh/absent → next loadSession always rebuilds).
 * Unchanged snapshots skip the rebuild so idle resync bursts never bounce
 * the scroll (sessionRenderState.ts owns the field checklist).
 */
const convRenderRelevance = new RenderRelevance();
let viewMode: "home" | "newTask" | "conv" | "manage" | "memory" | "devices" | "coco" = "home";

/** Single setter for viewMode: keeps the layout's standalone flag in sync.
   Devices / Manage are full-screen pages — the left chrome (device
   registry sidebar + session column) is hidden while they are up. */
function setViewMode(mode: typeof viewMode): void {
  viewMode = mode;
  if (maintAutoCheckTimer !== null) {
    window.clearInterval(maintAutoCheckTimer);
    maintAutoCheckTimer = null;
  }
  if (mode === "devices") {
    maintAutoCheckTimer = window.setInterval(maybeAutoCheckMaintenance, 60_000);
  }
  refs.layout?.classList.toggle("is-standalone", mode === "manage" || mode === "devices" || mode === "coco");
  // Leaving the CoCo view stops its poll loop and clears the view root —
  // single choke point so every other view switch stays one-liners.
  if (mode !== "coco" && refs.cocoView && !refs.cocoView.hidden) {
    refs.cocoView.hidden = true;
    teardownCoco();
  }
}
const tokenHubController = new TokenHubController({
  apiBase,
  sessionToken: () => sessionToken,
});
tokenHubController.subscribe((change) => {
  if (viewMode === "manage" && refs.manageView) {
    if (change === "provider-order") syncTokenHubProviderOrder(refs.manageView, tokenHubController);
    else renderManageBody();
  }
  if (viewMode === "devices" && refs.devicesView) renderDevicesView();
});
const mcpHubController = new McpHubController({
  apiBase,
  sessionToken: () => sessionToken,
});
mcpHubController.subscribe((change) => {
  if (viewMode === "manage" && refs.manageView) {
    if (change === "server-order") syncMcpHubServerOrder(refs.manageView, mcpHubController);
    // Snapshot edits repaint ONLY the MCP Hub card in place — a full
    // renderManageBody() recreates .manage-body (the page scroller) and
    // yanked the page to the top on every edit (user report). Card not
    // mounted (mid-render race) → fall back to the full render.
    else if (!repaintMcpHubCard(refs.manageView, buildMcpHubCard)) renderManageBody();
  }
  if (viewMode === "devices" && refs.devicesView) {
    // Same rule for the selected device's MCP card: .dev-detail (the
    // scroller) and sibling cards keep their DOM and scroll. No device
    // selected → nothing MCP-related to repaint.
    const device = devices.find((d) => d.deviceId === devicesSelectedId);
    if (device && !repaintDeviceMcpCard(refs.devicesView, () =>
      buildDeviceMcpCard(device.deviceId, device.name, device.online, mcpHubController),
    )) {
      renderDevicesView();
    }
  }
});
const skillHubController = new SkillHubController({
  apiBase,
  sessionToken: () => sessionToken,
});
skillHubController.subscribe((change) => {
  if (viewMode === "manage" && refs.manageView) {
    if (change === "skill-order") syncSkillHubOrder(refs.manageView, skillHubController);
    // Snapshot edits repaint ONLY the Skill Hub card in place (same rule as
    // the MCP Hub card): .manage-body keeps its DOM and scroll position.
    else if (!repaintSkillHubCard(refs.manageView, buildSkillHubCard)) renderManageBody();
  }
  if (viewMode === "devices" && refs.devicesView) {
    const device = devices.find((d) => d.deviceId === devicesSelectedId);
    if (device && !repaintDeviceSkillCard(refs.devicesView, () =>
      buildDeviceSkillCard(device.deviceId, device.name, device.online, skillHubController),
    )) {
      renderDevicesView();
    }
  }
});
let serverInfo: ServerInfo | null = null;
let auditEntries: AuditEntry[] = [];
/** Remote prompt log (full text) — feeds the Manage card + Devices view stats. */
let promptEntries: PromptLogEntry[] = [];
/** Device whose detail panel is open in the Devices view. */
let devicesSelectedId: string | null = null;
let keys: KeySummary[] = [];
let currentKeyId: string | null = null;
let currentKeyName = "";

/** Memory-sync overview (GET /api/console/memory/overview; M4a view). */
type MemoryOverview = {
  version: string;
  sqlite: boolean;
  reason: string | null;
  seq: number;
  historyRows: number;
  docEntries: { worklog: number; pitfalls: number; style: number };
  tombstones: number;
  dbSizeBytes: number;
  devices: Array<{ deviceId: string; keyId: string | null; lastPushAt: number | null; lastPullSeq: number | null; lastSeenAt: number | null; ip: string | null }>;
  projects: Array<{ projectKey: string; counts: { worklog: number; pitfalls: number; style: number } }>;
};
let memoryOverview: MemoryOverview | null = null;
let freshKey: { name: string; key: string } | null = null;
/** Devices expanded in the sidebar (projects visible). */
const expandedDevices = new Set<string>();
/** deviceId → project display names seen in that device's sessions. */
const deviceProjects = new Map<string, string[]>();
/** deviceId → workspaceId → display name (project sidebar labels). */
const deviceWorkspaceNames = new Map<string, Map<string, string>>();
/** deviceId → full project options (device listWorkspaces; empty when unsupported). */
const deviceWorkspaces = new Map<string, NewTaskWorkspaceOption[]>();
/** Active workspace filter in the session column (null = all projects).
 *  Workspace-id keyed (not name-keyed — two projects may share a name);
 *  unified with the New Task picker selection (one "current project"). */
let projectFilter: string | null = null;
/**
 * Auto-pick pending: a fresh device selection must not reveal the unfiltered
 * list — the next refresh locks the filter onto the executing project. Cleared
 * once applied or when the user picks a project themselves.
 */
let projectFilterAuto = true;
/** New Task prefs persisted per device: last picked project + draft text. */
const NT_WS_KEY = "larryRemote.newTaskWs";
const NT_DRAFT_KEY = "larryRemote.newTaskDrafts";
/** Composer toggles persisted per device (Mac parity: process-level prefs). */
const NT_PREFS_KEY = "larryRemote.composerPrefs";
/** Single remote upload cap — mirrors the device-side guard (8 MB). */
const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

// DOM refs (built once after login)
const refs = {} as AppRefs;

// ── login ────────────────────────────────────────────────────
let stopLoginFire: (() => void) | null = null;
let stopRemoteBrand: (() => void) | null = null;
function apiBase(): string {
  return import.meta.env.BASE_URL as string;
}

interface LoginReply {
  ok?: boolean;
  token?: string;
  username?: string;
  error?: string;
  retryAfterSeconds?: number;
}

async function postLogin(body: {
  username: string;
  password: string;
  captchaId?: string;
  captchaAnswer?: string;
}): Promise<LoginReply> {
  try {
    const res = await fetch(`${apiBase()}api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json().catch(() => ({}))) as LoginReply;
  } catch {
    return { error: "network" };
  }
}

function loginErrorText(reply: LoginReply): string {
  switch (reply.error) {
    case "invalid_credentials": return "Wrong username or password.";
    case "invalid_captcha": return "Captcha didn’t match — try the new one.";
    case "too_many_attempts":
      return `Too many attempts — wait ${Math.ceil((reply.retryAfterSeconds ?? 60) / 60)} min and try again.`;
    case "network": return "Cannot reach the relay server — try again.";
    default: return "Sign-in failed — try again.";
  }
}

function renderLogin(errorText: string): void {
  stopRemoteBrand?.();
  stopRemoteBrand = null;
  stopLoginFire?.();
  app.replaceChildren();
  const userInput = el("input", { id: "login-username", type: "text", placeholder: "username", autocomplete: "username" }) as HTMLInputElement;
  const passInput = el("input", { id: "login-password", type: "password", placeholder: "password", autocomplete: "current-password" }) as HTMLInputElement;
  const captchaInput = el("input", { id: "login-captcha", type: "text", placeholder: "Code", autocomplete: "off", autocapitalize: "none", maxlength: "8", spellcheck: "false", "aria-describedby": "login-captcha-hint" }) as HTMLInputElement;
  const err = el("div", { class: "login-error", "aria-live": "polite" }, errorText);
  const btn = el("button", { class: "login-btn action-primary" }, "Sign in") as HTMLButtonElement;

  // Captcha challenge: fetched on load — every login attempt must clear it.
  let captchaId = "";
  const captchaBox = el("div", { class: "login-field login-captcha", hidden: true },
    el("div", { class: "login-field-head" },
      el("label", { for: "login-captcha" }, "Captcha"),
      el("span", { id: "login-captcha-hint", class: "login-captcha-hint" }, "Click image to refresh"),
    ),
    el("div", { class: "login-captcha-row" },
      captchaInput,
      el("button", { class: "login-captcha-img", type: "button", title: "Refresh captcha", "aria-label": "Refresh captcha" }),
    ),
  ) as HTMLElement;
  const imgSlot = captchaBox.querySelector(".login-captcha-img") as HTMLElement;
  const refreshCaptcha = async () => {
    try {
      const res = await fetch(`${apiBase()}api/auth/captcha`);
      const data = (await res.json()) as { id?: string; svg?: string };
      if (data.id && data.svg) {
        captchaId = data.id;
        imgSlot.innerHTML = data.svg;
        captchaBox.hidden = false;
        captchaInput.value = "";
      }
    } catch { /* offline — plain retry */ }
  };
  imgSlot.addEventListener("click", () => void refreshCaptcha());
  void refreshCaptcha();

  const go = async () => {
    const username = userInput.value.trim();
    const password = passInput.value;
    if (!username || !password) return;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    err.textContent = "";
    const reply = await postLogin({
      username,
      password,
      ...(captchaId ? { captchaId, captchaAnswer: captchaInput.value.trim() } : {}),
    });
    if (reply.ok && reply.token) {
      localStorage.setItem(KEY_STORAGE, reply.token);
      sessionToken = reply.token;
      currentKeyName = reply.username ?? username;
      buildShell();
      return;
    }
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    err.textContent = loginErrorText(reply);
    // Every attempt burns the challenge — always have a fresh one.
    await refreshCaptcha();
  };
  btn.addEventListener("click", () => void go());
  for (const input of [userInput, passInput, captchaInput]) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !(e as KeyboardEvent).isComposing) void go();
    });
  }

  const card = el("div", { class: "login-card" },
    el("div", { class: "login-brand" }, brandIcon(18), el("b", {}, "Larry Agent · Remote")),
    el("p", { class: "login-sub" }, "Sign in with your console account to view and control your devices."),
    el("div", { class: "login-fields" },
      el("div", { class: "login-field" }, el("label", { for: "login-username" }, "Username"), userInput),
      el("div", { class: "login-field" }, el("label", { for: "login-password" }, "Password"), passInput),
      captchaBox,
    ),
    err,
    btn,
  );
  const fireCanvas = el("canvas", { class: "login-fire-canvas" }) as HTMLCanvasElement;
  app.append(el("div", { class: "login-wrap" },
    el("div", { class: "login-fire", "aria-hidden": "true" }, fireCanvas),
    card,
  ));
  stopLoginFire = mountLoginFire(fireCanvas);
  userInput.focus();
}

function tryConnect(token: string, onOk: () => void, onFail: (why: string) => void): Promise<void> {
  return new Promise((resolveP) => {
    let settled = false;
    const probe = new RelayClient({
      onDevices: () => {
        if (settled) return;
        settled = true;
        probe.disconnect();
        onOk();
        resolveP();
      },
      onEvent: () => {},
      onConnectionChange: (state) => {
        if (state === "offline" && !settled) {
          settled = true;
          onFail("Session expired — sign in again.");
          resolveP();
        }
      },
      onResubscribed: () => {},
    });
    // 6s budget for the first devices push.
    window.setTimeout(() => {
      if (!settled) {
        settled = true;
        probe.disconnect();
        onFail("Session expired — sign in again.");
        resolveP();
      }
    }, 6000);
    probe.connect(token);
  });
}

// ── shell ────────────────────────────────────────────────────
type ConnBadge = { wrap: HTMLElement; shield: HTMLElement; status?: HTMLElement; count?: HTMLElement };

/**
 * Last known connection / E2EE state — the page heads of standalone views
 * (Devices / Manage / CoCo) hide the app topbar, so they render their own
 * shared connection status and shield. One state, N badges: the topbar keeps its
 * own copy, the heads read this snapshot on mount and are re-applied here on
 * every change.
 */
const connState = {
  socket: "connecting" as "online" | "connecting" | "offline",
  e2ee: "" as "" | "on" | "err",
  e2eeTitle: "",
};
const connBadges = new Set<ConnBadge>();

function applyConnBadge(badge: ConnBadge): void {
  const state = connectionStatus(connState, devices.filter(device => device.online).length);
  badge.shield.className = `e2ee-badge ${state.shield}`;
  badge.shield.title = state.title;
  badge.shield.setAttribute("aria-label", state.title);
  if (badge.status) badge.status.textContent = state.status;
  if (badge.count) badge.count.textContent = state.count;
}

function syncConnBadges(): void {
  for (const badge of connBadges) applyConnBadge(badge);
}

/** Compact connection badge for a page head that replaces the hidden topbar. */
function headConnBadge(details = false, className = "head-conn"): HTMLElement {
  // Views rebuild their heads; drop the badges whose host got replaced so the
  // registry can't grow across re-renders.
  for (const old of [...connBadges]) if (!old.wrap.isConnected) connBadges.delete(old);
  const shield = transportShield();
  const status = details ? el("span", { class: "conn-status" }) : undefined;
  const count = details ? el("span", { class: "conn-count" }) : undefined;
  const copy = details ? el("span", { class: "conn-copy" }, status, count) : null;
  const wrap = el("span", { class: className }, copy, shield);
  const badge: ConnBadge = { wrap, shield, status, count };
  connBadges.add(badge);
  applyConnBadge(badge);
  return wrap;
}

function buildShell() {
  connBadges.clear();
  stopRemoteBrand?.();
  const remoteBrand = createRemoteBrand();
  stopRemoteBrand = remoteBrand.destroy;
  stopLoginFire?.();
  stopLoginFire = null;
  app.replaceChildren();
  const topbar = el("div", { class: "topbar" },
    el("div", { class: "topbar-brand" }, brandIcon(18), "Larry Agent", remoteBrand.root),
    headConnBadge(true, "topbar-meta"),
    // Mobile-only entries (desktop keeps them in the sidebar footer).
    el("div", { class: "topbar-actions" },
      el("button", {
        class: "topbar-gear",
        type: "button",
        title: "Devices",
        "aria-label": "Devices",
        onclick: () => void showDevices(),
      }, shellEntryIcon("devices", 16)),
      el("button", {
        class: "topbar-gear",
        type: "button",
        title: "Manage",
        "aria-label": "Manage",
        onclick: () => void showManage(),
      }, shellEntryIcon("manage", 16)),
    ),
  );

  const sidebar = el("nav", { class: "sidebar" });
  const sessionCol = el("aside", { class: "session-col", id: "sessionCol" });
  const main = el("main", { class: "main" });

  // ── mobile home layer (≤768px; CSS hides everything on desktop) ──
  const devDot = el("span", { class: "dev-dot" });
  const devName = el("span", { class: "m-select-value" }, "—");
  const devSelectBtn = el("button", {
    class: "m-select-btn", type: "button",
    "aria-haspopup": "listbox", "aria-expanded": "false",
    title: "Device",
  }, devDot, devName, el("span", { class: "m-select-chevron" }, icon("chevronDown", 13))) as HTMLButtonElement;
  const projIcon = el("span", { class: "m-select-icon" }, icon("folderOpen", 14));
  const projName = el("span", { class: "m-select-value" }, "All Projects");
  const projSelectBtn = el("button", {
    class: "m-select-btn", type: "button",
    "aria-haspopup": "listbox", "aria-expanded": "false",
    title: "Project filter",
  }, projIcon, projName, el("span", { class: "m-select-chevron" }, icon("chevronDown", 13))) as HTMLButtonElement;

  const mobileFab = el("button", {
    class: "mobile-fab action-primary", type: "button",
    title: "New task", "aria-label": "New task",
  }, icon("plus", 22)) as HTMLButtonElement;
  mobileFab.addEventListener("click", () => showNewTask());

  // Explicit session refresh (desktop keeps it on the sidebar device row).
  const mRefreshBtn = el("button", {
    class: "m-refresh-btn", type: "button",
    title: "Refresh sessions", "aria-label": "Refresh sessions",
  }, icon("refresh", 15)) as HTMLButtonElement;
  mRefreshBtn.addEventListener("click", () => {
    if (selectedDeviceId) void refreshDeviceNow(selectedDeviceId);
  });
  // CoCo entry: phones have no sidebar device row, so the workspace sits one
  // tap away from the session list instead of three (Devices → device → CoCo).
  // Visibility/target come from cocoEntryState (render.ts) — one gate shared
  // with the desktop row and the Devices card button.
  const mCocoBtn = el("button", {
    class: "m-coco-btn", type: "button",
    title: "Open CoCo", "aria-label": "Open CoCo", hidden: true,
  },
    el("span", { class: "m-coco-mark" }, cocoIcon("logo")),
    el("span", { class: "m-coco-busy", hidden: true }),
  ) as HTMLButtonElement;
  mCocoBtn.addEventListener("click", () => openCocoEntry());
  const mobileHead = el("div", { class: "mobile-home-head" }, devSelectBtn, projSelectBtn, mCocoBtn, mRefreshBtn);

  const deviceSheet = el("div", { class: "sheet" },
    el("div", { class: "sheet-handle", "aria-hidden": "true" }),
    el("div", { class: "sheet-title" }, "Device"),
    el("div", { class: "sheet-body", role: "listbox", "aria-label": "Devices" }));
  const projectSheet = el("div", { class: "sheet" },
    el("div", { class: "sheet-handle", "aria-hidden": "true" }),
    el("div", { class: "sheet-title" }, "Project"),
    el("div", { class: "sheet-body", role: "listbox", "aria-label": "Projects" }));
  // Devices view detail picker (mobile) — separate from the home device
  // sheet: this one picks which registry entry to inspect, not the
  // session-active device.
  const devPickerSheet = el("div", { class: "sheet" },
    el("div", { class: "sheet-handle", "aria-hidden": "true" }),
    el("div", { class: "sheet-title" }, "Device"),
    el("div", { class: "sheet-body", role: "listbox", "aria-label": "Pick a device" }));
  // CoCo device sheet (mobile) — only reachable when the home tile can't
  // resolve a target by itself: several CoCo-capable devices and the selected
  // one is not among them.
  const cocoSheet = el("div", { class: "sheet" },
    el("div", { class: "sheet-handle", "aria-hidden": "true" }),
    el("div", { class: "sheet-title" }, "CoCo"),
    el("div", { class: "sheet-body", role: "listbox", "aria-label": "CoCo devices" }));

  // Right column views (session column is persistent in the middle).
  const mainEmpty = el("section", { class: "view view-empty", id: "mainEmpty" });
  const newTaskView = el("section", { class: "view", id: "newTaskView", hidden: true });
  const convView = el("section", { class: "view", id: "convView", hidden: true });
  const manageView = el("section", { class: "view", id: "manageView", hidden: true });
  const memoryView = el("section", { class: "view", id: "memoryView", hidden: true });
  const devicesView = el("section", { class: "view", id: "devicesView", hidden: true });
  const cocoView = el("section", { class: "view", id: "cocoView", hidden: true });
  main.append(mainEmpty, newTaskView, convView, manageView, memoryView, devicesView, cocoView);

  const layout = el("div", { class: "layout" }, sidebar, mobileHead, sessionCol, main, mobileFab);

  refs.sidebar = sidebar;
  refs.sessionCol = sessionCol;
  refs.newTaskView = newTaskView;
  refs.convView = convView;
  refs.manageView = manageView;
  refs.memoryView = memoryView;
  refs.devicesView = devicesView;
  refs.cocoView = cocoView;
  refs.mainEmpty = mainEmpty;
  refs.layout = layout;
  refs.mobileHead = mobileHead;
  refs.devSelectBtn = devSelectBtn;
  refs.projSelectBtn = projSelectBtn;
  refs.devDot = devDot;
  refs.devName = devName;
  refs.projIcon = projIcon;
  refs.projName = projName;
  refs.deviceSheet = deviceSheet;
  refs.projectSheet = projectSheet;
  refs.devPickerSheet = devPickerSheet;
  refs.cocoSheet = cocoSheet;
  refs.mCocoBtn = mCocoBtn;
  refs.mobileFab = mobileFab;
  refs.mRefreshBtn = mRefreshBtn;

  app.append(el("div", { class: "app" }, topbar, layout), deviceSheet, projectSheet, devPickerSheet, cocoSheet, filesPanel.root);

  devSelectBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (devSelectBtn.disabled) return;
    openSheetPanel(deviceSheet, devSelectBtn);
  });
  projSelectBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (projSelectBtn.disabled) return;
    openSheetPanel(projectSheet, projSelectBtn);
  });

  client = new RelayClient({
    onDevices: (list) => {
      const prevSelected = selectedDeviceId ? devices.find((d) => d.deviceId === selectedDeviceId) : undefined;
      const previousInspected = devices.find((d) => d.deviceId === devicesSelectedId);
      const prevDevices = devices;
      devices = list;
      for (const device of list) {
        tokenHubController.setDeviceOnline(device.deviceId, device.online);
        mcpHubController.setDeviceOnline(device.deviceId, device.online);
        skillHubController.setDeviceOnline(device.deviceId, device.online);
      }
      if (viewMode === "devices" && !list.some((d) => d.deviceId === devicesSelectedId)) {
        devicesSelectedId = list[0]?.deviceId ?? null;
      }
      renderSidebar();
      renderSessionColumn();
      if (viewMode === "manage") renderManageBody();
      if (viewMode === "devices") {
        // Progress ticks (~2s cadence during an update) must not rebuild the
        // whole view: replaceChildren recreated the scrolling .dev-detail and
        // yanked scroll back to the top on every push. When the broadcast
        // differs only by volatile maintenance fields, patch the maintenance
        // card's chip + live zone in place — DOM identity, scroll, and focus
        // survive. Any structural change still takes the full re-render.
        const tickOnly =
          devicesSelectedId === (previousInspected?.deviceId ?? null) &&
          isMaintenanceTickOnly(prevDevices, list);
        if (
          !tickOnly ||
          !patchMaintenanceLive(
            refs.devicesView,
            list.find((d) => d.deviceId === devicesSelectedId)?.maintenance ?? null,
            buildMaintenancePanel(devices.find((d) => d.deviceId === devicesSelectedId) ?? null),
          )
        ) {
          renderDevicesView();
        }
        const inspected = list.find((d) => d.deviceId === devicesSelectedId);
        if (inspected?.online && (inspected.deviceId !== previousInspected?.deviceId || !previousInspected?.online)) {
          void refreshSelectedDeviceProviders();
        }
        maybeAutoCheckMaintenance();
      }
      if (viewMode === "newTask") renderNewTaskView();
      if (selectedDeviceId && !list.some((d) => d.deviceId === selectedDeviceId)) {
        selectedDeviceId = null;
        sessions = [];
        projectFilter = null;
        goHome();
      } else if (selectedDeviceId) {
        // Selected device came back online — its session list is stale
        // (or was never pulled while it was offline). Re-fetch so the
        // column doesn't sit on an empty/offline note forever.
        const now = list.find((d) => d.deviceId === selectedDeviceId);
        if (now?.online && !prevSelected?.online) void refreshSessions();
      } else if (viewMode === "home") {
        // Nothing selected yet — auto-pick so the home list isn't stuck on
        // "pick a device": a device with a running session wins (that's
        // almost always why the console was opened); else the first online.
        // Desktop and mobile share the rule (mobile used to be first-online
        // only, desktop never auto-picked at all). The sync pick is list
        // order, so refine it once the candidates' session lists are in —
        // most recently running session while anyone is busy, most recent
        // activity when everyone is idle (see refineAutoPick).
        const pick = pickDefaultDevice(list);
        if (pick) {
          selectDevice(pick.deviceId);
          void refineAutoPick(list, pick.deviceId);
        }
      }
      syncConnBadges();
    },
    onEvent: (env) => {
      // Device-level signal (no session) — never reaches handleStreamEvent.
      if (env.event.type === "providers_changed") {
        void onDeviceProvidersChanged(env.deviceId);
        return;
      }
      handleStreamEvent(env.sessionId, env.event);
    },
    onConnectionChange: (state) => {
      connState.socket = state;
      syncConnBadges();
    },
    onResubscribed: () => {
      void refreshSessions();
      void loadSession(currentSession?.id ?? null, currentSession ? readConvScrollState() ?? undefined : undefined);
    },
    onE2EEState: (state, detail) => {
      if (state === "active") {
        connState.e2ee = "on";
        connState.e2eeTitle = "Stream encrypted (E2EE v1)";
      } else if (state === "error") {
        connState.e2ee = "err";
        connState.e2eeTitle = detail || "Stream encryption error";
      } else {
        connState.e2ee = "";
        connState.e2eeTitle = "";
      }
      syncConnBadges();
    },
    onAuthOk: (info) => {
      currentKeyId = info.keyId || null;
      currentKeyName = info.keyName;
      renderSidebar();
    },
    onKeys: (list) => {
      keys = list;
      if (viewMode === "manage") renderManageBody();
    },
  });
  client.connect(sessionToken);

  renderSidebar();
  renderSessionColumn();
  goHome();
}

// ── mobile navigation (≤768px) ───────────────────────────────
/** Mobile breakpoint probe — matchMedia-less hosts (tests) report desktop. */
const mobileMedia = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(max-width: 768px)")
  : null;
function isMobileViewport(): boolean {
  return mobileMedia?.matches === true;
}

/** Mirror viewMode onto the layout so CSS can push/pop the main pane. */
function syncMobileView(): void {
  refs.layout?.setAttribute("data-view", viewMode);
}

/** Dismiss both selector sheets + their scrim (device/project pickers). */
function closeMobileSheets(): void {
  refs.deviceSheet?.classList.remove("is-open");
  refs.projectSheet?.classList.remove("is-open");
  refs.devPickerSheet?.classList.remove("is-open");
  refs.cocoSheet?.classList.remove("is-open");
  refs.devSelectBtn?.classList.remove("is-open");
  refs.projSelectBtn?.classList.remove("is-open");
  refs.mCocoBtn?.classList.remove("is-open");
  refs.devicesView?.querySelector(".dev-picker")?.classList.remove("is-open");
  refs.devSelectBtn?.setAttribute("aria-expanded", "false");
  refs.projSelectBtn?.setAttribute("aria-expanded", "false");
  refs.mCocoBtn?.setAttribute("aria-expanded", "false");
  refs.devicesView?.querySelector(".dev-picker")?.setAttribute("aria-expanded", "false");
  syncMenuScrim(false);
}

/**
 * Open CoCo from the home selector row. Bound to the device the selector
 * shows: one tap when that device can host CoCo, otherwise the CoCo device
 * sheet asks — never a silent jump to some other device.
 */
function openCocoEntry(): void {
  const entry = cocoEntryState(devices, selectedDeviceId ?? devices[0]?.deviceId ?? null);
  if (!entry.visible) return;
  if (entry.direct) {
    void showCoco(entry.direct);
    return;
  }
  buildCocoSheet(entry);
  openSheetPanel(refs.cocoSheet, refs.mCocoBtn);
}

/** English hint line for the CoCo sheet — names why the tap had to ask. */
function cocoSheetHint(entry: CocoEntryState): string {
  const current = devices.find((d) => d.deviceId === (selectedDeviceId ?? devices[0]?.deviceId));
  const name = current?.name ?? "This device";
  if (entry.blocked === "offline") return `${name} is offline — CoCo runs on a connected device.`;
  if (entry.blocked === "unsupported") return `${name} does not support CoCo yet.`;
  return "Pick the device to open CoCo on.";
}

/** CoCo sheet body — the entry candidates, each one tap into its workspace. */
function buildCocoSheet(entry: CocoEntryState): void {
  const list = refs.cocoSheet?.querySelector(".sheet-body");
  if (!list) return;
  list.replaceChildren(el("p", { class: "sheet-hint" }, cocoSheetHint(entry)));
  for (const d of entry.devices) {
    const busy = (d.runningSessions ?? 0) > 0;
    list.append(el("button", {
      class: `sheet-item${d.deviceId === selectedDeviceId ? " is-selected" : ""}`,
      type: "button", role: "option",
      "aria-selected": d.deviceId === selectedDeviceId ? "true" : "false",
      onclick: () => {
        closeMobileSheets();
        void showCoco(d.deviceId);
      },
    },
      el("span", { class: "sheet-item-leading" }, el("span", { class: "sheet-coco-mark" }, cocoIcon("logo"))),
      el("span", { class: "sheet-item-labels" },
        el("span", {}, d.name),
        el("span", { class: "sheet-item-sub" },
          busy ? `${d.runningSessions} session${d.runningSessions === 1 ? "" : "s"} running` : "idle")),
    ));
  }
  if (!entry.devices.length) list.append(el("p", { class: "empty-note" }, "No CoCo devices online."));
}

/** Device picker sheet — same key grouping as the desktop sidebar. */
function buildDeviceSheet(): void {
  const list = refs.deviceSheet?.querySelector(".sheet-body");
  if (!list) return;
  list.replaceChildren();
  const groups = new Map<string, DeviceSummary[]>();
  for (const d of devices) {
    const g = d.keyName ?? "—";
    const bucket = groups.get(g);
    if (bucket) bucket.push(d);
    else groups.set(g, [d]);
  }
  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [groupName, devs] of sorted) {
    list.append(el("div", { class: "sheet-group-label" }, `${groupName} · ${devs.length}`));
    for (const d of devs) {
      const busy = d.online && (d.runningSessions ?? 0) > 0;
      const sub = d.online
        ? (busy ? `${d.runningSessions} session${d.runningSessions === 1 ? "" : "s"} running` : "idle")
        : "offline";
      list.append(el("button", {
        class: `sheet-item${d.deviceId === selectedDeviceId ? " is-selected" : ""}`,
        type: "button", role: "option",
        "aria-selected": d.deviceId === selectedDeviceId ? "true" : "false",
        // Same device → selectDevice's mobile branch refreshes it in place.
        onclick: () => {
          closeMobileSheets();
          selectDevice(d.deviceId);
        },
      },
        el("span", { class: "sheet-item-leading" },
          el("span", { class: `dev-dot${d.online ? " online" : ""}${busy ? " busy" : ""}` })),
        el("span", { class: "sheet-item-labels" },
          el("span", {}, d.name),
          el("span", { class: "sheet-item-sub" }, sub)),
        el("span", { class: "sheet-item-check" }, icon("check", 15)),
      ));
    }
  }
  if (!devices.length) list.append(el("p", { class: "empty-note" }, "No devices registered yet."));
}

/** Devices-view picker sheet — chooses which registry entry to inspect. */
function buildDevPickerSheet(): void {
  const list = refs.devPickerSheet?.querySelector(".sheet-body");
  if (!list) return;
  list.replaceChildren();
  for (const d of devices) {
    const busy = d.online && (d.runningSessions ?? 0) > 0;
    const sub = d.online
      ? (busy ? `${d.runningSessions} session${d.runningSessions === 1 ? "" : "s"} running` : "idle")
      : "offline";
    list.append(el("button", {
      class: `sheet-item${d.deviceId === devicesSelectedId ? " is-selected" : ""}`,
      type: "button", role: "option",
      "aria-selected": d.deviceId === devicesSelectedId ? "true" : "false",
      onclick: () => {
        closeMobileSheets();
        devicesSelectedId = d.deviceId;
        renderDevicesView();
        void refreshSelectedDeviceProviders();
      },
    },
      el("span", { class: "sheet-item-leading" },
        el("span", { class: `dev-dot${d.online ? " online" : ""}${busy ? " busy" : ""}` })),
      el("span", { class: "sheet-item-labels" },
        el("span", {}, d.name),
        el("span", { class: "sheet-item-sub" }, `${d.platform} · ${d.keyName ?? "—"} · ${sub}`)),
      el("span", { class: "sheet-item-check" }, icon("check", 15)),
    ));
  }
  if (!devices.length) list.append(el("p", { class: "empty-note" }, "No devices registered yet."));
}

/** Project filter sheet — All + the selected device's project aggregate. */
function buildProjectSheet(): void {
  const list = refs.projectSheet?.querySelector(".sheet-body");
  if (!list) return;
  list.replaceChildren();
  const device = devices.find((d) => d.deviceId === selectedDeviceId);
  if (!device) {
    list.append(el("p", { class: "empty-note" }, "Pick a device first."));
    return;
  }
  const projects = deviceProjects.get(selectedDeviceId!) ?? [];
  const mk = (label: string, value: string | null, iconName: string) => el("button", {
    class: `sheet-item${(projectFilter ?? null) === value ? " is-selected" : ""}`,
    type: "button", role: "option",
    "aria-selected": (projectFilter ?? null) === value ? "true" : "false",
    onclick: () => {
      closeMobileSheets();
      applyCurrentProject(selectedDeviceId!, value);
    },
  },
    el("span", { class: "sheet-item-leading" }, icon(iconName, 16)),
    el("span", { class: "sheet-item-labels" }, el("span", {}, label)),
    el("span", { class: "sheet-item-check" }, icon("check", 15)),
  );
  list.append(mk("All Projects", null, "folderOpen"));
  for (const p of projects) list.append(mk(projectName(selectedDeviceId!, p), p, "folder"));
}

/** Refresh the mobile home chrome: selector pills, FAB state, sheet bodies. */
function renderMobileHome(): void {
  if (!refs.mobileHead) return; // shell not built (login screen)
  const device = devices.find((d) => d.deviceId === selectedDeviceId) ?? devices[0] ?? null;
  const busy = device && device.online && (device.runningSessions ?? 0) > 0;
  refs.devDot.className = `dev-dot${device?.online ? " online" : ""}${busy ? " busy" : ""}`;
  refs.devName.textContent = device ? device.name : "No device";
  refs.projName.textContent = projectFilter && selectedDeviceId
    ? projectName(selectedDeviceId, projectFilter)
    : "All Projects";
  refs.projIcon.innerHTML = icon(projectFilter ? "folder" : "folderOpen", 14);
  refs.mobileFab.disabled = !device?.online;
  refs.projSelectBtn.disabled = !device;
  refs.mRefreshBtn.disabled = !device?.online;
  refs.mRefreshBtn.classList.toggle("spinning", !!device && refreshingDevices.has(device.deviceId));
  // CoCo tile: hidden unless some device can host it; the target is either
  // resolved (one tap) or the sheet picks. Dot = CoCo work is running.
  const cocoEntry = cocoEntryState(devices, device?.deviceId ?? null);
  refs.mCocoBtn.hidden = !cocoEntry.visible;
  refs.mCocoBtn.setAttribute("aria-expanded", refs.cocoSheet?.classList.contains("is-open") ? "true" : "false");
  const cocoBusy = refs.mCocoBtn.querySelector<HTMLElement>(".m-coco-busy");
  if (cocoBusy) cocoBusy.hidden = !cocoEntry.busy;
  const cocoTarget = cocoEntry.direct
    ? devices.find((d) => d.deviceId === cocoEntry.direct)?.name
    : null;
  const cocoTitle = cocoTarget ? `Open CoCo on ${cocoTarget}` : `Open CoCo — ${cocoSheetHint(cocoEntry).replace(/\.$/, "")}`;
  refs.mCocoBtn.title = cocoTitle;
  refs.mCocoBtn.setAttribute("aria-label", cocoTitle);
  buildDeviceSheet();
  buildProjectSheet();
}

/** Mobile-only view header with a back affordance (hidden on desktop). */
function mobileBackHead(title: string): HTMLElement {
  return el("div", { class: "m-head" },
    el("button", {
      class: "m-back", type: "button",
      title: "Back", "aria-label": "Back",
      onclick: () => goHome(),
    }, icon("back", 18)),
    el("h1", {}, title));
}

// ── sidebar ──────────────────────────────────────────────────
// ── CoCo view (CocoController + CocoView, poll-based) ─────────────

/** Live CoCo view state — one device at a time, poll while mounted. */
let cocoController: CocoController | null = null;
let cocoView: CocoView | null = null;
let cocoDeviceId: string | null = null;

/** CoCo entry gate: device advertised the "coco" cap and is online. */
function deviceHasCoco(d: DeviceSummary): boolean {
  return deviceCocoReady(d);
}

function teardownCoco(): void {
  cocoView?.destroy();
  cocoView = null;
  cocoController?.stop();
  cocoController = null;
  cocoDeviceId = null;
}

/**
 * Open the CoCo workspace for one device. The controller polls while the
 * view is mounted; any other view switch tears it down (setViewMode hook).
 */
async function showCoco(deviceId: string): Promise<void> {
  const conn = client;
  if (!conn) return;
  const device = devices.find((d) => d.deviceId === deviceId);
  if (!device || !deviceHasCoco(device)) return;
  if (cocoDeviceId !== deviceId) {
    teardownCoco();
    cocoDeviceId = deviceId;
    // Remote-mode probe: readonly swaps the composer/decisions for notes.
    // Best-effort — a failed probe assumes full (the device still refuses).
    let readonly = false;
    try {
      const opts = await conn.request<{ remoteMode: "readonly" | "full" }>(deviceId, "listComposerOptions");
      readonly = opts.remoteMode !== "full";
    } catch { /* keep full */ }
    cocoController = new CocoController({
      deviceId,
      request: <T>(d: string, action: Parameters<RelayClient["request"]>[1], payload?: unknown, timeoutMs?: number) =>
        conn.request<T>(d, action, payload, timeoutMs),
    });
    cocoView = new CocoView(refs.cocoView, cocoController, {
      device: { name: device.name, platform: device.platform },
      readonly,
      onExit: () => exitCoco(),
      onToast: (message) => window.alert(message),
      // The app topbar (and its status dot / E2EE lock) is hidden here.
      headBadge: () => headConnBadge(),
    });
  }
  setViewMode("coco");
  currentSession = null;
  live?.destroy();
  live = null;
  livePendingAsk = null;
  detachConvQueueHooks();
  filesPanel.close();
  refs.newTaskView.hidden = true;
  refs.convView.hidden = true;
  refs.manageView.hidden = true;
  refs.memoryView.hidden = true;
  refs.devicesView.hidden = true;
  refs.mainEmpty.hidden = true;
  refs.cocoView.hidden = false;
  cocoController?.start();
  cocoView?.render();
  renderSidebar();
  syncMobileView();
}

/** Back from CoCo — teardown + home. */
function exitCoco(): void {
  teardownCoco();
  setViewMode("home");
  refs.mainEmpty.hidden = false;
  renderSidebar();
  syncMobileView();
}

function renderSidebar(): void {
  const sb = refs.sidebar;
  sb.replaceChildren();

  // Group devices by the key they registered under (multi-key relay).
  const groups = new Map<string, DeviceSummary[]>();
  for (const d of devices) {
    const g = d.keyName ?? "—";
    const list = groups.get(g);
    if (list) list.push(d);
    else groups.set(g, [d]);
  }
  const sortedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const showGroups = sortedGroups.length > 1;

  sb.append(el("div", { class: "side-label" }, icon("monitor", 12), "Devices"));

  for (const [groupName, devs] of sortedGroups) {
    if (showGroups) sb.append(el("div", { class: "side-key-label" }, `${groupName} · ${devs.length}`));
    for (const d of devs) {
      const selected = d.deviceId === selectedDeviceId;
      const expanded = expandedDevices.has(d.deviceId);
      const busy = d.online && (d.runningSessions ?? 0) > 0;
      const row = el("button", {
        class: `side-item device${selected ? " selected" : ""}${expanded ? " expanded" : ""}`,
        onclick: () => selectDevice(d.deviceId),
      },
        el("span", {
          class: `dev-dot${d.online ? " online" : ""}${busy ? " busy" : ""}`,
          title: busy ? `${d.runningSessions} session${d.runningSessions === 1 ? "" : "s"} running` : undefined,
        }),
        el("span", { class: "name", title: d.name }, d.name),
        // Square CoCo entry beside the device — caps-gated, stopPropagation
        // so the click doesn't also select the device.
        ...(deviceHasCoco(d) ? [el("span", {
          class: `side-coco-btn${viewMode === "coco" && cocoDeviceId === d.deviceId ? " active" : ""}`,
          role: "button",
          "data-device-id": d.deviceId,
          title: busy ? `CoCo on ${d.name} — busy` : `CoCo on ${d.name}`,
          "aria-label": `Open CoCo on ${d.name}`,
          onclick: (e: Event) => {
            e.stopPropagation();
            void showCoco(d.deviceId);
          },
        }, cocoIcon("logo"), busy ? el("span", { class: "dot" }) : null)] : []),
        el("span", {
          class: `dev-refresh${d.online ? "" : " off"}${refreshingDevices.has(d.deviceId) ? " spinning" : ""}`,
          role: "button",
          "data-device-id": d.deviceId,
          title: selected ? "Refresh sessions" : "Refresh projects",
          "aria-label": `Refresh ${d.name}`,
          onclick: (e) => {
            e.stopPropagation();
            if (!d.online) return;
            void refreshDeviceNow(d.deviceId);
          },
        }, icon("refresh", 12)),
        el("span", { class: `side-caret${expanded ? " open" : ""}` }, icon("chevronRight", 12)),
      );
      sb.append(row);
      if (expanded) {
        const projects = deviceProjects.get(d.deviceId) ?? [];
        const sub = el("div", { class: "side-sub" });
        if (!projects.length) {
          sub.append(el("div", { class: "side-sub-empty" }, d.online ? "No projects yet" : "Offline"));
        } else {
          for (const p of projects) {
            const isSel = selected && projectFilter === p;
            const label = projectName(d.deviceId, p);
            sub.append(el("button", {
              class: `side-sub-item${isSel ? " selected" : ""}`,
              title: `Filter sessions by ${label}`,
              onclick: (e) => {
                e.stopPropagation();
                if (selectedDeviceId !== d.deviceId) selectDevice(d.deviceId);
                // Click-to-filter only — a selected project never toggles off.
                applyCurrentProject(d.deviceId, p);
              },
            },
              icon(isSel ? "folderOpen" : "folder", 13),
              el("span", { class: "name" }, label),
            ));
          }
        }
        sb.append(sub);
      }
    }
  }

  sb.append(renderSidebarFooter({
    devicesIcon: shellEntryIcon("devices", 15),
    manageIcon: shellEntryIcon("manage", 15),
    onDevices: () => void showDevices(),
    onManage: () => showManage(),
    onSignOut: () => {
      void fetch(`${import.meta.env.BASE_URL}api/auth/logout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: sessionToken }),
      }).catch(() => {});
      localStorage.removeItem(KEY_STORAGE);
      location.reload();
    },
  }));

  // Mobile selector pills + sheets mirror the same device/project data.
  renderMobileHome();
}

// ── session column (middle) ──────────────────────────────────
function selectDevice(deviceId: string): void {
  if (selectedDeviceId === deviceId) {
    // Re-clicking the selected device toggles its project list…
    if (expandedDevices.has(deviceId)) expandedDevices.delete(deviceId);
    else {
      expandedDevices.add(deviceId);
      // Fetch unless the cache is registry-backed: an aggregate warmed
      // without workspace names (refineAutoPick) would render orphan
      // labels — the refresh re-applies with names and hides orphans.
      if (!deviceProjects.has(deviceId) || !deviceWorkspaceNames.has(deviceId)) void fetchDeviceProjects(deviceId);
    }
    renderSidebar();
    // Desktop: toggle + hop to New Task. Mobile has no sidebar rows —
    // re-tapping the selected device in the sheet means "refresh here".
    if (isMobileViewport()) {
      syncMobileView();
      void refreshDeviceNow(deviceId);
    } else {
      showNewTask();
    }
    return;
  }
  selectedDeviceId = deviceId;
  sessions = [];
  projectFilter = null;
  projectFilterAuto = true;
  // The old device's conversation must not survive the switch: a WS
  // resubscribe (onResubscribed) would otherwise replay its session id
  // against the NEW device — "session not found".
  currentSession = null;
  if (newTaskStageDeviceId !== deviceId) {
    newTaskStageStore = { drafts: [] };
    newTaskStageDeviceId = deviceId;
  }
  convStageStore = { drafts: [] };
  convStageSessionId = null;
  client?.subscribe(deviceId);
  expandedDevices.add(deviceId);
  renderSidebar();
  renderSessionColumn();
  // Desktop opens New Task on device selection; mobile stays on the home
  // list (the device sheet is a picker, not a navigation jump). Both are
  // overridden moments later when the session list lands and auto-open
  // jumps into the most recently interacted session (refreshSessions).
  if (isMobileViewport()) syncMobileView();
  else showNewTask();
  void refreshSessions({ autoOpen: true });
}

/** Ordinary session column filter: CoCo-owned sessions (chat `coco_chat` +
 *  autonomous background runs `coco`) never list — the CoCo view owns them.
 *  The device's internal `coco_internal` sessions stay hidden either way. */
function ordinarySessions(list: SessionSummary[]): SessionSummary[] {
  return list.filter((s) => s.source !== "coco_chat" && s.source !== "coco");
}

/** Pull sessions + workspace names for a device; updates project aggregates. */
async function loadDeviceData(deviceId: string): Promise<SessionSummary[]> {
  const conn = client;
  if (!conn) throw new Error("not connected");
  const list = ordinarySessions(
    await conn.request<SessionSummary[]>(deviceId, "listSessions"),
  );
  // Best-effort workspace names (newer device builds); falls back to id basename.
  try {
    const ws = await conn.request<Array<{ id: string; name: string; path: string }>>(deviceId, "listWorkspaces");
    deviceWorkspaceNames.set(deviceId, new Map(ws.map((w) => [w.id, w.name])));
    deviceWorkspaces.set(deviceId, ws.map((w) => ({ id: w.id, name: w.name, path: w.path })));
  } catch {
    deviceWorkspaceNames.delete(deviceId);
    deviceWorkspaces.delete(deviceId);
  }
  applyDeviceSessions(deviceId, list);
  return list;
}

/** Refresh the expanded device's project list (sidebar toggle). */
async function fetchDeviceProjects(deviceId: string): Promise<void> {
  try {
    await loadDeviceData(deviceId);
    if (expandedDevices.has(deviceId)) renderSidebar();
  } catch { /* offline device — sidebar shows Offline */ }
}

/** Devices with a refresh in flight — drives the sidebar spin affordance. */
const refreshingDevices = new Set<string>();

/** Device refresh button: sessions for the selected device, projects
 * otherwise; the icon spins for the duration of the pull. */
async function refreshDeviceNow(deviceId: string): Promise<void> {
  if (refreshingDevices.has(deviceId)) return;
  refreshingDevices.add(deviceId);
  syncDevRefreshSpin(deviceId);
  try {
    if (deviceId === selectedDeviceId) await refreshSessions();
    else await fetchDeviceProjects(deviceId);
  } finally {
    refreshingDevices.delete(deviceId);
    syncDevRefreshSpin(deviceId);
  }
}

/**
 * Apply the spin state to the refresh affordance in the current sidebar.
 * renderSidebar consults the set too, so re-renders mid-flight keep spinning.
 */
function syncDevRefreshSpin(deviceId: string): void {
  const spinning = refreshingDevices.has(deviceId);
  const sel = `.dev-refresh[data-device-id="${CSS.escape(deviceId)}"]`;
  for (const btn of refs.sidebar.querySelectorAll<HTMLElement>(sel)) {
    btn.classList.toggle("spinning", spinning);
  }
  // Mobile selector-row refresh button tracks the selected device.
  if (deviceId === selectedDeviceId && refs.mRefreshBtn) {
    refs.mRefreshBtn.classList.toggle("spinning", spinning);
  }
}

function projectName(deviceId: string, workspaceId: string): string {
  const name = deviceWorkspaceNames.get(deviceId)?.get(workspaceId);
  if (name) return name;
  // Workspace id is no longer in the registry (deleted / never migrated):
  // show a readable label instead of the raw UUID.
  return orphanProjectLabel(workspaceId);
}

/** True when the workspace id is a plain path (legacy keying, not a UUID). */
function isPathLikeWorkspaceId(workspaceId: string): boolean {
  return workspaceId.includes("/") || workspaceId.includes("\\");
}

/**
 * Label for a workspace id that is no longer in the device's registry
 * (deleted / never migrated). The old fallback showed the raw UUID — a
 * meaningless 36-char blob. Give the user something readable instead.
 */
function orphanProjectLabel(workspaceId: string): string {
  return isPathLikeWorkspaceId(workspaceId)
    ? `${workspaceBasename(workspaceId)} (missing)`
    : "Removed project";
}

function applyDeviceSessions(deviceId: string, list: SessionSummary[]): void {
  const seen = new Set<string>();
  // Registry snapshot: a workspace missing from it is an orphan (deleted /
  // never migrated) — its sessions still list under "All Projects", but no
  // "Removed project" folder is offered. No registry data (listWorkspaces
  // unsupported / failed) → keep every workspace id (legacy behavior).
  const known = deviceWorkspaceNames.get(deviceId);
  for (const s of list) {
    // Archived sessions belong to archived projects — keep the sidebar clean.
    if (s.archived) continue;
    if (known && !known.has(s.workspaceId)) continue;
    seen.add(s.workspaceId);
  }
  deviceProjects.set(
    deviceId,
    [...seen].sort((a, b) => projectName(deviceId, a).localeCompare(projectName(deviceId, b))),
  );
}

// ── first-load auto-pick refinement ──────────────────────────
let autoPickToken = 0;

/**
 * The synchronous auto-pick is device list order ("first busy device",
 * else "first online"); with several candidates that may not be where the
 * user actually is. Fetch each candidate's session list and re-seat the
 * selection: while anyone is busy, the device with the most recently
 * active running session wins; when everyone is idle, the device with the
 * most recent session activity (any status) wins. No-ops when there is
 * only one candidate, when the user already picked elsewhere, or when a
 * newer onDevices pass superseded this one.
 */
async function refineAutoPick(list: DeviceSummary[], syncPickId: string): Promise<void> {
  const token = ++autoPickToken;
  const conn = client;
  if (!conn) return;
  const busy = list.filter((d) => d.online && (d.runningSessions ?? 0) > 0);
  // Nobody busy → every online device is idle; the same fetch decides by
  // recent activity instead of running state.
  const candidates = busy.length > 0 ? busy : list.filter((d) => d.online);
  if (candidates.length < 2) return;
  const settled = await Promise.all(
    candidates.map(async (d) => {
      try {
        const deviceSessions = await conn.request<SessionSummary[]>(d.deviceId, "listSessions");
        return { deviceId: d.deviceId, sessions: ordinarySessions(deviceSessions) };
      } catch {
        return null; // Went offline mid-fetch or old build — sits out the vote.
      }
    }),
  );
  if (token !== autoPickToken) return; // A newer pass owns the selection now.
  const entries = settled.filter((e): e is { deviceId: string; sessions: SessionSummary[] } => e !== null);
  for (const e of entries) applyDeviceSessions(e.deviceId, e.sessions); // warm the project cache
  const winner = busy.length > 0 ? pickRecentRunningDevice(entries) : pickRecentActivityDevice(entries);
  if (!winner || winner === syncPickId) return;
  if (selectedDeviceId !== syncPickId) return; // User already chose — leave it.
  selectDevice(winner);
}

function workspaceBasename(wsId: string): string {
  const clean = (wsId || "").replace(/\/+$/, "");
  const slash = clean.lastIndexOf("/");
  return slash >= 0 ? clean.slice(slash + 1) || clean : clean || "—";
}

/**
 * Set the device's "current project" — one state driving both the session
 * column filter and the New Task picker (persisted per device). null = All
 * Projects (filter only; the picker keeps its last selection).
 */
function applyCurrentProject(deviceId: string, workspaceId: string | null): void {
  projectFilter = workspaceId;
  projectFilterAuto = false;
  if (workspaceId) writeDeviceMapEntry(NT_WS_KEY, deviceId, workspaceId);
  renderSidebar();
  renderSessionColumn();
}

/** Loose semver compare — device hello versions are plain x.y.z. */
function versionAtLeast(version: string, min: string): boolean {
  const a = version.split(".").map((n) => parseInt(n, 10) || 0);
  const b = min.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** Remote session delete exists on devices running ≥ 1.3.4 (desktop + agentd
 *  share the app version). Older builds would answer "unknown action" — the
 *  list simply renders without trash buttons for them. */
function canDeleteSessions(deviceId: string | null): boolean {
  if (!deviceId) return false;
  const version = devices.find((d) => d.deviceId === deviceId)?.version ?? "";
  return version !== "" && versionAtLeast(version, "1.3.4");
}

async function requestDeleteSession(s: SessionSummary): Promise<void> {
  if (!client || !selectedDeviceId) return;
  const label = s.title || "Untitled";
  if (!confirm(`Delete session “${label}”? The device archives it to history and it disappears from every console.`)) return;
  try {
    await client.request<{ deleted: boolean }>(selectedDeviceId, "deleteSession", { sessionId: s.id });
    // The device broadcasts session_deleted and handleStreamEvent already
    // bounces an open view home + re-pulls the list; this is the initiating
    // viewer's own deterministic path (the event is a race, not a guarantee).
    if (currentSession?.id === s.id) goHome("This session was deleted.");
    await refreshSessions();
    renderSessionColumn();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Delete failed.");
  }
}

function renderSessionColumn(): void {
  const col = refs.sessionCol;
  const device = devices.find((d) => d.deviceId === selectedDeviceId);
  let list = sessions;
  if (projectFilter && selectedDeviceId) {
    list = sessions.filter((s) => s.workspaceId === projectFilter);
  }

  // No header bar: the column is just the scrollable list.
  const body = device
    ? device.online
      ? list.length
        ? renderSessionList(
            list,
            currentSession?.id ?? null,
            // Ordinary project sessions only — CoCo-owned sessions are
            // filtered upstream (ordinarySessions) and live in the CoCo view.
            (s) => void openSession(s.id),
            canDeleteSessions(selectedDeviceId) ? (s) => void requestDeleteSession(s) : undefined,
          )
        : el("div", { class: "empty-note" }, "No sessions yet.")
      : el("div", { class: "empty-note" }, "Device is offline — sessions unavailable.")
    : el("div", { class: "empty-note" }, "Pick an online device to browse its sessions.");

  col.replaceChildren(el("div", { class: "col-body" }, body));
  renderMobileHome();
}

/**
 * Refresh the selected device's session list. `autoOpen` is set only on the
 * first refresh after a device selection (manual or auto-pick): it opens
 * the most recently interacted session — its project becomes the filter,
 * so the console lands where the user last was instead of an empty column.
 */
async function refreshSessions(opts?: { autoOpen?: boolean }): Promise<void> {
  if (!selectedDeviceId || !client) return;
  // Snapshot the pull target: the await below can straddle a device re-seat
  // (refineAutoPick winner / user click) and the fresh selection owns the
  // column from that moment. Resuming with a stale device's openTarget would
  // send ITS session id to the NEW device — the "session not found" failure
  // view (sealed res {error:"session not found"}, relay does not log it).
  const pullDeviceId = selectedDeviceId;
  try {
    sessions = (await loadDeviceData(pullDeviceId))
      .filter((s) => !s.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (selectedDeviceId !== pullDeviceId) return; // stale chain — dropped
    let openTarget: SessionSummary | null = null;
    // Device selection starts in auto mode: lock the column onto the
    // default-open session's project, never the full list. A session whose
    // workspace is still registered outranks orphan projects (their label
    // is a raw id / "Removed project" — a broken-looking default).
    if (projectFilterAuto) {
      openTarget = pickDefaultSession(sessions, deviceProjects.get(selectedDeviceId) ?? undefined);
      projectFilter = openTarget?.workspaceId ?? pickDefaultProject(selectedDeviceId, sessions);
      projectFilterAuto = false;
    }
    renderSidebar();
    renderSessionColumn();
    if (viewMode === "newTask") renderNewTaskView();
    if (opts?.autoOpen && openTarget) {
      void openSession(openTarget.id, pullDeviceId);
    }
  } catch (err) {
    renderSessionColumn();
    refs.sessionCol.querySelector(".col-body")?.replaceChildren(
      el("div", { class: "empty-note" }, `Failed to load sessions: ${(err as Error).message}`),
    );
  }
}

/**
 * Default project filter after selecting a device: a project with a running
 * session first, else the one that most recently had session activity, else
 * the first project (rule lives in defaultProject.ts). Workspace-id keyed;
 * null only when the device has no projects.
 */
function pickDefaultProject(deviceId: string, list: SessionSummary[]): string | null {
  return pickDefaultProjectRule(deviceProjects.get(deviceId) ?? [], list);
}

// ── right column views ───────────────────────────────────────
function goHome(emptyMessage = "Select a session to view the conversation."): void {
  setViewMode("home");
  currentSession = null;
  live?.destroy();
  live = null;
  livePendingAsk = null;
  detachConvQueueHooks();
  filesPanel.close();
  refs.newTaskView.hidden = true;
  refs.convView.hidden = true;
  refs.manageView.hidden = true;
  refs.memoryView.hidden = true;
  refs.devicesView.hidden = true;
  refs.mainEmpty.hidden = false;
  refs.mainEmpty.replaceChildren(
    el("div", { class: "empty-hero" },
      el("div", { class: "empty-hero-icon" }, emptyAgentIcon()),
      el("p", {}, emptyMessage),
    ),
  );
  renderSessionColumn();
  syncMobileView();
}

// ── new task (create a session on the device) ───────────────
/** Signature of the last rendered New Task panel — skips no-op rebuilds. */
let newTaskRenderSig = "";
/** A repaint was deferred because the picker popover was open. */
let newTaskRepaintPending = false;
/** Live panel instance — checked so an open popover blocks repaints. */
let activeNewTaskPanel: ReturnType<typeof buildNewTaskPanel> | null = null;
/** Device whose draft text is currently mounted in the New Task composer. */
let newTaskDraftDeviceId: string | null = null;
let newTaskDraftTimer: number | null = null;
/** Staged New Task attachments — survive capability re-renders, reset per device. */
let newTaskStageStore: { drafts: RemoteAttachmentDraft[] } = { drafts: [] };
let newTaskStageDeviceId: string | null = null;
/** Staged conversation attachments, keyed to the open session. */
let convStageStore: { drafts: RemoteAttachmentDraft[] } = { drafts: [] };
let convStageSessionId: string | null = null;

// ── prompt queue (running-session follow-ups, Mac parity) ────
/**
 * Structural view of a device QueuedPrompt — wide enough to accept both the
 * ipcTypes shape (listPromptQueue replies) and the streamEvents shape
 * (prompt_queue snapshots) without kind-incompatible casts.
 */
type QueueItemView = { id: string; userText: string; attachments: Array<{ name: string }>; mode: string };
/** Latest full queue snapshot for the open session (device is the source of truth). */
let promptQueue: QueueItemView[] = [];
/** Queue view mounted by the current conversation render (rebuilt per render). */
let convQueueView: PromptQueueView | null = null;
/** Submit-gesture recompute hook owned by the current conversation render. */
let convSubmitGesture: (() => void) | null = null;
/** Live turn-running flag for the open session (event-driven, snapshot-free). */
let convGestureState: { running: boolean } | null = null;
let demoStatesKey = "";
let demoStates = new Map<string, DemoCardState>();
/**
 * Mobile collapsed-composer control owned by the current conversation render.
 * The bar only exists ≤768px; crossing back to desktop force-expands so the
 * full form can never stay hidden behind a stale `is-collapsed` class.
 */
let convComposerCollapse: { setCollapsed(next: boolean): void } | null = null;
/**
 * Keeps the mobile collapsed capsule's idle ⇄ running variant in step with
 * the live turn state (status stream events flip it without a view rebuild).
 */
let syncPillRunning: (() => void) | null = null;
/** Live-strip elapsed timer (mobile conv-head ContextPill). */
let convLiveTimerId: number | null = null;
let convLiveStartedAt = 0;
const convMobileMQ = window.matchMedia("(max-width: 768px)");
convMobileMQ.addEventListener("change", () => {
  if (!convMobileMQ.matches) convComposerCollapse?.setCollapsed(false);
});
/** Devices that answer the queue actions (older builds keep the legacy send). */
const queueCaps = new Map<string, boolean>();
/**
 * Plan approval bar (Approve | Discard) for the open session — lives across
 * conversation rebuilds so an expanded doc preview survives resyncs. The
 * controller (and its host node) is recreated on session switch; renderConvView
 * re-appends the persistent host into every fresh composer stack.
 */
let planReview: PlanReviewSync | null = null;
let planReviewSessionId: string | null = null;

/** Mirror a fresh queue snapshot into the view + submit gesture. */
function applyQueueSnapshot(items: QueueItemView[]): void {
  const demoQueueChanged = demoQueueFingerprint(promptQueue.map((item) => item.userText)) !== demoQueueFingerprint(items.map((item) => item.userText));
  promptQueue = items;
  convQueueView?.setItems(items.map(queuedPromptToViewItem));
  convSubmitGesture?.();
  if (demoQueueChanged && currentSession && viewMode === "conv") renderConvView(readConvScrollState() ?? undefined);
}

/** Tear down conversation-render hooks (goHome / manage / new task). */
function detachConvQueueHooks(): void {
  promptQueue = [];
  convQueueView = null;
  convSubmitGesture = null;
  convGestureState = null;
  syncPillRunning = null;
  convRenderRelevance.reset();
  if (convLiveTimerId != null) {
    window.clearInterval(convLiveTimerId);
    convLiveTimerId = null;
  }
  convLiveStartedAt = 0;
  refs.convGauge = null;
  refs.convRunStatus = null;
  refs.convComposerCard = null;
  refs.convRunPill = null;
  refs.convHead = null;
  refs.convLive = null;
  refs.convComposer = null;
}

function readDeviceMap(key: string): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeDeviceMapEntry(key: string, deviceId: string, value: string): void {
  const map = readDeviceMap(key);
  if (value) map[deviceId] = value;
  else delete map[deviceId];
  localStorage.setItem(key, JSON.stringify(map));
}

/**
 * Project options for the New Task picker. Falls back to projects seen in
 * the session list when the device build lacks listWorkspaces.
 */
function workspaceOptionsFor(deviceId: string | null): NewTaskWorkspaceOption[] {
  if (!deviceId) return [];
  const stored = deviceWorkspaces.get(deviceId);
  if (stored && stored.length > 0) return stored;
  const seen = new Map<string, NewTaskWorkspaceOption>();
  for (const s of sessions) {
    if (s.archived || seen.has(s.workspaceId)) continue;
    seen.set(s.workspaceId, {
      id: s.workspaceId,
      name: workspaceBasename(s.workspaceId),
      path: s.workspaceId,
    });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── composer capability (legacy devices hide the new controls) ──
// Probe + backoff self-heal live in composerProbe.ts (unit-tested there);
// the wiring below adapts the shared client + device list to it. Older
// packaged builds answer "unknown action" → the console keeps the plain
// composer there (feature masked, never broken).
const composerProbe = createComposerProbeStore({
  request: (deviceId, timeoutMs) =>
    client!.request<ComposerOptions>(deviceId, "listComposerOptions", undefined, timeoutMs),
  deviceVersion: (deviceId) => devices.find((d) => d.deviceId === deviceId)?.version ?? "",
});

/** Composer options for a modern device; null → legacy/unknown, hide controls. */
function composerCapFor(deviceId: string | null): ComposerOptions | null {
  return composerProbe.capFor(deviceId);
}

/**
 * providers_changed push from a device: drop the cached composer probe and
 * repaint whatever composer surface is on screen for the selected device.
 * Repaints ride the existing render paths (drafts + scroll survive; the
 * new-task render sig short-circuits when the fresh list is identical).
 */
function onDeviceProvidersChanged(deviceId: string): void {
  composerProbe.invalidate(deviceId);
  if (deviceId !== selectedDeviceId) return;
  void ensureComposerCapability(deviceId).then(() => {
    if (viewMode === "newTask") renderNewTaskView();
    else if (viewMode === "conv" && currentSession) {
      // The fresh provider list may repaint the composer even when the
      // session snapshot itself is unchanged — the capability lives
      // outside the session fingerprint, so force past the identical-
      // snapshot skip (same gap as the probe retry below).
      convRenderRelevance.reset();
      void loadSession(currentSession.id, readConvScrollState() ?? undefined);
    }
  });
}

/**
 * Silent re-probe for the provider menu's onProviderMenuOpen — stale caches
 * heal the moment the user actually looks at the list. Returns fresh options
 * when the probe landed, null while unresolved (nothing to repaint).
 */
async function refreshComposerOptionsOnMenuOpen(deviceId: string): Promise<ComposerOptions | null> {
  composerProbe.invalidate(deviceId);
  try {
    await ensureComposerCapability(deviceId);
  } catch {
    return null;
  }
  return composerCapFor(deviceId);
}

/** Probe one device for web-composer support. True → capability changed, repaint. */
function ensureComposerCapability(deviceId: string): Promise<boolean> {
  return client ? composerProbe.ensure(deviceId) : Promise.resolve(false);
}

/**
 * True while the composer capability probe is unresolved on an ONLINE
 * device — neither the Mac-parity toolbar nor the legacy plain composer is
 * the correct surface yet, so composer areas render the loading
 * placeholder instead of flashing a default composer (user decision).
 * Settled states: "ok" → toolbar, "legacy" → plain composer (both final).
 */
function composerProbePending(deviceId: string | null): boolean {
  if (!deviceId || composerCapFor(deviceId) != null) return false;
  if (composerProbe.probeOf(deviceId) === "legacy") return false;
  return devices.find((d) => d.deviceId === deviceId)?.online === true;
}

/**
 * A render just showed the composer loading placeholder — the capability
 * probe is unresolved (busy device outran the 10s probe budget, relay or
 * phone-network hiccup). Retry with backoff and repaint whichever composer
 * surface is on screen once the probe settles (toolbar or plain composer).
 */
function scheduleComposerProbeRetry(deviceId: string): void {
  composerProbe.scheduleRetry(
    deviceId,
    () => {
      if (viewMode === "conv" && currentSession) {
        // Draft text + scroll position survive the rebuild (renderConvView
        // restores both). The composer capability is NOT part of the
        // session fingerprint — reset it or the snapshot-identical skip
        // would keep the loading placeholder alive past the settle.
        convRenderRelevance.reset();
        void loadSession(currentSession.id, readConvScrollState() ?? undefined);
      } else if (viewMode === "newTask") {
        renderNewTaskView();
      }
    },
    () => selectedDeviceId === deviceId && (viewMode === "conv" || viewMode === "newTask"),
  );
}

// ── composer prefs (per device, Mac process-level parity) ─────
interface ComposerPrefs {
  providerId: string | null;
  reasoningEffort: ComposerReasoningEffort;
  infinite: boolean;
  bypass: boolean;
}

function readComposerPrefs(deviceId: string): Partial<ComposerPrefs> {
  try {
    const parsed = JSON.parse(readDeviceMap(NT_PREFS_KEY)[deviceId] ?? "null") as unknown;
    const base = parsed && typeof parsed === "object" ? (parsed as Partial<ComposerPrefs> & { reasoningMax?: boolean }) : {};
    // Older stored drafts carry the Max boolean — migrate onto the dial.
    if (!isComposerReasoningEffort(base.reasoningEffort) && typeof base.reasoningMax === "boolean") {
      base.reasoningEffort = base.reasoningMax ? "max" : "low";
    }
    return base;
  } catch {
    return {};
  }
}

function writeComposerPrefs(deviceId: string, patch: Partial<ComposerPrefs>): void {
  const next = { ...readComposerPrefs(deviceId), ...patch };
  writeDeviceMapEntry(NT_PREFS_KEY, deviceId, JSON.stringify(next));
}

/** New Task defaults: device settings overlaid with stored local choices. */
function resolveNewTaskPrefs(deviceId: string, options: ComposerOptions): ComposerPrefs {
  const stored = readComposerPrefs(deviceId);
  // Modern devices report the dial level; legacy ones the Max boolean.
  const defaultLevel = isComposerReasoningEffort(options.defaults.reasoningEffort)
    ? options.defaults.reasoningEffort
    : options.defaults.reasoningEffortMax === true
      ? "max"
      : "low";
  return {
    providerId:
      typeof stored.providerId === "string" && options.providers.some((p) => p.id === stored.providerId)
        ? stored.providerId
        : options.activeProviderId,
    reasoningEffort: isComposerReasoningEffort(stored.reasoningEffort) ? stored.reasoningEffort : defaultLevel,
    infinite: typeof stored.infinite === "boolean" ? stored.infinite : options.defaults.composerInfinite,
    bypass: stored.bypass === true,
  };
}

// ── attachment staging (upload now, attach on send) ───────────
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("failed to read file"));
    reader.readAsDataURL(file);
  });
}

function guessKind(file: File): string {
  return file.type.startsWith("image/") ? "image" : "file";
}

/**
 * One composer's attachment pipeline: browser files → uploadAttachment →
 * staged drafts. Chips live in the toolbar; removal is honoured even while
 * an upload is in flight.
 */
function createAttachmentStage(
  deviceId: string,
  toolbar: ComposerToolbar,
  store: { drafts: RemoteAttachmentDraft[] } = { drafts: [] },
) {
  const { drafts } = store;
  const chips = new Map<string, ComposerAttachmentItem>(); // uploading + error chips
  const cancelled = new Set<string>();

  const sync = () => {
    toolbar.setItems([
      ...chips.values(),
      ...drafts.map((d) => ({ id: d.path, name: d.name, kind: d.kind })),
    ]);
  };

  async function addFiles(files: File[]): Promise<void> {
    void (async () => {
      for (const file of files) {
        const kind = guessKind(file);
        if (file.size > UPLOAD_MAX_BYTES) {
          chips.set(`err:${file.name}:${chips.size}`, {
            id: `err:${file.name}:${chips.size}`,
            name: `${file.name} — over 8 MB`,
            kind,
            error: `${file.name} exceeds the 8 MB remote upload limit`,
          });
          sync();
          continue;
        }
        const id = `up:${Math.random().toString(36).slice(2)}`;
        chips.set(id, { id, name: file.name, kind, uploading: true });
        cancelled.delete(id);
        sync();
        try {
          const contentBase64 = await fileToBase64(file);
          if (cancelled.has(id)) {
            chips.delete(id);
            sync();
            continue;
          }
          const draft = await client!.request<RemoteAttachmentDraft>(
            deviceId,
            "uploadAttachment",
            { name: file.name, mimeType: file.type || "application/octet-stream", contentBase64 },
            130_000,
          );
          if (cancelled.has(id)) {
            // Staged but then removed — drop silently.
            chips.delete(id);
            const idx = drafts.findIndex((d) => d.path === draft.path);
            if (idx >= 0) drafts.splice(idx, 1);
          } else {
            chips.delete(id);
            drafts.push(draft);
          }
        } catch (err) {
          if (!cancelled.has(id)) {
            chips.set(id, {
              id,
              name: `${file.name} — ${(err as Error).message}`,
              kind,
              error: `${file.name}: ${(err as Error).message}`,
            });
          } else {
            chips.delete(id);
          }
        }
        sync();
      }
    })();
  }

  function remove(id: string): void {
    cancelled.add(id);
    chips.delete(id);
    const idx = drafts.findIndex((d) => d.path === id);
    if (idx >= 0) drafts.splice(idx, 1);
    sync();
  }

  return {
    addFiles,
    remove,
    /** Drafts for startTurn; clears the stage (send consumed them). */
    take(): RemoteAttachmentDraft[] {
      const out = [...store.drafts];
      store.drafts.length = 0;
      sync();
      return out;
    },
    /** Put failed-send drafts back on the stage (chips reappear). */
    restore(restored: RemoteAttachmentDraft[]): void {
      for (const draft of restored) {
        if (!drafts.some((d) => d.path === draft.path)) drafts.push(draft);
      }
      sync();
    },
    clear(): void {
      drafts.length = 0;
      chips.clear();
      sync();
    },
    sync,
  };
}

/** Persist the mounted draft before the panel is rebuilt/switched away. */
function flushNewTaskDraft(): void {
  const deviceId = newTaskDraftDeviceId;
  if (!deviceId) return;
  newTaskDraftDeviceId = null;
  const ta = refs.newTaskView.querySelector("textarea") as HTMLTextAreaElement | null;
  if (!ta) return;
  writeDeviceMapEntry(NT_DRAFT_KEY, deviceId, ta.value);
}

function showNewTask(): void {
  if (!selectedDeviceId) {
    goHome();
    return;
  }
  setViewMode("newTask");
  currentSession = null;
  live?.destroy();
  live = null;
  livePendingAsk = null;
  detachConvQueueHooks();
  filesPanel.close();
  flushNewTaskDraft();
  refs.convView.hidden = true;
  refs.manageView.hidden = true;
  refs.memoryView.hidden = true;
  refs.devicesView.hidden = true;
  refs.mainEmpty.hidden = true;
  refs.newTaskView.hidden = false;
  renderNewTaskView();
  renderSessionColumn();
  syncMobileView();
}

function renderNewTaskView(): void {
  const deviceId = selectedDeviceId;
  const device = devices.find((d) => d.deviceId === deviceId);
  const options = workspaceOptionsFor(deviceId);
  const composerOptions = composerCapFor(deviceId);  // Probe legacy/modern once per device version; rebuild when it settles.
  if (device?.online) {
    void ensureComposerCapability(deviceId!).then((changed) => {
      if (viewMode !== "newTask") return;
      if (composerCapFor(deviceId) != null) {
        // Repaint only when the modern capability actually landed — a
        // transient failure keeps the probe "unknown" (changed=true against
        // the empty cache) and re-rendering would just re-probe in a tight
        // loop. The backoff retry owns that case instead.
        if (changed) renderNewTaskView();
      } else if (composerProbe.probeOf(deviceId!) === "legacy") {
        // Legacy settle swaps the loading placeholder for the plain
        // composer — the final surface for old device bridges.
        if (changed) renderNewTaskView();
      } else {
        scheduleComposerProbeRetry(deviceId!);
      }
    });
  }
  // Rebuild only when the inputs changed — never churn the composer while
  // the user is typing (presence pushes re-render on every device update).
  // selectedWs rides the sig so a remote createWorkspace (or picker pick on
  // a re-rendered panel) repaints the picker onto the new selection.
  const stored = deviceId ? readDeviceMap(NT_DRAFT_KEY)[deviceId] ?? "" : "";
  const selectedWs = deviceId ? readDeviceMap(NT_WS_KEY)[deviceId] ?? null : null;
  const sig = JSON.stringify([
    deviceId,
    device?.online ?? false,
    selectedWs,
    options.map((w) => [w.id, w.name]),
    composerOptions && [
      composerOptions.activeProviderId,
      composerOptions.remoteMode,
      composerOptions.defaults,
      composerOptions.providers.map((p) => [p.id, p.name, p.modelId]),
    ],
    // Pending flag: unknown → legacy settle keeps composerOptions null but
    // must still swap the loading placeholder for the plain composer.
    composerProbePending(deviceId),
  ]);
  if (sig === newTaskRenderSig && refs.newTaskView.childElementCount > 0) return;
  newTaskRenderSig = sig;

  // Never repaint over an open picker popover (project list / create form /
  // folder browser) — a late async response (composer probe, workspace
  // refresh) used to rebuild the panel mid-browse and close the popover.
  // Defer until the menu closes; onMenuClosed repaints.
  if (activeNewTaskPanel?.isMenuOpen()) {
    newTaskRepaintPending = true;
    return;
  }
  newTaskRepaintPending = false;

  flushNewTaskDraft();
  refs.newTaskView.replaceChildren();
  // Mobile-only header (back + title); desktop renders the hero instead.
  refs.newTaskView.append(mobileBackHead("New Task"));
  if (!device || !device.online) {
    refs.newTaskView.append(el("div", { class: "view-empty" },
      el("div", { class: "empty-hero" },
        el("div", { class: "empty-hero-icon" }, emptyAgentIcon()),
        el("p", {}, device ? "Device is offline — new tasks unavailable." : "Pick an online device to start."),
      ),
    ));
    return;
  }

  // Mac-parity controls — only on modern device builds (legacy keeps the
  // plain composer; old bridges reject the new actions outright).
  let toolbar: ComposerToolbar | null = null;
  let stage: ReturnType<typeof createAttachmentStage> | null = null;
  let panel: ReturnType<typeof buildNewTaskPanel> | null = null;
  const sendState = composerOptions
    ? (() => {
        const prefs = resolveNewTaskPrefs(deviceId!, composerOptions);
        const live = { ...prefs };
        toolbar = buildComposerToolbar(
          {
            providers: composerOptions.providers,
            state: { providerId: live.providerId, reasoningEffort: live.reasoningEffort, infinite: live.infinite, bypass: live.bypass },
            bypassAvailable: composerOptions.remoteMode === "full",
          },
          {
            onPickFiles: (files) => stage?.addFiles(files),
            onRemoveAttachment: (id) => stage?.remove(id),
            onProviderMenuOpen: () => {
              void refreshComposerOptionsOnMenuOpen(deviceId!).then((fresh) => {
                if (!fresh) return;
                toolbar?.setProviders(fresh.providers);
                // Selected profile vanished on the device — follow its new
                // active default instead of sending turns at a dead id.
                if (!fresh.providers.some((p) => p.id === live.providerId)) {
                  live.providerId = fresh.activeProviderId;
                  toolbar?.setState({ providerId: fresh.activeProviderId });
                }
              });
            },
            onPickProvider: (providerId) => {
              live.providerId = providerId;
              // Toolbar keeps its own copy of the selection (menu checkmark
              // + pill label) — repaint it; no full panel rebuild exists for
              // local-only picks (the render sig tracks device-side data).
              toolbar?.setState({ providerId });
              writeComposerPrefs(deviceId!, { providerId });
            },
            onReasoningEffortSelect: (level) => {
              live.reasoningEffort = level;
              writeComposerPrefs(deviceId!, { reasoningEffort: level });
            },
            onToggleInfinite: (next) => {
              live.infinite = next;
              writeComposerPrefs(deviceId!, { infinite: next });
            },
            onToggleBypass: (next) => {
              live.bypass = next;
              writeComposerPrefs(deviceId!, { bypass: next });
            },
            onSend: () => panel?.triggerSend(),
          },
        );
        stage = createAttachmentStage(deviceId!, toolbar, newTaskStageStore);
        return live;
      })()
    : null;

  panel = buildNewTaskPanel({
    workspaces: options,
    selectedWorkspaceId: selectedWs,
    draft: stored,
    heroIconUrl: `${import.meta.env.BASE_URL}hero-300.png`,
    toolbar,
    composerLoading: !toolbar && composerProbePending(deviceId),
    onPickWorkspace: (workspaceId) => {
      // One "current project" — picker pick drives the session filter too.
      applyCurrentProject(deviceId!, workspaceId);
    },
    onMenuClosed: () => {
      if (!newTaskRepaintPending) return;
      newTaskRepaintPending = false;
      // Force past the sig guard — inputs changed while the popover was open.
      newTaskRenderSig = "";
      if (viewMode === "newTask") renderNewTaskView();
    },
    onCreateWorkspace: async (name, path) => {
      const dev = deviceId;
      if (!dev || !client) return { ok: false, error: "Device is offline." };
      try {
        const ws = await client.request<{ id: string; name: string; path: string; existing?: boolean }>(
          dev, "createWorkspace", { name, path });
        // Re-pull workspaces so the picker + sidebar reflect the device.
        try { await loadDeviceData(dev); } catch { /* best-effort refresh */ }
        applyCurrentProject(dev, ws.id);
        // Repaint the picker onto the new project (sig now differs).
        if (viewMode === "newTask") renderNewTaskView();
        return {
          ok: true,
          workspace: { id: ws.id, name: ws.name, path: ws.path },
          existing: ws.existing === true,
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    onBrowseDir: async (path) => {
      const dev = deviceId;
      if (!dev || !client) return { ok: false, error: "Device is offline." };
      try {
        const r = await client.request<{ path: string; parent: string | null; dirs: string[] }>(
          dev, "browseDir", path ? { path } : {});
        return { ok: true, path: r.path, parent: r.parent, dirs: r.dirs };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    onSend: (text, workspaceId) => {
      const attachments = stage?.take() ?? [];
      void sendNewTask(text, workspaceId, panel!, {
        providerId: sendState?.providerId ?? null,
        reasoningEffort: sendState?.reasoningEffort ?? "low",
        infinite: sendState?.infinite === true,
        bypass: sendState?.bypass === true,
        attachments,
        toolbar,
        stage,
      });
    },
  });
  newTaskDraftDeviceId = deviceId;
  activeNewTaskPanel = panel;
  panel.textarea.addEventListener("input", () => {
    if (newTaskDraftTimer !== null) window.clearTimeout(newTaskDraftTimer);
    const dev = deviceId!;
    newTaskDraftTimer = window.setTimeout(() => {
      newTaskDraftTimer = null;
      writeDeviceMapEntry(NT_DRAFT_KEY, dev, panel.textarea.value);
    }, 300);
  });
  refs.newTaskView.append(panel.root);
  panel.textarea.focus();
}

interface SendNewTaskExtras {
  providerId: string | null;
  reasoningEffort: ComposerReasoningEffort;
  infinite: boolean;
  bypass: boolean;
  attachments: RemoteAttachmentDraft[];
  toolbar: ComposerToolbar | null;
  stage: ReturnType<typeof createAttachmentStage> | null;
}

/** startTurn without sessionId → device creates + runs a fresh session. */
async function sendNewTask(
  text: string,
  workspaceId: string | null,
  panel: ReturnType<typeof buildNewTaskPanel>,
  extras: SendNewTaskExtras,
): Promise<void> {
  if (!client || !selectedDeviceId) return;
  panel.setBusy(true);
  extras.toolbar?.setDisabled(true);
  panel.clearError();
  try {
    const res = await client.request<StartTurnResponse>(selectedDeviceId, "startTurn", {
      workspaceId,
      userText: text,
      // Composer feature pass-through (ignored by legacy device bridges).
      fullPermissions: extras.bypass,
      ...(extras.providerId ? { providerId: extras.providerId } : {}),
      reasoningEffort: extras.reasoningEffort,
      ...(extras.infinite ? { composerInfinite: true } : {}),
      ...(extras.attachments.length > 0 ? { attachments: extras.attachments } : {}),
    });
    newTaskDraftDeviceId = null; // sent — drop the draft without resurrecting it
    writeDeviceMapEntry(NT_DRAFT_KEY, selectedDeviceId, "");
    await refreshSessions();
    await openSession(res.sessionId);
  } catch (err) {
    panel.setBusy(false);
    extras.toolbar?.setDisabled(false);
    extras.stage?.restore(extras.attachments);
    panel.showError((err as Error).message);
  }
}

async function openSession(sessionId: string, ownerDeviceId?: string): Promise<void> {
  // ownerDeviceId pins the session's device for auto-open chains: the caller
  // (refreshSessions) captured it before its await; without the pin a
  // re-seat mid-pull would resolve getSession against the wrong device.
  const deviceId = ownerDeviceId ?? selectedDeviceId;
  if (!deviceId) return;
  const restore = currentSession?.id === sessionId ? readConvScrollState() ?? undefined : undefined;
  live?.destroy();
  live = null;
  setViewMode("conv");
  // The loading placeholder below replaces the old session's DOM — a
  // same-id openSession (startTurn redirect) must still rebuild once the
  // snapshot lands, so the relevance state from any prior view is void.
  convRenderRelevance.reset();
  if (convStageSessionId !== sessionId) {
    convStageStore = { drafts: [] };
    convStageSessionId = sessionId;
  }
  // Fresh conversation: the previous session's context reading never
  // bleeds into the new one's gauge (the snapshot hydrates it back if the
  // device already has a provider reading).
  liveContextUsage = null;
  refs.newTaskView.hidden = true;
  refs.manageView.hidden = true;
  refs.memoryView.hidden = true;
  refs.devicesView.hidden = true;
  refs.mainEmpty.hidden = true;
  refs.convView.hidden = false;
  refs.convView.replaceChildren(el("div", { class: "loading-center" }, el("div", { class: "spinner" }), "Loading session…"));
  renderSessionColumn();
  syncMobileView();
  await loadSession(sessionId, restore, deviceId);
}

/**
 * Fold a fresh session snapshot into the cached list so the status light,
 * meta counts and title never go stale after opening a session (the list
 * row used to keep spinning after the turn had already gone idle).
 */
function syncSessionSummary(session: Session): void {
  const idx = sessions.findIndex((s) => s.id === session.id);
  if (idx < 0) return;
  const prev = sessions[idx]!;
  sessions[idx] = {
    ...prev,
    title: session.title || prev.title,
    status: session.status,
    progressText: session.progressText ?? prev.progressText,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  };
}

async function loadSession(
  sessionId: string | null,
  restore?: { top: number; atBottom: boolean },
  ownerDeviceId?: string,
): Promise<void> {
  if (!sessionId || !selectedDeviceId || !client) return;
  // Switching conversations closes the Files panel; same-session resyncs
  // (idle sweep) keep it open — Refresh pulls fresh data on demand.
  if (currentSession?.id !== sessionId) filesPanel.close();
  // Monotonic guard: resync sources fire in bursts (idle sweep, ask settle,
  // resubscribe…) and an older snapshot resolving late must never overwrite
  // a newer render.
  const seq = ++loadSessionSeq;
  const deviceId = ownerDeviceId ?? selectedDeviceId;
  try {
    const [session, queueItems] = await Promise.all([
      client.request<Session | null>(deviceId, "getSession", { sessionId }),
      // Prompt-queue snapshot doubles as the queue capability probe: older
      // device builds answer "unknown action" → the console keeps the legacy
      // send-while-running behavior there (feature masked, never broken).
      client.request<QueueItemView[]>(deviceId, "listPromptQueue", { sessionId })
        .then((items) => {
          queueCaps.set(deviceId, true);
          return Array.isArray(items) ? items : [];
        })
        .catch((err: Error) => {
          if (/unknown action/i.test(err.message ?? "")) queueCaps.set(deviceId, false);
          return queueCaps.get(deviceId) === true ? promptQueue : [];
        }),
      // Composer capability (legacy masking). Cached per device version.
      ensureComposerCapability(deviceId).catch(() => false),
    ]);
    if (seq !== loadSessionSeq || viewMode !== "conv" || !session) return;
    // Stale chain (device re-seated while this pull was in flight): the view
    // belongs to another device now — neither render nor the error path may
    // paint over it.
    if (deviceId !== selectedDeviceId) return;
    applyOptimisticComposer(session);
    // Same-DOM check: idle resyncs fire in bursts (done + status:idle
    // staggered retries, resubscribes) and each rebuild re-pins the scroll
    // bottom — when the snapshot is render-identical to what produced the
    // current view, skip the rebuild so the transcript never bounces.
    if (convRenderRelevance.matches(session)) {
      currentSession = session;
      return;
    }
    const scrollRestore = currentSession?.id === session.id
      ? readConvScrollState() ?? restore
      : restore;
    currentSession = session;
    livePendingAsk = session.pendingUserAsk ?? null;
    // Context gauge: hydrate from the snapshot only while it is fresh — a
    // provider reading beats the streamed value, but a stale snapshot (race
    // with live usage events) must not clobber newer state.
    const snapshotUsage = gaugeValueFromSessionContextUsage(
      (session as { contextUsage?: Parameters<typeof gaugeValueFromSessionContextUsage>[0] }).contextUsage ?? {},
    );
    if (
      snapshotUsage &&
      shouldAcceptGaugeTokens(
        liveContextUsage?.usedTokens ?? 0,
        snapshotUsage.usedTokens,
      )
    ) {
      liveContextUsage = snapshotUsage;
    }
    promptQueue = queueItems;
    // Fold the fresh snapshot into the cached list — opening a session must
    // never leave its list row showing a stale status light.
    syncSessionSummary(session);
    renderConvView(scrollRestore);
    renderSessionColumn();
    // A transiently failed probe (short 10s budget vs a busy device)
    // renders the legacy composer-row fallback — heal it on settle.
    if (composerCapFor(deviceId) == null) scheduleComposerProbeRetry(deviceId);
    // A STOP-rollback may have fired while this console was closed (or the
    // one-shot event raced the view swap) — pull the latched prompt so it
    // lands back in the composer. Take-once: later resyncs get null.
    void consumePromptRestoreLatch(deviceId, sessionId);
  } catch {
    // A stale failed fetch (a newer loadSession already superseded it) must
    // never paint the error note over a newer loading state or render.
    if (seq !== loadSessionSeq || viewMode !== "conv" || deviceId !== selectedDeviceId) return;
    // A failed fetch says nothing about snapshot content — reset the
    // relevance state so a later retry is never (wrongly) treated as
    // "already rendered" while the view shows the error note.
    convRenderRelevance.reset();
    live?.destroy();
    live = null;
    // Retry refetches in place; Back to home escapes the session view —
    // the failure note replaces the whole conversation pane (header and
    // mobile back button included), so without the escape it is a dead end.
    refs.convView.replaceChildren(sessionLoadErrorView(
      () => retrySessionLoad(sessionId),
      () => goHome(),
    ));
  }
}

/**
 * Retry a failed snapshot load: repaint the loading placeholder and refetch.
 * No scroll restore — this is a fresh-open shape (pin to the newest message).
 */
function retrySessionLoad(sessionId: string): void {
  if (!selectedDeviceId || !client) return;
  refs.convView.replaceChildren(
    el("div", { class: "loading-center" }, el("div", { class: "spinner" }), "Loading session…"),
  );
  void loadSession(sessionId);
}

function renderConvView(restore?: { top: number; atBottom: boolean }): void {
  live?.destroy();
  const session = currentSession!;
  const demoKey = `${selectedDeviceId}:${session.id}`;
  if (demoStatesKey !== demoKey) { demoStatesKey = demoKey; demoStates = new Map(); }
  // Whole-view rebuild: the DOM is about to be replaced wholesale — this
  // snapshot's fingerprint becomes the new render-relevance baseline.
  convRenderRelevance.rendered(session);
  // Snapshot reloads (plan events, ask settle, resync bursts) rebuild the
  // whole view — never lose an unsubmitted composer draft across them.
  const prevDraft = (
    refs.convView.querySelector(".composer-card textarea, .composer textarea") as HTMLTextAreaElement | null
  )?.value ?? "";
  // present_demo: settled scan across the transcript and the prompt queue —
  // the newest unsettled card opens; settled/older ones render collapsed.
  const demoScan = buildDemoScan(
    session.messages,
    promptQueue.map((q) => q.userText),
  );
  const callbacks = {
    onAnswerAsk: (requestId: string, answer: UserAskAnswer) => {
      void client
        ?.request<boolean>(selectedDeviceId!, "respondUserAsk", { requestId, selected: answer.selected, selections: answer.selections ?? null, custom: answer.custom, ...(answer.comment ? { comment: answer.comment } : {}) })
        .then(() => loadSession(session.id))
        .catch(() => loadSession(session.id));
    },
    onCancel: () => {
      void client?.request<boolean>(selectedDeviceId!, "cancelTurn", { sessionId: session.id }).then(() => loadSession(session.id));
    },
    demoStates,
    demoSettledByCallId: demoScan.settledByCallId,
    demoOpenCallId: demoScan.openCallId,
    onSubmitDemoParams: async (
      toolCallId: string,
      values: Record<string, string | number | boolean | null>,
      note?: string,
    ) => {
      const deviceId = selectedDeviceId;
      if (!client || !deviceId) throw new Error("Device is disconnected. Reconnect and try again.");
      const res = await submitDemoConfirm({
        client,
        deviceId,
        sessionId: session.id,
        running: currentSession?.status === "running",
        toolCallId,
        values,
        ...(note ? { note } : {}),
      });
      // A late reply must never navigate back after switching conversations/devices.
      if (viewMode === "conv" && currentSession?.id === session.id && selectedDeviceId === deviceId) {
        if (res.enqueued) applyQueueSnapshot((res.items ?? []) as QueueItemView[]);
        void loadSession(session.id);
      }
      return res;
    },
  };

  const gauge = buildContextGauge(
    composerCapFor(selectedDeviceId)?.defaults.contextLimitTokens,
  );
  gauge.setUsage(liveContextUsage);
  refs.convGauge = gauge;
  const rendered = renderConversation(session, callbacks);
  const scrollHost = el("div", { class: "conv-scroll" }, rendered.stream);
  // Floating scroll-to-bottom button: appears once the user scrolls away
  // from the tail, hides smoothly when back at the bottom.
  const bottomBtn = el("button", {
    class: "scroll-bottom-btn",
    title: "Scroll to bottom",
    onclick: () => stream.autoScroll.follow(),
  }, icon("chevronDown", 16));
  // The scroll-to-bottom button rides INSIDE the floating composer (fade
  // zone, top-right — Mac footer-actions parity) instead of the scrollport:
  // as a scrollport child it would sit underneath the overlay composer.
  const scrollWrap = el("div", { class: "conv-scroll-wrap" }, scrollHost);
  const updateBottomBtn = () => {
    bottomBtn.classList.toggle("shown", stream.shouldShowScrollBottomButton());
  };
  const stream = new ChatLiveStream(rendered.stream, scrollHost, restore?.atBottom ?? true, updateBottomBtn);
  live = stream;
  stream.setCallbacks({
    pendingAsk: session.pendingUserAsk ?? null,
    onAnswerAsk: (requestId, answer) => callbacks.onAnswerAsk(requestId, answer),
    demoStates,
    demoSettledByCallId: demoScan.settledByCallId,
    demoOpenCallId: demoScan.openCallId,
    onSubmitDemoParams: (toolCallId, values, note) => {
      return callbacks.onSubmitDemoParams?.(toolCallId, values, note);
    },
  });
  if (session.status === "running") {
    stream.setStatusLine(session.progressText?.trim() || statusPill(session.status).label, true);
  }
  updateBottomBtn();

  const composerInput = el("textarea", { rows: "1", placeholder: "Send a message to this session… (Enter to send)" }) as HTMLTextAreaElement;
  refs.convComposer = composerInput;
  /** Legacy fallback only — modern builds send through the toolbar round button. */
  const legacySendBtn = el("button", { class: "send-btn" }, icon("send"), "Send") as HTMLButtonElement;
  const composeErr = el("div", { class: "compose-error", hidden: true });

  // ── Mac-parity composer controls (modern device builds only) ──
  const composerOptions = composerCapFor(selectedDeviceId);
  let toolbar: ComposerToolbar | null = null;
  let stage: ReturnType<typeof createAttachmentStage> | null = null;
  let bypassArmed = false;
  let reasoningEffort: ComposerReasoningEffort = "low";
  /** Repaints the mobile collapsed-pill effort chip (assigned during mount). */
  let syncPillEffort: (() => void) | null = null;
  if (convStageSessionId !== session.id) {
    convStageStore = { drafts: [] };
    convStageSessionId = session.id;
  }
  if (composerOptions) {
    const running = session.status === "running";
    bypassArmed = readComposerPrefs(selectedDeviceId!).bypass === true;
    // Modern session rows carry the dial level; legacy rows the Max boolean.
    reasoningEffort = isComposerReasoningEffort(session.reasoningEffort)
      ? session.reasoningEffort
      : (session as { reasoningEffortMax?: boolean | null }).reasoningEffortMax === true
        ? "max"
        : isComposerReasoningEffort(composerOptions.defaults.reasoningEffort)
          ? composerOptions.defaults.reasoningEffort
          : composerOptions.defaults.reasoningEffortMax === true
            ? "max"
            : "low";
    const infinite = session.composerInfinite ?? composerOptions.defaults.composerInfinite;
    toolbar = buildComposerToolbar(
      {
        providers: composerOptions.providers,
        state: {
          providerId: session.providerId ?? composerOptions.activeProviderId,
          reasoningEffort,
          infinite,
          bypass: bypassArmed,
        },
        bypassAvailable: composerOptions.remoteMode === "full",
        providerFallbackLabel: session.model ?? null,
      },
      {
        onPickFiles: (files) => stage?.addFiles(files),
        onRemoveAttachment: (id) => stage?.remove(id),
        onProviderMenuOpen: () => {
          // Session-bound provider selection: only refresh the list in
          // place — a deleted profile falls back to the session model label.
          void refreshComposerOptionsOnMenuOpen(selectedDeviceId!).then((fresh) => {
            if (fresh) toolbar?.setProviders(fresh.providers);
          });
        },
        onPickProvider: (providerId) => {
          void client
            ?.request<Session>(selectedDeviceId!, "setSessionProvider", { sessionId: session.id, providerId })
            .then(() => loadSession(session.id, readConvScrollState() ?? undefined))
            .catch((err: Error) => {
              composeErr.textContent = err.message;
              composeErr.hidden = false;
            });
        },
        onReasoningEffortSelect: (level) => {
          stageOptimisticComposer(session.id, { reasoningEffort: level });
          void client
            ?.request(selectedDeviceId!, "setComposerPrefs", { sessionId: session.id, patch: { reasoningEffort: level } })
            .then(() => {
              reasoningEffort = level;
              if (currentSession?.id === session.id) currentSession.reasoningEffort = level;
              syncPillEffort?.();
            })
            .catch((err: Error) => {
              dropOptimisticComposer(session.id, { reasoningEffort: level });
              toolbar?.setState({ reasoningEffort });
              composeErr.textContent = err.message;
              composeErr.hidden = false;
            });
        },
        onToggleInfinite: (next) => {
          stageOptimisticComposer(session.id, { infinite: next });
          void client
            ?.request(selectedDeviceId!, "setComposerPrefs", { sessionId: session.id, patch: { infinite: next } })
            .then(() => {
              if (currentSession?.id === session.id) currentSession.composerInfinite = next;
            })
            .catch((err: Error) => {
              dropOptimisticComposer(session.id, { infinite: next });
              toolbar?.setState({ infinite: !next });
              composeErr.textContent = err.message;
              composeErr.hidden = false;
            });
        },
        onToggleBypass: (next) => {
          bypassArmed = next;
          writeComposerPrefs(selectedDeviceId!, { bypass: next });
        },
        onSend: () => void submit(),
        onStop: () => callbacks.onCancel(),
      },
    );
    stage = createAttachmentStage(selectedDeviceId!, toolbar, convStageStore);
    toolbar.setLocked(running);
    toolbar.setRunning(running);
    // Context usage rides the round button (Mac ring parity): progress ring
    // on every breakpoint, hover tooltip with the raw numbers desktop-side.
    gauge.attachRing(toolbar.sendWrap);
    gauge.attachTooltip(toolbar.sendWrap);
  }

  // ── prompt queue (queue-capable device builds, Mac parity) ──
  // Queue actions ship with the modern composer surface — a legacy composer
  // (no toolbar) always falls back to the historical send path.
  const queueCap = !!composerOptions && queueCaps.get(selectedDeviceId ?? "") === true;
  const gesture: { running: boolean } = { running: session.status === "running" };
  let composerSubmitting = false;
  let enqueuePending = false;
  let insertAfterEnqueue = false;
  convGestureState = gesture;

  /** Queue mutation → device; mirrors the reply snapshot into the view. */
  const queueMutate = async (
    action: "promoteQueuedPrompt" | "deferQueuedPrompt" | "removeQueuedPrompt" | "moveQueuedPromptToFront" | "updateQueuedPromptText",
    payload: Record<string, unknown>,
  ): Promise<void> => {
    if (!client || !selectedDeviceId) return;
    try {
      const res = await client.request<PromptQueueMutationResponse>(selectedDeviceId, action, {
        sessionId: session.id,
        ...payload,
      });
      applyQueueSnapshot(res.items);
      // Promote on an idle session starts the turn right away.
      if (res.ok && res.started) {
        gesture.running = true;
        convQueueView?.setSessionIdle(false);
        syncPillRunning?.();
        void refreshSessions();
      }
    } catch (err) {
      composeErr.textContent = (err as Error).message;
      composeErr.hidden = false;
    }
  };

  let queueView: PromptQueueView | null = null;
  if (queueCap) {
    queueView = new PromptQueueView();
    convQueueView = queueView;
    queueView.setSessionIdle(!gesture.running);
    queueView.setItems(promptQueue.map(queuedPromptToViewItem));
    queueView.setHandlers({
      onRemove: (id) => void queueMutate("removeQueuedPrompt", { promptId: id }),
      onUpdateText: (id, text) => void queueMutate("updateQueuedPromptText", { promptId: id, text }),
      onMoveToFront: (id) => void queueMutate("moveQueuedPromptToFront", { promptId: id }),
      onPromote: (id) => void queueMutate("promoteQueuedPrompt", { promptId: id }),
      onDefer: (id) => void queueMutate("deferQueuedPrompt", { promptId: id }),
    });
  }

  const syncSendEnabled = () => {
    const blocked = composerSubmitting || (!composerInput.value.trim() && (stage ? convStageStore.drafts.length === 0 : true));
    if (toolbar) toolbar.setSendDisabled(blocked);
    else legacySendBtn.disabled = blocked;
  };
  /**
   * Mac syncSendEnabled parity: the round button mirrors the resolved submit
   * gesture — stop square, queue-labelled send, or plain send. Queue-capable
   * devices use the full matrix; legacy devices keep the boolean behavior.
   */
  const syncSubmitGesture = () => {
    if (!queueCap || !toolbar) {
      syncSendEnabled();
      return;
    }
    const hasContent = !!(composerInput.value.trim() || (stage ? convStageStore.drafts.length > 0 : false));
    const action = resolveComposerSubmitAction({
      hasContent,
      running: gesture.running,
      queueHasDeferred: promptQueue.some((q) => q.mode === "deferred"),
    });
    toolbar.setStopMode(action === "stop", { steer: action === "enqueue" || action === "promote-head" });
    toolbar.setSendDisabled(composerSubmitting || (action === "send" && !hasContent));
  };
  convSubmitGesture = syncSubmitGesture;
  stage?.sync();

  // Auto-grow with content — Mac syncTextareaHeight keeps 1–5 lines.
  const autoGrow = () => {
    composerInput.style.height = "auto";
    const line = Number.parseFloat(window.getComputedStyle(composerInput).lineHeight) || 20.25;
    composerInput.style.height = `${Math.min(5 * line, Math.max(1 * line, composerInput.scrollHeight))}px`;
  };
  composerInput.addEventListener("input", () => {
    autoGrow();
    syncSubmitGesture();
  });
  if (prevDraft) {
    composerInput.value = prevDraft;
    autoGrow();
  }
  syncSubmitGesture();

  const send = async () => {
    const text = composerInput.value.trim();
    const staged = stage ? convStageStore.drafts : [];
    if ((!text && staged.length === 0) || !client || !selectedDeviceId) return;
    if (toolbar) toolbar.setSendDisabled(true);
    else legacySendBtn.disabled = true;
    composeErr.hidden = true;
    const attachments = stage?.take() ?? [];
    composerInput.value = "";
    autoGrow();
    try {
      const res = await client.request<StartTurnResponse>(selectedDeviceId!, "startTurn", {
        sessionId: session.id,
        userText: text,
        // Mac composer pass-through (legacy bridges ignore the extras).
        fullPermissions: bypassArmed,
        reasoningEffort,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      gesture.running = true;
      queueView?.setSessionIdle(false);
      syncPillRunning?.();
      if (res.sessionId !== session.id) await openSession(res.sessionId);
      else {
        toolbar?.setRunning(true);
        void refreshSessions();
      }
    } catch (err) {
      if (!composerInput.value.trim()) composerInput.value = text;
      stage?.restore(attachments);
      autoGrow();
      composeErr.textContent = (err as Error).message;
      composeErr.hidden = false;
    } finally {
      syncSubmitGesture();
    }
  };

  /** First submit waits for the next turn; a second empty Enter inserts now. */
  const enqueue = async () => {
    const text = composerInput.value.trim();
    const staged = stage ? convStageStore.drafts : [];
    if ((!text && staged.length === 0) || !client || !selectedDeviceId) return false;
    toolbar?.setSendDisabled(true);
    composeErr.hidden = true;
    const attachments = stage?.take() ?? [];
    composerInput.value = "";
    autoGrow();
    try {
      const res = await client.request<EnqueuePromptResponse>(selectedDeviceId!, "enqueuePrompt", {
        sessionId: session.id,
        userText: text,
        mode: "deferred",
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      applyQueueSnapshot(res.items);
      return true;
    } catch (err) {
      if (!composerInput.value.trim()) composerInput.value = text;
      stage?.restore(attachments);
      autoGrow();
      composeErr.textContent = (err as Error).message;
      composeErr.hidden = false;
      return false;
    } finally {
      syncSubmitGesture();
    }
  };

  /**
   * Composer submit gesture — Mac promptQueueGesture parity: idle sends,
   * running queues; empty composer + waiting queue promotes the head, empty
   * composer + empty queue stops. Legacy devices (no queue actions) keep the
   * historical send path (startTurn errors while running).
   */
  const submit = async (keyboard = false): Promise<void> => {
    const hasContent = !!(composerInput.value.trim() || (stage ? convStageStore.drafts.length > 0 : false));
    if (composerSubmitting) {
      if (keyboard && enqueuePending && !hasContent) insertAfterEnqueue = true;
      return;
    }
    composerSubmitting = true;
    syncSubmitGesture();
    try {
      if (!queueCap) return await send();
      const action = resolveComposerSubmitAction({
        hasContent,
        running: gesture.running,
        queueHasDeferred: promptQueue.some((q) => q.mode === "deferred"),
      });
      switch (action) {
        case "send":
          return await send();
        case "enqueue": {
          enqueuePending = true;
          const queued = await enqueue();
          if (queued && insertAfterEnqueue && gesture.running && refs.convComposer === composerInput) {
            const head = promptQueue.find((q) => q.mode === "deferred");
            if (head) await queueMutate("promoteQueuedPrompt", { promptId: head.id });
          }
          return;
        }
        case "promote-head": {
          const head = promptQueue.find((q) => q.mode === "deferred");
          if (head) await queueMutate("promoteQueuedPrompt", { promptId: head.id });
          return;
        }
        case "stop":
          callbacks.onCancel();
          return;
        default:
          return;
      }
    } finally {
      composerSubmitting = false;
      enqueuePending = false;
      insertAfterEnqueue = false;
      syncSubmitGesture();
    }
  };
  legacySendBtn.addEventListener("click", () => void submit());
  composerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !(e as KeyboardEvent).isComposing) {
      e.preventDefault();
      if (e.repeat) return;
      void submit(true);
    }
  });

  refs.convView.replaceChildren();
  // ── conv-head live strip (mobile running) ──
  // While a turn runs on phones, the title is replaced by the desktop
  // ContextPill content, inline (not floating): single-line variant —
  // plan active → current step + dots + timer; otherwise the latest
  // prompt + files chip; progress text only as a last resort. No
  // spinner (user decision). Content is driven by syncConvLive().
  const convLivePromptText = el("span", { class: "conv-live-prompt-text" });
  const convLiveFiles = el("span", { class: "conv-live-files", hidden: true });
  const convLiveDots = el("span", { class: "conv-live-dots", "aria-hidden": "true" });
  const convLiveStep = el("span", { class: "conv-live-step" });
  const convLiveTimer = el("span", { class: "conv-live-timer" });
  const convLiveProgLabel = el("span", { class: "conversation-status-label conv-live-prog-label" });
  const convLive = el("div", { class: "conv-live" },
    el("div", { class: "conv-live-row", hidden: true }, convLivePromptText, convLiveFiles),
    el("div", { class: "conv-live-row", hidden: true }, convLiveDots, convLiveStep, convLiveTimer),
    el("div", { class: "conv-live-row", hidden: true }, convLiveProgLabel),
  );
  const convHead = el("div", { class: "conv-head" },
    // Mobile-only back affordance (desktop hides it in style.css).
    el("button", {
      class: "m-back", type: "button",
      title: "Back", "aria-label": "Back",
      onclick: () => goHome(),
    }, icon("back", 18)),
    el("h1", {}, session.title || "Untitled"),
    convLive,
    el("button", {
      class: "conv-files-btn", type: "button",
      title: "Files", "aria-label": "Conversation files",
      onclick: () => filesPanel.open(session.id),
    }, icon("files", 16)),
  );
  refs.convHead = convHead;
  refs.convLive = {
    root: convLive,
    promptRow: convLivePromptText.parentElement!,
    promptText: convLivePromptText,
    files: convLiveFiles,
    taskRow: convLiveDots.parentElement!,
    dots: convLiveDots,
    step: convLiveStep,
    timer: convLiveTimer,
    progRow: convLiveProgLabel.parentElement!,
    progLabel: convLiveProgLabel,
  };
  refs.convView.append(
    // Head row keeps ONLY the title on every breakpoint — the status text
    // lives on the live Thinking block's title (mobile run pill mirrors it)
    // and context usage rides the send/stop rings.
    convHead,
    scrollWrap,
    (() => {
      const composerBox = el("div", { class: "composer" }, bottomBtn);
      stream.attachComposerViewport(scrollHost, composerBox);
      // ── plan approval bar (Mac footer parity: plan review
      //    → queue → composer card). Recreated per session so closures bind
      //    the right sessionId; the host node survives view rebuilds.
      if (!planReview || planReviewSessionId !== session.id) {
        planReviewSessionId = session.id;
        planReview = createPlanReviewSync({
          runAction: (action) => {
            if (!client || !selectedDeviceId) {
              return Promise.resolve({ ok: false, error: "Connection lost." });
            }
            return client.request<{ ok: boolean; error?: string }>(
              selectedDeviceId,
              action,
              { sessionId: session.id },
            );
          },
          loadMarkdown: async (path) => {
            if (!client || !selectedDeviceId) {
              throw new Error("Preview unavailable — connection lost.");
            }
            // {ok:false} carries the device's refusal (scoping, 1 MB cap,
            // binary reject) — throw it so the preview body shows the real
            // reason instead of the generic fallback.
            const res = await client.request<{
              ok?: boolean;
              message?: string;
              content?: string;
            }>(selectedDeviceId, "readTextFile", { sessionId: session.id, path });
            if (!res || typeof res !== "object" || res.ok !== true) {
              throw new Error(
                (res && typeof res.message === "string" && res.message) ||
                  "Could not load plan document.",
              );
            }
            if (typeof res.content !== "string") {
              throw new Error("Could not load plan document.");
            }
            return res.content;
          },
          onAfterAction: () => {
            void loadSession(session.id);
            void refreshSessionsQuiet();
          },
        });
      }
      composerBox.append(planReview.host);
      planReview.sync(session);
      if (toolbar) {
        // Queued prompts fold open directly above the composer card —
        // the same stack position as the desktop footer.
        if (queueView) composerBox.append(queueView.root);
        // The card wears the running zebra stripes (scanbar replacement);
        // syncRunPill below seeds .is-running from the snapshot.
        const composerCard = el("div", { class: "composer-card" },
          el("div", { class: "composer-stripes" },
            el("div", { class: "composer-stripes-layer" })),
          toolbar.attachments,
          composerInput,
          toolbar.root,
          composeErr);
        refs.convComposerCard = composerCard;
        composerBox.append(composerCard);

        // ── Mobile collapsed composer (single-line bar ⇄ full form) ──
        // Phones idle with an empty draft show a compact pill (message-bubble
        // icon + placeholder + effort chip); tapping it expands the full
        // composer and focuses the textarea. Collapse needs: blur + empty
        // input + no attachments + no queue + not running + no compose error.
        // Desktop never mounts the bar.
        const pillEffort = el("span", { class: "composer-provider-effort-chip", hidden: true });
        syncPillEffort = () => {
          pillEffort.hidden = reasoningEffort === "low";
          pillEffort.textContent = reasoningEffort.toUpperCase();
          pillEffort.classList.toggle("is-max", reasoningEffort === "max");
          pillEffort.classList.toggle("is-off", reasoningEffort === "off");
          pillEffort.dataset.level = reasoningEffort;
        };
        syncPillEffort();
        const pillBtn = el("button", {
          class: "composer-pill", type: "button",
          "aria-label": "Open composer", "aria-expanded": "false",
        },
          el("div", { class: "composer-stripes" },
            el("div", { class: "composer-stripes-layer" })),
          el("span", { class: "composer-pill-icon", "aria-hidden": "true" }, icon("messageSquare", 15)),
          el("span", { class: "composer-pill-text" }, "Send a message…"),
          pillEffort,
        );
        // Running variant — the SAME capsule shell with the toolbar's 36px
        // stop button tucked into its right end (wrapped for the context
        // ring); the left zone doubles as the steer affordance (tap →
        // expand + focus) and carries the live status line. Idle/running
        // variants swap via .is-running on the bar (no height change → no
        // morph).
        const runStatusText = el(
          "span",
          { class: "composer-run-status" },
          session.status === "running" ? statusPill(session.status).label : "Steer this turn…",
        );
        refs.convRunStatus = runStatusText;
        const runSteerBtn = el("button", {
          class: "composer-run-steer", type: "button",
          "aria-label": "Open composer", "aria-expanded": "false",
        },
          el("span", { class: "composer-pill-icon", "aria-hidden": "true" }, icon("messageSquare", 15)),
          runStatusText,
        );
        const stopWrap = el("div", { class: "composer-stop-wrap" },
          el("button", {
            class: "composer-stop-btn", type: "button",
            title: "Stop", "aria-label": "Stop turn",
            onclick: () => callbacks.onCancel(),
          }, icon("stop", 15)),
        );
        gauge.attachRing(stopWrap);
        const runPill = el("div", { class: "composer-run-pill" },
          el("div", { class: "composer-stripes" },
            el("div", { class: "composer-stripes-layer" })),
          runSteerBtn,
          stopWrap,
        );
        refs.convRunPill = runPill;
        const pillBar = el("div", { class: "composer-pill-bar" }, pillBtn, runPill);
        composerBox.append(pillBar);

        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        // Collapse no longer requires an idle turn: running sessions with an
        // untouched draft fold to the run capsule (steer zone + stop button).
        const collapseAllowed = () =>
          convMobileMQ.matches &&
          !composerInput.value.trim() &&
          !composerInput.disabled &&
          convStageStore.drafts.length === 0 &&
          promptQueue.length === 0 &&
          composeErr.hidden;
        let collapsed = false;
        let morphSeq = 0;
        /** Swap forms with a height morph so the conversation never jumps. */
        const morphTo = (next: boolean): void => {
          const seq = ++morphSeq;
          const from = reducedMotion || !convMobileMQ.matches ? -1 : composerBox.offsetHeight;
          if (from >= 0) composerBox.style.height = `${from}px`;
          composerBox.classList.toggle("is-collapsed", next);
          const expanded = next ? "false" : "true";
          pillBtn.setAttribute("aria-expanded", expanded);
          runSteerBtn.setAttribute("aria-expanded", expanded);
          if (from < 0) return;
          requestAnimationFrame(() => {
            composerBox.style.height = "";
            const to = composerBox.offsetHeight;
            if (to === from) return;
            composerBox.style.height = `${from}px`;
            void composerBox.offsetHeight; // commit the start height, then animate
            composerBox.style.height = `${to}px`;
            const release = () => {
              if (seq !== morphSeq) return;
              morphSeq++;
              composerBox.style.height = "";
              composerBox.removeEventListener("transitionend", onEnd);
            };
            const onEnd = (ev: TransitionEvent): void => {
              if (ev.target !== composerBox || ev.propertyName !== "height") return;
              release();
            };
            composerBox.addEventListener("transitionend", onEnd);
            window.setTimeout(release, 460); // safety net if transitionend is lost
          });
        };
        const setCollapsed = (next: boolean): void => {
          if (next === collapsed) return;
          if (next && !collapseAllowed()) return;
          collapsed = next;
          morphTo(next);
        };
        convComposerCollapse = { setCollapsed };
        // Idle ⇄ running capsule variant is RETIRED (user decision): while a
        // turn runs the mobile bottom keeps the idle collapsed pill — tap to
        // expand, stop lives in the expanded toolbar. The header live strip
        // (syncConvLive below) is the single activity surface. Stripes ride
        // the composer card AND the collapsed idle pill — on mobile the pill
        // is the always-visible bottom surface, so it carries the running cue.
        const syncRunPill = (): void => {
          composerCard.classList.toggle("is-running", gesture.running);
          pillBtn.classList.toggle("is-running", gesture.running);
          // Header live strip rides the same running flips.
          syncConvLive();
        };
        syncPillRunning = syncRunPill;
        syncRunPill();
        const expandAndFocus = (): void => {
          setCollapsed(false);
          // Same task as the tap gesture → iOS opens the keyboard.
          composerInput.focus();
        };
        pillBtn.addEventListener("click", expandAndFocus);
        runSteerBtn.addEventListener("click", expandAndFocus);
        composerInput.addEventListener("focus", () => {
          setCollapsed(false);
          // On phones the keyboard shrinks the pane right after focus —
          // keep the conversation tail visible above the composer.
          if (convMobileMQ.matches) {
            stream.autoScroll.contentChanged();
          }
        });
        composerInput.addEventListener("blur", () => {
          // Grace period: taps on send/stop register before the collapse check.
          window.setTimeout(() => setCollapsed(true), 160);
        });
        // Start collapsed when the session opens clean (no morph on mount).
        if (collapseAllowed()) {
          collapsed = true;
          composerBox.classList.add("is-collapsed");
          pillBtn.setAttribute("aria-expanded", "false");
          runSteerBtn.setAttribute("aria-expanded", "false");
        }
      } else if (composerProbePending(selectedDeviceId)) {
        // Capability probe unresolved on an online device — no default
        // composer while it settles (user decision). The retry ladder /
        // settle repaint swaps in the toolbar or the legacy row.
        composerBox.append(buildComposerLoading());
      } else {
        composerBox.append(
          el("div", { class: "composer-row" }, composerInput, legacySendBtn),
          composeErr,
        );
      }
      return composerBox;
    })(),
  );

  // Seed the mobile header live strip from the snapshot (the head was just
  // rebuilt above — running sessions pick up prompt/plan content right away).
  syncConvLive();

  // Snap to bottom after layout: scrollTop assignments on a detached node are
  // ignored. Preserve both the reader's offset and explicit follow state.
  requestAnimationFrame(() => {
    if (live !== stream) return;
    if (restore && !restore.atBottom) stream.autoScroll.restoreTop(restore.top);
    stream.autoScroll.snapIfFollowing();
    updateBottomBtn();
  });
}

// ── live stream events ───────────────────────────────────────
/** Pending turn-idle resync timers, by session id (dedup across status/done). */
const idleResyncTimers = new Map<string, () => void>();
let loadSessionSeq = 0;

// ── optimistic composer prefs (toggle vs snapshot race) ──────────────
// Turning Infinite / Effort only writes the device-side session row
// asynchronously, while idle/ask/steer resyncs fire loadSession up to
// ~1.6s after a turn. A snapshot fetched inside that window still carries
// the old value and would rebuild the toolbar with the switch visually
// reverted. Patches survive until the snapshot agrees (device persisted
// the toggle) or the TTL lapses.
type OptimisticComposerPatch = { infinite?: boolean; reasoningEffort?: ComposerReasoningEffort; expires: number };
const optimisticComposer = new Map<string, OptimisticComposerPatch>();
const OPTIMISTIC_COMPOSER_TTL_MS = 8000;

function stageOptimisticComposer(sessionId: string, patch: Omit<OptimisticComposerPatch, "expires">): void {
  const prev = optimisticComposer.get(sessionId);
  const base = prev && prev.expires > Date.now() ? prev : ({} as OptimisticComposerPatch);
  optimisticComposer.set(sessionId, { ...base, ...patch, expires: Date.now() + OPTIMISTIC_COMPOSER_TTL_MS });
}

function dropOptimisticComposer(sessionId: string, patch: Omit<OptimisticComposerPatch, "expires">): void {
  const prev = optimisticComposer.get(sessionId);
  if (!prev) return;
  for (const key of Object.keys(patch) as ("infinite" | "reasoningEffort")[]) {
    if (prev[key] === patch[key]) delete prev[key];
  }
  if (Object.keys(prev).length <= 1) optimisticComposer.delete(sessionId);
}

/** Fold in-flight toggles so a racing snapshot reload keeps the switch lit. */
function applyOptimisticComposer(session: Session): void {
  const patch = optimisticComposer.get(session.id);
  if (!patch) return;
  if (patch.expires <= Date.now()) {
    optimisticComposer.delete(session.id);
    return;
  }
  let agreed = true;
  if (patch.infinite !== undefined) {
    if (session.composerInfinite === patch.infinite) delete patch.infinite;
    else { session.composerInfinite = patch.infinite; agreed = false; }
  }
  if (patch.reasoningEffort !== undefined) {
    if (session.reasoningEffort === patch.reasoningEffort) delete patch.reasoningEffort;
    else { session.reasoningEffort = patch.reasoningEffort; agreed = false; }
  }
  if (agreed) optimisticComposer.delete(session.id);
}

/**
 * Staggered snapshot refreshes after a turn settles. The first reload races
 * the device store write (tool_result with the file_diff part), so retry
 * until the streamed preview cards normalize into their final bodies.
 */
function scheduleIdleResync(sessionId: string): void {
  cancelIdleResync(sessionId);
  // Chain one retry at a time: the first reload races the device store write
  // (tool_result rows land right after the done broadcast), so each retry is
  // armed only after the previous one fired. The old [400,1400,3000] volley
  // self-cancelled — every callback called cancelIdleResync first, so only
  // the 400ms one ever ran and the "staggered retries" were fiction.
  const chain = (delays: readonly number[]): void => {
    const [head, ...rest] = delays;
    const timer = window.setTimeout(() => {
      idleResyncTimers.delete(sessionId);
      if (currentSession?.id === sessionId && viewMode === "conv") {
        void loadSession(sessionId, readConvScrollState() ?? undefined);
      }
      if (rest.length > 0) chain(rest);
    }, head);
    idleResyncTimers.set(sessionId, () => window.clearTimeout(timer));
  };
  chain([400, 1000, 1600]);
}

function cancelIdleResync(sessionId: string): void {
  idleResyncTimers.get(sessionId)?.();
  idleResyncTimers.delete(sessionId);
}

// ── STOP-rollback prompt restore (Mac parity) ─────────────────
/**
 * Put a STOP-before-content prompt back into the web composer. Never
 * clobbers new input — if the user already typed something after stopping,
 * the restore is skipped. Attachments are reported dropped (their staged
 * files live on the device; the Mac composer keeps them).
 */
function restorePromptToWebComposer(text: string, droppedAttachments: number): void {
  const input = refs.convComposer;
  if (!input) return;
  if (input.value.trim().length > 0) return;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  if (droppedAttachments > 0) {
    console.info(
      `[console] prompt restored without ${droppedAttachments} attachment(s) — re-attach from the Mac composer`,
    );
  }
}

/** loadSession-time latch consumption for a rollback the console missed. */
async function consumePromptRestoreLatch(deviceId: string, sessionId: string): Promise<void> {
  if (!client) return;
  try {
    const payload = await client.request<{ text: string } | null>(deviceId, "takePromptRestore", { sessionId });
    if (!payload || typeof payload.text !== "string") return;
    if (currentSession?.id === sessionId && viewMode === "conv") {
      restorePromptToWebComposer(payload.text, 0);
    }
  } catch {
    // Older device builds without the action — nothing to restore.
  }
}

// ── tool card snapshot refresh (tool_finished) ────────────────
/** Debounced getSession pulls per session, keyed by session id. */
const toolRefreshTimers = new Map<string, number>();

/**
 * A tool finished mid-turn: swap its live running card for the snapshot
 * version (status, exit code, output) in place — streaming text/reasoning
 * keep flowing untouched. Debounced so tool bursts coalesce into one pull;
 * the done/idle staggered resync remains the final normalizer.
 */
function scheduleToolCardRefresh(sessionId: string): void {
  const prev = toolRefreshTimers.get(sessionId);
  if (prev) window.clearTimeout(prev);
  toolRefreshTimers.set(sessionId, window.setTimeout(() => {
    toolRefreshTimers.delete(sessionId);
    if (currentSession?.id !== sessionId || viewMode !== "conv" || !client || !selectedDeviceId || !live) return;
    void client
      .request<Session | null>(selectedDeviceId, "getSession", { sessionId })
      .then((session) => {
        if (!session || currentSession?.id !== sessionId || !live) return;
        currentSession = session;
        live.refreshToolCards(session);
      })
      .catch(() => {
        // Transient failure — the idle resync sweep still normalizes.
      });
  }, 250));
}

/** Capture the conversation scroll position so resyncs don't yank the view. */
function readConvScrollState(): { top: number; atBottom: boolean } | null {
  const host = refs.convView.querySelector(".conv-scroll") as HTMLElement | null;
  if (!host) return null;
  return {
    top: host.scrollTop,
    atBottom: live?.autoScroll.following ?? true,
  };
}

/**
 * Debounced snapshot reload when an ask settles (answered here or on the Mac).
 * Small delay lets the device append + persist the ask tool result so the
 * card renders its final body instead of a "Running…" stub.
 */
const askResyncTimers = new Map<string, number>();

function scheduleAskResync(sessionId: string, delay = 250): void {
  const prev = askResyncTimers.get(sessionId);
  if (prev) window.clearTimeout(prev);
  askResyncTimers.set(sessionId, window.setTimeout(() => {
    askResyncTimers.delete(sessionId);
    if (currentSession?.id === sessionId && viewMode === "conv") {
      void loadSession(sessionId, readConvScrollState() ?? undefined);
    }
  }, delay));
}

/**
 * Debounced snapshot reload when a steer prompt lands mid-turn: the queued
 * row is removed by the prompt_queue snapshot, but the user message card in
 * the transcript only materializes via a fresh session snapshot (same rule
 * as the desktop's structural refresh after steer_consumed).
 */
const steerResyncTimers = new Map<string, number>();

function scheduleSteerResync(sessionId: string, delay = 250): void {
  const prev = steerResyncTimers.get(sessionId);
  if (prev) window.clearTimeout(prev);
  steerResyncTimers.set(sessionId, window.setTimeout(() => {
    steerResyncTimers.delete(sessionId);
    if (currentSession?.id === sessionId && viewMode === "conv") {
      void loadSession(sessionId, readConvScrollState() ?? undefined);
    }
  }, delay));
}

/**
 * Debounced snapshot reload at turn start (status "running"): the user
 * message card is persisted on the device before the event fires, but the
 * stream carries no user-message payload — without this reload a prompt
 * sent on the Mac (or a queue-drain follow-up) stays invisible in the open
 * conversation until the turn goes idle. Mirrors the desktop's
 * status==="running" → assistantSliceRefresh reconciliation.
 */
const turnStartResyncTimers = new Map<string, number>();

function scheduleTurnStartResync(sessionId: string, delay = 250): void {
  const prev = turnStartResyncTimers.get(sessionId);
  if (prev) window.clearTimeout(prev);
  turnStartResyncTimers.set(sessionId, window.setTimeout(() => {
    turnStartResyncTimers.delete(sessionId);
    if (currentSession?.id === sessionId && viewMode === "conv") {
      void loadSession(sessionId, readConvScrollState() ?? undefined);
    }
  }, delay));
}

/**
 * Turn status routing (B plan, desktop parity): the status text lives on
 * the live Thinking block's title in the transcript; the mobile run pill
 * mirrors the line while the turn runs.
 */
function setConvStatus(
  text: string,
  opts: { visible?: boolean; active?: boolean; animated?: boolean } = {},
): void {
  const trimmed = text.trim();
  const show = opts.visible !== false && trimmed.length > 0;
  live?.setStatusLine(trimmed, show);
  // Mobile run pill: the steer zone mirrors the status line while the turn
  // is live; idle falls back to the steer placeholder.
  const runStatus = refs.convRunStatus;
  if (runStatus) {
    runStatus.textContent = show ? trimmed : "Steer this turn…";
    runStatus.classList.toggle("is-animated", show && opts.animated === true);
  }
}

/**
 * Card-painting tool calls in flight (tool_call → tool_finished). While a
 * card tool runs, its card is the feedback — the status line (Thinking
 * shell title + mobile run pill) must not show beside it (Mac Write/Patch
 * rule). Web only suppresses once the card is actually on screen: during
 * args streaming the web paints no preview card, so the preparing line
 * stays as the only live signal until tool_call lands.
 */
const cardToolCallIds = new Set<string>();

/**
 * Mobile conv-head live strip — the desktop ContextPill content inline
 * (single-line variant, no spinner): plan active → current step + dots +
 * timer; otherwise the latest prompt + files chip; progress text only as
 * a last resort. Flipped and filled by the same running transitions that
 * drive the composer stripes.
 */
function syncConvLive(): void {
  const live = refs.convLive;
  if (!live) return;
  const running = convGestureState?.running === true;
  refs.convHead?.classList.toggle("is-live", running && convMobileMQ.matches);
  const stopTimer = (): void => {
    if (convLiveTimerId != null) {
      window.clearInterval(convLiveTimerId);
      convLiveTimerId = null;
    }
  };
  if (!running) {
    stopTimer();
    convLiveStartedAt = 0;
    live.promptRow.hidden = true;
    live.taskRow.hidden = true;
    live.progRow.hidden = true;
    return;
  }
  if (convLiveStartedAt === 0) convLiveStartedAt = Date.now();
  if (convLiveTimerId == null) {
    const tick = (): void => {
      const s = Math.max(0, Math.floor((Date.now() - convLiveStartedAt) / 1000));
      live.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    tick();
    convLiveTimerId = window.setInterval(tick, 1000);
  }

  const messages = currentSession?.messages ?? [];
  let lastUser: Session["messages"][number] | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") { lastUser = messages[i]!; break; }
  }
  const text = lastUser ? pillTextFromParts(lastUser.parts as Array<Record<string, unknown>>) : null;
  const files = lastUser ? pillFilesFromParts(lastUser.parts as Array<Record<string, unknown>>) : null;

  // Latest ACTIVE plan snapshot (map values keep creation order).
  const { plansByCreateToolCallId } = buildPlansByCreateToolCallId(messages);
  let plan: PlanSnapshot | null = null;
  for (const snapshot of plansByCreateToolCallId.values()) {
    if (snapshot.status === "active") plan = snapshot;
  }

  if (plan) {
    // Task row: dots (≤6 + overflow count) + running step + timer.
    const states = plan.steps.map((s) => pillStepState(s.status));
    const currentIdx = states.indexOf("current");
    const stepText = currentIdx >= 0 ? (plan.steps[currentIdx]?.title ?? plan.title) : plan.title;
    live.step.textContent = stepText;
    live.step.title = plan.title;
    const MAX_DOTS = 6;
    const shown = states.slice(0, MAX_DOTS);
    live.dots.replaceChildren(
      ...shown.map((s) => el("i", { class: s })),
    );
    if (states.length > MAX_DOTS) {
      live.dots.append(el("span", { class: "conv-live-dots-overflow" }, `+${states.length - MAX_DOTS}`));
    }
    live.taskRow.hidden = false;
    live.promptRow.hidden = true;
    live.progRow.hidden = true;
  } else if (text || files) {
    // Prompt row: echo + files chip (files-only prompts hide the text).
    live.promptText.textContent = text ?? "";
    live.promptText.hidden = !text;
    if (files) {
      live.files.hidden = false;
      live.files.textContent = `${files.length}`;
      live.files.title = files.join("\n");
    } else {
      live.files.hidden = true;
    }
    live.promptRow.hidden = false;
    live.taskRow.hidden = true;
    live.progRow.hidden = true;
  } else {
    // Last resort: live progress line (tool-result turns, resync gaps).
    live.progLabel.textContent = currentSession?.progressText?.trim() || "Executing tool…";
    live.progRow.hidden = false;
    live.promptRow.hidden = true;
    live.taskRow.hidden = true;
  }
}

function handleStreamEvent(sessionId: string, event: ConsoleStreamEvent): void {
  // Deleted on the device — drop it live: bounce an open view home and
  // re-pull the list (debounced) so the row disappears without a refresh.
  if (event.type === "session_deleted") {
    if (currentSession?.id === sessionId) {
      goHome("This session was deleted on the device.");
    }
    refreshSessionsQuiet();
    return;
  }
  if (!currentSession || sessionId !== currentSession.id) {
    // Events for other sessions of the subscribed device (or none open):
    // turn starts/ends still matter to the session list — its status lights
    // used to keep spinning after a turn had gone idle elsewhere.
    if (event.type === "status" || event.type === "done") refreshSessionsQuiet();
    return;
  }
  switch (event.type) {
    case "user_ask": {
      // Device-side ask lifecycle (sessionRuntime → bridge). Mount the
      // interactive panel onto the streamed running card in place.
      const ask = event.ask;
      if (!ask || typeof ask.requestId !== "string" || typeof ask.toolCallId !== "string") break;
      livePendingAsk = {
        requestId: ask.requestId,
        toolCallId: ask.toolCallId,
        question: typeof ask.question === "string" ? ask.question : "",
        options: Array.isArray(ask.options) ? ask.options.filter((o): o is string => typeof o === "string") : [],
        ...(ask.optionDetails ? { optionDetails: ask.optionDetails } : {}),
        allowCustom: ask.allowCustom === true,
        allowMultiple: ask.allowMultiple === true,
      };
      const mounted = live?.attachPendingAsk(livePendingAsk) ?? false;
      // Card not streamed yet (subscribe raced) — snapshot render carries it.
      if (!mounted) void loadSession(sessionId);
      break;
    }
    case "user_ask_dismiss": {
      if (typeof event.requestId === "string" && livePendingAsk?.requestId === event.requestId) {
        livePendingAsk = null;
      }
      scheduleAskResync(sessionId);
      break;
    }
    case "progress": {
      // Mirror the desktop composer status: the live progress line rides in
      // the conv head (shimmering for Thinking/Executing/… prefixes).
      if (typeof event.text === "string") {
        setConvStatus(event.text, {
          active: true,
          animated: isAnimatedProgressText(event.text),
          visible: cardToolCallIds.size === 0,
        });
      }
      // Header live strip: progress text only matters while the prog row is
      // the visible fallback (plan/prompt rows own the line otherwise).
      if (refs.convLive && !refs.convLive.progRow.hidden) syncConvLive();
      // Fallback for device builds without user_ask events (older packaged
      // apps): the ask progress text is the only live signal an ask card is
      // waiting. Reload the snapshot (pendingUserAsk persisted pre-broadcast)
      // so the panel renders.
      if (
        typeof event.text === "string" &&
        /^Waiting for (your answer|bypass permissions)/.test(event.text) &&
        !livePendingAsk
      ) {
        // ask persists right after this progress event — give it a beat.
        scheduleAskResync(sessionId, 400);
      }
      break;
    }
    case "tool_finished": {
      if (typeof event.id === "string") cardToolCallIds.delete(event.id);
      // Old-build fallback: the pending ask card finished (answered on the
      // Mac) — normalize the card from the snapshot.
      if (livePendingAsk && event.id === livePendingAsk.toolCallId) {
        livePendingAsk = null;
        scheduleAskResync(sessionId);
      }
      // Mac `renderFinishedTool` parity: results never ride the event —
      // pull a fresh snapshot and swap the finished card in place (real
      // status / return code / output). No fake "Done" text anymore.
      scheduleToolCardRefresh(sessionId);
      break;
    }
    case "text_delta":
    case "reasoning_delta":
    case "tool_call":
    case "error":
      if (event.type === "tool_call" && typeof event.id === "string") {
        const bridged = unwrapToolCallBridge(event.name, event.arguments);
        if (isConversationCardVisible(bridged.name, bridged.arguments)) {
          cardToolCallIds.add(event.id);
        }
      }
      live?.apply(event as StreamEvent);
      // Plan lifecycle events re-sync the header live strip (task row) —
      // snapshot rebuilds only run at turn boundaries.
      if (event.type === "tool_call" && (event.name === "create_plan" || event.name === "plan_update")) {
        syncConvLive();
      }
      break;
    case "status": {
      const runningStatus = event.status === "running" || event.status === "streaming" || event.status === "tool_running";
      // Running zebra stripes on the composer card — the scanbar's
      // replacement, flipped on every status event like the scanbar was
      // (the run capsule is retired; the header live strip flips via
      // syncPillRunning below).
      refs.convComposerCard?.classList.toggle("is-running", runningStatus);
      if (runningStatus) {
        setConvStatus(statusPill(event.status).label, { active: true });
        void refreshSessionsQuiet();
        // Turn just started: pull the snapshot so the new user message card
        // appears live (no user-message payload rides the stream). "running"
        // only — streaming/tool_running fire mid-round where a rebuild would
        // fight the live delta buffers.
        if (event.status === "running") {
          scheduleTurnStartResync(sessionId);
        }
      }
      else {
        // Idle — Mac hides the status row; errors land in the transcript.
        setConvStatus("", { visible: false });
        // Turn boundary: card-tool attribution resets with the turn.
        cardToolCallIds.clear();
        // Turn went idle — normalize streamed preview cards (diff bodies etc.)
        // in case the `done` snapshot refresh raced the store write.
        scheduleIdleResync(sessionId);
      }
      // Keep the submit gesture (stop/queue/send) + queue palette in step
      // with the live turn state without a full view rebuild.
      if (convGestureState && convGestureState.running !== runningStatus) {
        convGestureState.running = runningStatus;
        convQueueView?.setSessionIdle(!runningStatus);
        convSubmitGesture?.();
        syncPillRunning?.();
      }
      break;
    }
    case "usage":
    case "context_display": {
      // Context gauge live update (Mac ring parity: provider readings only,
      // gaugeValueFromStreamEvent filters estimates and empty placeholders).
      const value = gaugeValueFromStreamEvent(event);
      if (value) {
        liveContextUsage = value;
        refs.convGauge?.setUsage(value);
      }
      break;
    }
    case "prompt_queue": {
      // Full queue snapshot after every mutation (device is authoritative).
      applyQueueSnapshot(Array.isArray(event.items) ? event.items : []);
      break;
    }
    case "prompt_restored": {
      // STOP landed before any model content: the device dropped the turn's
      // prompt from the transcript and hands it back for a second edit
      // (Mac parity). Attachments are not restorable here — their staged
      // files live on the device; the Mac composer keeps them.
      restorePromptToWebComposer(event.text, event.attachments.length);
      // Consume the device-side latch so the Mac does not re-restore on a
      // later remount (take-once, wherever the user returns).
      void client?.request(selectedDeviceId!, "takePromptRestore", { sessionId }).catch(() => {});
      scheduleIdleResync(sessionId);
      break;
    }
    case "steer_consumed": {
      // An armed prompt landed in the running transcript — refresh so the
      // user message card appears (the queue row itself is already gone
      // via the prompt_queue snapshot that precedes this event).
      scheduleSteerResync(sessionId);
      break;
    }
    case "done":
      // Collapse any live Thinking block + paint the last buffered text at
      // once (Mac finalizeTurn parity); the snapshot refresh below is
      // authoritative. Staggered retries: the tool_result rows can land in
      // the store right after the done broadcast, and a single early
      // refresh would leave preview-shaped (no red/green diff) tool cards.
      live?.finish();
      scheduleIdleResync(sessionId);
      void refreshSessionsQuiet();
      break;
    case "plan":
    case "plan_approval":
      void loadSession(sessionId);
      break;
    default:
      break;
  }
}

let quietTimer: number | null = null;
function refreshSessionsQuiet(): void {
  if (quietTimer !== null) return;
  quietTimer = window.setTimeout(() => {
    quietTimer = null;
    void refreshSessions();
  }, 800);
}

// ── manage view ──────────────────────────────────────────────
async function refreshManageData(): Promise<void> {
  if (!client) return;
  try {
    serverInfo = await client.serverInfo();
  } catch { /* offline */ }
  try {
    keys = await client.listKeys();
  } catch { /* offline */ }
  try {
    auditEntries = await client.requestAudit(200);
  } catch { /* offline */ }
  try {
    promptEntries = await client.requestPrompts(200);
  } catch { /* offline */ }
  await tokenHubController.refresh();
  void mcpHubController.refresh().then(() => {
    if (viewMode === "manage") renderManageBody();
  });
  void skillHubController.refresh().then(() => {
    if (viewMode === "manage") renderManageBody();
  });
  void refreshSecurity();
  renderManageBody();
}

/** Fetch the remote prompt log (Manage card + Devices view stats). */
async function refreshPromptEntries(): Promise<void> {
  if (!client) return;
  try {
    promptEntries = await client.requestPrompts(200);
  } catch { /* offline */ }
}

// ── manage: IP security (bans + throttle) ────────────────────
let securityState: { bans: Array<{ ip: string; reason: string; bannedAt: number; expiresAt: number }>; failures: Array<{ ip: string; failures: number; strikes: number; blockedUntil: number }> } | null = null;

async function refreshSecurity(): Promise<void> {
  if (!sessionToken) return;
  try {
    const res = await fetch(`${apiBase()}api/auth/security`, { headers: { "x-auth-token": sessionToken } });
    if (res.status === 200) {
      const data = (await res.json()) as typeof securityState;
      securityState = data;
      if (viewMode === "manage") renderManageBody();
    }
  } catch { /* offline */ }
}

function banIpRequest(ip: string, hours = 0): void {
  if (!sessionToken) return;
  void fetch(`${apiBase()}api/auth/ban`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-auth-token": sessionToken },
    body: JSON.stringify({ ip, hours }),
  }).then(() => refreshSecurity());
}

async function showManage(): Promise<void> {
  setViewMode("manage");
  currentSession = null;
  live?.destroy();
  live = null;
  livePendingAsk = null;
  detachConvQueueHooks();
  filesPanel.close();
  refs.newTaskView.hidden = true;
  refs.convView.hidden = true;
  refs.devicesView.hidden = true;
  refs.memoryView.hidden = true;
  refs.mainEmpty.hidden = true;
  refs.manageView.hidden = false;
  renderSidebar();
  renderManageBody();
  syncMobileView();
  await refreshManageData();
}

/** Manage page's MCP Hub card (head with live server count + hub body). */
function buildMcpHubCard(): HTMLElement {
  const mcpHub = mcpHubController.getSnapshot();
  const mcpCount = mcpHub.servers.length;
  const mcpHubDetail = mcpHub.status === "loading"
    ? "Loading encrypted MCP servers…"
    : mcpHub.status === "unavailable"
      ? (mcpHub.statusDetail ?? "Encrypted storage is unavailable.")
      : `${mcpCount} MCP ${mcpCount === 1 ? "Server" : "Servers"} · transports encrypted at rest`;
  return el("div", { class: "card token-hub-card mcp-hub-card" },
    el("div", { class: "card-head" },
      el("span", { class: "ic card-header-symbol" }, cardHeaderIcon("mcp")),
      el("div", {},
        el("div", { class: "t" }, "MCP Hub"),
        el("div", { class: "d" }, mcpHubDetail),
      ),
      el("div", { class: "card-actions" },
        el("button", {
          class: "ghost-btn action-primary",
          type: "button",
          title: "Add MCP server",
          disabled: mcpHub.status !== "ready",
          onclick: () => openAddServerDialog(mcpHubController),
        }, icon("plus", 13), "Add server"),
      ),
    ),
    renderMcpHubView(mcpHubController),
  );
}

/** Manage page's Skill Hub card (head with live skill count + hub body). */
function buildSkillHubCard(): HTMLElement {
  const skillHub = skillHubController.getSnapshot();
  const skillCount = skillHub.skills.length;
  const skillHubDetail = skillHub.status === "loading"
    ? "Loading encrypted skills…"
    : skillHub.status === "unavailable"
      ? (skillHub.statusDetail ?? "Encrypted storage is unavailable.")
      : `${skillCount} Skill${skillCount === 1 ? "" : "s"} · packages encrypted at rest`;
  return el("div", { class: "card token-hub-card skill-hub-card" },
    el("div", { class: "card-head" },
      el("span", { class: "ic card-header-symbol" }, cardHeaderIcon("skills")),
      el("div", {},
        el("div", { class: "t" }, "Skill Hub"),
        el("div", { class: "d" }, skillHubDetail),
      ),
      el("div", { class: "card-actions" },
        el("button", {
          class: "ghost-btn action-primary",
          type: "button",
          title: "Add skill",
          disabled: skillHub.status !== "ready",
          onclick: () => openAddSkillDialog(skillHubController),
        }, icon("plus", 13), "Add skill"),
      ),
    ),
    renderSkillHubView(skillHubController),
  );
}

function renderManageBody(): void {
  const restoreHubPosition = captureTokenHubViewPosition(refs.manageView);
  const restoreMcpHubPosition = captureMcpHubViewPosition(refs.manageView);
  const restoreSkillHubPosition = captureSkillHubViewPosition(refs.manageView);
  const body = renderManageCards({
    currentKeyId,
    account: { username: currentKeyName || "admin" },
    onChangeAccount: (currentPassword, username, password) => {
      void (async () => {
        try {
          const res = await fetch(`${import.meta.env.BASE_URL}api/auth/password`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: sessionToken, currentPassword, username, password }),
          });
          const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
          if (data.ok) {
            alert("Account updated.");
            if (username) currentKeyName = username;
            renderSidebar();
            renderManageBody();
          } else {
            alert(data.error === "invalid_credentials" ? "Current password is wrong." : `Update failed (${data.error ?? "unknown"}).`);
          }
        } catch {
          alert("Cannot reach the relay server.");
        }
      })();
    },
    keys,
    freshKey,
    info: serverInfo,
    audit: auditEntries,
    onClearAudit: () => {
      if (!client) return;
      if (!confirm("Clear the audit log on the relay? The wipe itself is recorded as the only remaining entry.")) return;
      void client.clearAudit().then((logs) => {
        auditEntries = logs;
        if (viewMode === "manage") renderManageBody();
      }).catch(() => { /* offline — stays as-is */ });
    },
    prompts: promptEntries,
    devices,
    onCreateKey: () => {
      const name = prompt("Name for the new key (e.g. Office, Home):", "");
      if (name === null || !client) return;
      void client.createKey(name.trim()).then(({ key, summary }) => {
        freshKey = { name: summary.name, key };
        return refreshManageData();
      });
    },
    onCopyKey: async (k) => {
      if (!client) return false;
      try {
        const key = await client.revealKey(k.id);
        await navigator.clipboard.writeText(key);
        return true;
      } catch (e) {
        console.error("copy key failed", e);
        return false;
      }
    },
    onRenameKey: (k) => {
      const name = prompt("Rename key:", k.name);
      if (name === null || !name.trim() || name.trim() === k.name || !client) return;
      void client.renameKey(k.id, name.trim()).then(() => refreshManageData());
    },
    onRotateKey: (k) => {
      if (!client || !confirm(`Rotate key “${k.name}”? Devices using it disconnect until their stored key is updated.`)) return;
      void client.rotateKey(k.id).then((fresh) => {
        freshKey = { name: k.name, key: fresh };
        return refreshManageData();
      });
    },
    onDeleteKey: (k) => {
      if (!client) return;
      const isCurrent = k.id === currentKeyId;
      const msg = isCurrent
        ? `Delete key “${k.name}”? You are signed in with it — you will be signed out, and its devices disconnect immediately.`
        : `Delete key “${k.name}”? Devices using it disconnect immediately.`;
      if (!confirm(msg)) return;
      void client.deleteKey(k.id).then(() => refreshManageData());
    },
    onDismissFreshKey: () => {
      freshKey = null;
      renderManageBody();
    },
    onBlock: (d, blocked) => client?.blockDevice(d.deviceId, blocked),
    security: securityState ?? undefined,
    onBanIp: (preset) => {
      const ip = prompt("IP address to ban (permanent — unban anytime below):", preset);
      if (!ip || !ip.trim()) return;
      banIpRequest(ip.trim());
    },
    onUnbanIp: (ip) => {
      if (!confirm(`Unban ${ip}? Its requests are accepted again immediately.`)) return;
      if (!sessionToken) return;
      void fetch(`${apiBase()}api/auth/unban`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-auth-token": sessionToken },
        body: JSON.stringify({ ip }),
      }).then(() => refreshSecurity());
    },
    onRemove: (d) => {
      if (confirm(`Remove device “${d.name}” from the registry? It can re-register with the same key.`)) {
        client?.removeDevice(d.deviceId);
        window.setTimeout(() => void showManage(), 400);
      }
    },
  });
  const hub = tokenHubController.getSnapshot();
  const providerCount = hub.providers.length;
  const hubDetail = hub.status === "loading"
    ? "Loading encrypted providers…"
    : hub.status === "unavailable"
      ? (hub.statusDetail ?? "Encrypted storage is unavailable.")
      : `${providerCount} LLM ${providerCount === 1 ? "Provider" : "Providers"} · API keys encrypted at rest`;
  // Memory entry card (single entry point for the Memory view).
  body.prepend(el("div", { class: "card" },
    el("div", { class: "card-head" },
      el("span", { class: "ic card-header-symbol" }, cardHeaderIcon("memory")),
      el("div", {},
        el("div", { class: "t" }, "Memory"),
        el("div", { class: "d" }, "Cross-device memory sync · overview, projects & devices"),
      ),
      el("div", { class: "card-actions" },
        el("button", {
          class: "ghost-btn", type: "button",
          title: "Open Memory", "aria-label": "Open Memory",
          onclick: () => void showMemory(),
        }, icon("chevronRight", 12), "Open"),
      ),
    ),
  ));
  body.prepend(buildSkillHubCard());
  body.prepend(buildMcpHubCard());
  body.prepend(el("div", { class: "card token-hub-card" },
    el("div", { class: "card-head" },
      el("span", { class: "ic card-header-symbol" }, cardHeaderIcon("providers")),
      el("div", {},
        el("div", { class: "t" }, "LLM Provider Hub"),
        el("div", { class: "d" }, hubDetail),
      ),
      el("div", { class: "card-actions" },
        el("button", {
          class: "ghost-btn action-primary",
          type: "button",
          title: "Add provider",
          disabled: hub.status !== "ready",
          onclick: () => openAddProviderWizard(tokenHubController),
        }, icon("plus", 13), "Add provider"),
      ),
    ),
    renderTokenHubView(tokenHubController),
  ));
  const head = el("div", { class: "view-head" },
    // Mobile-only back affordance (desktop hides it in style.css).
    el("button", {
      class: "m-back", type: "button",
      title: "Back", "aria-label": "Back",
      onclick: () => goHome(),
    }, icon("back", 18)),
    el("h1", {}, "Manage"),
    el("span", { class: "spacer" }),
    // The topbar (and its status dot / E2EE lock) is hidden on this page.
    headConnBadge(true),
    el("button", {
      class: "ghost-btn head-refresh", type: "button",
      title: "Refresh", "aria-label": "Refresh",
      onclick: () => void showManage(),
    }, icon("refresh"), el("span", { class: "btn-label" }, "Refresh")),
  );
  body.append(el("footer", { class: "manage-footer" }, serverInfo ? `relay v${serverInfo.version}` : "relay"));
  refs.manageView.replaceChildren(head, body);
  restoreHubPosition();
  restoreMcpHubPosition();
  restoreSkillHubPosition();
}

// ── memory view (M4a: overview + degradation banner) ─────────
async function refreshMemoryOverview(): Promise<void> {
  if (!sessionToken) return;
  try {
    const res = await fetch(`${apiBase()}api/console/memory/overview`, { headers: { "x-auth-token": sessionToken } });
    if (res.status === 200) {
      memoryOverview = (await res.json()) as MemoryOverview;
      if (viewMode === "memory") renderMemoryBody();
    }
  } catch { /* offline */ }
}

async function showMemory(): Promise<void> {
  setViewMode("memory");
  currentSession = null;
  live?.destroy();
  live = null;
  livePendingAsk = null;
  detachConvQueueHooks();
  filesPanel.close();
  refs.newTaskView.hidden = true;
  refs.convView.hidden = true;
  refs.manageView.hidden = true;
  refs.devicesView.hidden = true;
  refs.mainEmpty.hidden = true;
  refs.memoryView.hidden = false;
  renderSidebar();
  renderMemoryBody();
  syncMobileView();
  await refreshMemoryOverview();
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtSyncTime(ts: number | null): string {
  if (!ts) return "never";
  const delta = Date.now() - ts;
  if (delta < 60_000) return "just now";
  if (delta < 3600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 24 * 3600_000) return `${Math.round(delta / 3600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function renderMemoryBody(): void {
  const body = el("div", { class: "manage-body" });
  const o = memoryOverview;

  if (o && !o.sqlite) {
    body.append(el("div", { class: "card memory-degraded" },
      el("div", { class: "card-head" },
        el("span", { class: "ic" }, icon("warn", 15) as unknown as string),
        el("div", {},
          el("div", { class: "t" }, "Memory unavailable on this relay"),
          el("div", { class: "d" }, `Node.js ≥ 22.13 is required. Reason: ${o.reason ?? "unknown"}. Everything else keeps working.`),
        ),
      ),
    ));
  } else if (o) {
    const stat = (label: string, value: string): HTMLElement =>
      el("div", { class: "memory-stat" },
        el("div", { class: "memory-stat-v" }, value),
        el("div", { class: "memory-stat-l" }, label));
    body.append(el("div", { class: "card" },
      el("div", { class: "card-head" },
        el("span", { class: "ic" }, icon("brain", 15) as unknown as string),
        el("div", {},
          el("div", { class: "t" }, "Overview"),
          el("div", { class: "d" }, `Cross-device memory · relay v${o.version} · global seq ${o.seq}`),
        ),
      ),
      el("div", { class: "card-body" },
        el("div", { class: "memory-stats" },
          stat("Archived sessions", String(o.historyRows)),
          stat("Worklog entries", String(o.docEntries.worklog)),
          stat("Pitfalls entries", String(o.docEntries.pitfalls)),
          stat("Style entries", String(o.docEntries.style)),
          stat("Tombstones", String(o.tombstones)),
          stat("Database", fmtBytes(o.dbSizeBytes)),
        ),
      ),
    ));
    if (o.projects.length > 0) {
      const tbody = el("tbody");
      for (const p of o.projects) {
        tbody.append(el("tr", { class: "static" },
          el("td", { class: "key-mono" }, p.projectKey),
          el("td", {}, String(p.counts.worklog)),
          el("td", {}, String(p.counts.pitfalls)),
          el("td", {}, String(p.counts.style)),
        ));
      }
      body.append(el("div", { class: "card" },
        el("div", { class: "card-head" },
          el("span", { class: "ic" }, icon("folderOpen", 15) as unknown as string),
          el("div", {},
            el("div", { class: "t" }, "Projects"),
            el("div", { class: "d" }, "Entry counts per project key (git remote)"),
          ),
        ),
        el("div", { class: "card-body flush" },
          el("div", { class: "card-scroll" },
            el("table", { class: "zebra dev-table" },
              el("thead", {}, el("tr", {},
                el("th", {}, "Project"),
                el("th", {}, "Worklog"),
                el("th", {}, "Pitfalls"),
                el("th", {}, "Style"),
              )),
              tbody,
            ),
            el("div", { class: "m-rows", "aria-label": "Projects" },
              ...o.projects.map((p) => el("div", { class: "m-row" },
                el("div", { class: "m-row-main" },
                  el("div", { class: "m-row-title key-mono" }, p.projectKey),
                  el("div", { class: "m-row-sub" }, `worklog ${p.counts.worklog} · pitfalls ${p.counts.pitfalls} · style ${p.counts.style}`),
                ),
              )),
            ),
          ),
        ),
      ));
    }
    // Sync devices card is always rendered — an empty table collapses to a
    // sliver otherwise; the empty row holds a placeholder with guidance.
    {
      const tbody = el("tbody");
      for (const d of o.devices) {
        tbody.append(el("tr", { class: "static" },
          el("td", {}, el("span", { class: "cell-title" }, d.deviceId)),
          el("td", { class: "cell-sub" }, fmtSyncTime(d.lastPushAt)),
          el("td", { class: "cell-sub" }, d.lastPullSeq == null ? "—" : `seq ${d.lastPullSeq}`),
          el("td", { class: "cell-sub" }, fmtSyncTime(d.lastSeenAt)),
        ));
      }
      if (!o.devices.length) {
        tbody.append(el("tr", { class: "static" },
          el("td", { colspan: "4", class: "empty-cell" }, "No devices have synced memory yet — enable memory sync on a client to see it here."),
        ));
      }
      // Mobile hides the zebra in flush bodies — mirror the empty state in
      // the m-rows track so phones see the placeholder too.
      const mobileRows = el("div", { class: "m-rows", "aria-label": "Sync devices" },
        ...(o.devices.length
          ? o.devices.map((d) => el("div", { class: "m-row" },
              el("div", { class: "m-row-main" },
                el("div", { class: "m-row-title key-mono" }, d.deviceId),
                el("div", { class: "m-row-sub" }, `push ${fmtSyncTime(d.lastPushAt)} · pull ${d.lastPullSeq == null ? "—" : `seq ${d.lastPullSeq}`} · seen ${fmtSyncTime(d.lastSeenAt)}`),
              ),
            ))
          : [el("div", { class: "m-row m-row-empty" }, "No devices have synced memory yet.")]));
      body.append(el("div", { class: "card" },
        el("div", { class: "card-head" },
          el("span", { class: "ic" }, icon("monitor", 15) as unknown as string),
          el("div", {},
            el("div", { class: "t" }, "Sync devices"),
            el("div", { class: "d" }, "Devices that pushed or pulled memory"),
          ),
        ),
        el("div", { class: "card-body flush" },
          el("div", { class: "card-scroll" },
            el("table", { class: "zebra dev-table" },
              el("thead", {}, el("tr", {},
                el("th", {}, "Device"),
                el("th", {}, "Last push"),
                el("th", {}, "Last pull"),
                el("th", {}, "Last seen"),
              )),
              tbody,
            ),
            mobileRows,
          ),
        ),
      ));
    }
  } else {
    body.append(el("div", { class: "view-empty" },
      el("p", {}, memoryOverview === null ? "Loading memory overview…" : "Memory overview unavailable.")));
  }

  const head = el("div", { class: "view-head" },
    el("button", {
      class: "m-back", type: "button",
      title: "Back", "aria-label": "Back",
      onclick: () => void showManage(),
    }, icon("back", 18)),
    el("h1", {}, "Memory"),
    el("span", { class: "count-pill" }, memoryOverview ? (memoryOverview.sqlite ? "sync on" : "disabled") : "…"),
    el("span", { class: "spacer" }),
    el("button", {
      class: "ghost-btn head-refresh", type: "button",
      title: "Refresh", "aria-label": "Refresh",
      onclick: () => void refreshMemoryOverview(),
    }, icon("refresh"), el("span", { class: "btn-label" }, "Refresh")),
  );
  refs.memoryView.replaceChildren(head, body);
}

// ── devices view ─────────────────────────────────────────────
async function showDevices(): Promise<void> {
  setViewMode("devices");
  currentSession = null;
  live?.destroy();
  live = null;
  livePendingAsk = null;
  detachConvQueueHooks();
  filesPanel.close();
  refs.newTaskView.hidden = true;
  refs.convView.hidden = true;
  refs.manageView.hidden = true;
  refs.memoryView.hidden = true;
  refs.mainEmpty.hidden = true;
  refs.devicesView.hidden = false;
  if (!devicesSelectedId || !devices.some((d) => d.deviceId === devicesSelectedId)) {
    devicesSelectedId = devices[0]?.deviceId ?? null;
  }
  renderDevicesView();
  syncMobileView();
  await Promise.all([refreshPromptEntries(), tokenHubController.refresh(), mcpHubController.refresh(), refreshSelectedDeviceProviders()]);
  if (viewMode === "devices") renderDevicesView();
}

function refreshSelectedDeviceProviders(): Promise<void> {
  const device = devices.find((item) => item.deviceId === devicesSelectedId);
  if (!device?.online) return Promise.resolve();
  const pending = tokenHubController.getSyncPending(device.deviceId);
  const mcpPending = mcpHubController.getSyncPending(device.deviceId);
  const skillPending = skillHubController.getSyncPending(device.deviceId);
  const jobs: Array<Promise<void>> = [];
  if (!pending || pending === "preview") {
    jobs.push(tokenHubController.loadDeviceSyncPreview(device.deviceId).then(() => undefined).catch(() => {}));
  }
  if (!mcpPending || mcpPending === "preview") {
    jobs.push(mcpHubController.loadDeviceSyncPreview(device.deviceId).then(() => undefined).catch(() => {}));
  }
  if (!skillPending || skillPending === "preview") {
    jobs.push(skillHubController.loadDeviceSyncPreview(device.deviceId).then(() => undefined).catch(() => {}));
  }
  return Promise.all(jobs).then(() => {});
}

function maintenanceCheckTarget(device: DeviceSummary): MaintenanceCheckTarget {
  return {
    deviceId: device.deviceId,
    platform: device.platform,
    version: device.version,
    manifestUrl: maintStore.manifestUrl.trim(),
  };
}

function maybeAutoCheckMaintenance(): void {
  if (!client || viewMode !== "devices" || document.hidden || maintPending !== null) return;
  const device = devices.find((d) => d.deviceId === devicesSelectedId);
  if (!device?.online || !supportsMaintenance(device) || !maintenanceChannel(device.platform)) return;
  if (device.maintenance?.phase === "running" || device.maintenance?.phase === "queued") return;
  // A scheduled refresh must not disable or rebuild a form being edited.
  if (document.activeElement?.closest(".maint-card [data-maint-field]")) return;
  void checkMaintenanceRelease(device);
}

async function checkMaintenanceRelease(device: DeviceSummary, manual = false): Promise<void> {
  if (!client || !device.online || maintPending !== null) return;
  const target = maintenanceCheckTarget(device);
  const channel = maintenanceChannel(device.platform);
  if (!channel) {
    if (manual) alert(`This device (${device.platform || "unknown platform"}) has no release channel in the manifest.`);
    return;
  }
  const before = { ...maintDraftFor(channel) };
  const request = maintReleaseChecker.check(target, manual);
  if (request && viewMode === "devices") renderDevicesView();
  const result = request ? await request : maintReleaseChecker.state(target);
  if (!result || result.checking) return;
  const currentDevice = devices.find((d) => d.deviceId === devicesSelectedId);
  const stillSelected = viewMode === "devices" && currentDevice?.deviceId === device.deviceId &&
    currentDevice.online && currentDevice.platform === target.platform && currentDevice.version === target.version &&
    maintStore.manifestUrl.trim() === target.manifestUrl;
  let filled = false;
  const draft = maintDraftFor(channel);
  if (result.entry && !result.error && stillSelected && maintPending === null &&
    (draft.source !== result.entry.url || draft.sha256 !== (result.entry.sha256 ?? "") || draft.version !== result.entry.version) &&
    canFillMaintenanceRelease(before, maintDraftFor(channel), manual, maintEditedChannels.has(channel))) {
    maintStore = withDraft(maintStore, channel, {
      source: result.entry.url,
      sha256: result.entry.sha256 ?? "",
      version: result.entry.version,
    });
    if (manual) maintEditedChannels.delete(channel);
    saveMaintStore();
    filled = true;
  }
  if ((request || filled) && viewMode === "devices") renderDevicesView();
  if (manual && result.error) alert(`Could not check the latest release: ${result.error}`);
}

document.addEventListener("visibilitychange", maybeAutoCheckMaintenance);
window.addEventListener("pageshow", maybeAutoCheckMaintenance);

/**
 * Maintenance panel state + callbacks. Built by renderDevicesView AND by the
 * progress-tick patch path (onDevices), so the in-place zone patch renders
 * through exactly the same logic as a full re-render.
 */
function buildMaintenancePanel(selForMaintenance: DeviceSummary | null): DeviceMaintenancePanel {
  // Update / restart-of-process: agentd and desktop ≥ 1.5.2 (hello.caps).
  const maintOk = supportsMaintenance(selForMaintenance);
  // Remote shell additionally needs the deviceExec action (agentd only —
  // desktops never advertise `exec`, and pre-1.3.5 nodes lack the action).
  const execOk = supportsExec(selForMaintenance) && versionAtLeast(selForMaintenance!.version, "1.3.5");
  const desktop = maintOk && !isAgentdDevice(selForMaintenance);
  // Release channel of THIS device: its draft is the only one the card reads,
  // so a fetched win package can neither fill nor validate a mac/agentd card.
  const channel = maintenanceChannel(selForMaintenance?.platform ?? null);
  const draft = maintDraftFor(channel);
  const releaseCheck = selForMaintenance ? maintReleaseChecker.state(maintenanceCheckTarget(selForMaintenance)) : null;
  return {
    status: maintStatus.get(devicesSelectedId ?? "") ?? null,
    form: {
      source: draft.source,
      sha256: draft.sha256,
      force: maintStore.force,
      manifestUrl: maintStore.manifestUrl,
      ...(draft.version ? { version: draft.version } : {}),
      ...(channel ? { channel } : {}),
    },
    checking: releaseCheck?.checking ?? false,
    ...(releaseCheck ? { releaseCheck: {
      checkedAt: releaseCheck.checkedAt,
      error: releaseCheck.error,
      version: releaseCheck.entry?.version ?? null,
      keptSelection: !!releaseCheck.entry && (draft.source !== releaseCheck.entry.url || draft.sha256 !== (releaseCheck.entry.sha256 ?? "")),
    } } : {}),
    pending: maintPending,
    logOpen: maintLogOpen,
    onLogToggle: (open) => {
      maintLogOpen = open;
    },
    openSections: maintOpenSections.get(selForMaintenance?.deviceId ?? "") ?? {},
    onSectionToggle: (section, open) => {
      if (!selForMaintenance) return;
      const id = selForMaintenance.deviceId;
      maintOpenSections.set(id, { ...maintOpenSections.get(id), [section]: open });
    },
    ...(execOk
      ? {
          exec: {
            command: execCommand,
            running: maintPending === "exec",
            last: execLast.get(devicesSelectedId ?? "") ?? null,
            onCommandChange: (command: string) => {
              execCommand = command;
            },
            onRun: (d: DeviceSummary) => void runExec(d),
          },
        }
      : {}),
    ...(desktop
      ? {
          restartHint: "Restart app",
          restartTitle: "Restart the Larry Agent app (relaunches itself)",
          sourcePlaceholder: "https://…/Larry-Agent-<version>-mac-<arch>.zip or -win-x64-setup.exe",
        }
      : {}),
    ...(supportsReboot(selForMaintenance)
      ? { onReboot: (d: DeviceSummary) => void runMaintenanceAction(d, "reboot", async () => {
          if (!confirm(`Reboot the host “${d.name}”? It stays offline for ~a minute.`)) return null;
          await client!.request(d.deviceId, "rebootDevice");
          return "Reboot requested — the device returns when it boots back up.";
        }) }
      : {}),
    onFormChange: (patch) => {
      // Manifest URL and the force flag are platform-independent; the release
      // itself is written into THIS device's channel draft only.
      maintStore = applyDraftPatch(maintStore, channel, patch.sha256 !== undefined ? { ...patch, version: undefined } : patch);
      if (channel && (patch.source !== undefined || patch.sha256 !== undefined)) maintEditedChannels.add(channel);
      saveMaintStore();
    },
    onRestart: (d) => void runMaintenanceAction(d, "restart", async () => {
      if (!confirm(`Restart JellyBot on “${d.name}”? Running turns keep their state; the ${isAgentdDevice(d) ? "service" : "app"} comes back in seconds.`)) return null;
      await client!.request(d.deviceId, "restartDevice");
      return "Restart requested — the device reconnects within seconds.";
    }),
    onUpdate: (d) => void runMaintenanceAction(d, "update", async () => {
      const deviceChannel = maintenanceChannel(d.platform);
      const deviceDraft = maintDraftFor(deviceChannel);
      const source = deviceDraft.source.trim();
      if (!source) throw new Error("no release selected — Fetch latest fills it from the manifest");
      // Guard the cross-platform trap the shared draft used to create: a
      // win setup must never be pushed at a mac (or a tarball at a desktop).
      if (deviceChannel && !releaseMatchesChannel(source, deviceChannel)) {
        throw new Error(
          `“${source.split("/").pop()}” is not a ${deviceChannel} package — Fetch latest resolves the release for this device's platform`,
        );
      }
      const payload: Record<string, unknown> = { source, force: maintStore.force };
      if (/^https?:\/\//i.test(source)) payload.sha256 = deviceDraft.sha256.trim();
      if (deviceDraft.version) payload.version = deviceDraft.version;
      const result = await client!.request<{ mode?: string }>(d.deviceId, "updateDevice", payload);
      return result?.mode === "updater"
        ? "Update queued — watch the progress in Maintenance."
        : "Update started in-process — watch the progress in Maintenance.";
    }),
    onCheckUpdate: (d) => void checkMaintenanceRelease(d, true),
    onRefreshStatus: (d) => void runMaintenanceAction(d, "status", async () => {
      const status = await client!.request<DeviceMaintenancePanelStatus>(d.deviceId, "deviceStatus");
      maintStatus.set(d.deviceId, status);
      return null;
    }),
  };
}

function renderDevicesView(): void {
  const focused = document.activeElement as HTMLElement | null;
  const sameMaintenanceDevice = refs.devicesView.querySelector<HTMLElement>(".maint-card")?.dataset.deviceId === devicesSelectedId;
  const maintenanceField = sameMaintenanceDevice ? focused?.closest<HTMLInputElement | HTMLTextAreaElement>("[data-maint-field]") : null;
  const maintenanceFocus = maintenanceField ? {
    field: maintenanceField.dataset.maintField,
    start: maintenanceField.selectionStart,
    end: maintenanceField.selectionEnd,
  } : null;
  const maintenanceScroll = sameMaintenanceDevice ? {
    body: refs.devicesView.querySelector<HTMLElement>(".devices-body")?.scrollTop ?? 0,
    detail: refs.devicesView.querySelector<HTMLElement>(".dev-detail")?.scrollTop ?? 0,
  } : null;
  const focusedProvider = focused?.closest<HTMLElement>(".th-device-profile-row");
  const focusedCard = focusedProvider?.closest<HTMLElement>(".th-device-card");
  const providerFocus = focusedProvider && focusedCard ? {
    deviceId: focusedCard.dataset.deviceId,
    providerId: focusedProvider.dataset.providerId,
    action: focused?.dataset.providerAction ?? focusedProvider.dataset.focusAction ?? "copy",
    index: [...focusedCard.querySelectorAll(".th-device-profile-row")].indexOf(focusedProvider),
  } : null;
  const selForMaintenance = devices.find((d) => d.deviceId === devicesSelectedId) ?? null;
  // Capability-gate the card; modern desktop clients also support maintenance,
  // while exec and host reboot keep their separate agentd-only gates.
  const maintOk = supportsMaintenance(selForMaintenance);
  // Only reachable for devices advertising `maintenance` — see maintOk above.
  const maintenancePanel: DeviceMaintenancePanel = buildMaintenancePanel(selForMaintenance);
  const body = renderDevicesViewBody({
    devices,
    prompts: promptEntries,
    selectedId: devicesSelectedId,
    ...(selForMaintenance
      ? {
          providerManagementCard: buildDeviceProviderCard(
            selForMaintenance.deviceId,
            selForMaintenance.name,
            selForMaintenance.online,
            tokenHubController,
          ),
          mcpManagementCard: buildDeviceMcpCard(
            selForMaintenance.deviceId,
            selForMaintenance.name,
            selForMaintenance.online,
            mcpHubController,
          ),
          skillManagementCard: buildDeviceSkillCard(
            selForMaintenance.deviceId,
            selForMaintenance.name,
            selForMaintenance.online,
            skillHubController,
          ),
        }
      : {}),
    onSelect: (d) => {
      devicesSelectedId = d.deviceId;
      renderDevicesView();
      void refreshSelectedDeviceProviders();
    },
    onOpenPicker: () => {
      buildDevPickerSheet();
      openSheetPanel(refs.devPickerSheet, refs.devicesView.querySelector<HTMLElement>(".dev-picker"));
    },
    onOpenCoco: (d) => void showCoco(d.deviceId),
    onBlock: (d, blocked) => {
      client?.blockDevice(d.deviceId, blocked);
      window.setTimeout(() => {
        if (viewMode === "devices") renderDevicesView();
      }, 400);
    },
    onRemove: (d) => {
      if (confirm(`Remove device “${d.name}” from the registry? It can re-register with the same key.`)) {
        client?.removeDevice(d.deviceId);
        devicesSelectedId = null;
        window.setTimeout(() => {
          if (viewMode === "devices") renderDevicesView();
        }, 400);
      }
    },
    ...(maintOk ? { maintenance: maintenancePanel } : {}),
  });
  const head = el("div", { class: "view-head" },
    // Mobile-only back affordance (desktop hides it in style.css).
    el("button", {
      class: "m-back", type: "button",
      title: "Back", "aria-label": "Back",
      onclick: () => goHome(),
    }, icon("back", 18)),
    el("h1", {}, "Devices"),
    el("span", { class: "count-pill" }, `${devices.length} registered`),
    el("span", { class: "spacer" }),
    // The topbar (and its status dot / E2EE lock) is hidden on this page.
    headConnBadge(true),
    el("button", {
      class: "ghost-btn head-refresh", type: "button",
      title: "Refresh", "aria-label": "Refresh",
      onclick: () => {
        void Promise.all([refreshPromptEntries(), tokenHubController.refresh(), mcpHubController.refresh(), refreshSelectedDeviceProviders()]).then(() => {
          if (viewMode === "devices") renderDevicesView();
        });
      },
    }, icon("refresh"), el("span", { class: "btn-label" }, "Refresh")),
  );
  refs.devicesView.replaceChildren(head, body);
  if (maintenanceFocus) {
    const field = refs.devicesView.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-maint-field="${maintenanceFocus.field}"]`);
    if (field && !field.disabled) {
      field.focus({ preventScroll: true });
      if (maintenanceFocus.start !== null && maintenanceFocus.end !== null) {
        field.setSelectionRange(maintenanceFocus.start, maintenanceFocus.end);
      }
    }
  }
  if (providerFocus?.deviceId === devicesSelectedId) {
    const card = refs.devicesView.querySelector<HTMLElement>(".th-device-card");
    const rows = [...(card?.querySelectorAll<HTMLElement>(".th-device-profile-row") ?? [])];
    const row = rows.find((item) => item.dataset.providerId === providerFocus.providerId)
      ?? rows[Math.min(providerFocus.index, rows.length - 1)];
    const button = row?.querySelector<HTMLButtonElement>(`[data-provider-action="${providerFocus.action}"]:not(:disabled)`);
    if (button) button.focus();
    else if (row) {
      // Keep the keyboard position during a pending operation; on completion
      // this same descriptor restores its action (or the adjacent row).
      row.tabIndex = -1;
      row.dataset.focusAction = providerFocus.action;
      row.focus();
    } else card?.querySelector<HTMLButtonElement>(".th-device-add")?.focus();
  }
  if (maintenanceScroll && !providerFocus) {
    const scrollBody = refs.devicesView.querySelector<HTMLElement>(".devices-body");
    const scrollDetail = refs.devicesView.querySelector<HTMLElement>(".dev-detail");
    if (scrollBody) scrollBody.scrollTop = maintenanceScroll.body;
    if (scrollDetail) scrollDetail.scrollTop = maintenanceScroll.detail;
  }
  maybeAutoCheckMaintenance();
}

/** Shared runner for maintenance actions: pending lock, error surfacing, re-render. */
async function runMaintenanceAction(
  device: DeviceSummary,
  kind: "restart" | "reboot" | "update" | "status",
  action: () => Promise<string | null>,
): Promise<void> {
  if (!client) return;
  maintPending = kind;
  if (viewMode === "devices") renderDevicesView();
  try {
    const message = await action();
    if (message) alert(message);
  } catch (error) {
    alert(`Maintenance action failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    maintPending = null;
    if (viewMode === "devices") renderDevicesView();
  }
}

/** deviceExec: the relay window outlasts the 120s device cap; output lands in the card. */
async function runExec(device: DeviceSummary): Promise<void> {
  if (!client) return;
  const command = execCommand.trim();
  if (!command || maintPending !== null) return;
  maintPending = "exec";
  if (viewMode === "devices") renderDevicesView();
  try {
    const result = await client.request<DeviceExecResult>(
      device.deviceId,
      "deviceExec",
      { command },
      150_000,
    );
    if (result) execLast.set(device.deviceId, { ...result, command, ts: Date.now() });
  } catch (error) {
    alert(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    maintPending = null;
    if (viewMode === "devices") renderDevicesView();
  }
}

// ── boot ─────────────────────────────────────────────────────
// macOS-style overlay scrollbars everywhere (Windows Chrome parity with the
// Mac client) — auto-wires any element whose computed overflow scrolls,
// including everything rendered later.
initOverlayScrollbars();

// iOS keyboard avoidance: publishes --kb-inset for the mobile panes.
installKeyboardInset();
installStandaloneZoomLock();
installMobileBackGesture(() => refs.layout);

const stored = localStorage.getItem(KEY_STORAGE) ?? "";
if (stored) {
  void (async () => {
    await tryConnect(stored, () => {
      sessionToken = stored;
      buildShell();
    }, () => renderLogin("Session expired — sign in again."));
  })();
} else {
  renderLogin("");
}
import type { UserAskAnswer } from "./types.js";
