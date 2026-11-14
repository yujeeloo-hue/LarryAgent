import {
  ArchiveRestore,
  Check,
  Download,
  Eye,
  FileDown,
  Fingerprint,
  FolderOpen,
  GripVertical,
  Info,
  KeyRound,
  Plus,
  Sparkles,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
  createElement,
  type IconNode,
} from "lucide";
import { createLucideIcon } from "../../ui/icons.js";
import { createLucideIcon as createOriginalIcon } from "../../ui/originalIcons.js";
import { createMonoIcon, type MonoIconName } from "../../ui/monoIcon.js";
import {
  createBrandIcon,
  matchModelBrand,
  type ModelBrandSource,
} from "../../ui/modelBrand.js";
import { createStorageProviderBrandIcon } from "../../ui/storageBrand.js";
import {
  EffortSegView,
  type ReasoningEffortLevel,
} from "../../ui/effortSeg/EffortSegView.js";
import { THEMES, type ThemeId } from "../../state/theme.js";
import { AppDropdown } from "../../ui/appDropdown.js";
import { AccentPicker } from "./AccentPicker.js";
import { createSettingCategoryIcon, type SettingCategoryId } from "./settingCategoryIcon.js";
import { normalizeLlmProviderOptions, resolveLlmApiProtocol, resolveResponsesStateful, modelEndpoint, type LlmProviderApiOptions } from "../../../../llm/apiProtocol.js";
import { resolveToolRoleImageSupport } from "../../../../settings/toolRoleImageDefaults.js";
import "./setting.css";
import { createCocoSettingsPanel } from "../coco/CocoSettingsPanel.js";

/** Flex gap between provider rows in the list (must match setting.css). */
const PROVIDER_ROW_GAP_PX = 4;
/** Pointer travel before a press on a provider row becomes a drag. */
const PROVIDER_DRAG_START_THRESHOLD_PX = 5;
/** Distance from the list edge that starts edge auto-scroll while dragging. */
const PROVIDER_EDGE_SCROLL_PX = 26;
/** Max px/frame scrolled at the very edge (fades to 0 approaching the band). */
const PROVIDER_EDGE_SCROLL_SPEED_PX = 10;

/** Friendly labels for backup bundle sections (header.json `sections`). */
const BACKUP_SECTION_LABELS: Record<string, string> = {
  settings: "Providers & preferences",
  cocoSettings: "CoCo settings",
  tools: "Tools & MCP",
  secrets: "API keys",
  skills: "Skills",
  userMemory: "User memory",
  fsmGraphs: "FSM graphs",
};

/** Human-readable byte size (e.g. "1.2 MB", "860 KB", "42 B"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * Moonshot / Kimi server hosts (renderer copy of the main-side predicate in
 * settings/types.ts — keep the host list in sync). Vision models there
 * reject external image URLs — only base64 data URIs and `ms://<file-id>`
 * references work.
 */
function isMoonshotProviderBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) return false;
  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    return (
      host === "api.moonshot.cn" ||
      host.endsWith(".moonshot.cn") ||
      host === "api.moonshot.ai" ||
      host.endsWith(".moonshot.ai") ||
      host === "api.kimi.com" ||
      host.endsWith(".kimi.com")
    );
  } catch {
    return false;
  }
}

export type SettingProviderForm = LlmProviderApiOptions & {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  supportsMultimodal: boolean;
  /** How images reach a multimodal provider: https URL, inlined base64, or the provider's files API. */
  imageInput: "url" | "base64" | "file";
  /** Explicit tool-result image override; omit to follow the verified default list. */
  toolRoleImages?: boolean;
  /** Use Base URL as the full endpoint — never append /chat/completions. */
  rawEndpoint: boolean;
};

export type SettingImageGenForm = {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  /** Use Base URL as the full endpoint — never append /images/generations. */
  rawEndpoint: boolean;
  /** Explicit watermark body field; omit = provider default (not sent). */
  watermark?: boolean;
  /** How input images reach the provider; omit = image input disabled. */
  imageInput?: "base64" | "url";
};

export type SettingObjectStorageForm = {
  provider: "amazon" | "tencent";
  region: string;
  bucket: string;
  accessKeyId: string;
  endpoint: string;
  keyPrefix: string;
  urlMode: "presigned" | "public";
  enabled: boolean;
};

export type SettingFormState = {
  providers: SettingProviderForm[];
  activeProviderId: string;
  selectedProviderId: string;
  apiKeyConfiguredByProviderId: Record<string, boolean>;
  /** Vision fallback: id of a Multimodal chat provider, or null. */
  visionProviderId: string | null;
  /** Dev Mode ghost text: chat provider id, or null for the new-task default. */
  inlineCompletionProviderId: string | null;
  imageGenProviders: SettingImageGenForm[];
  activeImageGenProviderId: string;
  selectedImageGenProviderId: string;
  imageGenApiKeyConfiguredByProviderId: Record<string, boolean>;
  objectStorage: SettingObjectStorageForm | null;
  objectStorageSecretConfigured: boolean;
  fullPermissionsDefault: boolean;
  autoSkillSummarizeDefault: boolean;
  composerInfinite: boolean;
  reasoningEffort: ReasoningEffortLevel;
  contextLimitTokens: number;
  compactTriggerRatio: number;
  iterationProtectRawIterationCount: number;
  iterationProtectTokenRatio: number;
  maxModelIterations: number;
  maxTurnTokens: number;
  /** Chat request headers-wait timeout (ms); UI edits in seconds. */
  llmRequestTimeoutMs: number;
  environmentContext: {
    workspace: boolean;
    timezone: boolean;
    locale: boolean;
    location: boolean;
    repository: boolean;
  };
  userMemoryAutoExtract: boolean;
  toolStatsEnabled: boolean;
  userMemoryProfile: string;
  userMemoryUpdatedAt: number;
  /** Renderer theme id (persisted in settings.json). */
  themeId: ThemeId;
  /** Highlight color override: "auto" | preset id | "#rrggbb". */
  accentColor: string;
  /** Interface text scale factor (whole-UI zoom); 1 = 100%. */
  uiFontScale: number;
  /** Conversation text scale factor (`--chat-fs-scale`); 1 = 100%. */
  chatFontScale: number;
};

export type SettingCardId =
  | "coco"
  | "providers"
  | "vision"
  | "completion"
  | "imagegen"
  | "objectstorage"
  | "permissions"
  | "safety"
  | "agent"
  | "remote"
  | "update"
  | "appearance"
  | "user"
  | "storage"
  | "backup";

type SettingCategory = {
  id: SettingCategoryId;
  label: string;
  group: "Preferences" | "System";
  cards: SettingCardId[];
};

const SETTING_CATEGORIES: SettingCategory[] = [
  { id: "appearance", label: "Appearance", group: "Preferences", cards: ["appearance"] },
  { id: "models", label: "Models", group: "Preferences", cards: ["providers", "vision", "completion", "imagegen"] },
  { id: "composer", label: "Composer", group: "Preferences", cards: ["permissions"] },
  { id: "agent", label: "Agent", group: "Preferences", cards: ["agent"] },
  { id: "coco", label: "CoCo", group: "Preferences", cards: ["coco"] },
  { id: "memory", label: "Memory", group: "Preferences", cards: ["user"] },
  { id: "security", label: "Security", group: "System", cards: ["safety"] },
  { id: "remote", label: "Remote Control", group: "System", cards: ["remote"] },
  { id: "update", label: "Update", group: "System", cards: ["update"] },
  { id: "data", label: "Data & Backup", group: "System", cards: ["objectstorage", "storage", "backup"] },
];

/** Keep all forms mounted so navigation preserves drafts and controller listeners. */
function createCategoryLayout(cards: Record<SettingCardId, HTMLElement>, initialCategory: SettingCategoryId): HTMLElement {
  const layout = document.createElement("div");
  layout.className = "setting-layout";
  const nav = document.createElement("nav");
  nav.className = "setting-categories";
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-label", "Settings categories");
  nav.setAttribute("aria-orientation", "vertical");
  const content = document.createElement("div");
  content.className = "setting-content";
  const tabs: HTMLButtonElement[] = [];
  const panels: HTMLElement[] = [];
  const scrollPositions = new Map<number, number>();
  let selectedIndex = Math.max(0, SETTING_CATEGORIES.findIndex(category => category.id === initialCategory));
  let group = "";

  const select = (index: number): void => {
    if (index === selectedIndex) return;
    scrollPositions.set(selectedIndex, content.scrollTop);
    selectedIndex = index;
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.setAttribute("tabindex", i === index ? "0" : "-1");
      panels[i]!.hidden = i !== index;
    });
    content.scrollTop = scrollPositions.get(index) ?? 0;
  };

  SETTING_CATEGORIES.forEach((category, index) => {
    if (category.group !== group) {
      group = category.group;
      const heading = document.createElement("p");
      heading.className = "setting-category-group";
      heading.textContent = group;
      heading.setAttribute("role", "presentation");
      nav.append(heading);
    }
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "setting-category-tab";
    tab.id = `setting-tab-${category.id}`;
    tab.dataset.category = category.id;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `setting-panel-${category.id}`);
    tab.setAttribute("aria-selected", String(index === selectedIndex));
    tab.setAttribute("tabindex", index === selectedIndex ? "0" : "-1");
    tab.append(createSettingCategoryIcon(category.id), document.createTextNode(category.label));
    tab.addEventListener("click", () => select(index));
    tabs.push(tab);
    nav.append(tab);

    const panel = document.createElement("section");
    panel.className = "setting-category-panel";
    panel.id = `setting-panel-${category.id}`;
    panel.dataset.category = category.id;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    panel.tabIndex = 0;
    panel.hidden = index !== selectedIndex;
    const list = document.createElement("div");
    list.className = "setting-card-list";
    for (const cardId of category.cards) {
      cards[cardId].dataset.card = cardId;
      list.append(cards[cardId]);
    }
    panel.append(list);
    panels.push(panel);
    content.append(panel);
  });

  nav.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = (index + 1) % tabs.length; break;
      case "ArrowUp": next = (index - 1 + tabs.length) % tabs.length; break;
      case "Home": next = 0; break;
      case "End": next = tabs.length - 1; break;
      default: return;
    }
    event.preventDefault();
    select(next);
    tabs[next]!.focus({ preventScroll: true });
  });
  layout.append(nav, content);
  return layout;
}

/**
 * Text-size presets (Settings → Appearance). Values are the persisted scale
 * factors as strings (AppDropdown mirrors the select surface); snapping
 * on read-back keeps hand-edited settings.json values usable.
 */
const UI_FONT_SCALE_OPTIONS = [
  { value: "0.9", label: "Compact", hint: "90%" },
  { value: "1", label: "Default", hint: "100%" },
  { value: "1.15", label: "Large", hint: "115%" },
  { value: "1.3", label: "Extra Large", hint: "130%" },
] as const;

const CHAT_FONT_SCALE_OPTIONS = [
  { value: "0.9", label: "Small", hint: "90%" },
  { value: "1", label: "Default", hint: "100%" },
  { value: "1.1", label: "Large", hint: "110%" },
  { value: "1.25", label: "Extra Large", hint: "125%" },
  { value: "1.5", label: "Huge", hint: "150%" },
] as const;

/** Nearest preset value for a persisted scale (identity for exact matches). */
export function snapFontScale(
  value: number,
  options: readonly { value: string }[],
): string {
  let best = options[0]?.value ?? "1";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const option of options) {
    const distance = Math.abs(parseFloat(option.value) - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = option.value;
    }
  }
  return best;
}

function fieldRow(
  labelText: string,
  control: HTMLElement,
  hint?: string,
): HTMLElement {
  const row = document.createElement("label");
  row.className = "setting-field";

  const label = document.createElement("span");
  label.className = "setting-field-label";
  label.textContent = labelText;

  row.append(label, control);
  if (hint) {
    const hintEl = document.createElement("span");
    hintEl.className = "setting-field-hint";
    hintEl.textContent = hint;
    row.append(hintEl);
  }
  return row;
}

function textInput(
  name: string,
  options?: { type?: string; placeholder?: string; autocomplete?: "off" | "on" },
): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "setting-input";
  input.name = name;
  input.type = options?.type ?? "text";
  input.spellcheck = false;
  if (options?.placeholder) input.placeholder = options.placeholder;
  if (options?.autocomplete) input.autocomplete = options.autocomplete;
  return input;
}

/** Checkbox styled as a switch (CSS); keeps input.checked / change events. */
function switchInput(name: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "setting-toggle";
  input.name = name;
  input.setAttribute("role", "switch");
  input.setAttribute("aria-checked", "false");
  input.addEventListener("change", () => syncSwitchAria(input));
  return input;
}

function syncSwitchAria(input: HTMLInputElement): void {
  input.setAttribute("aria-checked", input.checked ? "true" : "false");
}

/** Official Lucide outline glyphs for the Update card's actions and status marks. */
function strokeLucide(icon: IconNode, size: number, strokeWidth = 2): SVGElement {
  return createElement(icon, {
    width: size,
    height: size,
    "stroke-width": strokeWidth,
    "aria-hidden": "true",
    focusable: "false",
  });
}

function createCard(
  icon: MonoIconName | SVGElement,
  title: string,
  description: string,
): {
  card: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  status: HTMLElement;
} {
  const card = document.createElement("article");
  card.className = "setting-card";

  const header = document.createElement("div");
  header.className = "setting-card-header";

  const iconWrap = document.createElement("div");
  iconWrap.className = "setting-card-icon";
  iconWrap.append(typeof icon === "string" ? createMonoIcon(icon, 20) : icon);

  const titles = document.createElement("div");
  titles.className = "setting-card-titles";

  const titleEl = document.createElement("h3");
  titleEl.className = "setting-card-title";
  titleEl.textContent = title;

  const descEl = document.createElement("p");
  descEl.className = "setting-card-desc";
  descEl.textContent = description;

  titles.append(titleEl, descEl);
  header.append(iconWrap, titles);

  const body = document.createElement("div");
  body.className = "setting-card-body";

  const footer = document.createElement("div");
  footer.className = "setting-card-footer";

  const status = document.createElement("p");
  status.className = "setting-card-status";
  status.hidden = true;

  footer.append(status);

  card.append(header, body, footer);

  return { card, body, footer, status };
}

/** Geometry snapshot of one provider row within the list's content box. */
type ProviderRowGeometry = {
  top: number;
  height: number;
};

/**
 * Live state of a pointer drag-reorder gesture over the providers list.
 * Created on pointerdown, mutated while dragging, cleared on release/cancel.
 */
type ProviderDragState = {
  pointerId: number;
  sourceRow: HTMLElement;
  /** Index of the dragged row in `rows` (== its slot in this.providers). */
  sourceIndex: number;
  rows: HTMLElement[];
  geometry: ProviderRowGeometry[];
  /** Uniform step between adjacent slots (row height + list gap). */
  stepPx: number;
  startX: number;
  startY: number;
  grabOffsetY: number;
  started: boolean;
  /** Target slot (over ALL rows) the dragged profile would occupy right now. */
  insertIndex: number;
  ghost: HTMLElement | null;
  frame: number | null;
  lastClientY: number;
};

/**
 * Settings screen — category navigation with persistent, auto-saving forms.
 */
export class SettingView {
  readonly root: HTMLElement;
  readonly providerListEl: HTMLElement;
  readonly addProviderButton: HTMLButtonElement;
  readonly deleteProviderButton: HTMLButtonElement;
  readonly setDefaultProviderButton: HTMLButtonElement;
  readonly nameInput: HTMLInputElement;
  readonly baseUrlInput: HTMLInputElement;
  readonly modelIdInput: HTMLInputElement;
  /** Brand icon shown next to the Model ID input (updated on selection). */
  private readonly modelIdBrandIcon: HTMLSpanElement;
  readonly multimodalToggle: HTMLInputElement;
  readonly toolRoleImagesToggle: HTMLInputElement;
  readonly imageInputSelect: AppDropdown;
  readonly rawEndpointToggle: HTMLInputElement;
  readonly apiProtocolSelect: AppDropdown;
  readonly apiProtocolHint: HTMLElement;
  readonly responsesToolsInput: HTMLTextAreaElement;
  readonly responsesStatefulToggle: HTMLInputElement;
  readonly responsesWebSearchToggle: HTMLInputElement;
  readonly responsesCodeExecutionToggle: HTMLInputElement;
  readonly responsesImageGenerationToggle: HTMLInputElement;
  private readonly responsesOptionsBlock: HTMLElement;
  readonly apiKeyInput: HTMLInputElement;
  readonly apiKeyStatus: HTMLElement;
  readonly clearApiKeyButton: HTMLButtonElement;
  /** Vision fallback provider dropdown (Multimodal chat providers only). */
  readonly visionProviderSelect: AppDropdown;
  /** Dev Mode ghost-text provider. Empty value follows the new-task default. */
  readonly completionProviderSelect: AppDropdown;
  readonly imageGenProviderListEl: HTMLElement;
  readonly addImageGenProviderButton: HTMLButtonElement;
  readonly deleteImageGenProviderButton: HTMLButtonElement;
  readonly setActiveImageGenProviderButton: HTMLButtonElement;
  readonly imageGenNameInput: HTMLInputElement;
  readonly imageGenBaseUrlInput: HTMLInputElement;
  readonly imageGenModelIdInput: HTMLInputElement;
  readonly imageGenRawEndpointToggle: HTMLInputElement;
  readonly imageGenWatermarkSelect: AppDropdown;
  readonly imageGenImageInputSelect: AppDropdown;
  readonly imageGenApiKeyInput: HTMLInputElement;
  readonly imageGenApiKeyStatus: HTMLElement;
  readonly clearImageGenApiKeyButton: HTMLButtonElement;
  readonly objectStorageProviderSelect: AppDropdown;
  private readonly objectStorageProviderBrandIcon: HTMLSpanElement;
  readonly objectStorageRegionInput: HTMLInputElement;
  readonly objectStorageBucketInput: HTMLInputElement;
  readonly objectStorageAccessKeyIdInput: HTMLInputElement;
  readonly objectStorageEndpointInput: HTMLInputElement;
  readonly objectStorageKeyPrefixInput: HTMLInputElement;
  readonly objectStorageUrlModeSelect: AppDropdown;
  readonly objectStorageEnabledToggle: HTMLInputElement;
  readonly objectStorageSecretInput: HTMLInputElement;
  readonly objectStorageSecretStatus: HTMLElement;
  readonly objectStorageTestButton: HTMLButtonElement;
  readonly clearObjectStorageButton: HTMLButtonElement;
  readonly clearObjectStorageSecretButton: HTMLButtonElement;
  readonly fullPermissionsToggle: HTMLInputElement;
  readonly autoSkillSummarizeToggle: HTMLInputElement;
  /** Shell Safe Mode master switch (tools.json shellSafety.enabled). */
  readonly shellSafetyToggle: HTMLInputElement;
  /** Outside-workspace command policy (tools.json shellSafety.fatalPolicy). */
  readonly shellSafetyPolicySelect: AppDropdown;
  /** New Task default: Infinite (settings.json composerInfinite). */
  readonly newTaskInfiniteToggle: HTMLInputElement;
  /** New Task default reasoning-effort dial (settings.json reasoningEffort). */
  readonly newTaskReasoningSeg: EffortSegView;
  /** Fires when the effort dial changes (debounced save in the controller). */
  onReasoningEffortChange: (level: ReasoningEffortLevel) => void = () => {};
  readonly themeSelect: AppDropdown;
  /** Highlight color swatch picker (same card as Theme). */
  readonly accentPicker: AccentPicker;
  /** Text size dropdowns (same card as Theme): whole-UI zoom / chat text. */
  readonly uiFontScaleSelect: AppDropdown;
  readonly chatFontScaleSelect: AppDropdown;
  readonly contextLimitInput: HTMLInputElement;
  readonly compactTriggerRatioInput: HTMLInputElement;
  readonly iterationProtectRawIterationCountInput: HTMLInputElement;
  readonly iterationProtectTokenRatioInput: HTMLInputElement;
  readonly maxRoundsInput: HTMLInputElement;
  readonly maxTurnTokensInput: HTMLInputElement;
  /** Chat request timeout (s); stored as llmRequestTimeoutMs. */
  readonly llmRequestTimeoutInput: HTMLInputElement;
  private readonly iterationProtectSection: HTMLElement;
  readonly envWorkspaceToggle: HTMLInputElement;
  readonly envTimezoneToggle: HTMLInputElement;
  readonly envLocaleToggle: HTMLInputElement;
  readonly envLocationToggle: HTMLInputElement;
  readonly envRepositoryToggle: HTMLInputElement;
  readonly toolStatsEnabledToggle: HTMLInputElement;
  readonly resetUserPromptButton: HTMLButtonElement;
  readonly userMemoryAutoExtractToggle: HTMLInputElement;
  readonly userMemoryProfileInput: HTMLTextAreaElement;
  readonly clearMemoryButton: HTMLButtonElement;
  readonly cleanupButton: HTMLButtonElement;
  readonly exportBackupButton: HTMLButtonElement;
  readonly chooseBackupButton: HTMLButtonElement;
  readonly applyBackupButton: HTMLButtonElement;
  private readonly backupSummaryBox: HTMLElement;
  private readonly backupImportTitle: HTMLElement;
  private readonly backupSummaryPath: HTMLElement;
  private readonly backupSummarySections: HTMLElement;
  private readonly backupSummaryMeta: HTMLElement;
  private readonly backupProgressBar: HTMLElement;
  private backupImportPath = "";
  private readonly storageUsageRows: Array<{
    label: string;
    value: HTMLElement;
  }> = [];

  private readonly statusByCard: Record<SettingCardId, HTMLElement>;
  private readonly versionEl: HTMLElement;
  private providers: SettingProviderForm[] = [];
  private selectedProviderId = "";
  private activeProviderId = "";
  private apiKeyConfiguredByProviderId: Record<string, boolean> = {};
  private imageGenProviders: SettingImageGenForm[] = [];
  private selectedImageGenProviderId = "";
  private activeImageGenProviderId = "";
  private imageGenApiKeyConfiguredByProviderId: Record<string, boolean> = {};

  private busyCard: SettingCardId | null = null;
  private onSelectProvider: ((id: string) => void) | null = null;
  private onProviderOrderChange: (() => void) | null = null;
  private onSelectImageGenProvider: ((id: string) => void) | null = null;

  /** Providers-list pointer drag state; null while idle. */
  private providerDrag: ProviderDragState | null = null;
  private providerDragBound = false;
  /** Swallows the click that lands right after a drop so it never selects. */
  private suppressNextRowClick = false;

  // ── Remote relay bridge fields (assigned in buildRemoteCard) ──
  private remoteEnableToggle!: HTMLInputElement;
  private remoteServerUrlInput!: HTMLInputElement;
  private remoteApiKeyInput!: HTMLInputElement;
  private remoteDeviceNameInput!: HTMLInputElement;
  private remoteModeSelect!: AppDropdown;
  private remotePushSelect!: AppDropdown;
  private remoteConnStatusLine!: HTMLElement;
  private remoteConfigCache: RemoteRelayConfig | null = null;
  private remoteStatusUnsubscribe: (() => void) | null = null;
  private remoteSyncActionButtons: (() => void) | null = null;

  // ── Update card fields (assigned in buildUpdateCard) ──
  private updateChip!: HTMLElement;
  private updateVersionLine!: HTMLElement;
  private updateMetaLine!: HTMLElement;
  private updateNote!: HTMLElement;
  private updateLive!: HTMLElement;
  private updateCheckButton!: HTMLButtonElement;
  private updateRunButton!: HTMLButtonElement;
  private updateStateUnsubscribe: (() => void) | null = null;
  private updateLiveRefs: { pct?: HTMLElement; track?: HTMLElement; fill?: HTMLElement; label?: HTMLElement; rate?: HTMLElement } = {};
  private updateSnapshot: {
    currentVersion: string;
    platform: string;
    latest: { version: string; url: string; sha256?: string } | null;
    upToDate: boolean;
    checkedAt: number | null;
    checking: boolean;
    /** Click landed, run IPC in flight (until the first state push takes over). */
    requesting: boolean;
    checkError: string | null;
    maintenance: UpdateMaintenanceState | null;
  } = {
    currentVersion: "",
    platform: "",
    latest: null,
    upToDate: false,
    checkedAt: null,
    checking: false,
    requesting: false,
    checkError: null,
    maintenance: null,
  };

  constructor(initialCategory: SettingCategoryId = "appearance") {
    this.root = document.createElement("section");
    this.root.className = "screen setting-screen";

    const header = document.createElement("div");
    header.className = "screen-header setting-screen-header";
    const titleRow = document.createElement("div");
    titleRow.className = "setting-title-row";
    const title = document.createElement("h1");
    title.className = "screen-title";
    title.textContent = "Settings";
    this.versionEl = document.createElement("span");
    this.versionEl.className = "setting-app-version";
    this.versionEl.hidden = true;
    titleRow.append(title, this.versionEl);
    header.append(titleRow);

    const appearance = createCard(
      "appearance",
      "Appearance",
      "Renderer theme, highlight color and text size. Changes apply immediately and are restored on next launch.",
    );

    this.themeSelect = new AppDropdown(
      THEMES.map((theme) => ({
        value: theme.id,
        label: theme.name,
        hint: theme.description,
      })),
      "dark",
    );
    this.accentPicker = new AccentPicker();
    const accentField = document.createElement("div");
    accentField.className = "setting-field";
    const accentLabel = document.createElement("span");
    accentLabel.className = "setting-field-label";
    accentLabel.textContent = "Highlight color";
    accentField.append(accentLabel, this.accentPicker.el);
    const appearanceRow = document.createElement("div");
    appearanceRow.className = "setting-field-row setting-field-row-2";
    appearanceRow.append(
      fieldRow(
        "Theme",
        this.themeSelect.el,
        "The default Dark theme is the classic JellyBot look.",
      ),
      accentField,
    );
    appearance.body.append(appearanceRow);

    this.uiFontScaleSelect = new AppDropdown(UI_FONT_SCALE_OPTIONS, "1");
    this.chatFontScaleSelect = new AppDropdown(
      CHAT_FONT_SCALE_OPTIONS,
      "1",
    );
    const textSizeRow = document.createElement("div");
    textSizeRow.className = "setting-field-row setting-field-row-2";
    textSizeRow.append(
      fieldRow(
        "Interface text",
        this.uiFontScaleSelect.el,
        "Scales the whole interface — sidebar, settings, cards.",
      ),
      fieldRow(
        "Conversation text",
        this.chatFontScaleSelect.el,
        "Extra scaling for message text, code and diffs.",
      ),
    );
    appearance.body.append(textSizeRow);

    const providers = createCard(
      "providers",
      "Providers",
      "Configure OpenAI-compatible LLM profiles. Default is used for new tasks; each task can pick its own in the composer.",
    );

    const listHeader = document.createElement("div");
    listHeader.className = "setting-provider-list-header";
    const listLabel = document.createElement("span");
    listLabel.className = "setting-field-label";
    listLabel.textContent = "Profiles";
    this.addProviderButton = document.createElement("button");
    this.addProviderButton.type = "button";
    this.addProviderButton.className = "setting-btn setting-btn-icon";
    this.addProviderButton.setAttribute("aria-label", "Add provider");
    this.addProviderButton.title = "Add provider";
    this.addProviderButton.append(createLucideIcon(Plus, { size: 14 }));
    listHeader.append(listLabel, this.addProviderButton);

    this.providerListEl = document.createElement("div");
    this.providerListEl.className = "setting-provider-list";
    this.providerListEl.setAttribute("role", "listbox");

    this.nameInput = textInput("name", { placeholder: "Display name" });
    this.baseUrlInput = textInput("baseUrl", {
      placeholder: "https://api.openai.com/v1",
    });
    this.modelIdInput = textInput("modelId", { placeholder: "gpt-4o-mini" });
    const modelIdWrap = document.createElement("div");
    modelIdWrap.className = "setting-input-with-icon";
    this.modelIdBrandIcon = document.createElement("span");
    this.modelIdBrandIcon.className = "setting-model-brand-icon";
    modelIdWrap.append(this.modelIdInput, this.modelIdBrandIcon);
    // Brand match runs against modelId → baseUrl host → display name, so all
    // three editors refresh the icon live while typing (not only on switch).
    const syncModelBrandIcon = (): void => {
      this.updateModelIdBrandIcon({
        name: this.nameInput.value,
        baseUrl: this.baseUrlInput.value,
        modelId: this.modelIdInput.value,
      });
    };
    this.nameInput.addEventListener("input", syncModelBrandIcon);
    this.baseUrlInput.addEventListener("input", syncModelBrandIcon);
    this.modelIdInput.addEventListener("input", syncModelBrandIcon);
    this.multimodalToggle = switchInput("supportsMultimodal");
    this.toolRoleImagesToggle = switchInput("toolRoleImages");
    this.rawEndpointToggle = switchInput("rawEndpoint");
    this.apiProtocolSelect = new AppDropdown(
      [
        { value: "auto", label: "Auto (from URL)" },
        { value: "chat_completions", label: "Chat Completions" },
        { value: "responses", label: "Responses" },
      ],
      "auto",
      { ariaLabel: "API protocol" },
    );
    this.apiProtocolHint = document.createElement("span");
    this.apiProtocolHint.className = "setting-field-hint";
    this.apiProtocolHint.style.overflowWrap = "anywhere";
    this.responsesToolsInput = document.createElement("textarea");
    this.responsesToolsInput.className = "setting-input";
    this.responsesToolsInput.rows = 4;
    this.responsesToolsInput.spellcheck = false;
    this.responsesToolsInput.placeholder = '[{"type":"web_search"}]';
    this.responsesToolsInput.setAttribute("aria-label", "Responses hosted tools JSON");
    this.responsesStatefulToggle = switchInput("responsesStateful");
    this.responsesStatefulToggle.addEventListener("change", () => {
      const selected = this.providers.find((provider) => provider.id === this.selectedProviderId);
      if (selected) selected.responsesStateful = this.responsesStatefulToggle.checked;
    });
    this.responsesOptionsBlock = document.createElement("div");
    this.responsesOptionsBlock.className = "setting-responses-options";
    const statefulRow = document.createElement("label");
    statefulRow.className = "setting-toggle-row";
    const statefulCopy = document.createElement("div");
    statefulCopy.className = "setting-toggle-copy";
    const statefulLabel = document.createElement("span");
    statefulLabel.className = "setting-field-label";
    statefulLabel.textContent = "Keep Responses conversation state";
    statefulCopy.append(statefulLabel);
    statefulRow.append(statefulCopy, this.responsesStatefulToggle);
    const hostedToggle = (name: string, title: string): { input: HTMLInputElement; row: HTMLElement } => {
      const input = switchInput(name);
      const row = document.createElement("label");
      row.className = "setting-toggle-row";
      const copy = document.createElement("div");
      copy.className = "setting-toggle-copy";
      const label = document.createElement("span");
      label.className = "setting-field-label";
      label.textContent = title;
      copy.append(label);
      row.append(copy, input);
      return { input, row };
    };
    const searchToggle = hostedToggle("responsesWebSearch", "Web search");
    const codeToggle = hostedToggle("responsesCodeExecution", "Code execution");
    const imageToggle = hostedToggle("responsesImageGeneration", "Image generation");
    this.responsesWebSearchToggle = searchToggle.input;
    this.responsesCodeExecutionToggle = codeToggle.input;
    this.responsesImageGenerationToggle = imageToggle.input;
    for (const [input, type] of [[this.responsesWebSearchToggle, "web_search"], [this.responsesCodeExecutionToggle, "code_interpreter"], [this.responsesImageGenerationToggle, "image_generation"]] as const) {
      input.addEventListener("change", () => this.setResponsesToolEnabled(type, input));
    }
    const advanced = document.createElement("details");
    advanced.className = "setting-responses-advanced";
    const advancedTitle = document.createElement("summary");
    advancedTitle.className = "setting-field-label";
    advancedTitle.textContent = "Advanced hosted tool configuration";
    advanced.append(advancedTitle, fieldRow("Hosted tools (JSON)", this.responsesToolsInput, "Configure file search, MCP, or options for the tools above. Existing options are preserved when enabling another tool. Graph tool restrictions also apply."));
    this.responsesOptionsBlock.append(
      statefulRow,
      searchToggle.row,
      codeToggle.row,
      imageToggle.row,
      advanced,
    );
    const updateProtocol = (): void => this.refreshApiProtocol();
    this.baseUrlInput.addEventListener("input", updateProtocol);
    this.apiProtocolSelect.addEventListener("change", updateProtocol);
    this.rawEndpointToggle.addEventListener("change", updateProtocol);
    this.responsesToolsInput.addEventListener("input", () => {
      if (this.validateResponsesTools()) this.syncResponsesToolToggles();
    });

    this.imageInputSelect = new AppDropdown(
      [
        { value: "url", label: "Image URL (via Cloud Storage)" },
        { value: "base64", label: "Base64" },
      ],
      "url",
      { ariaLabel: "Image input mode" },
    );
    this.refreshImageInputOptions("url");
    this.baseUrlInput.addEventListener("input", () => {
      // Option set depends on the provider host (Moonshot drops the S3 URL
      // option and adds its files API); auto-correct the value if the
      // current one is no longer offered.
      this.refreshImageInputOptions();
    });
    const imageInputRow = document.createElement("div");
    imageInputRow.className = "setting-toggle-row";
    const imageInputCopy = document.createElement("div");
    imageInputCopy.className = "setting-toggle-copy";
    const imageInputTitle = document.createElement("span");
    imageInputTitle.className = "setting-field-label";
    imageInputTitle.textContent = "Image input";
    const imageInputHint = document.createElement("span");
    imageInputHint.className = "setting-field-hint";
    imageInputHint.textContent =
      "How images reach a multimodal model. Moonshot servers accept base64 and their own file upload only — no external image URLs. Other providers default to Cloud Storage URLs; base64 inlines a downscaled (≤800×600) image.";
    imageInputCopy.append(imageInputTitle, imageInputHint);
    imageInputRow.append(imageInputCopy, this.imageInputSelect.el);

    const toolRoleImagesRow = document.createElement("label");
    toolRoleImagesRow.className = "setting-toggle-row";
    const toolRoleImagesCopy = document.createElement("div");
    toolRoleImagesCopy.className = "setting-toggle-copy";
    const toolRoleImagesTitle = document.createElement("span");
    toolRoleImagesTitle.className = "setting-field-label";
    toolRoleImagesTitle.textContent = "Tool-result images";
    const toolRoleImagesHint = document.createElement("span");
    toolRoleImagesHint.className = "setting-field-hint";
    toolRoleImagesHint.textContent =
      "read_image attaches the picture itself inside the tool result instead of a text description. Follows the verified default list (DeepSeek vision models; GLM-5.3-Flash via Cloud Storage URLs) — toggle to override.";
    toolRoleImagesCopy.append(toolRoleImagesTitle, toolRoleImagesHint);
    toolRoleImagesRow.append(toolRoleImagesCopy, this.toolRoleImagesToggle);

    const rawEndpointRow = document.createElement("label");
    rawEndpointRow.className = "setting-toggle-row";
    const rawEndpointCopy = document.createElement("div");
    rawEndpointCopy.className = "setting-toggle-copy";
    const rawEndpointTitle = document.createElement("span");
    rawEndpointTitle.className = "setting-field-label";
    rawEndpointTitle.textContent = "Full endpoint URL";
    const rawEndpointHint = document.createElement("span");
    rawEndpointHint.className = "setting-field-hint";
    rawEndpointHint.textContent =
      "Use the Base URL exactly as-is. The API protocol still controls the request format.";
    rawEndpointCopy.append(rawEndpointTitle, rawEndpointHint);
    rawEndpointRow.append(rawEndpointCopy, this.rawEndpointToggle);

    const multimodalRow = document.createElement("label");
    multimodalRow.className = "setting-toggle-row";
    const multimodalCopy = document.createElement("div");
    multimodalCopy.className = "setting-toggle-copy";
    const multimodalTitle = document.createElement("span");
    multimodalTitle.className = "setting-field-label";
    multimodalTitle.textContent = "Supports multimodal";
    const multimodalHint = document.createElement("span");
    multimodalHint.className = "setting-field-hint";
    multimodalHint.textContent =
      "When enabled, read_image uses this chat model directly. Otherwise the provider selected in the Vision card is used.";
    multimodalCopy.append(multimodalTitle, multimodalHint);
    multimodalRow.append(multimodalCopy, this.multimodalToggle);

    const detail = document.createElement("div");
    detail.className = "setting-provider-detail";
    const nameModelRow = document.createElement("div");
    nameModelRow.className = "setting-field-row setting-field-row-2";
    nameModelRow.append(
      fieldRow("Name", this.nameInput),
      fieldRow("Model ID", modelIdWrap),
    );
    detail.append(
      nameModelRow,
      fieldRow("Base URL", this.baseUrlInput),
      fieldRow("API protocol", this.apiProtocolSelect.el),
      this.apiProtocolHint,
      rawEndpointRow,
      this.responsesOptionsBlock,
      multimodalRow,
      imageInputRow,
      toolRoleImagesRow,
    );

    this.apiKeyStatus = document.createElement("div");
    this.apiKeyStatus.className = "setting-api-key-status";
    this.apiKeyInput = textInput("apiKey", {
      type: "password",
      placeholder: "Paste API key — saved when you leave the field",
      autocomplete: "off",
    });
    const apiKeyBlock = document.createElement("div");
    apiKeyBlock.className = "setting-api-key-block";
    apiKeyBlock.append(
      fieldRow(
        "API key",
        this.apiKeyInput,
        "Stored encrypted on this device for this profile — never written to settings.json.",
      ),
      this.apiKeyStatus,
    );

    providers.body.append(listHeader, this.providerListEl, detail, apiKeyBlock);

    this.deleteProviderButton = document.createElement("button");
    this.deleteProviderButton.type = "button";
    this.deleteProviderButton.className = "setting-btn action-danger";
    this.deleteProviderButton.append(
      createLucideIcon(Trash2, { size: 14 }),
      document.createTextNode(" Delete"),
    );

    this.setDefaultProviderButton = document.createElement("button");
    this.setDefaultProviderButton.type = "button";
    this.setDefaultProviderButton.className = "setting-btn action-primary";
    this.setDefaultProviderButton.textContent = "Set as default";
    this.setDefaultProviderButton.title =
      "Use this profile for new tasks (does not change existing tasks)";

    this.clearApiKeyButton = document.createElement("button");
    this.clearApiKeyButton.type = "button";
    this.clearApiKeyButton.className = "setting-btn action-danger";
    this.clearApiKeyButton.textContent = "Clear key";

    const providerActions = document.createElement("div");
    providerActions.className = "setting-card-actions";
    providerActions.append(
      this.setDefaultProviderButton,
      this.deleteProviderButton,
      this.clearApiKeyButton,
    );
    providers.footer.prepend(providerActions);

    const vision = createCard(
      "vision",
      "Vision",
      "Fallback image model for read_image when the task's chat provider does not support multimodal.",
    );

    this.visionProviderSelect = new AppDropdown(
      [{ value: "", label: "None — vision disabled" }],
      "",
      { ariaLabel: "Vision provider" },
    );
    vision.body.append(
      fieldRow(
        "Provider",
        this.visionProviderSelect.el,
        "Only providers with Multimodal enabled are listed. Turn it on in LLM Providers first.",
      ),
    );

    const completion = createCard(
      createLucideIcon(Sparkles, { size: 20 }),
      "Completion",
      "Model used for Dev Mode ghost text while you type.",
    );
    this.completionProviderSelect = new AppDropdown(
      [{ value: "", label: "Default — new-task provider" }],
      "",
      { ariaLabel: "Completion provider" },
    );
    completion.body.append(
      fieldRow(
        "Provider",
        this.completionProviderSelect.el,
        "A fast chat model stays responsive. Default uses the provider set for new tasks.",
      ),
    );

    const imageGen = createCard(
      "imagegen",
      "ImageGen",
      "Text-to-image profiles (OpenAI Images-compatible). The active one is used when the agent generates images from a prompt.",
    );

    const imageGenListHeader = document.createElement("div");
    imageGenListHeader.className = "setting-provider-list-header";
    const imageGenListLabel = document.createElement("span");
    imageGenListLabel.className = "setting-field-label";
    imageGenListLabel.textContent = "Profiles";
    this.addImageGenProviderButton = document.createElement("button");
    this.addImageGenProviderButton.type = "button";
    this.addImageGenProviderButton.className = "setting-btn setting-btn-icon";
    this.addImageGenProviderButton.setAttribute("aria-label", "Add image profile");
    this.addImageGenProviderButton.title = "Add image profile";
    this.addImageGenProviderButton.append(createLucideIcon(Plus, { size: 14 }));
    imageGenListHeader.append(imageGenListLabel, this.addImageGenProviderButton);

    this.imageGenProviderListEl = document.createElement("div");
    this.imageGenProviderListEl.className = "setting-provider-list";
    this.imageGenProviderListEl.setAttribute("role", "listbox");

    this.imageGenNameInput = textInput("imageGenName", {
      placeholder: "ImageGen",
    });
    this.imageGenBaseUrlInput = textInput("imageGenBaseUrl", {
      placeholder: "https://open.bigmodel.cn/api/paas/v4",
    });
    this.imageGenModelIdInput = textInput("imageGenModelId", {
      placeholder: "cogview-4-250304",
    });
    this.imageGenRawEndpointToggle = switchInput("imageGenRawEndpoint");

    this.imageGenWatermarkSelect = new AppDropdown(
      [
        { value: "default", label: "Provider default" },
        { value: "on", label: "On" },
        { value: "off", label: "Off" },
      ],
      "default",
      { ariaLabel: "Watermark" },
    );

    const imageGenWatermarkRow = document.createElement("label");
    imageGenWatermarkRow.className = "setting-toggle-row";
    const imageGenWatermarkCopy = document.createElement("div");
    imageGenWatermarkCopy.className = "setting-toggle-copy";
    const imageGenWatermarkTitle = document.createElement("span");
    imageGenWatermarkTitle.className = "setting-field-label";
    imageGenWatermarkTitle.textContent = "Watermark";
    const imageGenWatermarkHint = document.createElement("span");
    imageGenWatermarkHint.className = "setting-field-hint";
    imageGenWatermarkHint.textContent =
      "Sent as the watermark body field when On/Off (e.g. Volcano Ark seedream). Provider default never sends the field.";
    imageGenWatermarkCopy.append(
      imageGenWatermarkTitle,
      imageGenWatermarkHint,
    );
    imageGenWatermarkRow.append(
      imageGenWatermarkCopy,
      this.imageGenWatermarkSelect.el,
    );

    this.imageGenImageInputSelect = new AppDropdown(
      [
        { value: "disabled", label: "Disabled" },
        { value: "base64", label: "Base64 (inline)" },
        { value: "url", label: "Cloud Storage URL (S3/COS)" },
      ],
      "disabled",
      { ariaLabel: "Image input" },
    );

    const imageGenImageInputRow = document.createElement("label");
    imageGenImageInputRow.className = "setting-toggle-row";
    const imageGenImageInputCopy = document.createElement("div");
    imageGenImageInputCopy.className = "setting-toggle-copy";
    const imageGenImageInputTitle = document.createElement("span");
    imageGenImageInputTitle.className = "setting-field-label";
    imageGenImageInputTitle.textContent = "Image input";
    const imageGenImageInputHint = document.createElement("span");
    imageGenImageInputHint.className = "setting-field-hint";
    imageGenImageInputHint.textContent =
      "How generate_image reference images reach the provider (image-to-image). Base64 inlines the file; Cloud Storage URL uploads it and sends the https link. Requires a provider that accepts the image field (e.g. Volcano Ark seedream).";
    imageGenImageInputCopy.append(
      imageGenImageInputTitle,
      imageGenImageInputHint,
    );
    imageGenImageInputRow.append(
      imageGenImageInputCopy,
      this.imageGenImageInputSelect.el,
    );

    const imageGenRawEndpointRow = document.createElement("label");
    imageGenRawEndpointRow.className = "setting-toggle-row";
    const imageGenRawEndpointCopy = document.createElement("div");
    imageGenRawEndpointCopy.className = "setting-toggle-copy";
    const imageGenRawEndpointTitle = document.createElement("span");
    imageGenRawEndpointTitle.className = "setting-field-label";
    imageGenRawEndpointTitle.textContent = "Full endpoint URL";
    const imageGenRawEndpointHint = document.createElement("span");
    imageGenRawEndpointHint.className = "setting-field-hint";
    imageGenRawEndpointHint.textContent =
      "Use the Base URL exactly as-is for image generation requests. No /images/generations path is appended.";
    imageGenRawEndpointCopy.append(
      imageGenRawEndpointTitle,
      imageGenRawEndpointHint,
    );
    imageGenRawEndpointRow.append(
      imageGenRawEndpointCopy,
      this.imageGenRawEndpointToggle,
    );
    this.imageGenApiKeyStatus = document.createElement("div");
    this.imageGenApiKeyStatus.className = "setting-api-key-status";
    this.imageGenApiKeyInput = textInput("imageGenApiKey", {
      type: "password",
      placeholder: "Paste API key — saved when you leave the field",
      autocomplete: "off",
    });

    const imageGenDetail = document.createElement("div");
    imageGenDetail.className = "setting-provider-detail";
    const imageGenNameModelRow = document.createElement("div");
    imageGenNameModelRow.className = "setting-field-row setting-field-row-2";
    imageGenNameModelRow.append(
      fieldRow("Name", this.imageGenNameInput),
      fieldRow("Model ID", this.imageGenModelIdInput),
    );
    imageGenDetail.append(
      imageGenNameModelRow,
      fieldRow("Base URL", this.imageGenBaseUrlInput),
      imageGenRawEndpointRow,
      imageGenWatermarkRow,
      imageGenImageInputRow,
    );
    const imageGenApiKeyBlock = document.createElement("div");
    imageGenApiKeyBlock.className = "setting-api-key-block";
    imageGenApiKeyBlock.append(
      fieldRow(
        "API key",
        this.imageGenApiKeyInput,
        "Stored encrypted on this device as imagegen key — never written to settings.json.",
      ),
      this.imageGenApiKeyStatus,
    );
    imageGen.body.append(
      imageGenListHeader,
      this.imageGenProviderListEl,
      imageGenDetail,
      imageGenApiKeyBlock,
    );

    this.setActiveImageGenProviderButton = document.createElement("button");
    this.setActiveImageGenProviderButton.type = "button";
    this.setActiveImageGenProviderButton.className = "setting-btn action-primary";
    this.setActiveImageGenProviderButton.textContent = "Set as active";
    this.setActiveImageGenProviderButton.title =
      "Use this profile for image generation";

    this.deleteImageGenProviderButton = document.createElement("button");
    this.deleteImageGenProviderButton.type = "button";
    this.deleteImageGenProviderButton.className = "setting-btn action-danger";
    this.deleteImageGenProviderButton.append(
      createLucideIcon(Trash2, { size: 14 }),
      document.createTextNode(" Delete"),
    );

    this.clearImageGenApiKeyButton = document.createElement("button");
    this.clearImageGenApiKeyButton.type = "button";
    this.clearImageGenApiKeyButton.className = "setting-btn action-danger";
    this.clearImageGenApiKeyButton.textContent = "Clear key";

    const imageGenActions = document.createElement("div");
    imageGenActions.className = "setting-card-actions";
    imageGenActions.append(
      this.setActiveImageGenProviderButton,
      this.deleteImageGenProviderButton,
      this.clearImageGenApiKeyButton,
    );
    imageGen.footer.prepend(imageGenActions);

    // ---- Object Storage (S3 / COS) ----
    const objectStorage = createCard(
      "object-storage",
      "Object Storage",
      "S3-compatible storage (Amazon S3 / Tencent COS) for multimodal image attachments. Images upload on send and the model receives an image URL instead of a base64 blob.",
    );

    this.objectStorageProviderSelect = new AppDropdown(
      [
        { value: "amazon", label: "Amazon S3" },
        { value: "tencent", label: "Tencent COS" },
      ],
      "amazon",
      { ariaLabel: "Object storage provider" },
    );

    // Brand icon left of the trigger — kept as an overlay inside the frame
    // because the icon swaps with the selected provider.
    this.objectStorageProviderBrandIcon = document.createElement("span");
    this.objectStorageProviderBrandIcon.className =
      "setting-model-brand-icon";
    this.objectStorageProviderBrandIcon.setAttribute("aria-hidden", "true");
    const objectStorageProviderWrap = document.createElement("div");
    objectStorageProviderWrap.className = "setting-select-with-brand";
    objectStorageProviderWrap.append(
      this.objectStorageProviderBrandIcon,
      this.objectStorageProviderSelect.el,
    );
    this.objectStorageProviderSelect.addEventListener("change", () => {
      this.updateObjectStorageProviderBrandIcon();
    });
    this.updateObjectStorageProviderBrandIcon();

    this.objectStorageRegionInput = textInput("objectStorageRegion", {
      placeholder: "us-east-1 / ap-guangzhou",
    });
    this.objectStorageBucketInput = textInput("objectStorageBucket", {
      placeholder: "my-bucket (COS: name-appid)",
    });
    this.objectStorageAccessKeyIdInput = textInput(
      "objectStorageAccessKeyId",
      { placeholder: "Access Key ID" },
    );
    this.objectStorageEndpointInput = textInput("objectStorageEndpoint", {
      placeholder: "Optional — custom endpoint / CDN domain",
    });
    this.objectStorageKeyPrefixInput = textInput("objectStorageKeyPrefix", {
      placeholder: "jellybot/",
    });

    this.objectStorageUrlModeSelect = new AppDropdown(
      [
        {
          value: "presigned",
          label: "Presigned (7-day signed URLs, private bucket)",
        },
        {
          value: "public",
          label: "Public (permanent URLs, bucket needs public read)",
        },
      ],
      "presigned",
      { ariaLabel: "Object storage URL mode" },
    );

    this.objectStorageEnabledToggle = switchInput("objectStorageEnabled");

    const objectStorageEnabledRow = document.createElement("label");
    objectStorageEnabledRow.className = "setting-toggle-row";
    const objectStorageEnabledCopy = document.createElement("div");
    objectStorageEnabledCopy.className = "setting-toggle-copy";
    const objectStorageEnabledTitle = document.createElement("span");
    objectStorageEnabledTitle.className = "setting-field-label";
    objectStorageEnabledTitle.textContent = "Enabled";
    const objectStorageEnabledHint = document.createElement("span");
    objectStorageEnabledHint.className = "setting-field-hint";
    objectStorageEnabledHint.textContent =
      "Upload image attachments and send image URLs to multimodal models. Requires a provider that accepts URL-based image input.";
    objectStorageEnabledCopy.append(
      objectStorageEnabledTitle,
      objectStorageEnabledHint,
    );
    objectStorageEnabledRow.append(
      objectStorageEnabledCopy,
      this.objectStorageEnabledToggle,
    );

    this.objectStorageSecretStatus = document.createElement("div");
    this.objectStorageSecretStatus.className = "setting-api-key-status";
    this.objectStorageSecretInput = textInput("objectStorageSecret", {
      type: "password",
      placeholder: "Paste Secret Access Key — saved when you leave the field",
      autocomplete: "off",
    });

    const objectStorageDetail = document.createElement("div");
    objectStorageDetail.className = "setting-provider-detail";
    const objectStorageProviderRow = document.createElement("div");
    objectStorageProviderRow.className =
      "setting-field-row setting-field-row-2";
    objectStorageProviderRow.append(
      fieldRow("Provider", objectStorageProviderWrap),
      fieldRow("Region", this.objectStorageRegionInput),
    );
    const objectStorageBucketRow = document.createElement("div");
    objectStorageBucketRow.className = "setting-field-row setting-field-row-2";
    objectStorageBucketRow.append(
      fieldRow("Bucket", this.objectStorageBucketInput),
      fieldRow("Access Key ID", this.objectStorageAccessKeyIdInput),
    );
    const objectStorageEndpointRow = document.createElement("div");
    objectStorageEndpointRow.className = "setting-field-row setting-field-row-2";
    objectStorageEndpointRow.append(
      fieldRow("Endpoint", this.objectStorageEndpointInput),
      fieldRow("Key prefix", this.objectStorageKeyPrefixInput),
    );
    objectStorageDetail.append(
      objectStorageProviderRow,
      objectStorageBucketRow,
      objectStorageEndpointRow,
      fieldRow(
        "URL mode",
        this.objectStorageUrlModeSelect.el,
        "Presigned works with private buckets; Public requires public-read and gives permanent URLs.",
      ),
      objectStorageEnabledRow,
    );

    const objectStorageSecretBlock = document.createElement("div");
    objectStorageSecretBlock.className = "setting-api-key-block";
    objectStorageSecretBlock.append(
      fieldRow(
        "Secret Access Key",
        this.objectStorageSecretInput,
        "Stored encrypted on this device as object-storage key — never written to settings.json.",
      ),
      this.objectStorageSecretStatus,
    );

    objectStorage.body.append(objectStorageDetail, objectStorageSecretBlock);

    this.objectStorageTestButton = document.createElement("button");
    this.objectStorageTestButton.type = "button";
    this.objectStorageTestButton.className = "setting-btn";
    this.objectStorageTestButton.textContent = "Test connection";

    this.clearObjectStorageButton = document.createElement("button");
    this.clearObjectStorageButton.type = "button";
    this.clearObjectStorageButton.className = "setting-btn action-danger";
    this.clearObjectStorageButton.textContent = "Clear config";

    this.clearObjectStorageSecretButton = document.createElement("button");
    this.clearObjectStorageSecretButton.type = "button";
    this.clearObjectStorageSecretButton.className = "setting-btn action-danger";
    this.clearObjectStorageSecretButton.textContent = "Clear key";

    const objectStorageActions = document.createElement("div");
    objectStorageActions.className = "setting-card-actions";
    objectStorageActions.append(
      this.clearObjectStorageButton,
      this.clearObjectStorageSecretButton,
      this.objectStorageTestButton,
    );
    objectStorage.footer.prepend(objectStorageActions);

    const permissions = createCard(
      "composer",
      "Composer defaults",
      "Starting values for the composer: Bypass permissions and Self-learning apply on app load; Infinite / Effort seed the New Task composer. Conversations keep their own per-task settings.",
    );
    this.fullPermissionsToggle = switchInput("fullPermissionsDefault");

    const toggleRow = document.createElement("label");
    toggleRow.className = "setting-toggle-row";
    const toggleCopy = document.createElement("div");
    toggleCopy.className = "setting-toggle-copy";
    const toggleTitle = document.createElement("span");
    toggleTitle.className = "setting-field-label";
    toggleTitle.textContent = "Bypass permissions by default";
    const toggleHint = document.createElement("span");
    toggleHint.className = "setting-field-hint";
    toggleHint.textContent =
      "When enabled, level-1 tools (write / shell) start with Bypass permissions on. Level-2 tools still require approval.";
    toggleCopy.append(toggleTitle, toggleHint);
    toggleRow.append(toggleCopy, this.fullPermissionsToggle);

    this.autoSkillSummarizeToggle = switchInput("autoSkillSummarizeDefault");
    const selfLearningRow = document.createElement("label");
    selfLearningRow.className = "setting-toggle-row";
    const selfLearningCopy = document.createElement("div");
    selfLearningCopy.className = "setting-toggle-copy";
    const selfLearningTitle = document.createElement("span");
    selfLearningTitle.className = "setting-field-label";
    selfLearningTitle.textContent = "Self-learning by default";
    const selfLearningHint = document.createElement("span");
    selfLearningHint.className = "setting-field-hint";
    selfLearningHint.textContent =
      "When enabled, Self-learning starts on at app load: after eligible turns (with Bypass permissions on) the agent reviews and saves reusable skills. CoCo tasks follow this setting.";
    selfLearningCopy.append(selfLearningTitle, selfLearningHint);
    selfLearningRow.append(selfLearningCopy, this.autoSkillSummarizeToggle);

    this.newTaskInfiniteToggle = switchInput("composerInfinite");

    const infiniteRow = document.createElement("label");
    infiniteRow.className = "setting-toggle-row";
    const infiniteCopy = document.createElement("div");
    infiniteCopy.className = "setting-toggle-copy";
    const infiniteTitle = document.createElement("span");
    infiniteTitle.className = "setting-field-label";
    infiniteTitle.textContent = "New Task starts with Infinite";
    const infiniteHint = document.createElement("span");
    infiniteHint.className = "setting-field-hint";
    infiniteHint.textContent =
      "When enabled, new task composers open with Infinite on — no round or token limits in any run mode.";
    infiniteCopy.append(infiniteTitle, infiniteHint);
    infiniteRow.append(infiniteCopy, this.newTaskInfiniteToggle);

    this.newTaskReasoningSeg = new EffortSegView({
      onSelect: (level) => this.onReasoningEffortChange(level),
      ariaLabel: "New Task default effort",
    });

    const reasoningRow = document.createElement("div");
    reasoningRow.className = "setting-toggle-row";
    const reasoningCopy = document.createElement("div");
    reasoningCopy.className = "setting-toggle-copy";
    const reasoningTitle = document.createElement("span");
    reasoningTitle.className = "setting-field-label";
    reasoningTitle.textContent = "New Task starts with Effort";
    const reasoningHint = document.createElement("span");
    reasoningHint.className = "setting-field-hint";
    reasoningHint.textContent =
      "Default dial level for new task composers (OFF/LOW/MED/HIGH/MAX). Tasks can retune their own dial; ⌘⇧M still toggles Infinite + MAX.";
    reasoningCopy.append(reasoningTitle, reasoningHint);
    reasoningRow.append(reasoningCopy, this.newTaskReasoningSeg.root);

    permissions.body.append(toggleRow, selfLearningRow, infiniteRow, reasoningRow);

    // ---- Shell Safe Mode (moved from the Tools screen) ----
    const safety = createCard(
      "security",
      "Shell Safe Mode",
      "Workspace deletes go to the Trash; risky shell commands ask before running; targets outside the workspace are blocked. Turn off to run commands unchanged.",
    );

    this.shellSafetyToggle = switchInput("shellSafetyEnabled");
    const shellSafetyRow = document.createElement("label");
    shellSafetyRow.className = "setting-toggle-row";
    const shellSafetyCopy = document.createElement("div");
    shellSafetyCopy.className = "setting-toggle-copy";
    const shellSafetyTitle = document.createElement("span");
    shellSafetyTitle.className = "setting-field-label";
    shellSafetyTitle.textContent = "Enabled";
    const shellSafetyHint = document.createElement("span");
    shellSafetyHint.className = "setting-field-hint";
    shellSafetyHint.textContent =
      "Assesses every shell command before it runs. Turn off to run commands unchanged (not recommended).";
    shellSafetyCopy.append(shellSafetyTitle, shellSafetyHint);
    shellSafetyRow.append(shellSafetyCopy, this.shellSafetyToggle);

    this.shellSafetyPolicySelect = new AppDropdown(
      [
        { value: "ask", label: "Ask before running" },
        { value: "block", label: "Block outright" },
      ],
      "ask",
      { ariaLabel: "Outside-workspace command policy" },
    );

    const shellSafetyPolicyRow = document.createElement("label");
    shellSafetyPolicyRow.className = "setting-toggle-row";
    const shellSafetyPolicyCopy = document.createElement("div");
    shellSafetyPolicyCopy.className = "setting-toggle-copy";
    const shellSafetyPolicyTitle = document.createElement("span");
    shellSafetyPolicyTitle.className = "setting-field-label";
    shellSafetyPolicyTitle.textContent = "Outside-workspace commands";
    const shellSafetyPolicyHint = document.createElement("span");
    shellSafetyPolicyHint.className = "setting-field-hint";
    shellSafetyPolicyHint.textContent =
      "What happens when a command targets paths outside the workspace: Ask settles it with a confirmation card; Block denies it outright.";
    shellSafetyPolicyCopy.append(
      shellSafetyPolicyTitle,
      shellSafetyPolicyHint,
    );
    shellSafetyPolicyRow.append(
      shellSafetyPolicyCopy,
      this.shellSafetyPolicySelect.el,
    );

    safety.body.append(shellSafetyRow, shellSafetyPolicyRow);

    const agent = createCard(
      "agent",
      "Agent",
      "Context limits, compaction, and environment injection.",
    );
    this.contextLimitInput = textInput("contextLimitTokens", {
      type: "number",
    });
    this.contextLimitInput.min = "1024";
    this.contextLimitInput.step = "1024";
    this.contextLimitInput.value = "128000";

    this.compactTriggerRatioInput = textInput("compactTriggerRatio", {
      type: "number",
    });
    this.compactTriggerRatioInput.min = "0.5";
    this.compactTriggerRatioInput.max = "0.95";
    this.compactTriggerRatioInput.step = "0.01";
    this.compactTriggerRatioInput.value = "0.55";

    this.iterationProtectRawIterationCountInput = textInput(
      "iterationProtectRawIterationCount",
      { type: "number" },
    );
    this.iterationProtectRawIterationCountInput.min = "1";
    this.iterationProtectRawIterationCountInput.step = "1";
    this.iterationProtectRawIterationCountInput.value = "20";

    this.iterationProtectTokenRatioInput = textInput("iterationProtectTokenRatio", {
      type: "number",
    });
    this.iterationProtectTokenRatioInput.min = "0.05";
    this.iterationProtectTokenRatioInput.max = "0.9";
    this.iterationProtectTokenRatioInput.step = "0.01";
    this.iterationProtectTokenRatioInput.value = "0.2";

    this.maxRoundsInput = textInput("maxModelIterations", { type: "number" });
    this.maxRoundsInput.min = "1";
    this.maxRoundsInput.step = "1";
    this.maxRoundsInput.value = "128";

    this.maxTurnTokensInput = textInput("maxTurnTokens", { type: "number" });
    this.maxTurnTokensInput.min = "1";
    this.maxTurnTokensInput.step = "1000";
    this.maxTurnTokensInput.value = "3000000";

    this.llmRequestTimeoutInput = textInput("llmRequestTimeout", {
      type: "number",
    });
    this.llmRequestTimeoutInput.min = "1";
    this.llmRequestTimeoutInput.max = "600";
    this.llmRequestTimeoutInput.step = "1";
    this.llmRequestTimeoutInput.value = "30";

    this.envWorkspaceToggle = switchInput("envWorkspace");
    this.envWorkspaceToggle.checked = true;
    this.envWorkspaceToggle.setAttribute("aria-checked", "true");

    this.envTimezoneToggle = switchInput("envTimezone");
    this.envTimezoneToggle.checked = true;
    this.envTimezoneToggle.setAttribute("aria-checked", "true");

    this.envLocaleToggle = switchInput("envLocale");
    this.envLocaleToggle.checked = true;
    this.envLocaleToggle.setAttribute("aria-checked", "true");

    this.envLocationToggle = switchInput("envLocation");
    this.envLocationToggle.checked = true;
    this.envLocationToggle.setAttribute("aria-checked", "true");

    this.envRepositoryToggle = switchInput("envRepository");
    this.envRepositoryToggle.checked = true;
    this.envRepositoryToggle.setAttribute("aria-checked", "true");

    this.toolStatsEnabledToggle = switchInput("toolStatsEnabled");
    this.toolStatsEnabledToggle.checked = true;
    this.toolStatsEnabledToggle.setAttribute("aria-checked", "true");

    const envSection = document.createElement("div");
    envSection.className = "setting-env-section";
    const envTitle = document.createElement("div");
    envTitle.className = "setting-field-label";
    envTitle.textContent = "Inject environment context";
    const envHint = document.createElement("div");
    envHint.className = "setting-field-hint";
    envHint.textContent =
      "Live system fields injected each model iteration (not saved in the chat transcript). Date and time are not injected — the agent can call get_current_time when needed. Turn all off to skip.";
    envSection.append(
      envTitle,
      envHint,
      this.createEnvToggleRow(
        "Workspace",
        "Name, id, and absolute path of the current workspace.",
        this.envWorkspaceToggle,
      ),
      this.createEnvToggleRow(
        "Timezone",
        "IANA timezone and UTC offset.",
        this.envTimezoneToggle,
      ),
      this.createEnvToggleRow(
        "Language & locale",
        "Preferred system languages and locale.",
        this.envLocaleToggle,
      ),
      this.createEnvToggleRow(
        "Location",
        "System timezone and region (not GPS).",
        this.envLocationToggle,
      ),
      this.createEnvToggleRow(
        "Repository snapshot",
        "Folder layout, git status, recent files, and open editor tabs, captured when each task turn starts.",
        this.envRepositoryToggle,
      ),
    );

    this.iterationProtectSection = document.createElement("div");
    this.iterationProtectSection.className = "setting-compaction-section";
    this.iterationProtectSection.append(
      fieldRow(
        "Protected newest iterations",
        this.iterationProtectRawIterationCountInput,
        "Newest model iterations kept fully raw (default 20).",
      ),
      fieldRow(
        "Protect token ratio",
        this.iterationProtectTokenRatioInput,
        "Keep protecting while cumulative protected tokens stay under this fraction of the context limit (default 0.2).",
      ),
    );

    const statsToggleRow = document.createElement("label");
    statsToggleRow.className = "setting-toggle-row";
    const statsToggleCopy = document.createElement("div");
    statsToggleCopy.className = "setting-toggle-copy";
    const statsToggleTitle = document.createElement("span");
    statsToggleTitle.className = "setting-field-label";
    statsToggleTitle.textContent = "Tool call stats";
    const statsToggleHint = document.createElement("span");
    statsToggleHint.className = "setting-field-hint";
    statsToggleHint.textContent =
      "When enabled, every tool invocation is recorded in the task database for the Detail → Tool Stats panel (separate from Log).";
    statsToggleCopy.append(statsToggleTitle, statsToggleHint);
    statsToggleRow.append(statsToggleCopy, this.toolStatsEnabledToggle);

    const limitsRow = document.createElement("div");
    limitsRow.className = "setting-field-row setting-field-row-2";
    limitsRow.append(
      fieldRow(
        "Compact trigger ratio",
        this.compactTriggerRatioInput,
        "Compact when the last provider prompt_tokens reach this fraction of the context limit (0.5–0.95). Falls back to a local estimate only until the first usage event.",
      ),
      fieldRow(
        "Max model iterations",
        this.maxRoundsInput,
        "Model → tools → model loops per user turn before Continue / Stop is offered. Continue grants another window of this many iterations.",
      ),
      fieldRow(
        "Max turn tokens",
        this.maxTurnTokensInput,
        "Billable tokens per user turn (sum of provider total_tokens each round). Default 3,000,000. Hitting the cap offers Continue / Stop.",
      ),
      fieldRow(
        "Request timeout (s)",
        this.llmRequestTimeoutInput,
        "Max wait for the model to accept each request (connect + response headers). Streaming is never cut off mid-flight. Default 30.",
      ),
    );

    agent.body.append(
      fieldRow(
        "Context limit (tokens)",
        this.contextLimitInput,
        "Used by the composer ring and auto-compaction threshold.",
      ),
      this.iterationProtectSection,
      limitsRow,
      statsToggleRow,
      envSection,
    );

    const user = createCard(
      "memory",
      "USER.md",
      "Personal cross-project prefs plus a minimal Projects index (name + root path). Project handoff AND project-specific style/conventions live in each workspace PROJECT.md. Stored in user-memory.json; injected every model iteration.",
    );
    this.userMemoryAutoExtractToggle = switchInput("userMemoryAutoExtract");
    this.userMemoryAutoExtractToggle.checked = true;
    this.userMemoryAutoExtractToggle.setAttribute("aria-checked", "true");
    const memoryToggleRow = document.createElement("label");
    memoryToggleRow.className = "setting-toggle-row";
    const memoryToggleCopy = document.createElement("div");
    memoryToggleCopy.className = "setting-toggle-copy";
    const memoryToggleTitle = document.createElement("span");
    memoryToggleTitle.className = "setting-field-label";
    memoryToggleTitle.textContent = "Auto-update after each turn";
    const memoryToggleHint = document.createElement("span");
    memoryToggleHint.className = "setting-field-hint";
    memoryToggleHint.textContent =
      "When enabled, a background pass may merge durable facts from a completed turn into this profile.";
    memoryToggleCopy.append(memoryToggleTitle, memoryToggleHint);
    memoryToggleRow.append(memoryToggleCopy, this.userMemoryAutoExtractToggle);
    this.userMemoryProfileInput = document.createElement("textarea");
    this.userMemoryProfileInput.className = "setting-input setting-textarea";
    this.userMemoryProfileInput.name = "userMemoryProfile";
    this.userMemoryProfileInput.rows = 24;
    this.userMemoryProfileInput.spellcheck = true;
    this.userMemoryProfileInput.placeholder =
      "Preferences, identity, Projects index (name — path), and other stable facts about you…";
    this.resetUserPromptButton = document.createElement("button");
    this.resetUserPromptButton.type = "button";
    this.resetUserPromptButton.className = "setting-btn setting-btn-ghost action-danger";
    this.resetUserPromptButton.textContent = "Reset to default";
    user.body.append(
      memoryToggleRow,
      fieldRow(
        "Profile",
        this.userMemoryProfileInput,
        "Stored in user-memory.json (not in settings.json). Aim under ~5000 characters — guidance only, content is never truncated. Keep Projects as an index only; move project-specific style/conventions into that workspace's PROJECT.md. Empty profile falls back to resources/prompts/USER.md at inject time.",
      ),
    );
    this.clearMemoryButton = document.createElement("button");
    this.clearMemoryButton.type = "button";
    this.clearMemoryButton.className = "setting-btn action-danger";
    this.clearMemoryButton.textContent = "Clear";
    const memoryActions = document.createElement("div");
    memoryActions.className = "setting-card-actions";
    memoryActions.append(this.resetUserPromptButton, this.clearMemoryButton);
    user.footer.prepend(memoryActions);

    const storage = createCard(
      "storage",
      "Storage",
      "Clean up logs, database migration backups, Chromium caches, and stale temp files. Tasks, settings, skills, and memory are never touched.",
    );

    const storageUsage = document.createElement("div");
    storageUsage.className = "setting-storage-usage";
    const addUsageRow = (
      label: string,
      hint: string,
    ): { label: string; value: HTMLElement } => {
      const row = document.createElement("div");
      row.className = "setting-storage-row";
      const copy = document.createElement("div");
      copy.className = "setting-storage-copy";
      const labelEl = document.createElement("span");
      labelEl.className = "setting-field-label";
      labelEl.textContent = label;
      const hintEl = document.createElement("span");
      hintEl.className = "setting-field-hint";
      hintEl.textContent = hint;
      copy.append(labelEl, hintEl);
      const value = document.createElement("span");
      value.className = "setting-storage-size";
      value.textContent = "—";
      row.append(copy, value);
      storageUsage.append(row);
      return { label, value };
    };
    this.storageUsageRows.push(
      addUsageRow("Logs", "agent logs, requests, and compaction artifacts older than 7 days"),
      addUsageRow("Caches", "Chromium cache dirs (Cache, Code Cache, GPU, blob storage)"),
      addUsageRow("Backups", "Legacy database migration backups"),
      addUsageRow("Temp", "stale jellybot-skill-* / .jellybot-pdf-* leftovers in the system temp dir"),
    );
    storage.body.append(storageUsage);

    this.cleanupButton = document.createElement("button");
    this.cleanupButton.type = "button";
    this.cleanupButton.className = "setting-btn action-danger";
    this.cleanupButton.append(
      createLucideIcon(Trash2, { size: 14 }),
      document.createTextNode(" Clean up…"),
    );
    const storageActions = document.createElement("div");
    storageActions.className = "setting-card-actions";
    storageActions.append(this.cleanupButton);
    storage.footer.prepend(storageActions);

    // ---- Backup export / import (.jbbundle, passphrase-encrypted) ----
    const backup = createCard(
      "backup",
      "Backup",
      "Export all settings to one encrypted file, or restore it on a fresh install.",
    );

    // Thin indeterminate strip at the card top — only visible while an
    // export/import is actually running.
    this.backupProgressBar = document.createElement("div");
    this.backupProgressBar.className = "setting-backup-progress";
    this.backupProgressBar.hidden = true;
    backup.body.append(this.backupProgressBar);

    // Static "what's included" explainer — same visual pattern as the
    // import summary (group title + detail box), sourced from the same
    // section-label map so the two stay in sync.
    const helpTitle = document.createElement("h3");
    helpTitle.className = "setting-backup-group-title";
    helpTitle.textContent = "What's included";
    backup.body.append(helpTitle);

    const helpBox = document.createElement("div");
    helpBox.className = "setting-backup-summary";
    const helpSections = document.createElement("p");
    helpSections.className = "setting-backup-summary-path";
    helpSections.textContent = Object.values(BACKUP_SECTION_LABELS).join(" · ");
    const helpCrypt = document.createElement("p");
    helpCrypt.className = "setting-backup-summary-sections";
    helpCrypt.textContent =
      "Everything is encrypted with one passphrase — keep it safe, it cannot be recovered if lost.";
    const helpImport = document.createElement("p");
    helpImport.className = "setting-backup-summary-meta";
    helpImport.textContent =
      "Importing replaces the current settings; existing files are backed up automatically first.";
    helpBox.append(helpSections, helpCrypt, helpImport);
    backup.body.append(helpBox);

    this.backupImportTitle = document.createElement("h3");
    this.backupImportTitle.className = "setting-backup-group-title";
    this.backupImportTitle.textContent = "Import";
    this.backupImportTitle.hidden = true;
    backup.body.append(this.backupImportTitle);

    this.backupSummaryBox = document.createElement("div");
    this.backupSummaryBox.className = "setting-backup-summary";
    this.backupSummaryBox.hidden = true;
    this.backupSummaryPath = document.createElement("p");
    this.backupSummaryPath.className = "setting-backup-summary-path";
    this.backupSummarySections = document.createElement("p");
    this.backupSummarySections.className = "setting-backup-summary-sections";
    this.backupSummaryMeta = document.createElement("p");
    this.backupSummaryMeta.className = "setting-backup-summary-meta";
    this.backupSummaryBox.append(
      this.backupSummaryPath,
      this.backupSummarySections,
      this.backupSummaryMeta,
    );
    backup.body.append(this.backupSummaryBox);

    this.applyBackupButton = document.createElement("button");
    this.applyBackupButton.type = "button";
    this.applyBackupButton.className = "setting-btn setting-btn-primary action-primary";
    this.applyBackupButton.hidden = true;
    this.applyBackupButton.append(
      createLucideIcon(ArchiveRestore, { size: 14 }),
      document.createTextNode(" Apply backup"),
    );

    this.exportBackupButton = document.createElement("button");
    this.exportBackupButton.type = "button";
    this.exportBackupButton.className = "setting-btn";
    this.exportBackupButton.append(
      createLucideIcon(FileDown, { size: 14 }),
      document.createTextNode(" Export backup…"),
    );

    this.chooseBackupButton = document.createElement("button");
    this.chooseBackupButton.type = "button";
    this.chooseBackupButton.className = "setting-btn";
    this.chooseBackupButton.append(
      createOriginalIcon(FolderOpen, { size: 14 }),
      document.createTextNode(" Choose backup file…"),
    );

    const backupActions = document.createElement("div");
    backupActions.className = "setting-card-actions";
    backupActions.append(
      this.exportBackupButton,
      this.chooseBackupButton,
      this.applyBackupButton,
    );
    backup.footer.prepend(backupActions);

    // ── Remote Control (web console via relay) ─────────────
    const remoteCard = this.buildRemoteCard();

    // ── Update (manual local upgrade) ──────────────────────
    const updateCard = this.buildUpdateCard();

    const cocoCard = createCocoSettingsPanel();
    this.statusByCard = {
      coco: document.createElement("span"),
      providers: providers.status,
      vision: vision.status,
      completion: completion.status,
      imagegen: imageGen.status,
      objectstorage: objectStorage.status,
      permissions: permissions.status,
      safety: safety.status,
      agent: agent.status,
      remote: remoteCard.status,
      update: updateCard.status,
      appearance: appearance.status,
      user: user.status,
      storage: storage.status,
      backup: backup.status,
    };

    this.root.append(header, createCategoryLayout({
      coco: cocoCard,
      appearance: appearance.card,
      providers: providers.card,
      vision: vision.card,
      completion: completion.card,
      imagegen: imageGen.card,
      objectstorage: objectStorage.card,
      permissions: permissions.card,
      safety: safety.card,
      agent: agent.card,
      remote: remoteCard.card,
      update: updateCard.card,
      user: user.card,
      storage: storage.card,
      backup: backup.card,
    }, initialCategory));
  }

  /** Remote relay card — mirrors docs/demo/remote-settings.html (approved). */
  private buildRemoteCard(): { card: HTMLElement; status: HTMLElement } {
    const { card, body, footer, status } = createCard("remote-control", "Remote Control", "Mirror this JellyBot to the relay server and control it from a web browser. The connection is outbound-only — no inbound ports are opened.");

    // Master switch
    const enableToggle = switchInput("remoteEnabled");
    const toggleRow = document.createElement("label");
    toggleRow.className = "setting-toggle-row";
    const toggleCopy = document.createElement("span");
    toggleCopy.className = "setting-toggle-copy";
    const toggleTitle = document.createElement("span");
    toggleTitle.textContent = "Enable Remote";
    const toggleSub = document.createElement("span");
    toggleSub.className = "setting-card-desc";
    toggleSub.textContent = "Off: never contact the relay server";
    toggleCopy.append(toggleTitle, toggleSub);
    toggleRow.append(toggleCopy, enableToggle);

    // Server URL
    const serverUrlInput = textInput("remoteServerUrl", {
      placeholder: "https://your-relay-host",
      autocomplete: "off",
    });

    // API key + reveal
    const apiKeyInput = textInput("remoteApiKey", {
      type: "password",
      placeholder: "jbr_… (saved securely)",
      autocomplete: "off",
    });
    const keyRevealBtn = document.createElement("button");
    keyRevealBtn.type = "button";
    keyRevealBtn.className = "setting-btn setting-btn-icon";
    keyRevealBtn.title = "Reveal";
    keyRevealBtn.append(createLucideIcon(Eye, { size: 14 }));
    keyRevealBtn.addEventListener("click", () => {
      apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
    });
    const keyWrap = document.createElement("div");
    keyWrap.style.cssText = "display:flex;gap:6px;align-items:center";
    keyWrap.append(apiKeyInput, keyRevealBtn);

    // Device name
    const deviceNameInput = textInput("remoteDeviceName", {
      placeholder: "Device name shown in the web console",
      autocomplete: "off",
    });
    // Fresh identity for this install — the escape hatch when two installs
    // share one device ID (settings backups used to clone it; the relay lets
    // one identity hold a single slot, so they kick each other forever).
    const regenerateIdBtn = document.createElement("button");
    regenerateIdBtn.type = "button";
    regenerateIdBtn.className = "setting-btn setting-btn-icon";
    regenerateIdBtn.title = "Regenerate Device ID — fresh identity for this install";
    regenerateIdBtn.setAttribute("aria-label", "Regenerate Device ID");
    regenerateIdBtn.append(createOriginalIcon(Fingerprint, { size: 14 }));
    const nameWrap = document.createElement("div");
    nameWrap.style.cssText = "display:flex;gap:6px;align-items:center";
    nameWrap.append(deviceNameInput, regenerateIdBtn);

    // Mode + push activity dropdowns
    const modeSelect = new AppDropdown(
      [
        { value: "readonly", label: "Read-only — web can view tasks" },
        { value: "full", label: "Full control — web can send messages" },
      ],
      "readonly",
      { ariaLabel: "Control mode" },
    );
    const pushSelect = new AppDropdown(
      [
        { value: "all", label: "All tasks" },
        { value: "active", label: "Active task only" },
        { value: "off", label: "Off — pull on demand" },
      ],
      "all",
      { ariaLabel: "Push activity" },
    );

    // Field grid: 2×2 per demo
    const gridTop = document.createElement("div");
    gridTop.className = "setting-field-row setting-field-row-2";
    const gridBottom = document.createElement("div");
    gridBottom.className = "setting-field-row setting-field-row-2";
    gridTop.append(
      fieldRow("API Key", keyWrap),
      fieldRow("Device Name", nameWrap),
    );
    gridBottom.append(
      fieldRow("Control Mode", modeSelect.el),
      fieldRow("Push Activity", pushSelect.el),
    );

    // Connection status line
    const connLine = document.createElement("div");
    connLine.className = "setting-remote-status";
    connLine.textContent = "Loading…";

    // Streaming gate note: live activity only leaves this Mac while a
    // viewer holds the device open in the web console (relay ≥ 1.3).
    const pushHint = document.createElement("div");
    pushHint.className = "setting-remote-hint";
    pushHint.textContent =
      "Live activity streams only while a viewer has this device open in the web console. “Active task only” further narrows it to tasks with a turn in flight.";

    // ── Memory Sync (M2): cross-device archive summaries ──────────
    const msToggle = switchInput("memorySyncEnabled");
    const msToggleRow = document.createElement("label");
    msToggleRow.className = "setting-toggle-row";
    const msCopy = document.createElement("span");
    msCopy.className = "setting-toggle-copy";
    const msTitle = document.createElement("span");
    msTitle.textContent = "Memory Sync";
    const msSub = document.createElement("span");
    msSub.className = "setting-card-desc";
    msSub.textContent = "Share deleted-task summaries across your devices via the relay";
    msCopy.append(msTitle, msSub);
    msToggleRow.append(msCopy, msToggle);

    const msCheck = (name: string, label: string, desc: string): HTMLElement => {
      const row = document.createElement("label");
      row.className = "setting-check-row";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = name;
      input.className = "setting-check";
      const copy = document.createElement("span");
      copy.className = "setting-check-copy";
      copy.append(
        Object.assign(document.createElement("span"), { textContent: label }),
        Object.assign(document.createElement("span"), {
          className: "setting-card-desc",
          textContent: desc,
        }),
      );
      row.append(input, copy);
      row.dataset.name = name;
      return row;
    };
    const msArchiveRow = msCheck("memorySyncArchive", "Task archive", "Deleted-task summaries");
    const msDocsRow = msCheck("memorySyncDocs", "Project docs", "WORKLOG / PITFALLS / STYLE entries");

    const msSyncBtn = document.createElement("button");
    msSyncBtn.type = "button";
    msSyncBtn.className = "setting-btn";
    msSyncBtn.textContent = "Sync now";
    const msResyncBtn = document.createElement("button");
    msResyncBtn.type = "button";
    msResyncBtn.className = "setting-btn";
    msResyncBtn.textContent = "Full resync";
    const msBtnRow = document.createElement("div");
    msBtnRow.className = "setting-field-row setting-field-row-2";
    msBtnRow.append(msSyncBtn, msResyncBtn);

    const msStatusLine = document.createElement("div");
    msStatusLine.className = "setting-remote-status";
    msStatusLine.textContent = "Memory sync off";
    const msHint = document.createElement("div");
    msHint.className = "setting-remote-hint";
    msHint.textContent =
      "Each relay server is a separate island: switching the server URL above starts a fresh sync cursor. Summaries are merged by union — clearing history on one device never propagates to others.";

    const msSection = document.createElement("div");
    msSection.className = "setting-memory-sync";
    msSection.append(msToggleRow, msArchiveRow, msDocsRow, msBtnRow, msStatusLine, msHint);

    const formatMsStatus = (
      snap: { lastRunAt: number | null; lastResult: string | null; lastError: string | null; pushed: number; inserted: number; updated: number; cursor: number; pendingPush: number },
    ): string => {
      if (!msToggle.checked) return "Memory sync off";
      if (!snap.lastRunAt) return `Not synced yet · ${snap.pendingPush} pending`;
      const when = new Date(snap.lastRunAt).toLocaleTimeString();
      if (snap.lastResult === "error") {
        return `Last sync ${when} failed — ${snap.lastError ?? "unknown error"}`;
      }
      if (snap.lastResult === "off") return `Sync disabled at ${when}`;
      return `Synced ${when} · pushed ${snap.pushed} · merged ${snap.inserted + snap.updated} · ${snap.pendingPush} pending`;
    };
    const refreshMsStatus = async (): Promise<void> => {
      try {
        const { status: snap } = await window.jellybot!.getMemorySyncStatus();
        msStatusLine.textContent = formatMsStatus(snap);
      } catch {
        msStatusLine.textContent = "Memory sync status unavailable";
      }
    };
    const persistMs = async (
      patch: { enabled?: boolean; sessionArchive?: boolean; projectDocs?: boolean },
      enabled: boolean,
      sessionArchive: boolean,
      projectDocs: boolean,
    ): Promise<void> => {
      msSyncBtn.disabled = true;
      try {
        const { config } = await window.jellybot!.setRemoteConfig({
          memorySync: {
            enabled,
            sessionArchive,
            projectDocs,
            ...patch,
          },
        });
        this.remoteConfigCache = config;
        msSyncBtn.disabled = !(config.enabled && config.memorySync?.enabled);
        await refreshMsStatus();
      } catch (err) {
        msStatusLine.textContent = err instanceof Error ? err.message : "Save failed";
      } finally {
        msSyncBtn.disabled = false;
        updateActionButtons();
        void refreshMsStatus();
      }
    };
    const msArchiveInput = msArchiveRow.querySelector("input") as HTMLInputElement;
    const msDocsInput = msDocsRow.querySelector("input") as HTMLInputElement;
    msToggle.addEventListener("change", () => {
      void persistMs({ enabled: msToggle.checked }, msToggle.checked, msArchiveInput.checked, msDocsInput.checked);
    });
    msArchiveInput.addEventListener("change", () => {
      void persistMs({ sessionArchive: msArchiveInput.checked }, msToggle.checked, msArchiveInput.checked, msDocsInput.checked);
    });
    msDocsInput.addEventListener("change", () => {
      void persistMs({ projectDocs: msDocsInput.checked }, msToggle.checked, msArchiveInput.checked, msDocsInput.checked);
    });
    msSyncBtn.addEventListener("click", async () => {
      msSyncBtn.disabled = true;
      msStatusLine.textContent = "Syncing…";
      try {
        const { outcome, status: snap } = await window.jellybot!.syncMemoryNow();
        if (outcome.kind === "error") {
          msStatusLine.textContent = `Sync failed — ${outcome.reason ?? "unknown error"}`;
        } else if (outcome.kind === "off") {
          msStatusLine.textContent = "Memory sync is off";
        } else {
          msStatusLine.textContent =
            `Synced · pushed ${outcome.pushed} · merged ${outcome.inserted + outcome.updated} · ${snap.pendingPush} pending`;
        }
      } catch (err) {
        msStatusLine.textContent = err instanceof Error ? err.message : "Sync failed";
      } finally {
        msSyncBtn.disabled = false;
      }
    });
    msResyncBtn.addEventListener("click", async () => {
      msResyncBtn.disabled = true;
      msStatusLine.textContent = "Full resync…";
      try {
        const { outcome } = await window.jellybot!.fullResyncMemory();
        msStatusLine.textContent =
          outcome.kind === "error"
            ? `Resync failed — ${outcome.reason ?? "unknown error"}`
            : `Resynced · pushed ${outcome.pushed} · merged ${outcome.inserted + outcome.updated}`;
      } catch (err) {
        msStatusLine.textContent = err instanceof Error ? err.message : "Resync failed";
      } finally {
        msResyncBtn.disabled = false;
      }
    });
    void refreshMsStatus();

    body.append(
      toggleRow,
      fieldRow("Server URL", serverUrlInput),
      gridTop,
      gridBottom,
      pushHint,
      connLine,
      msSection,
    );

    // Actions
    const actions = document.createElement("div");
    actions.className = "setting-card-actions";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "setting-btn setting-btn-primary action-primary";
    saveBtn.textContent = "Save & Connect";
    const reconnectBtn = document.createElement("button");
    reconnectBtn.type = "button";
    reconnectBtn.className = "setting-btn";
    reconnectBtn.title = "Reconnect";
    reconnectBtn.append(createLucideIcon(RefreshCw, { size: 14 }), document.createTextNode("Reconnect"));
    actions.append(reconnectBtn, saveBtn);
    footer.append(actions);

    this.remoteEnableToggle = enableToggle;
    this.remoteServerUrlInput = serverUrlInput;
    this.remoteApiKeyInput = apiKeyInput;
    this.remoteDeviceNameInput = deviceNameInput;
    this.remoteModeSelect = modeSelect;
    this.remotePushSelect = pushSelect;
    this.remoteConnStatusLine = connLine;

    /** Button semantics follow the master switch: Reconnect only makes sense when on. */
    const updateActionButtons = (): void => {
      const on = enableToggle.checked;
      reconnectBtn.disabled = !on;
      saveBtn.textContent = on ? "Save & Connect" : "Save";
    };
    this.remoteSyncActionButtons = updateActionButtons;

    /** Kill switch — applies immediately, no Save needed. */
    const applyEnabled = async (checked: boolean): Promise<void> => {
      enableToggle.disabled = true;
      try {
        const { config } = await window.jellybot!.setRemoteConfig({ enabled: checked });
        this.remoteConfigCache = config;
        const { status: current } = await window.jellybot!.getRemoteStatus();
        this.setRemoteStatusLine(current, undefined, config.enabled);
      } catch (err) {
        enableToggle.checked = !checked; // revert the visual state
        syncSwitchAria(enableToggle);
        status.textContent = err instanceof Error ? err.message : "Failed to apply";
        status.hidden = false;
        window.setTimeout(() => {
          status.hidden = true;
        }, 2500);
      } finally {
        enableToggle.disabled = false;
        updateActionButtons();
      }
    };

    const save = async (): Promise<void> => {
      saveBtn.disabled = true;
      saveBtn.setAttribute("aria-busy", "true");
      try {
        const patch: Partial<RemoteRelayConfig> = {
          enabled: enableToggle.checked,
          serverUrl: serverUrlInput.value.trim(),
          deviceName: deviceNameInput.value.trim(),
          mode: modeSelect.value as "readonly" | "full",
          pushActivity: pushSelect.value as "all" | "active" | "off",
        };
        const { config } = await window.jellybot!.setRemoteConfig(patch);
        this.remoteConfigCache = config;
        const key = apiKeyInput.value.trim();
        if (key) {
          await window.jellybot!.saveRemoteKey(key);
          apiKeyInput.value = "";
          apiKeyInput.placeholder = "jbr_… (saved securely)";
        }
        const { status: current } = await window.jellybot!.getRemoteStatus();
        this.setRemoteStatusLine(current, undefined, config.enabled);
        status.textContent = "Saved";
        status.hidden = false;
        window.setTimeout(() => {
          status.hidden = true;
        }, 2000);
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : "Save failed";
        status.hidden = false;
      } finally {
        saveBtn.disabled = false;
        saveBtn.setAttribute("aria-busy", "false");
        updateActionButtons();
      }
    };
    saveBtn.addEventListener("click", () => void save());
    reconnectBtn.addEventListener("click", () => void save());
    regenerateIdBtn.addEventListener("click", async () => {
      regenerateIdBtn.disabled = true;
      regenerateIdBtn.setAttribute("aria-busy", "true");
      try {
        const { config } = await window.jellybot!.regenerateRemoteDeviceId();
        this.remoteConfigCache = config;
        const { status: current } = await window.jellybot!.getRemoteStatus();
        this.setRemoteStatusLine(current, undefined, config.enabled);
        status.textContent = "Device ID regenerated";
        status.hidden = false;
        window.setTimeout(() => {
          status.hidden = true;
        }, 2500);
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : "Failed to regenerate";
        status.hidden = false;
      } finally {
        regenerateIdBtn.disabled = false;
        regenerateIdBtn.setAttribute("aria-busy", "false");
      }
    });
    enableToggle.addEventListener("change", () => void applyEnabled(enableToggle.checked));
    updateActionButtons();

    // Async population + live status subscription.
    void this.populateRemoteCard();

    return { card, status };
  }

  private async populateRemoteCard(): Promise<void> {
    try {
      const { config, hasKey } = await window.jellybot!.getRemoteConfig();
      this.remoteConfigCache = config;
      this.remoteEnableToggle.checked = config.enabled;
      syncSwitchAria(this.remoteEnableToggle);
      this.remoteSyncActionButtons?.();
      this.remoteServerUrlInput.value = config.serverUrl;
      this.remoteDeviceNameInput.value = config.deviceName;
      this.remoteModeSelect.value = config.mode;
      this.remotePushSelect.value = config.pushActivity;
      this.remoteApiKeyInput.placeholder = hasKey
        ? "jbr_… (saved securely)"
        : "jbr_… (not set)";
      const ms = config.memorySync ?? { enabled: false, sessionArchive: false, projectDocs: false };
      const msToggle = this.root.querySelector('input[name="memorySyncEnabled"]') as HTMLInputElement | null;
      const msArchive = this.root.querySelector('input[name="memorySyncArchive"]') as HTMLInputElement | null;
      const msDocs = this.root.querySelector('input[name="memorySyncDocs"]') as HTMLInputElement | null;
      if (msToggle) {
        msToggle.checked = ms.enabled;
        syncSwitchAria(msToggle);
      }
      if (msArchive) msArchive.checked = ms.sessionArchive;
      if (msDocs) msDocs.checked = ms.projectDocs;
      try {
        const { status: snap } = await window.jellybot!.getMemorySyncStatus();
        const line = this.root.querySelector<HTMLElement>(".setting-memory-sync .setting-remote-status");
        if (line) {
          line.textContent = ms.enabled
            ? snap.lastRunAt
              ? snap.lastResult === "error"
                ? `Last sync ${new Date(snap.lastRunAt).toLocaleTimeString()} failed — ${snap.lastError ?? "unknown error"}`
                : `Synced ${new Date(snap.lastRunAt).toLocaleTimeString()} · pushed ${snap.pushed} · merged ${snap.inserted + snap.updated} · ${snap.pendingPush} pending`
              : `Not synced yet · ${snap.pendingPush} pending`
            : "Memory sync off";
        }
      } catch { /* status line keeps default */ }
      const { status } = await window.jellybot!.getRemoteStatus();
      this.setRemoteStatusLine(status, undefined, config.enabled);
    } catch {
      this.remoteConnStatusLine.textContent = "Remote unavailable";
    }
    if (this.remoteStatusUnsubscribe) this.remoteStatusUnsubscribe();
    this.remoteStatusUnsubscribe = window
      .jellybot!.onRemoteStatus(({ status, detail }) => {
        this.setRemoteStatusLine(status, detail, this.remoteEnableToggle.checked);
      });
  }

  /** Settings → Update card — manual in-place upgrade via the desktop maintenance engine. */
  private buildUpdateCard(): { card: HTMLElement; status: HTMLElement } {
    const { card, body, footer, status } = createCard(
      "update",
      "Update",
      "Check for updates and install the latest version.",
    );

    this.updateVersionLine = document.createElement("div");
    this.updateVersionLine.className = "up-version-line";
    this.updateMetaLine = document.createElement("div");
    this.updateMetaLine.className = "up-meta";
    const versionBlock = document.createElement("div");
    versionBlock.append(this.updateVersionLine, this.updateMetaLine);

    this.updateChip = document.createElement("span");
    this.updateChip.className = "up-chip";
    const headRight = document.createElement("span");
    headRight.className = "up-head-right";
    headRight.append(this.updateChip);
    const versionRow = document.createElement("div");
    versionRow.className = "up-version-row";
    versionRow.append(versionBlock, headRight);

    this.updateNote = document.createElement("div");
    this.updateNote.className = "up-note";
    this.updateNote.setAttribute("aria-live", "polite");

    this.updateLive = document.createElement("div");
    this.updateLive.className = "up-live";

    body.append(versionRow, this.updateNote, this.updateLive);

    this.updateCheckButton = document.createElement("button");
    this.updateCheckButton.type = "button";
    this.updateCheckButton.className = "setting-btn";
    this.updateRunButton = document.createElement("button");
    this.updateRunButton.type = "button";
    this.updateRunButton.className = "setting-btn setting-btn-primary";
    const actions = document.createElement("div");
    actions.className = "setting-card-actions";
    actions.append(this.updateCheckButton, this.updateRunButton);
    footer.prepend(actions);

    this.updateCheckButton.addEventListener("click", () => void this.triggerUpdateCheck());
    this.updateRunButton.addEventListener("click", () => void this.triggerUpdateRun());

    this.renderUpdateCard();
    // Async population (snapshot + silent auto-check + live state feed).
    void this.populateUpdateCard();
    return { card, status };
  }

  private async populateUpdateCard(): Promise<void> {
    const s = this.updateSnapshot;
    try {
      const state = await window.jellybot!.getUpdateState();
      s.currentVersion = state.currentVersion;
      s.platform = state.platform;
      s.maintenance = state.maintenance ?? null;
      if (state.check) {
        s.latest = state.check.entry ?? null;
        s.upToDate = state.check.upToDate;
        s.checkedAt = state.check.at;
      }
    } catch {
      /* bridge unavailable (tests / preload gap) — card keeps idle defaults */
    }
    const active = s.maintenance?.phase === "running" || s.maintenance?.phase === "queued";
    if (!active) await this.applyUpdateCheck(await this.safeUpdateCheck(false));
    try {
      this.updateStateUnsubscribe = window
        .jellybot!.onUpdateState((state) => {
          this.updateSnapshot.maintenance = state;
          this.renderUpdateCard();
        });
    } catch {
      /* no live feed — manual checks still work */
    }
    this.renderUpdateCard();
  }

  private async safeUpdateCheck(
    force: boolean,
  ): Promise<{ ok: boolean; error?: string; entry?: { version: string; url: string; sha256?: string } | null; checkedAt?: number; currentVersion?: string; upToDate?: boolean }> {
    try {
      return await window.jellybot!.checkForUpdate({ force });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async applyUpdateCheck(
    result: Awaited<ReturnType<SettingView["safeUpdateCheck"]>>,
  ): Promise<void> {
    const s = this.updateSnapshot;
    if (result.ok) {
      s.latest = result.entry ?? null;
      s.upToDate = result.upToDate ?? false;
      s.checkedAt = result.checkedAt ?? null;
      if (result.currentVersion) s.currentVersion = result.currentVersion;
      s.checkError = null;
    } else {
      s.checkError = result.error ?? "the release check failed";
    }
  }

  private async triggerUpdateCheck(): Promise<void> {
    const s = this.updateSnapshot;
    if (s.checking) return;
    s.checking = true;
    s.checkError = null;
    this.renderUpdateCard();
    await this.applyUpdateCheck(await this.safeUpdateCheck(true));
    s.checking = false;
    this.renderUpdateCard();
  }

  private async triggerUpdateRun(): Promise<void> {
    const s = this.updateSnapshot;
    const active = s.maintenance?.phase === "running" || s.maintenance?.phase === "queued";
    if (active || s.checking || s.requesting) return;
    s.requesting = true;
    this.renderUpdateCard();
    let result: { ok: boolean; error?: string };
    try {
      result = await window.jellybot!.runUpdate();
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    s.requesting = false;
    if (!result.ok) s.checkError = result.error ?? "the update failed to start";
    this.renderUpdateCard();
  }

  /** Single render from the card snapshot (mirrors the approved demo card). */
  private renderUpdateCard(): void {
    const s = this.updateSnapshot;
    const m = s.maintenance;
    const freshDone = m?.phase === "done" && Date.now() - m.ts < 15 * 60_000;
    const active = s.requesting || m?.phase === "running" || m?.phase === "queued";
    const failed = m?.phase === "failed";
    const step = m?.step;
    const relaunching =
      (m?.phase === "running" || m?.phase === "queued") &&
      (step === "install" || step === "switch" || step === "units" || step === "restart" || step === "smoke");
    const isMac = s.platform.startsWith("darwin");
    const buckets = isMac ? ["Download", "Verify", "Extract"] : ["Download", "Verify"];
    const progress = m?.progress;
    const pct =
      progress?.pct ??
      (progress?.totalBytes && progress.totalBytes > 0
        ? Math.min(100, Math.floor((progress.receivedBytes / progress.totalBytes) * 100))
        : undefined);
    const mega = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;
    const checkedAtText =
      s.checkedAt != null
        ? new Date(s.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : null;
    const platformMeta = s.platform
      ? `${s.platform} · ${isMac ? "mac-zip" : "win-nsis"} channel`
      : "";

    // Progress ticks re-render often; regions rebuild only when their key changes so
    // spinners (CSS animations) are not recreated and restarted on every tick.
    const sync = (host: HTMLElement, key: string, build: () => Node[]): void => {
      if (host.dataset.renderKey === key) return;
      host.dataset.renderKey = key;
      host.replaceChildren(...build());
    };
    const spinner = (): HTMLSpanElement => {
      const el = document.createElement("span");
      el.className = "spinner";
      el.setAttribute("aria-hidden", "true");
      return el;
    };

    // ── version line + meta ──
    const versionSpan = (text: string, cls?: string): HTMLSpanElement => {
      const el = document.createElement("span");
      if (cls) el.className = cls;
      el.textContent = text;
      return el;
    };
    if (freshDone && m?.version) {
      const version = m.version;
      sync(this.updateVersionLine, `done:${version}`, () => [versionSpan(version)]);
      this.updateMetaLine.textContent = `Current version · ${platformMeta}`;
    } else if (s.latest && !s.upToDate && s.latest.version) {
      const target = s.latest.version;
      sync(this.updateVersionLine, `upgrade:${s.currentVersion}:${target}`, () => {
        const arrow = versionSpan("→", "arrow");
        arrow.setAttribute("aria-hidden", "true");
        return [versionSpan(s.currentVersion || "—"), arrow, versionSpan(target, "target")];
      });
      this.updateMetaLine.textContent = `${active ? "Updating" : "Current version"} · ${platformMeta}`;
    } else {
      sync(this.updateVersionLine, `current:${s.currentVersion}`, () => [versionSpan(s.currentVersion || "—")]);
      this.updateMetaLine.textContent = `Current version · ${platformMeta}`;
    }

    // ── chip ──
    const setChip = (cls: string | null, children: Node[], text: string): void => {
      this.updateChip.className = cls ? `up-chip ${cls}` : "up-chip";
      sync(this.updateChip, `${children.length}:${text}`, () => [...children, document.createTextNode(text)]);
    };
    const chipSpinner = spinner;
    if (active) {
      const busy = step === "verify" ? "Verifying"
        : step === "extract" ? "Extracting"
        : relaunching ? "Relaunching"
        : "Updating";
      setChip("is-busy", [chipSpinner()], busy);
    } else if (failed) {
      setChip("is-failed", [], "Failed");
    } else if (freshDone) {
      setChip("is-done", [], "Update complete");
    } else if (s.upToDate) {
      setChip(null, [], "Up to date");
    } else {
      setChip(null, [], s.currentVersion ? `ver. ${s.currentVersion}` : "—");
    }

    // ── note line ──
    const setNote = (children: Node[], cls?: string): void => {
      this.updateNote.className = cls ? `up-note ${cls}` : "up-note";
      const key = children
        .map((c) => `${c.nodeName}.${c.nodeType === 1 ? (c as Element).getAttribute("class") ?? "" : ""}:${c.textContent ?? ""}`)
        .join("|");
      sync(this.updateNote, key, () => children);
    };
    const noteText = (text: string): HTMLSpanElement => {
      const el = document.createElement("span");
      el.textContent = text;
      return el;
    };
    const noteIcon = (icon: IconNode): SVGElement => strokeLucide(icon, 14);
    const noteSpinner = spinner;
    if (s.checking && !active) {
      setNote([noteSpinner(), noteText("Checking latest release…")]);
    } else if (s.requesting && !m) {
      setNote([noteSpinner(), noteText("Starting the update…")]);
    } else if (failed) {
      setNote(
        [noteIcon(TriangleAlert), noteText(`Update failed — ${m?.error ?? "nothing was changed"}, you can retry.`)],
        "is-error",
      );
    } else if (s.checkError && !active) {
      setNote([noteIcon(TriangleAlert), noteText(s.checkError)], "is-error");
    } else if (freshDone) {
      setNote([noteIcon(Info), noteText(`Update installed · now on ${m?.version ?? s.currentVersion}`)]);
    } else if (!active && s.upToDate) {
      setNote([
        noteIcon(Info),
        noteText(
          `Up to date — ${s.currentVersion} is the newest release${checkedAtText ? ` · checked ${checkedAtText}` : ""}`,
        ),
      ]);
    } else if (!active && s.latest && !s.upToDate) {
      const bold = document.createElement("b");
      bold.textContent = s.latest.version;
      setNote([
        noteIcon(Info),
        noteText("Latest release: "),
        bold,
        noteText(checkedAtText ? ` · checked ${checkedAtText}` : ""),
      ]);
    } else if (!active) {
      setNote([noteIcon(Info), noteText("Not checked yet — check now for the newest release.")]);
    } else {
      setNote([]);
    }

    // ── live zone (phase row + progress + step track + hint + error) ──
    const phaseText = active
      ? relaunching ? "Relaunching"
        : step === "download" ? "Downloading"
        : step === "verify" ? "Verifying"
        : step === "extract" ? "Extracting"
        : "Preparing update"
      : failed ? "Update failed"
      : freshDone ? `Update complete · ${m?.version ?? s.currentVersion}`
      : null;
    const showPct = !!phaseText && active && step === "download" && pct != null;
    const showBar = active && step === "download" && !!progress && pct != null;
    const stepIndex = step === "download" ? 0 : step === "verify" ? 1 : step === "extract" ? 2 : -1;
    const allDone = relaunching || (!active && !failed);
    const stepStates = active || failed || freshDone
      ? buckets.map((_, i) =>
        allDone ? "is-done"
        : failed ? (i === 0 ? "is-failed" : "")
        : active && stepIndex > i ? "is-done"
        : active && stepIndex === i ? "is-current"
        : "")
      : null;
    const hintText = active
      ? relaunching
        ? "Installing in place — the app relaunches itself on the new version in a moment."
        : "When these steps finish, the app installs the update and relaunches automatically — no further action needed."
      : null;
    const errorText = failed ? `${m?.error ?? "the update failed"} — nothing was changed.` : null;
    sync(this.updateLive, JSON.stringify([phaseText, showPct, showBar, buckets, stepStates, hintText, errorText]), () => {
      this.updateLiveRefs = {};
      const nodes: Node[] = [];
      if (phaseText) {
        const phaseRow = document.createElement("div");
        phaseRow.className = "up-phase-row";
        const phase = document.createElement("span");
        phase.className = "up-phase";
        phase.textContent = phaseText;
        phaseRow.append(phase);
        if (showPct) {
          const pctEl = document.createElement("span");
          pctEl.className = "up-phase-pct";
          phaseRow.append(pctEl);
          this.updateLiveRefs.pct = pctEl;
        }
        nodes.push(phaseRow);
      }
      if (showBar) {
        const bar = document.createElement("div");
        bar.className = "up-progress";
        const track = document.createElement("div");
        track.className = "up-progress-bar";
        track.setAttribute("role", "progressbar");
        track.setAttribute("aria-label", "Download progress");
        track.setAttribute("aria-valuemin", "0");
        track.setAttribute("aria-valuemax", "100");
        const fill = document.createElement("div");
        fill.className = "up-progress-fill";
        track.append(fill);
        const metaRow = document.createElement("div");
        metaRow.className = "up-progress-meta";
        const label = document.createElement("span");
        label.className = "up-progress-label";
        const rate = document.createElement("span");
        rate.className = "up-progress-rate";
        metaRow.append(label, rate);
        bar.append(track, metaRow);
        Object.assign(this.updateLiveRefs, { track, fill, label, rate });
        nodes.push(bar);
      }
      if (stepStates) {
        const track = document.createElement("div");
        track.className = "up-steps";
        track.setAttribute("role", "list");
        track.setAttribute("aria-label", "Update steps");
        buckets.forEach((label, i) => {
          const state = stepStates[i] ?? "";
          const item = document.createElement("div");
          item.className = `up-step ${state}`.trim();
          item.setAttribute("role", "listitem");
          const dot = document.createElement("span");
          dot.className = "up-step-dot";
          if (state === "is-done" || state === "is-failed") {
            const glyph = document.createElement("span");
            glyph.className = "up-step-glyph";
            glyph.setAttribute("aria-hidden", "true");
            glyph.append(strokeLucide(state === "is-done" ? Check : X, 10, 3));
            dot.append(glyph);
          } else if (state === "is-current") {
            dot.append(spinner());
          }
          const text = document.createElement("span");
          text.className = "up-step-label";
          text.textContent = label;
          item.append(dot, text);
          track.append(item);
        });
        nodes.push(track);
      }
      if (hintText) {
        const hint = document.createElement("div");
        hint.className = "up-relaunch-hint";
        const text = document.createElement("span");
        text.textContent = hintText;
        hint.append(strokeLucide(Info, 14), text);
        nodes.push(hint);
      }
      if (errorText) {
        const err = document.createElement("div");
        err.className = "up-error";
        err.setAttribute("role", "alert");
        const text = document.createElement("span");
        text.textContent = errorText;
        err.append(strokeLucide(TriangleAlert, 12), text);
        nodes.push(err);
      }
      return nodes;
    });
    // Volatile download numbers: patched in place every tick.
    const live = this.updateLiveRefs;
    if (live.pct && pct != null) live.pct.textContent = `${pct}%`;
    if (live.fill && live.track && progress && pct != null) {
      live.fill.style.width = `${pct}%`;
      live.track.setAttribute("aria-valuenow", String(pct));
      live.label!.textContent =
        `${mega(progress.receivedBytes)}${progress.totalBytes ? ` / ${mega(progress.totalBytes)}` : ""}`;
      live.rate!.textContent = progress.bytesPerSec ? `${(progress.bytesPerSec / 1_000_000).toFixed(1)} MB/s` : "";
    }

    // ── buttons ──
    this.updateCheckButton.disabled = active || s.checking;
    sync(this.updateCheckButton, String(s.checking), () => [
      s.checking ? spinner() : strokeLucide(RefreshCw, 13),
      document.createTextNode(s.checking ? "Checking…" : "Check for Updates"),
    ]);
    this.updateRunButton.disabled = active || s.checking || s.upToDate || !s.latest;
    this.updateRunButton.setAttribute("aria-busy", String(active));
    const runLabel = active ? "Updating…" : failed ? "Retry Update" : "Update";
    sync(this.updateRunButton, runLabel, () => [
      active ? spinner() : strokeLucide(Download, 13),
      document.createTextNode(runLabel),
    ]);
  }

  private setRemoteStatusLine(status: string, detail: string | undefined, enabled: boolean): void {
    const line = this.remoteConnStatusLine;
    if (!enabled) {
      line.textContent = "Remote off — relay connection closed";
      line.classList.remove("is-online");
      return;
    }
    const labels: Record<string, string> = {
      connecting: "Connecting…",
      connected: "Connected",
      reconnecting: "Reconnecting…",
      error: "Error",
      stopped: "Stopped",
      disabled: "Remote off",
    };
    line.textContent = `${labels[status] ?? status}${detail ? ` — ${detail}` : ""}`;
    line.classList.toggle("is-online", status === "connected");
  }

  /**
   * Show (or clear with `null`) the import summary. The Import title,
   * summary panel and Apply button appear together with it.
   */
  setBackupSummary(summary: {
    path: string;
    sections: string[];
    exportedAt: string;
    appVersion: string;
  } | null): void {
    this.backupImportPath = summary?.path ?? "";
    const has = summary !== null;
    this.backupImportTitle.hidden = !has;
    this.backupSummaryBox.hidden = !has;
    this.applyBackupButton.hidden = !has;
    if (summary) {
      this.backupSummaryPath.textContent = summary.path;
      this.backupSummarySections.textContent = summary.sections
        .map((name) => BACKUP_SECTION_LABELS[name] ?? name)
        .join(" · ");
      const exported = summary.exportedAt
        ? new Date(summary.exportedAt).toLocaleString()
        : "";
      this.backupSummaryMeta.textContent = `Exported ${exported}${
        summary.appVersion ? ` · from v${summary.appVersion}` : ""
      }`;
    }
  }

  /** Chosen backup file path ("" until a summary is loaded). */
  getBackupImportPath(): string {
    return this.backupImportPath;
  }

  /** Thin indeterminate bar while export/import work is actually running. */
  setBackupWorking(working: boolean): void {
    this.backupProgressBar.hidden = !working;
  }

  setOnSelectProvider(handler: ((id: string) => void) | null): void {
    this.onSelectProvider = handler;
  }

  /** Fired after a provider drop reordered the in-memory draft list. */
  setOnProviderOrderChange(handler: (() => void) | null): void {
    this.onProviderOrderChange = handler;
  }

  setAppVersion(version: string): void {
    const trimmed = version.trim();
    if (!trimmed) {
      this.versionEl.hidden = true;
      this.versionEl.textContent = "";
      return;
    }
    this.versionEl.hidden = false;
    this.versionEl.textContent = `ver.${trimmed}`;
  }

  setForm(state: SettingFormState): void {
    this.providers = state.providers.map((p) => ({ ...p }));
    this.activeProviderId = state.activeProviderId;
    this.selectedProviderId =
      state.selectedProviderId ||
      state.activeProviderId ||
      state.providers[0]?.id ||
      "";
    this.apiKeyConfiguredByProviderId = {
      ...state.apiKeyConfiguredByProviderId,
    };
    this.imageGenProviders = state.imageGenProviders.map((p) => ({ ...p }));
    this.selectedImageGenProviderId =
      state.selectedImageGenProviderId ||
      state.activeImageGenProviderId ||
      state.imageGenProviders[0]?.id ||
      "";
    this.activeImageGenProviderId = state.activeImageGenProviderId;
    this.imageGenApiKeyConfiguredByProviderId = {
      ...state.imageGenApiKeyConfiguredByProviderId,
    };
    this.objectStorageSecretConfigured = state.objectStorageSecretConfigured;
    this.fullPermissionsToggle.checked = state.fullPermissionsDefault;
    this.autoSkillSummarizeToggle.checked = state.autoSkillSummarizeDefault;
    this.newTaskInfiniteToggle.checked = state.composerInfinite;
    this.newTaskReasoningSeg.setLevel(state.reasoningEffort);
    this.contextLimitInput.value = String(state.contextLimitTokens);
    this.themeSelect.value = state.themeId;
    this.accentPicker.value = state.accentColor;
    this.uiFontScaleSelect.value = snapFontScale(
      state.uiFontScale ?? 1,
      UI_FONT_SCALE_OPTIONS,
    );
    this.chatFontScaleSelect.value = snapFontScale(
      state.chatFontScale ?? 1,
      CHAT_FONT_SCALE_OPTIONS,
    );
    this.compactTriggerRatioInput.value = String(state.compactTriggerRatio);
    this.iterationProtectRawIterationCountInput.value = String(
      state.iterationProtectRawIterationCount,
    );
    this.iterationProtectTokenRatioInput.value = String(
      state.iterationProtectTokenRatio,
    );
    this.maxRoundsInput.value = String(state.maxModelIterations);
    this.maxTurnTokensInput.value = String(state.maxTurnTokens);
    this.llmRequestTimeoutInput.value = String(
      Math.round(state.llmRequestTimeoutMs / 1000),
    );
    this.toolStatsEnabledToggle.checked = state.toolStatsEnabled;
    this.envWorkspaceToggle.checked = state.environmentContext.workspace;
    this.envTimezoneToggle.checked = state.environmentContext.timezone;
    this.envLocaleToggle.checked = state.environmentContext.locale;
    this.envLocationToggle.checked = state.environmentContext.location;
    this.envRepositoryToggle.checked = state.environmentContext.repository;
    this.userMemoryAutoExtractToggle.checked = state.userMemoryAutoExtract;
    this.userMemoryProfileInput.value = state.userMemoryProfile;
    this.setVisionOptions(state.providers, state.visionProviderId);
    this.setCompletionOptions(state.providers, state.inlineCompletionProviderId);
    this.fillObjectStorageDetail(state.objectStorage);
    this.renderProviderList();
    this.fillSelectedDetail();
    this.renderImageGenProviderList();
    this.fillImageGenSelectedDetail();
    this.syncAllSwitchAria();
    this.syncBusy();
  }

  private syncAllSwitchAria(): void {
    for (const input of [
      this.multimodalToggle,
      this.toolRoleImagesToggle,
      this.rawEndpointToggle,
      this.responsesStatefulToggle,
      this.responsesWebSearchToggle,
      this.responsesCodeExecutionToggle,
      this.responsesImageGenerationToggle,
      this.imageGenRawEndpointToggle,
      this.fullPermissionsToggle,
      this.autoSkillSummarizeToggle,
      this.shellSafetyToggle,
      this.newTaskInfiniteToggle,
      this.envWorkspaceToggle,
      this.envTimezoneToggle,
      this.envLocaleToggle,
      this.envLocationToggle,
      this.envRepositoryToggle,
      this.toolStatsEnabledToggle,
      this.userMemoryAutoExtractToggle,
      this.objectStorageEnabledToggle,
    ]) {
      syncSwitchAria(input);
    }
  }

  /** Rebuild the Vision dropdown from chat providers (Multimodal only).
   * Keeps the current selection when still offered; selectedId forces it. */
  setVisionOptions(
    providers: SettingProviderForm[],
    selectedId?: string | null,
  ): void {
    const keep =
      typeof selectedId === "string"
        ? selectedId
        : this.visionProviderSelect.value;
    this.visionProviderSelect.update(
      [
        { value: "", label: "None — vision disabled" },
        ...providers
          .filter((provider) => provider.supportsMultimodal === true)
          .map((provider) => ({
            value: provider.id,
            label: `${provider.name} — ${provider.modelId}`,
          })),
      ],
      keep,
    );
  }

  getVisionSelectedId(): string {
    return this.visionProviderSelect.value;
  }

  /** Rebuild the Completion dropdown from every chat provider.
   * Keeps the current selection when still offered; selectedId forces it. */
  setCompletionOptions(
    providers: SettingProviderForm[],
    selectedId?: string | null,
  ): void {
    const keep =
      typeof selectedId === "string"
        ? selectedId
        : this.completionProviderSelect.value;
    this.completionProviderSelect.update(
      [
        { value: "", label: "Default — new-task provider" },
        ...providers.map((provider) => ({
          value: provider.id,
          label: `${provider.name} — ${provider.modelId}`,
        })),
      ],
      keep,
    );
  }

  getCompletionSelectedId(): string {
    return this.completionProviderSelect.value;
  }

  setOnSelectImageGenProvider(handler: ((id: string) => void) | null): void {
    this.onSelectImageGenProvider = handler;
  }

  /** Replace the in-memory image profile list (add/delete flows). */
  setImageGenProvidersLocal(
    providers: SettingImageGenForm[],
    selectedId: string,
    activeId: string,
  ): void {
    this.imageGenProviders = providers.map((p) => ({ ...p }));
    this.selectedImageGenProviderId = selectedId;
    this.activeImageGenProviderId = activeId;
    this.renderImageGenProviderList();
    this.fillImageGenSelectedDetail();
  }

  private renderImageGenProviderList(): void {
    this.imageGenProviderListEl.replaceChildren();
    if (this.imageGenProviders.length === 0) {
      const empty = document.createElement("div");
      empty.className = "setting-provider-list-empty";
      empty.textContent =
        "No image generation profiles configured. Click + above to add one.";
      this.imageGenProviderListEl.append(empty);
      return;
    }
    for (const provider of this.imageGenProviders) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "setting-provider-row";
      row.setAttribute("role", "option");
      if (provider.id === this.selectedImageGenProviderId) {
        row.classList.add("is-selected");
      }
      const title = document.createElement("span");
      title.className = "setting-provider-row-title";
      title.textContent = provider.name;
      const meta = document.createElement("span");
      meta.className = "setting-provider-row-meta";
      meta.textContent = provider.modelId;
      row.append(title, meta);
      if (provider.id === this.activeImageGenProviderId) {
        const badge = document.createElement("span");
        badge.className = "setting-provider-active-badge";
        badge.textContent = "Active";
        badge.title = "Used for image generation";
        row.append(badge);
      }
      row.addEventListener("click", () => {
        this.commitSelectedImageGenDetailToModel();
        this.selectedImageGenProviderId = provider.id;
        this.renderImageGenProviderList();
        this.fillImageGenSelectedDetail();
        this.onSelectImageGenProvider?.(provider.id);
      });
      this.imageGenProviderListEl.append(row);
    }
  }

  /** Re-render the list only (keeps the detail editor untouched). */
  refreshImageGenProviderList(): void {
    this.renderImageGenProviderList();
  }

  /**
   * Sync list + active/selected ids after a save round-trip without
   * touching the detail editor (preserves in-progress typing/focus).
   */
  syncImageGenState(
    providers: SettingImageGenForm[],
    activeId: string,
    selectedId: string,
  ): void {
    this.imageGenProviders = providers.map((p) => ({ ...p }));
    this.activeImageGenProviderId = activeId;
    this.selectedImageGenProviderId = selectedId;
    this.renderImageGenProviderList();
    this.syncBusy();
  }

  private fillImageGenSelectedDetail(): void {
    const selected = this.imageGenProviders.find(
      (p) => p.id === this.selectedImageGenProviderId,
    );
    if (selected) {
      this.imageGenNameInput.value = selected.name;
      this.imageGenBaseUrlInput.value = selected.baseUrl;
      this.imageGenModelIdInput.value = selected.modelId;
      this.imageGenRawEndpointToggle.checked = selected.rawEndpoint === true;
      this.imageGenWatermarkSelect.value =
        typeof selected.watermark === "boolean"
          ? selected.watermark
            ? "on"
            : "off"
          : "default";
      this.imageGenImageInputSelect.value =
        selected.imageInput === "base64" || selected.imageInput === "url"
          ? selected.imageInput
          : "disabled";
      const keyConfigured =
        this.imageGenApiKeyConfiguredByProviderId[selected.id] === true;
      this.renderImageGenApiKeyStatus(keyConfigured);
    } else {
      this.imageGenNameInput.value = "";
      this.imageGenBaseUrlInput.value = "";
      this.imageGenModelIdInput.value = "";
      this.imageGenRawEndpointToggle.checked = false;
      this.imageGenWatermarkSelect.value = "default";
      this.imageGenImageInputSelect.value = "disabled";
      this.renderImageGenApiKeyStatus(false);
    }
    syncSwitchAria(this.imageGenRawEndpointToggle);
  }

  /** Write the detail editor fields back into the selected list entry. */
  commitSelectedImageGenDetailToModel(): void {
    const selected = this.imageGenProviders.find(
      (p) => p.id === this.selectedImageGenProviderId,
    );
    if (!selected) return;
    const watermarkValue = this.imageGenWatermarkSelect.value;
    selected.name = this.imageGenNameInput.value;
    selected.baseUrl = this.imageGenBaseUrlInput.value;
    selected.modelId = this.imageGenModelIdInput.value;
    selected.rawEndpoint = this.imageGenRawEndpointToggle.checked;
    if (watermarkValue === "on") {
      selected.watermark = true;
    } else if (watermarkValue === "off") {
      selected.watermark = false;
    } else {
      delete selected.watermark;
    }
    const imageInputValue = this.imageGenImageInputSelect.value;
    if (imageInputValue === "base64" || imageInputValue === "url") {
      selected.imageInput = imageInputValue;
    } else {
      delete selected.imageInput;
    }
  }

  getImageGenProvidersDraft(): SettingImageGenForm[] {
    this.commitSelectedImageGenDetailToModel();
    return this.imageGenProviders.map((p) => ({ ...p }));
  }

  getActiveImageGenProviderId(): string {
    return this.activeImageGenProviderId;
  }

  getSelectedImageGenProviderId(): string {
    return this.selectedImageGenProviderId;
  }

  setImageGenApiKeyConfigured(
    providerId: string,
    configured: boolean,
  ): void {
    this.imageGenApiKeyConfiguredByProviderId[providerId] = configured;
    if (providerId === this.selectedImageGenProviderId) {
      this.renderImageGenApiKeyStatus(configured);
    }
  }

  private renderImageGenApiKeyStatus(configured: boolean): void {
    this.imageGenApiKeyStatus.replaceChildren();
    const badge = document.createElement("span");
    badge.className = `setting-key-badge ${configured ? "is-ok" : "is-missing"}`;
    badge.append(
      createLucideIcon(KeyRound, { size: 14 }),
      document.createTextNode(
        configured ? "Saved securely" : "Not set",
      ),
    );
    this.imageGenApiKeyStatus.append(badge);
  }

  fillObjectStorageDetail(config: SettingObjectStorageForm | null): void {
    if (config) {
      this.objectStorageProviderSelect.value = config.provider;
      this.objectStorageRegionInput.value = config.region;
      this.objectStorageBucketInput.value = config.bucket;
      this.objectStorageAccessKeyIdInput.value = config.accessKeyId;
      this.objectStorageEndpointInput.value = config.endpoint;
      this.objectStorageKeyPrefixInput.value = config.keyPrefix;
      this.objectStorageUrlModeSelect.value = config.urlMode;
      this.objectStorageEnabledToggle.checked = config.enabled === true;
    } else {
      this.objectStorageProviderSelect.value = "amazon";
      this.objectStorageRegionInput.value = "";
      this.objectStorageBucketInput.value = "";
      this.objectStorageAccessKeyIdInput.value = "";
      this.objectStorageEndpointInput.value = "";
      this.objectStorageKeyPrefixInput.value = "";
      this.objectStorageUrlModeSelect.value = "presigned";
      this.objectStorageEnabledToggle.checked = false;
    }
    syncSwitchAria(this.objectStorageEnabledToggle);
    this.updateObjectStorageProviderBrandIcon();
    this.setObjectStorageSecretConfigured(this.objectStorageSecretConfigured);
  }

  /** Sync the brand icon next to the Provider select with its value. */
  private updateObjectStorageProviderBrandIcon(): void {
    this.objectStorageProviderBrandIcon.replaceChildren(
      createStorageProviderBrandIcon(
        this.objectStorageProviderSelect.value === "tencent"
          ? "tencent"
          : "amazon",
      ),
    );
  }

  private objectStorageSecretConfigured = false;

  setObjectStorageSecretConfigured(configured: boolean): void {
    this.objectStorageSecretConfigured = configured;
    this.objectStorageSecretStatus.replaceChildren();
    const badge = document.createElement("span");
    badge.className = `setting-key-badge ${configured ? "is-ok" : "is-missing"}`;
    badge.append(
      createLucideIcon(KeyRound, { size: 14 }),
      document.createTextNode(configured ? "Saved securely" : "Not set"),
    );
    this.objectStorageSecretStatus.append(badge);
    this.syncBusy();
  }

  getObjectStorageDraft(): SettingObjectStorageForm | null {
    const region = this.objectStorageRegionInput.value.trim();
    const bucket = this.objectStorageBucketInput.value.trim();
    const accessKeyId = this.objectStorageAccessKeyIdInput.value.trim();
    if (!region || !bucket || !accessKeyId) return null;
    return {
      provider:
        this.objectStorageProviderSelect.value === "tencent"
          ? "tencent"
          : "amazon",
      region,
      bucket,
      accessKeyId,
      endpoint: this.objectStorageEndpointInput.value.trim(),
      keyPrefix: this.objectStorageKeyPrefixInput.value.trim(),
      urlMode:
        this.objectStorageUrlModeSelect.value === "public"
          ? "public"
          : "presigned",
      enabled: this.objectStorageEnabledToggle.checked,
    };
  }

  getObjectStorageSecretDraft(): string {
    return this.objectStorageSecretInput.value;
  }

  clearObjectStorageSecretDraft(): void {
    this.objectStorageSecretInput.value = "";
  }

  getImageGenApiKeyDraft(): string {
    return this.imageGenApiKeyInput.value;
  }

  clearImageGenApiKeyDraft(): void {
    this.imageGenApiKeyInput.value = "";
  }

  private renderProviderList(): void {
    this.bindProviderDragReorder();
    this.providerListEl.replaceChildren();
    for (const provider of this.providers) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "setting-provider-row";
      row.setAttribute("role", "option");
      if (provider.id === this.selectedProviderId) {
        row.classList.add("is-selected");
      }
      const brand = matchModelBrand(provider);
      const brandIcon = brand ? createBrandIcon(brand, 14) : null;
      // Uniform leading grip slot — present on every row so titles stay
      // aligned across the list, and a hint that rows drag to reorder.
      const grip = document.createElement("span");
      grip.className = "setting-provider-row-grip";
      grip.setAttribute("aria-hidden", "true");
      grip.append(createLucideIcon(GripVertical, { size: 13 }));
      const title = document.createElement("span");
      title.className = "setting-provider-row-title";
      title.textContent = provider.name;
      const meta = document.createElement("span");
      meta.className = "setting-provider-row-meta";
      meta.textContent = provider.modelId;
      const rowChildren: Array<Node> = [grip];
      if (brandIcon) rowChildren.push(brandIcon);
      rowChildren.push(title, meta);
      row.append(...rowChildren);
      if (provider.id === this.activeProviderId) {
        const badge = document.createElement("span");
        badge.className = "setting-provider-active-badge";
        badge.textContent = "Default";
        badge.title = "Default for new tasks";
        row.append(badge);
      }
      row.addEventListener("click", () => {
        this.commitSelectedDetailToModel();
        this.selectedProviderId = provider.id;
        this.renderProviderList();
        this.fillSelectedDetail();
        this.onSelectProvider?.(provider.id);
      });
      this.providerListEl.append(row);
    }
  }

  /**
   * Rebuild the Image input options for the currently selected provider.
   * - Moonshot host: base64 + Moonshot file upload (external image URLs are
   *   not supported by their vision models).
   * - Others: Cloud Storage URL + base64.
   * A desired/current value that is no longer offered auto-corrects to the
   * first safe choice (base64 on Moonshot, URL elsewhere).
   */
  private refreshImageInputOptions(
    desired?: "url" | "base64" | "file",
  ): void {
    const selected = this.providers.find(
      (p) => p.id === this.selectedProviderId,
    );
    const moonshot = isMoonshotProviderBaseUrl(selected?.baseUrl ?? "");
    const choices: Array<{ value: "url" | "base64" | "file"; label: string }> =
      moonshot
        ? [
            { value: "base64", label: "Base64" },
            { value: "file", label: "Moonshot file upload (ms://)" },
          ]
        : [
            { value: "url", label: "Image URL (via Cloud Storage)" },
            { value: "base64", label: "Base64" },
          ];
    const current =
      desired ??
      (this.imageInputSelect.value as "url" | "base64" | "file" | "");
    const valid =
      choices.some((c) => c.value === current)
        ? (current as "url" | "base64" | "file")
        : (choices[0]!.value as "url" | "base64" | "file");
    this.imageInputSelect.update(choices, valid);
  }

  private fillSelectedDetail(): void {
    const selected = this.providers.find(
      (p) => p.id === this.selectedProviderId,
    );
    if (!selected) {
      this.nameInput.value = "";
      this.baseUrlInput.value = "";
      this.modelIdInput.value = "";
      this.updateModelIdBrandIcon(null);
      this.multimodalToggle.checked = false;
      syncSwitchAria(this.multimodalToggle);
      this.toolRoleImagesToggle.checked = false;
      this.toolRoleImagesToggle.disabled = true;
      syncSwitchAria(this.toolRoleImagesToggle);
      this.refreshImageInputOptions("url");
      this.imageInputSelect.disabled = true;
      this.rawEndpointToggle.checked = false;
      this.apiProtocolSelect.value = "auto";
      this.responsesToolsInput.value = "";
      this.responsesStatefulToggle.checked = false;
      this.syncResponsesToolToggles();
      this.refreshApiProtocol();
      syncSwitchAria(this.rawEndpointToggle);
      this.setApiKeyConfigured(false);
      this.setDefaultProviderButton.disabled = true;
      return;
    }
    this.nameInput.value = selected.name;
    this.baseUrlInput.value = selected.baseUrl;
    this.modelIdInput.value = selected.modelId;
    this.updateModelIdBrandIcon(selected);
    this.multimodalToggle.checked = selected.supportsMultimodal === true;
    syncSwitchAria(this.multimodalToggle);
    // Show the EFFECTIVE value (verified list + explicit override); the
    // switch writes an explicit override only when it diverges (commit).
    this.toolRoleImagesToggle.checked = resolveToolRoleImageSupport(selected).enabled;
    this.toolRoleImagesToggle.disabled = selected.supportsMultimodal !== true;
    syncSwitchAria(this.toolRoleImagesToggle);
    this.refreshImageInputOptions(
      selected.imageInput === "base64" || selected.imageInput === "file"
        ? selected.imageInput
        : "url",
    );
    this.imageInputSelect.disabled = false;
    this.rawEndpointToggle.checked = selected.rawEndpoint === true;
    this.apiProtocolSelect.value = selected.apiProtocol ?? "auto";
    this.responsesToolsInput.value = selected.responsesTools?.length ? JSON.stringify(selected.responsesTools, null, 2) : "";
    this.responsesToolsInput.setCustomValidity("");
    this.responsesStatefulToggle.checked = resolveResponsesStateful(selected);
    this.syncResponsesToolToggles();
    syncSwitchAria(this.responsesStatefulToggle);
    this.refreshApiProtocol();
    syncSwitchAria(this.rawEndpointToggle);
    this.setApiKeyConfigured(
      this.apiKeyConfiguredByProviderId[selected.id] === true,
    );
    this.setDefaultProviderButton.disabled =
      selected.id === this.activeProviderId;
    this.setDefaultProviderButton.textContent =
      selected.id === this.activeProviderId
        ? "Default for new tasks"
        : "Set as default";
  }

  /**
   * Sync the brand icon next to the Model ID input. Accepts any
   * { name, baseUrl, modelId } source — the committed provider on fill,
   * or the live editor draft while typing.
   */
  private updateModelIdBrandIcon(source: ModelBrandSource | null): void {
    this.modelIdBrandIcon.replaceChildren();
    if (!source) return;
    const brand = matchModelBrand(source);
    if (brand) this.modelIdBrandIcon.append(createBrandIcon(brand, 14));
  }

  /** Push editor fields into the in-memory selected provider. */
  commitSelectedDetailToModel(): void {
    const selected = this.providers.find(
      (p) => p.id === this.selectedProviderId,
    );
    if (!selected) return;
    selected.name = this.nameInput.value.trim() || selected.name;
    selected.baseUrl = this.baseUrlInput.value.trim() || selected.baseUrl;
    selected.modelId = this.modelIdInput.value.trim() || selected.modelId;
    selected.supportsMultimodal = this.multimodalToggle.checked;
    const { toolRoleImages: _explicitToolRoleImages, ...providerInfo } = selected;
    const toolRoleImagesDefault = resolveToolRoleImageSupport(providerInfo).enabled;
    if (this.toolRoleImagesToggle.checked !== toolRoleImagesDefault) {
      selected.toolRoleImages = this.toolRoleImagesToggle.checked;
    } else {
      // Matches the default again — drop any explicit override.
      delete selected.toolRoleImages;
    }
    selected.imageInput =
      this.imageInputSelect.value === "base64" ||
      this.imageInputSelect.value === "file"
        ? this.imageInputSelect.value
        : "url";
    selected.rawEndpoint = this.rawEndpointToggle.checked;
    Object.assign(selected, normalizeLlmProviderOptions({
      apiProtocol: this.apiProtocolSelect.value,
      ...(typeof selected.responsesStateful === "boolean" ? { responsesStateful: this.responsesStatefulToggle.checked } : {}),
    }));
    if (this.validateResponsesTools()) {
      selected.responsesTools = normalizeLlmProviderOptions({ responsesTools: JSON.parse(this.responsesToolsInput.value.trim() || "[]") }).responsesTools ?? [];
    }
  }

  private refreshApiProtocol(): void {
    const config = { baseUrl: this.baseUrlInput.value.trim(), rawEndpoint: this.rawEndpointToggle.checked,
      ...normalizeLlmProviderOptions({ apiProtocol: this.apiProtocolSelect.value }) };
    const protocol = resolveLlmApiProtocol(config);
    const label = protocol === "responses" ? "Responses" : "Chat Completions";
    this.apiProtocolHint.textContent = `${config.apiProtocol === "auto" ? "Auto: " : "Selected: "}${label} · ${modelEndpoint(config)}`;
    this.responsesOptionsBlock.hidden = protocol !== "responses";
    const selected = this.providers.find((provider) => provider.id === this.selectedProviderId);
    if (selected?.responsesStateful === undefined) {
      this.responsesStatefulToggle.checked = resolveResponsesStateful(config);
      syncSwitchAria(this.responsesStatefulToggle);
    }
  }

  validateResponsesTools(): boolean {
    try {
      const value: unknown = JSON.parse(this.responsesToolsInput.value.trim() || "[]");
      if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item) || typeof item.type !== "string" || !item.type.trim())) {
        throw new Error("Enter a JSON array of tools, each with a type.");
      }
      this.responsesToolsInput.setCustomValidity("");
      return true;
    } catch (error) {
      this.responsesToolsInput.setCustomValidity(error instanceof SyntaxError ? "Hosted tools must be valid JSON." : String((error as Error).message));
      return false;
    }
  }

  private syncResponsesToolToggles(): void {
    const tools = normalizeLlmProviderOptions({ responsesTools: JSON.parse(this.responsesToolsInput.value.trim() || "[]") }).responsesTools ?? [];
    for (const [input, types] of [
      [this.responsesWebSearchToggle, ["web_search", "web_search_preview"]],
      [this.responsesCodeExecutionToggle, ["code_interpreter"]],
      [this.responsesImageGenerationToggle, ["image_generation"]],
    ] as const) {
      input.checked = tools.some((tool) => (types as readonly string[]).includes(String(tool.type)));
      syncSwitchAria(input);
    }
  }

  private setResponsesToolEnabled(type: "web_search" | "code_interpreter" | "image_generation", input: HTMLInputElement): void {
    if (!this.validateResponsesTools()) {
      input.checked = !input.checked;
      syncSwitchAria(input);
      this.responsesToolsInput.reportValidity();
      return;
    }
    const tools = normalizeLlmProviderOptions({ responsesTools: JSON.parse(this.responsesToolsInput.value.trim() || "[]") }).responsesTools ?? [];
    const matches = (tool: { type?: unknown }): boolean => tool.type === type || (type === "web_search" && tool.type === "web_search_preview");
    const next = input.checked
      ? tools.some(matches) ? tools : [...tools, type === "code_interpreter" ? { type, container: { type: "auto" } } : { type }]
      : tools.filter((tool) => !matches(tool));
    this.responsesToolsInput.value = JSON.stringify(next, null, 2);
    this.syncResponsesToolToggles();
    // Reuse the existing controller's JSON autosave path.
    this.responsesToolsInput.dispatchEvent(new Event("input", { bubbles: true }));
  }

  setApiKeyConfigured(configured: boolean): void {
    if (this.selectedProviderId) {
      this.apiKeyConfiguredByProviderId[this.selectedProviderId] = configured;
    }
    this.apiKeyStatus.replaceChildren();
    const badge = document.createElement("span");
    badge.className = `setting-key-badge ${configured ? "is-ok" : "is-missing"}`;
    badge.append(
      createLucideIcon(KeyRound, { size: 14 }),
      document.createTextNode(
        configured ? "Saved securely" : "Not set",
      ),
    );
    this.apiKeyStatus.append(badge);
    this.syncBusy();
  }

  getSelectedProviderId(): string {
    return this.selectedProviderId;
  }

  getProvidersDraft(): SettingProviderForm[] {
    this.commitSelectedDetailToModel();
    return this.providers.map((p) => ({ ...p }));
  }

  getActiveProviderId(): string {
    return this.activeProviderId;
  }

  setProvidersLocal(
    providers: SettingProviderForm[],
    selectedId: string,
    activeId: string,
  ): void {
    this.providers = providers.map((p) => ({ ...p }));
    this.selectedProviderId = selectedId;
    this.activeProviderId = activeId;
    this.renderProviderList();
    this.fillSelectedDetail();
  }

  /** Re-render the profile list without resetting the detail editor fields. */
  refreshProviderList(): void {
    this.renderProviderList();
  }

  /**
   * Pointer drag-to-reorder for the providers list, bound once on the list
   * container (rows are rebuilt freely). A press that travels past the
   * threshold lifts a ghost copy of the row; sibling rows glide aside to
   * open the target slot; release commits the new order.
   */
  private bindProviderDragReorder(): void {
    if (this.providerDragBound) return;
    this.providerDragBound = true;
    this.providerListEl.addEventListener(
      "pointerdown",
      this.handleProviderListPointerDown,
    );
    // Capture phase so the swallow happens before row click handlers run.
    this.providerListEl.addEventListener(
      "click",
      (event) => {
        if (!this.suppressNextRowClick) return;
        this.suppressNextRowClick = false;
        event.preventDefault();
        event.stopPropagation();
      },
      true,
    );
  }

  private readonly handleProviderListPointerDown = (
    event: PointerEvent,
  ): void => {
    if (!event.isPrimary || event.button !== 0) return;
    if (this.providers.length < 2 || this.providerDrag) return;
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLElement>(".setting-provider-row");
    if (!row) return;
    const rows = Array.from(
      this.providerListEl.querySelectorAll<HTMLElement>(
        ".setting-provider-row",
      ),
    );
    const sourceIndex = rows.indexOf(row);
    if (sourceIndex < 0) return;
    const rect = row.getBoundingClientRect();
    const listTop = this.providerListEl.getBoundingClientRect().top;
    const scrollTop = this.providerListEl.scrollTop;
    this.providerDrag = {
      pointerId: event.pointerId,
      sourceRow: row,
      sourceIndex,
      rows,
      geometry: rows.map((el) => {
        const r = el.getBoundingClientRect();
        return {
          top: r.top - listTop + scrollTop,
          height: r.height,
        };
      }),
      stepPx: rows[0]!.getBoundingClientRect().height + PROVIDER_ROW_GAP_PX,
      startX: event.clientX,
      startY: event.clientY,
      grabOffsetY: event.clientY - rect.top,
      started: false,
      insertIndex: sourceIndex,
      ghost: null,
      frame: null,
      lastClientY: event.clientY,
    };
    window.addEventListener("pointermove", this.handleProviderDragMove);
    window.addEventListener("pointerup", this.handleProviderDragEnd);
    window.addEventListener("pointercancel", this.handleProviderDragCancel);
    window.addEventListener("keydown", this.handleProviderDragKeydown, true);
    // Losing the window mid-gesture must never strand the ghost card.
    window.addEventListener("blur", this.handleWindowBlurDuringDrag);
  };

  private readonly handleWindowBlurDuringDrag = (): void => {
    const drag = this.providerDrag;
    if (!drag) return;
    this.finishProviderDrag(drag, false);
  };

  private readonly handleProviderDragMove = (event: PointerEvent): void => {
    const drag = this.providerDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.started) {
      const dist = Math.hypot(
        event.clientX - drag.startX,
        event.clientY - drag.startY,
      );
      if (dist < PROVIDER_DRAG_START_THRESHOLD_PX) return;
      this.beginProviderDragVisual(drag);
    }
    drag.lastClientY = event.clientY;
  };

  private readonly handleProviderDragEnd = (event: PointerEvent): void => {
    const drag = this.providerDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = drag.started && drag.insertIndex !== drag.sourceIndex;
    this.finishProviderDrag(drag, moved);
  };

  private readonly handleProviderDragCancel = (event: PointerEvent): void => {
    const drag = this.providerDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.finishProviderDrag(drag, false);
  };

  private readonly handleProviderDragKeydown = (
    event: KeyboardEvent,
  ): void => {
    if (!this.providerDrag || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.finishProviderDrag(this.providerDrag, false);
  };

  /** Lift the ghost card and enter the animated drag mode. */
  private beginProviderDragVisual(drag: ProviderDragState): void {
    drag.started = true;
    const rect = drag.sourceRow.getBoundingClientRect();
    const ghost = drag.sourceRow.cloneNode(true) as HTMLElement;
    ghost.classList.add("is-drag-ghost");
    ghost.removeAttribute("role");
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    document.body.append(ghost);
    drag.ghost = ghost;
    drag.sourceRow.classList.add("is-drag-source");
    document.body.classList.add("provider-drag-active");
    drag.frame = requestAnimationFrame(this.tickProviderDrag);
  }

  private readonly tickProviderDrag = (): void => {
    const drag = this.providerDrag;
    if (!drag?.started) return;
    // An external re-render replaced the row nodes — abort safely.
    if (!drag.sourceRow.isConnected) {
      this.finishProviderDrag(drag, false);
      return;
    }
    this.applyProviderAutoScroll(drag);
    this.updateProviderDragPosition(drag);
    drag.frame = requestAnimationFrame(this.tickProviderDrag);
  };

  /** Nudge the provider scroller while the pointer rides its edges. */
  private applyProviderAutoScroll(drag: ProviderDragState): void {
    const el = this.providerListEl;
    if (el.scrollHeight <= el.clientHeight) return;
    const rect = el.getBoundingClientRect();
    let ratio = 0;
    const distTop = drag.lastClientY - rect.top;
    const distBottom = rect.bottom - drag.lastClientY;
    if (distTop >= 0 && distTop < PROVIDER_EDGE_SCROLL_PX) {
      ratio = -(PROVIDER_EDGE_SCROLL_PX - distTop) / PROVIDER_EDGE_SCROLL_PX;
    } else if (
      distBottom >= 0 &&
      distBottom < PROVIDER_EDGE_SCROLL_PX
    ) {
      ratio =
        (PROVIDER_EDGE_SCROLL_PX - distBottom) / PROVIDER_EDGE_SCROLL_PX;
    }
    if (ratio === 0) return;
    const maxScroll = el.scrollHeight - el.clientHeight;
    const next = Math.min(
      maxScroll,
      Math.max(0, el.scrollTop + ratio * PROVIDER_EDGE_SCROLL_SPEED_PX),
    );
    el.scrollTop = next;
  }

  /**
   * Follow the pointer with the ghost and shift siblings into the slots
   * around the current insertion index. Geometry stays in content-box
   * coordinates so scrolling never desyncs from the cached rects.
   */
  private updateProviderDragPosition(drag: ProviderDragState): void {
    if (!drag.ghost) return;
    const dy = drag.lastClientY - drag.startY;
    drag.ghost.style.transform = `translate3d(0, ${dy.toFixed(1)}px, 0) scale(1.02)`;

    const listTop = this.providerListEl.getBoundingClientRect().top;
    const pointerContentY =
      drag.lastClientY - listTop + this.providerListEl.scrollTop;
    let rank = 0;
    for (let d = 0; d < drag.rows.length; d++) {
      if (d === drag.sourceIndex) continue;
      const g = drag.geometry[d]!;
      if (pointerContentY > g.top + g.height / 2) rank++;
    }
    const insertIndex = Math.min(rank, drag.rows.length - 1);
    if (insertIndex !== drag.insertIndex) {
      drag.insertIndex = insertIndex;
      this.applyProviderSlotShifts(drag);
    }
  }

  /**
   * Glide non-dragged rows toward their would-be slots. With others ranked
   * `r` (source removed), each shifts by +step when it must fall below the
   * opening and −step when it must rise above it:
   * offset(r) = [r >= insertIndex] − [r >= sourceIndex].
   */
  private applyProviderSlotShifts(drag: ProviderDragState): void {
    const s = drag.sourceIndex;
    for (let d = 0; d < drag.rows.length; d++) {
      if (d === s) continue;
      const r = d < s ? d : d - 1;
      const dir = (r >= drag.insertIndex ? 1 : 0) - (r >= s ? 1 : 0);
      const row = drag.rows[d]!;
      row.style.transform =
        dir === 0 ? "" : `translate3d(0, ${(dir * drag.stepPx).toFixed(1)}px, 0)`;
    }
  }

  /** Tear down drag visuals; commit splices the draft order when requested. */
  private finishProviderDrag(
    drag: ProviderDragState,
    commit: boolean,
  ): void {
    this.providerDrag = null;
    if (drag.frame !== null) cancelAnimationFrame(drag.frame);
    window.removeEventListener("pointermove", this.handleProviderDragMove);
    window.removeEventListener("pointerup", this.handleProviderDragEnd);
    window.removeEventListener("pointercancel", this.handleProviderDragCancel);
    window.removeEventListener(
      "keydown",
      this.handleProviderDragKeydown,
      true,
    );
    window.removeEventListener("blur", this.handleWindowBlurDuringDrag);
    drag.ghost?.remove();
    drag.sourceRow.classList.remove("is-drag-source");
    for (const row of drag.rows) row.style.transform = "";
    document.body.classList.remove("provider-drag-active");
    if (drag.started) {
      this.suppressNextRowClick = true;
      window.setTimeout(() => {
        this.suppressNextRowClick = false;
      }, 400);
    }
    if (!commit) return;

    const moved = this.providers[drag.sourceIndex];
    if (!moved) {
      this.renderProviderList();
      return;
    }
    const others = this.providers.filter(
      (_, i) => i !== drag.sourceIndex,
    );
    const next: SettingProviderForm[] = [];
    let oi = 0;
    for (let slot = 0; slot < this.providers.length; slot++) {
      next.push(slot === drag.insertIndex ? moved : others[oi++]!);
    }
    this.providers = next;
    this.renderProviderList();
    this.onProviderOrderChange?.();
  }

  getApiKeyDraft(): string {
    return this.apiKeyInput.value;
  }

  clearApiKeyDraft(): void {
    this.apiKeyInput.value = "";
  }

  getPermissionsValues(): {
    fullPermissionsDefault: boolean;
    autoSkillSummarizeDefault: boolean;
  } {
    return {
      fullPermissionsDefault: this.fullPermissionsToggle.checked,
      autoSkillSummarizeDefault: this.autoSkillSummarizeToggle.checked,
    };
  }

  /** Shell Safe Mode controls live outside settings.json (tools.json). */
  getShellSafetyValues(): { enabled: boolean; fatalPolicy: "ask" | "block" } {
    return {
      enabled: this.shellSafetyToggle.checked,
      fatalPolicy:
        this.shellSafetyPolicySelect.value === "block" ? "block" : "ask",
    };
  }

  setShellSafety(options: {
    enabled: boolean;
    fatalPolicy: "ask" | "block";
  }): void {
    this.shellSafetyToggle.checked = options.enabled;
    syncSwitchAria(this.shellSafetyToggle);
    this.shellSafetyPolicySelect.value = options.fatalPolicy;
  }

  getComposerDefaultsValues(): {
    composerInfinite: boolean;
    reasoningEffort: ReasoningEffortLevel;
  } {
    return {
      composerInfinite: this.newTaskInfiniteToggle.checked,
      reasoningEffort: this.newTaskReasoningSeg.getLevel(),
    };
  }

  getAppearanceValues(): {
    themeId: ThemeId;
    accentColor: string;
    uiFontScale: number;
    chatFontScale: number;
  } {
    const value = this.themeSelect.value;
    return {
      themeId: (THEMES.some((t) => t.id === value) ? value : "dark") as ThemeId,
      accentColor: this.accentPicker.value,
      uiFontScale: parseFloat(this.uiFontScaleSelect.value) || 1,
      chatFontScale: parseFloat(this.chatFontScaleSelect.value) || 1,
    };
  }

  getAgentValues(): {
    contextLimitTokens: number;
    compactTriggerRatio: number;
    iterationProtectRawIterationCount: number;
    iterationProtectTokenRatio: number;
    maxModelIterations: number;
    maxTurnTokens: number;
    llmRequestTimeoutMs: number;
    toolStatsEnabled: boolean;
    environmentContext: SettingFormState["environmentContext"];
  } {
    return {
      contextLimitTokens: Number(this.contextLimitInput.value),
      compactTriggerRatio: Number(this.compactTriggerRatioInput.value),
      iterationProtectRawIterationCount: Number(
        this.iterationProtectRawIterationCountInput.value,
      ),
      iterationProtectTokenRatio: Number(this.iterationProtectTokenRatioInput.value),
      maxModelIterations: Number(this.maxRoundsInput.value),
      maxTurnTokens: Number(this.maxTurnTokensInput.value),
      llmRequestTimeoutMs: Math.round(
        Number(this.llmRequestTimeoutInput.value) * 1000,
      ),
      toolStatsEnabled: this.toolStatsEnabledToggle.checked,
      environmentContext: {
        workspace: this.envWorkspaceToggle.checked,
        timezone: this.envTimezoneToggle.checked,
        locale: this.envLocaleToggle.checked,
        location: this.envLocationToggle.checked,
        repository: this.envRepositoryToggle.checked,
      },
    };
  }

  getMemoryValues(): {
    userMemoryAutoExtract: boolean;
    userMemoryProfile: string;
  } {
    return {
      userMemoryAutoExtract: this.userMemoryAutoExtractToggle.checked,
      userMemoryProfile: this.userMemoryProfileInput.value,
    };
  }

  setUserMemoryProfile(profile: string): void {
    this.userMemoryProfileInput.value = profile;
  }

  private createEnvToggleRow(
    title: string,
    hint: string,
    toggle: HTMLInputElement,
  ): HTMLElement {
    const row = document.createElement("label");
    row.className = "setting-toggle-row";
    const copy = document.createElement("div");
    copy.className = "setting-toggle-copy";
    const label = document.createElement("span");
    label.className = "setting-field-label";
    label.textContent = title;
    const hintEl = document.createElement("span");
    hintEl.className = "setting-field-hint";
    hintEl.textContent = hint;
    copy.append(label, hintEl);
    row.append(copy, toggle);
    return row;
  }

  /** Update the per-category usage rows on the Storage card. */
  setStorageUsage(usage: StorageUsage | null): void {
    const entries: Record<string, number> = usage
      ? {
          Logs: usage.logs.bytes,
          Caches: usage.caches.bytes,
          Backups: usage.backup.bytes,
          Temp: usage.tmp.bytes,
        }
      : {};
    for (const row of this.storageUsageRows) {
      const bytes = entries[row.label];
      row.value.textContent = bytes === undefined ? "—" : formatBytes(bytes);
    }
  }

  setCardStatus(
    card: SettingCardId,
    message: string | null,
    kind: "ok" | "error" | "info" = "info",
  ): void {
    const el = this.statusByCard[card];
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      el.className = "setting-card-status";
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.className = `setting-card-status is-${kind}`;
  }

  setBusy(card: SettingCardId | null): void {
    this.busyCard = card;
    this.syncBusy();
  }

  private syncBusy(): void {
    const providersBusy = this.busyCard === "providers";
    const visionBusy = this.busyCard === "vision";
    const completionBusy = this.busyCard === "completion";
    const imageGenBusy = this.busyCard === "imagegen";
    const objectStorageBusy = this.busyCard === "objectstorage";
    const safetyBusy = this.busyCard === "safety";
    const agentBusy = this.busyCard === "agent";
    const userBusy = this.busyCard === "user";
    const storageBusy = this.busyCard === "storage";
    const backupBusy = this.busyCard === "backup";
    const keyConfigured =
      this.apiKeyConfiguredByProviderId[this.selectedProviderId] === true;

    this.addProviderButton.disabled = providersBusy;
    this.deleteProviderButton.disabled =
      providersBusy || this.providers.length <= 1;
    this.setDefaultProviderButton.disabled =
      providersBusy ||
      !this.selectedProviderId ||
      this.selectedProviderId === this.activeProviderId;
    this.clearApiKeyButton.disabled = providersBusy || !keyConfigured;
    this.visionProviderSelect.disabled = visionBusy;
    this.completionProviderSelect.disabled = completionBusy;
    const imageGenKeyConfigured =
      this.imageGenApiKeyConfiguredByProviderId[
        this.selectedImageGenProviderId
      ] === true;
    this.addImageGenProviderButton.disabled = imageGenBusy;
    this.deleteImageGenProviderButton.disabled =
      imageGenBusy || this.imageGenProviders.length === 0;
    this.setActiveImageGenProviderButton.disabled =
      imageGenBusy ||
      !this.selectedImageGenProviderId ||
      this.selectedImageGenProviderId === this.activeImageGenProviderId;
    this.clearImageGenApiKeyButton.disabled =
      imageGenBusy || !imageGenKeyConfigured;
    this.clearObjectStorageButton.disabled = objectStorageBusy;
    this.clearObjectStorageSecretButton.disabled =
      objectStorageBusy || !this.objectStorageSecretConfigured;
    this.objectStorageTestButton.disabled = objectStorageBusy;
    this.shellSafetyToggle.disabled = safetyBusy;
    this.shellSafetyPolicySelect.disabled = safetyBusy;
    this.toolStatsEnabledToggle.disabled = agentBusy;
    this.envWorkspaceToggle.disabled = agentBusy;
    this.envTimezoneToggle.disabled = agentBusy;
    this.envLocaleToggle.disabled = agentBusy;
    this.envLocationToggle.disabled = agentBusy;
    this.envRepositoryToggle.disabled = agentBusy;
    this.userMemoryAutoExtractToggle.disabled = userBusy;
    this.userMemoryProfileInput.disabled = userBusy;
    this.resetUserPromptButton.disabled = userBusy;
    this.clearMemoryButton.disabled = userBusy;
    this.cleanupButton.disabled = storageBusy;
    this.exportBackupButton.disabled = backupBusy;
    this.chooseBackupButton.disabled = backupBusy;
    this.applyBackupButton.disabled = backupBusy;

    // A pending operation keeps its action color. Unavailable actions (no
    // stored key, no selected profile, or already active) stay neutral.
    const actionBusy: [HTMLButtonElement, boolean][] = [
      [this.addProviderButton, providersBusy],
      [this.deleteProviderButton, providersBusy && this.providers.length > 1],
      [
        this.setDefaultProviderButton,
        providersBusy && !!this.selectedProviderId &&
          this.selectedProviderId !== this.activeProviderId,
      ],
      [this.clearApiKeyButton, providersBusy && keyConfigured],
      [this.addImageGenProviderButton, imageGenBusy],
      [
        this.deleteImageGenProviderButton,
        imageGenBusy && this.imageGenProviders.length > 0,
      ],
      [
        this.setActiveImageGenProviderButton,
        imageGenBusy && !!this.selectedImageGenProviderId &&
          this.selectedImageGenProviderId !== this.activeImageGenProviderId,
      ],
      [this.clearImageGenApiKeyButton, imageGenBusy && imageGenKeyConfigured],
      [this.clearObjectStorageButton, objectStorageBusy],
      [
        this.clearObjectStorageSecretButton,
        objectStorageBusy && this.objectStorageSecretConfigured,
      ],
      [this.resetUserPromptButton, userBusy],
      [this.clearMemoryButton, userBusy],
      [this.cleanupButton, storageBusy],
      [this.applyBackupButton, backupBusy && !this.applyBackupButton.hidden],
    ];
    for (const [button, busy] of actionBusy) {
      button.setAttribute("aria-busy", String(busy));
    }
  }
}
