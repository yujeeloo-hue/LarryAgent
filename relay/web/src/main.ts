import { demoQueueFingerprint, type DemoCardState } from "../../../src/session/demoCardState.js";
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
  releaseNewTaskComposer,
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
import { deviceProjectIds, isWorkspaceMutationTool } from "./workspaceSync.js";
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

document.documentElement.classList.toggle(
  "mac",
  /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent),
);

initTheme();

function brandIcon(size: number): HTMLElement {
  return el("img", {
    src: trayDogHeadUrl,
    class: "tray-brand-icon",
    alt: "",
    style: `width:${size}px;height:${size}px;display:block`,
  });
}

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
  cocoSheet: HTMLElement;
  mCocoBtn: HTMLButtonElement;
  mobileFab: HTMLButtonElement;
  mRefreshBtn: HTMLButtonElement;
  convRunStatus: HTMLElement | null;
  convComposerCard: HTMLElement | null;
  convRunPill: HTMLElement | null;
  convHead: HTMLElement | null;
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
  convGauge: ContextGauge | null;
  convComposer: HTMLTextAreaElement | null;
}

let client: RelayClient | null = null;
let sessionToken = "";
let devices: DeviceSummary[] = [];
let selectedDeviceId: string | null = null;

const maintStatus = new Map<string, DeviceMaintenancePanelStatus>();
const MAINT_FORM_KEY = "jbMaintForm";

let maintStore: MaintStore = parseMaintStore(readMaintStorage());
const maintEditedChannels = new Set<MaintenanceChannel>();
const maintReleaseChecker = new MaintenanceReleaseChecker((target) =>
  client!.request<MaintenanceRelease | null>(target.deviceId, "checkUpdate", { manifestUrl: target.manifestUrl }),
);
let maintAutoCheckTimer: number | null = null;
let maintPending: string | null = null;
let maintLogOpen = false;
const maintOpenSections = new Map<string, NonNullable<DeviceMaintenancePanel["openSections"]>>();
let execCommand = "";
const execLast = new Map<string, DeviceExecResult & { command: string; ts: number }>();

type DeviceMaintenancePanelStatus = NonNullable<
  Parameters<typeof renderDevicesViewBody>[0]["maintenance"]
>["status"];

function readMaintStorage(): string | null {
  try {
    return localStorage.getItem(MAINT_FORM_KEY);
  } catch {
    return null;
  }
}

function saveMaintStore(): void {
  try {
    localStorage.setItem(MAINT_FORM_KEY, JSON.stringify(maintStore));
  } catch {
  }
}

function maintDraftFor(channel: MaintenanceChannel | null): MaintDraft {
  return draftFor(maintStore, channel);
}

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
let livePendingAsk: PendingAskSnapshot | null = null;
let liveContextUsage: ContextGaugeValue | null = null;
const convRenderRelevance = new RenderRelevance();
let viewMode: "home" | "newTask" | "conv" | "manage" | "memory" | "devices" | "coco" = "home";

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
    else if (!repaintMcpHubCard(refs.manageView, buildMcpHubCard)) renderManageBody();
  }
  if (viewMode === "devices" && refs.devicesView) {
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
let promptEntries: PromptLogEntry[] = [];
let devicesSelectedId: string | null = null;
let keys: KeySummary[] = [];
let currentKeyId: string | null = null;
let currentKeyName = "";

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
const expandedDevices = new Set<string>();
const deviceProjects = new Map<string, string[]>();
const deviceWorkspaceNames = new Map<string, Map<string, string>>();
const deviceWorkspaces = new Map<string, NewTaskWorkspaceOption[]>();
let projectFilter: string | null = null;
let projectFilterAuto = true;
const NT_WS_KEY = "larryRemote.newTaskWs";
const NT_DRAFT_KEY = "larryRemote.newTaskDrafts";
const NT_PREFS_KEY = "larryRemote.composerPrefs";
const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

const refs = {} as AppRefs;

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
    } catch {  }
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

type ConnBadge = { wrap: HTMLElement; shield: HTMLElement; status?: HTMLElement; count?: HTMLElement };

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

function headConnBadge(details = false, className = "head-conn"): HTMLElement {
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

  const mRefreshBtn = el("button", {
    class: "m-refresh-btn", type: "button",
    title: "Refresh sessions", "aria-label": "Refresh sessions",
  }, icon("refresh", 15)) as HTMLButtonElement;
  mRefreshBtn.addEventListener("click", () => {
    if (selectedDeviceId) void refreshDeviceNow(selectedDeviceId);
  });
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
  const devPickerSheet = el("div", { class: "sheet" },
    el("div", { class: "sheet-handle", "aria-hidden": "true" }),
    el("div", { class: "sheet-title" }, "Device"),
    el("div", { class: "sheet-body", role: "listbox", "aria-label": "Pick a device" }));
  const cocoSheet = el("div", { class: "sheet" },
    el("div", { class: "sheet-handle", "aria-hidden": "true" }),
    el("div", { class: "sheet-title" }, "CoCo"),
    el("div", { class: "sheet-body", role: "listbox", "aria-label": "CoCo devices" }));

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
        const now = list.find((d) => d.deviceId === selectedDeviceId);
        if (now?.online && !prevSelected?.online) void refreshSessions();
      } else if (viewMode === "home") {
        const pick = pickDefaultDevice(list);
        if (pick) {
          selectDevice(pick.deviceId);
          void refineAutoPick(list, pick.deviceId);
        }
      }
      syncConnBadges();
    },
    onEvent: (env) => {
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

const mobileMedia = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(max-width: 768px)")
  : null;
function isMobileViewport(): boolean {
  return mobileMedia?.matches === true;
}

function syncMobileView(): void {
  refs.layout?.setAttribute("data-view", viewMode);
}

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

function cocoSheetHint(entry: CocoEntryState): string {
  const current = devices.find((d) => d.deviceId === (selectedDeviceId ?? devices[0]?.deviceId));
  const name = current?.name ?? "This device";
  if (entry.blocked === "offline") return `${name} is offline — CoCo runs on a connected device.`;
  if (entry.blocked === "unsupported") return `${name} does not support CoCo yet.`;
  return "Pick the device to open CoCo on.";
}

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

function renderMobileHome(): void {
  if (!refs.mobileHead) return;
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

function mobileBackHead(title: string): HTMLElement {
  return el("div", { class: "m-head" },
    el("button", {
      class: "m-back", type: "button",
      title: "Back", "aria-label": "Back",
      onclick: () => goHome(),
    }, icon("back", 18)),
    el("h1", {}, title));
}


let cocoController: CocoController | null = null;
let cocoView: CocoView | null = null;
let cocoDeviceId: string | null = null;

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

async function showCoco(deviceId: string): Promise<void> {
  const conn = client;
  if (!conn) return;
  const device = devices.find((d) => d.deviceId === deviceId);
  if (!device || !deviceHasCoco(device)) return;
  if (cocoDeviceId !== deviceId) {
    teardownCoco();
    cocoDeviceId = deviceId;
    let readonly = false;
    try {
      const opts = await conn.request<{ remoteMode: "readonly" | "full" }>(deviceId, "listComposerOptions");
      readonly = opts.remoteMode !== "full";
    } catch {  }
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

  renderMobileHome();
}

function selectDevice(deviceId: string): void {
  if (selectedDeviceId === deviceId) {
    if (expandedDevices.has(deviceId)) expandedDevices.delete(deviceId);
    else {
      expandedDevices.add(deviceId);
      if (!deviceProjects.has(deviceId) || !deviceWorkspaceNames.has(deviceId)) void fetchDeviceProjects(deviceId);
    }
    renderSidebar();
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
  if (isMobileViewport()) syncMobileView();
  else showNewTask();
  void refreshSessions({ autoOpen: true });
}

function ordinarySessions(list: SessionSummary[]): SessionSummary[] {
  return list.filter((s) => s.source !== "coco_chat" && s.source !== "coco");
}

async function loadDeviceData(deviceId: string): Promise<SessionSummary[]> {
  const conn = client;
  if (!conn) throw new Error("not connected");
  const list = ordinarySessions(
    await conn.request<SessionSummary[]>(deviceId, "listSessions"),
  );
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

async function fetchDeviceProjects(deviceId: string): Promise<void> {
  try {
    await loadDeviceData(deviceId);
    if (expandedDevices.has(deviceId)) renderSidebar();
  } catch {  }
}

const refreshingDevices = new Set<string>();

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

function syncDevRefreshSpin(deviceId: string): void {
  const spinning = refreshingDevices.has(deviceId);
  const sel = `.dev-refresh[data-device-id="${CSS.escape(deviceId)}"]`;
  for (const btn of refs.sidebar.querySelectorAll<HTMLElement>(sel)) {
    btn.classList.toggle("spinning", spinning);
  }
  if (deviceId === selectedDeviceId && refs.mRefreshBtn) {
    refs.mRefreshBtn.classList.toggle("spinning", spinning);
  }
}

function projectName(deviceId: string, workspaceId: string): string {
  const name = deviceWorkspaceNames.get(deviceId)?.get(workspaceId);
  if (name) return name;
  return orphanProjectLabel(workspaceId);
}

function isPathLikeWorkspaceId(workspaceId: string): boolean {
  return workspaceId.includes("/") || workspaceId.includes("\\");
}

function orphanProjectLabel(workspaceId: string): string {
  return isPathLikeWorkspaceId(workspaceId)
    ? `${workspaceBasename(workspaceId)} (missing)`
    : "Removed project";
}

function applyDeviceSessions(deviceId: string, list: SessionSummary[]): void {
  const ids = deviceProjectIds(
    list,
    deviceWorkspaceNames.get(deviceId),
    deviceWorkspaces.get(deviceId) ?? [],
  );
  deviceProjects.set(
    deviceId,
    ids.sort((a, b) => projectName(deviceId, a).localeCompare(projectName(deviceId, b))),
  );
}

let autoPickToken = 0;

async function refineAutoPick(list: DeviceSummary[], syncPickId: string): Promise<void> {
  const token = ++autoPickToken;
  const conn = client;
  if (!conn) return;
  const busy = list.filter((d) => d.online && (d.runningSessions ?? 0) > 0);
  const candidates = busy.length > 0 ? busy : list.filter((d) => d.online);
  if (candidates.length < 2) return;
  const settled = await Promise.all(
    candidates.map(async (d) => {
      try {
        const deviceSessions = await conn.request<SessionSummary[]>(d.deviceId, "listSessions");
        return { deviceId: d.deviceId, sessions: ordinarySessions(deviceSessions) };
      } catch {
        return null;
      }
    }),
  );
  if (token !== autoPickToken) return;
  const entries = settled.filter((e): e is { deviceId: string; sessions: SessionSummary[] } => e !== null);
  for (const e of entries) applyDeviceSessions(e.deviceId, e.sessions);
  const winner = busy.length > 0 ? pickRecentRunningDevice(entries) : pickRecentActivityDevice(entries);
  if (!winner || winner === syncPickId) return;
  if (selectedDeviceId !== syncPickId) return;
  selectDevice(winner);
}

function workspaceBasename(wsId: string): string {
  const clean = (wsId || "").replace(/\/+$/, "");
  const slash = clean.lastIndexOf("/");
  return slash >= 0 ? clean.slice(slash + 1) || clean : clean || "—";
}

function applyCurrentProject(deviceId: string, workspaceId: string | null): void {
  projectFilter = workspaceId;
  projectFilterAuto = false;
  if (workspaceId) writeDeviceMapEntry(NT_WS_KEY, deviceId, workspaceId);
  renderSidebar();
  renderSessionColumn();
}

function versionAtLeast(version: string, min: string): boolean {
  const a = version.split(".").map((n) => parseInt(n, 10) || 0);
  const b = min.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

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

  const body = device
    ? device.online
      ? list.length
        ? renderSessionList(
            list,
            currentSession?.id ?? null,
            (s) => void openSession(s.id),
            canDeleteSessions(selectedDeviceId) ? (s) => void requestDeleteSession(s) : undefined,
          )
        : el("div", { class: "empty-note" }, "No sessions yet.")
      : el("div", { class: "empty-note" }, "Device is offline — sessions unavailable.")
    : el("div", { class: "empty-note" }, "Pick an online device to browse its sessions.");

  col.replaceChildren(el("div", { class: "col-body" }, body));
  renderMobileHome();
}

async function refreshSessions(opts?: { autoOpen?: boolean }): Promise<void> {
  if (!selectedDeviceId || !client) return;
  const pullDeviceId = selectedDeviceId;
  try {
    sessions = (await loadDeviceData(pullDeviceId))
      .filter((s) => !s.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (selectedDeviceId !== pullDeviceId) return;
    let openTarget: SessionSummary | null = null;
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

function pickDefaultProject(deviceId: string, list: SessionSummary[]): string | null {
  return pickDefaultProjectRule(deviceProjects.get(deviceId) ?? [], list);
}

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

let newTaskRenderSig = "";
let newTaskRepaintPending = false;
let activeNewTaskPanel: ReturnType<typeof buildNewTaskPanel> | null = null;
let newTaskDraftDeviceId: string | null = null;
let newTaskDraftTimer: number | null = null;
let newTaskStageStore: { drafts: RemoteAttachmentDraft[] } = { drafts: [] };
let newTaskStageDeviceId: string | null = null;
let convStageStore: { drafts: RemoteAttachmentDraft[] } = { drafts: [] };
let convStageSessionId: string | null = null;

type QueueItemView = { id: string; userText: string; attachments: Array<{ name: string }>; mode: string };
let promptQueue: QueueItemView[] = [];
let convQueueView: PromptQueueView | null = null;
let convSubmitGesture: (() => void) | null = null;
let convGestureState: { running: boolean } | null = null;
let demoStatesKey = "";
let demoStates = new Map<string, DemoCardState>();
let convComposerCollapse: { setCollapsed(next: boolean): void } | null = null;
let syncPillRunning: (() => void) | null = null;
let convLiveTimerId: number | null = null;
let convLiveStartedAt = 0;
const convMobileMQ = window.matchMedia("(max-width: 768px)");
convMobileMQ.addEventListener("change", () => {
  if (!convMobileMQ.matches) convComposerCollapse?.setCollapsed(false);
});
const queueCaps = new Map<string, boolean>();
let planReview: PlanReviewSync | null = null;
let planReviewSessionId: string | null = null;

function applyQueueSnapshot(items: QueueItemView[]): void {
  const demoQueueChanged = demoQueueFingerprint(promptQueue.map((item) => item.userText)) !== demoQueueFingerprint(items.map((item) => item.userText));
  promptQueue = items;
  convQueueView?.setItems(items.map(queuedPromptToViewItem));
  convSubmitGesture?.();
  if (demoQueueChanged && currentSession && viewMode === "conv") renderConvView(readConvScrollState() ?? undefined);
}

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

const composerProbe = createComposerProbeStore({
  request: (deviceId, timeoutMs) =>
    client!.request<ComposerOptions>(deviceId, "listComposerOptions", undefined, timeoutMs),
  deviceVersion: (deviceId) => devices.find((d) => d.deviceId === deviceId)?.version ?? "",
});

function composerCapFor(deviceId: string | null): ComposerOptions | null {
  return composerProbe.capFor(deviceId);
}

function onDeviceProvidersChanged(deviceId: string): void {
  composerProbe.invalidate(deviceId);
  if (deviceId !== selectedDeviceId) return;
  void ensureComposerCapability(deviceId).then(() => {
    if (viewMode === "newTask") renderNewTaskView();
    else if (viewMode === "conv" && currentSession) {
      convRenderRelevance.reset();
      void loadSession(currentSession.id, readConvScrollState() ?? undefined);
    }
  });
}

async function refreshComposerOptionsOnMenuOpen(deviceId: string): Promise<ComposerOptions | null> {
  composerProbe.invalidate(deviceId);
  try {
    await ensureComposerCapability(deviceId);
  } catch {
    return null;
  }
  return composerCapFor(deviceId);
}

function ensureComposerCapability(deviceId: string): Promise<boolean> {
  return client ? composerProbe.ensure(deviceId) : Promise.resolve(false);
}

function composerProbePending(deviceId: string | null): boolean {
  if (!deviceId || composerCapFor(deviceId) != null) return false;
  if (composerProbe.probeOf(deviceId) === "legacy") return false;
  return devices.find((d) => d.deviceId === deviceId)?.online === true;
}

function scheduleComposerProbeRetry(deviceId: string): void {
  composerProbe.scheduleRetry(
    deviceId,
    () => {
      if (viewMode === "conv" && currentSession) {
        convRenderRelevance.reset();
        void loadSession(currentSession.id, readConvScrollState() ?? undefined);
      } else if (viewMode === "newTask") {
        renderNewTaskView();
      }
    },
    () => selectedDeviceId === deviceId && (viewMode === "conv" || viewMode === "newTask"),
  );
}

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

function resolveNewTaskPrefs(deviceId: string, options: ComposerOptions): ComposerPrefs {
  const stored = readComposerPrefs(deviceId);
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

function createAttachmentStage(
  deviceId: string,
  toolbar: ComposerToolbar,
  store: { drafts: RemoteAttachmentDraft[] } = { drafts: [] },
) {
  const { drafts } = store;
  const chips = new Map<string, ComposerAttachmentItem>();
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
    take(): RemoteAttachmentDraft[] {
      const out = [...store.drafts];
      store.drafts.length = 0;
      sync();
      return out;
    },
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
  newTaskRenderSig = "";
  newTaskRepaintPending = false;
  renderNewTaskView();
  renderSessionColumn();
  syncMobileView();
}

function renderNewTaskView(): void {
  const deviceId = selectedDeviceId;
  const device = devices.find((d) => d.deviceId === deviceId);
  const options = workspaceOptionsFor(deviceId);
  const composerOptions = composerCapFor(deviceId);
  if (device?.online) {
    void ensureComposerCapability(deviceId!).then((changed) => {
      if (viewMode !== "newTask") return;
      if (composerCapFor(deviceId) != null) {
        if (changed) renderNewTaskView();
      } else if (composerProbe.probeOf(deviceId!) === "legacy") {
        if (changed) renderNewTaskView();
      } else {
        scheduleComposerProbeRetry(deviceId!);
      }
    });
  }
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
    composerProbePending(deviceId),
  ]);
  if (sig === newTaskRenderSig && refs.newTaskView.childElementCount > 0) return;
  newTaskRenderSig = sig;

  if (activeNewTaskPanel?.isMenuOpen()) {
    newTaskRepaintPending = true;
    return;
  }
  newTaskRepaintPending = false;

  flushNewTaskDraft();
  refs.newTaskView.replaceChildren();
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
                if (!fresh.providers.some((p) => p.id === live.providerId)) {
                  live.providerId = fresh.activeProviderId;
                  toolbar?.setState({ providerId: fresh.activeProviderId });
                }
              });
            },
            onPickProvider: (providerId) => {
              live.providerId = providerId;
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
      applyCurrentProject(deviceId!, workspaceId);
    },
    onMenuClosed: () => {
      if (!newTaskRepaintPending) return;
      newTaskRepaintPending = false;
      newTaskRenderSig = "";
      if (viewMode === "newTask") renderNewTaskView();
    },
    onCreateWorkspace: async (name, path) => {
      const dev = deviceId;
      if (!dev || !client) return { ok: false, error: "Device is offline." };
      try {
        const ws = await client.request<{ id: string; name: string; path: string; existing?: boolean }>(
          dev, "createWorkspace", { name, path });
        try { await loadDeviceData(dev); } catch {  }
        applyCurrentProject(dev, ws.id);
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
      fullPermissions: extras.bypass,
      ...(extras.providerId ? { providerId: extras.providerId } : {}),
      reasoningEffort: extras.reasoningEffort,
      ...(extras.infinite ? { composerInfinite: true } : {}),
      ...(extras.attachments.length > 0 ? { attachments: extras.attachments } : {}),
    });
    newTaskDraftDeviceId = null;
    writeDeviceMapEntry(NT_DRAFT_KEY, selectedDeviceId, "");
    panel.textarea.value = "";
    releaseNewTaskComposer(panel, extras.toolbar);
    await refreshSessions();
    await openSession(res.sessionId);
  } catch (err) {
    releaseNewTaskComposer(panel, extras.toolbar);
    extras.stage?.restore(extras.attachments);
    panel.showError((err as Error).message);
  }
}

async function openSession(sessionId: string, ownerDeviceId?: string): Promise<void> {
  const deviceId = ownerDeviceId ?? selectedDeviceId;
  if (!deviceId) return;
  const restore = currentSession?.id === sessionId ? readConvScrollState() ?? undefined : undefined;
  live?.destroy();
  live = null;
  setViewMode("conv");
  convRenderRelevance.reset();
  if (convStageSessionId !== sessionId) {
    convStageStore = { drafts: [] };
    convStageSessionId = sessionId;
  }
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
  if (currentSession?.id !== sessionId) filesPanel.close();
  const seq = ++loadSessionSeq;
  const deviceId = ownerDeviceId ?? selectedDeviceId;
  try {
    const [session, queueItems] = await Promise.all([
      client.request<Session | null>(deviceId, "getSession", { sessionId }),
      client.request<QueueItemView[]>(deviceId, "listPromptQueue", { sessionId })
        .then((items) => {
          queueCaps.set(deviceId, true);
          return Array.isArray(items) ? items : [];
        })
        .catch((err: Error) => {
          if (/unknown action/i.test(err.message ?? "")) queueCaps.set(deviceId, false);
          return queueCaps.get(deviceId) === true ? promptQueue : [];
        }),
      ensureComposerCapability(deviceId).catch(() => false),
    ]);
    if (seq !== loadSessionSeq || viewMode !== "conv" || !session) return;
    if (deviceId !== selectedDeviceId) return;
    applyOptimisticComposer(session);
    if (convRenderRelevance.matches(session)) {
      currentSession = session;
      return;
    }
    const scrollRestore = currentSession?.id === session.id
      ? readConvScrollState() ?? restore
      : restore;
    currentSession = session;
    livePendingAsk = session.pendingUserAsk ?? null;
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
    syncSessionSummary(session);
    renderConvView(scrollRestore);
    renderSessionColumn();
    if (composerCapFor(deviceId) == null) scheduleComposerProbeRetry(deviceId);
    void consumePromptRestoreLatch(deviceId, sessionId);
  } catch {
    if (seq !== loadSessionSeq || viewMode !== "conv" || deviceId !== selectedDeviceId) return;
    convRenderRelevance.reset();
    live?.destroy();
    live = null;
    refs.convView.replaceChildren(sessionLoadErrorView(
      () => retrySessionLoad(sessionId),
      () => goHome(),
    ));
  }
}

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
  convRenderRelevance.rendered(session);
  const prevDraft = (
    refs.convView.querySelector(".composer-card textarea, .composer textarea") as HTMLTextAreaElement | null
  )?.value ?? "";
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
  const bottomBtn = el("button", {
    class: "scroll-bottom-btn",
    title: "Scroll to bottom",
    onclick: () => stream.autoScroll.follow(),
  }, icon("chevronDown", 16));
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
  const legacySendBtn = el("button", { class: "send-btn" }, icon("send"), "Send") as HTMLButtonElement;
  const composeErr = el("div", { class: "compose-error", hidden: true });

  const composerOptions = composerCapFor(selectedDeviceId);
  let toolbar: ComposerToolbar | null = null;
  let stage: ReturnType<typeof createAttachmentStage> | null = null;
  let bypassArmed = false;
  let reasoningEffort: ComposerReasoningEffort = "low";
  let syncPillEffort: (() => void) | null = null;
  if (convStageSessionId !== session.id) {
    convStageStore = { drafts: [] };
    convStageSessionId = session.id;
  }
  if (composerOptions) {
    const running = session.status === "running";
    bypassArmed = readComposerPrefs(selectedDeviceId!).bypass === true;
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
    gauge.attachRing(toolbar.sendWrap);
    gauge.attachTooltip(toolbar.sendWrap);
  }

  const queueCap = !!composerOptions && queueCaps.get(selectedDeviceId ?? "") === true;
  const gesture: { running: boolean } = { running: session.status === "running" };
  let composerSubmitting = false;
  let enqueuePending = false;
  let insertAfterEnqueue = false;
  convGestureState = gesture;

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
    convHead,
    scrollWrap,
    (() => {
      const composerBox = el("div", { class: "composer" }, bottomBtn);
      stream.attachComposerViewport(scrollHost, composerBox);
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
        if (queueView) composerBox.append(queueView.root);
        const composerCard = el("div", { class: "composer-card" },
          el("div", { class: "composer-stripes" },
            el("div", { class: "composer-stripes-layer" })),
          toolbar.attachments,
          composerInput,
          toolbar.root,
          composeErr);
        refs.convComposerCard = composerCard;
        composerBox.append(composerCard);

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
        const collapseAllowed = () =>
          convMobileMQ.matches &&
          !composerInput.value.trim() &&
          !composerInput.disabled &&
          convStageStore.drafts.length === 0 &&
          promptQueue.length === 0 &&
          composeErr.hidden;
        let collapsed = false;
        let morphSeq = 0;
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
            void composerBox.offsetHeight;
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
            window.setTimeout(release, 460);
          });
        };
        const setCollapsed = (next: boolean): void => {
          if (next === collapsed) return;
          if (next && !collapseAllowed()) return;
          collapsed = next;
          morphTo(next);
        };
        convComposerCollapse = { setCollapsed };
        const syncRunPill = (): void => {
          composerCard.classList.toggle("is-running", gesture.running);
          pillBtn.classList.toggle("is-running", gesture.running);
          syncConvLive();
        };
        syncPillRunning = syncRunPill;
        syncRunPill();
        const expandAndFocus = (): void => {
          setCollapsed(false);
          composerInput.focus();
        };
        pillBtn.addEventListener("click", expandAndFocus);
        runSteerBtn.addEventListener("click", expandAndFocus);
        composerInput.addEventListener("focus", () => {
          setCollapsed(false);
          if (convMobileMQ.matches) {
            stream.autoScroll.contentChanged();
          }
        });
        composerInput.addEventListener("blur", () => {
          window.setTimeout(() => setCollapsed(true), 160);
        });
        if (collapseAllowed()) {
          collapsed = true;
          composerBox.classList.add("is-collapsed");
          pillBtn.setAttribute("aria-expanded", "false");
          runSteerBtn.setAttribute("aria-expanded", "false");
        }
      } else if (composerProbePending(selectedDeviceId)) {
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

  syncConvLive();

  requestAnimationFrame(() => {
    if (live !== stream) return;
    if (restore && !restore.atBottom) stream.autoScroll.restoreTop(restore.top);
    stream.autoScroll.snapIfFollowing();
    updateBottomBtn();
  });
}

const idleResyncTimers = new Map<string, () => void>();
let loadSessionSeq = 0;

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

function scheduleIdleResync(sessionId: string): void {
  cancelIdleResync(sessionId);
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

async function consumePromptRestoreLatch(deviceId: string, sessionId: string): Promise<void> {
  if (!client) return;
  try {
    const payload = await client.request<{ text: string } | null>(deviceId, "takePromptRestore", { sessionId });
    if (!payload || typeof payload.text !== "string") return;
    if (currentSession?.id === sessionId && viewMode === "conv") {
      restorePromptToWebComposer(payload.text, 0);
    }
  } catch {
  }
}

const toolRefreshTimers = new Map<string, number>();

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
      });
  }, 250));
}

function readConvScrollState(): { top: number; atBottom: boolean } | null {
  const host = refs.convView.querySelector(".conv-scroll") as HTMLElement | null;
  if (!host) return null;
  return {
    top: host.scrollTop,
    atBottom: live?.autoScroll.following ?? true,
  };
}

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

function setConvStatus(
  text: string,
  opts: { visible?: boolean; active?: boolean; animated?: boolean } = {},
): void {
  const trimmed = text.trim();
  const show = opts.visible !== false && trimmed.length > 0;
  live?.setStatusLine(trimmed, show);
  const runStatus = refs.convRunStatus;
  if (runStatus) {
    runStatus.textContent = show ? trimmed : "Steer this turn…";
    runStatus.classList.toggle("is-animated", show && opts.animated === true);
  }
}

const cardToolCallIds = new Set<string>();
const workspaceMutationToolCallIds = new Set<string>();

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

  const { plansByCreateToolCallId } = buildPlansByCreateToolCallId(messages);
  let plan: PlanSnapshot | null = null;
  for (const snapshot of plansByCreateToolCallId.values()) {
    if (snapshot.status === "active") plan = snapshot;
  }

  if (plan) {
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
    live.progLabel.textContent = currentSession?.progressText?.trim() || "Executing tool…";
    live.progRow.hidden = false;
    live.promptRow.hidden = true;
    live.taskRow.hidden = true;
  }
}

function handleStreamEvent(sessionId: string, event: ConsoleStreamEvent): void {
  if (event.type === "session_deleted") {
    if (currentSession?.id === sessionId) {
      goHome("This session was deleted on the device.");
    }
    refreshSessionsQuiet();
    return;
  }
  if (!currentSession || sessionId !== currentSession.id) {
    if (event.type === "status" || event.type === "done") refreshSessionsQuiet();
    return;
  }
  switch (event.type) {
    case "user_ask": {
      const ask = event.ask;
      if (!ask || typeof ask.requestId !== "string" || typeof ask.toolCallId !== "string") break;
      livePendingAsk = {
        requestId: ask.requestId,
        toolCallId: ask.toolCallId,
        question: typeof ask.question === "string" ? ask.question : "",
        ...(typeof ask.detail === "string" && ask.detail ? { detail: ask.detail } : {}),
        options: Array.isArray(ask.options) ? ask.options.filter((o): o is string => typeof o === "string") : [],
        ...(ask.optionDetails ? { optionDetails: ask.optionDetails } : {}),
        ...(typeof ask.handoffQrPng === "string" ? { handoffQrPng: ask.handoffQrPng } : {}),
        allowCustom: ask.allowCustom === true,
        allowMultiple: ask.allowMultiple === true,
      };
      const mounted = live?.attachPendingAsk(livePendingAsk) ?? false;
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
      if (typeof event.text === "string") {
        setConvStatus(event.text, {
          active: true,
          animated: isAnimatedProgressText(event.text),
          visible: cardToolCallIds.size === 0,
        });
      }
      if (refs.convLive && !refs.convLive.progRow.hidden) syncConvLive();
      if (
        typeof event.text === "string" &&
        /^Waiting for (your answer|bypass permissions)/.test(event.text) &&
        !livePendingAsk
      ) {
        scheduleAskResync(sessionId, 400);
      }
      break;
    }
    case "tool_finished": {
      if (typeof event.id === "string") {
        cardToolCallIds.delete(event.id);
        if (workspaceMutationToolCallIds.delete(event.id)) void refreshSessionsQuiet();
      }
      if (livePendingAsk && event.id === livePendingAsk.toolCallId) {
        livePendingAsk = null;
        scheduleAskResync(sessionId);
      }
      if (isWorkspaceMutationTool(event.name)) void refreshSessionsQuiet();
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
        if (isWorkspaceMutationTool(bridged.name)) {
          workspaceMutationToolCallIds.add(event.id);
        }
      }
      live?.apply(event as StreamEvent);
      if (event.type === "tool_call" && (event.name === "create_plan" || event.name === "plan_update")) {
        syncConvLive();
      }
      break;
    case "status": {
      const runningStatus = event.status === "running" || event.status === "streaming" || event.status === "tool_running";
      refs.convComposerCard?.classList.toggle("is-running", runningStatus);
      if (runningStatus) {
        setConvStatus(statusPill(event.status).label, { active: true });
        void refreshSessionsQuiet();
        if (event.status === "running") {
          scheduleTurnStartResync(sessionId);
        }
      }
      else {
        setConvStatus("", { visible: false });
        cardToolCallIds.clear();
        scheduleIdleResync(sessionId);
      }
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
      const value = gaugeValueFromStreamEvent(event);
      if (value) {
        liveContextUsage = value;
        refs.convGauge?.setUsage(value);
      }
      break;
    }
    case "prompt_queue": {
      applyQueueSnapshot(Array.isArray(event.items) ? event.items : []);
      break;
    }
    case "prompt_restored": {
      restorePromptToWebComposer(event.text, event.attachments.length);
      void client?.request(selectedDeviceId!, "takePromptRestore", { sessionId }).catch(() => {});
      scheduleIdleResync(sessionId);
      break;
    }
    case "steer_consumed": {
      scheduleSteerResync(sessionId);
      break;
    }
    case "done":
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

async function refreshManageData(): Promise<void> {
  if (!client) return;
  try {
    serverInfo = await client.serverInfo();
  } catch {  }
  try {
    keys = await client.listKeys();
  } catch {  }
  try {
    auditEntries = await client.requestAudit(200);
  } catch {  }
  try {
    promptEntries = await client.requestPrompts(200);
  } catch {  }
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

async function refreshPromptEntries(): Promise<void> {
  if (!client) return;
  try {
    promptEntries = await client.requestPrompts(200);
  } catch {  }
}

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
  } catch {  }
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
      }).catch(() => {  });
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
    el("button", {
      class: "m-back", type: "button",
      title: "Back", "aria-label": "Back",
      onclick: () => goHome(),
    }, icon("back", 18)),
    el("h1", {}, "Manage"),
    el("span", { class: "spacer" }),
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

async function refreshMemoryOverview(): Promise<void> {
  if (!sessionToken) return;
  try {
    const res = await fetch(`${apiBase()}api/console/memory/overview`, { headers: { "x-auth-token": sessionToken } });
    if (res.status === 200) {
      memoryOverview = (await res.json()) as MemoryOverview;
      if (viewMode === "memory") renderMemoryBody();
    }
  } catch {  }
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

function buildMaintenancePanel(selForMaintenance: DeviceSummary | null): DeviceMaintenancePanel {
  const maintOk = supportsMaintenance(selForMaintenance);
  const execOk = supportsExec(selForMaintenance) && versionAtLeast(selForMaintenance!.version, "1.3.5");
  const desktop = maintOk && !isAgentdDevice(selForMaintenance);
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
  const maintOk = supportsMaintenance(selForMaintenance);
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
    el("button", {
      class: "m-back", type: "button",
      title: "Back", "aria-label": "Back",
      onclick: () => goHome(),
    }, icon("back", 18)),
    el("h1", {}, "Devices"),
    el("span", { class: "count-pill" }, `${devices.length} registered`),
    el("span", { class: "spacer" }),
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

initOverlayScrollbars();

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
