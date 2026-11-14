import { createLucideIcon } from "../originalIcons.js";
import { createBrandIcon, matchModelBrand } from "../modelBrand.js";
import { mergeContextUsage, type ContextUsage } from "../contextUsage.js";
import { ComposerSendButtonView } from "./ComposerSendButtonView.js";
import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleQuestionMark,
  FastForward,
  File as FileIcon,
  FileAudio,
  FileCode,
  FileImage,
  FileVideo,
  Image as ImageIcon,
  Infinity as InfinityIcon,
  Lock,
  Mic,
  NotebookPen,
  Paperclip,
  Plus,
  Shield,
  ShieldOff,
  Sparkle,
  Sparkles,
  Square,
  X,
  Zap,
  type IconNode,
  Workflow,
} from "lucide";
import { VoiceWaveform } from "./VoiceWaveform.js";
import { enabledGraphEntries } from "./enabledGraphEntries.js";
import {
  EffortSegView,
  type ReasoningEffortLevel,
} from "../effortSeg/EffortSegView.js";
import {
  DEFAULT_CUSTOM_GRAPH_COLOR,
  composerAccentColor,
  normalizeHexColor,
} from "./composerAccent.js";
import {
  filterSlashCommands,
  matchSlashCommand,
  type SlashCommand,
} from "./slashCommands.js";
import { isImeComposing } from "../ime.js";
import "./task-composer.css";

/** Composer run mode shown in the plus menu. */
export type ComposerRunMode = "agent" | "ask" | "plan" | "custom";

/**
 * Built-in Auto V2 graph — same id shape as the main-process
 * builtinGraphId("react_v2") (src/agent/fsm/graphLibrary/manager.ts).
 * Presented as a top-level run-mode row directly under Auto instead of
 * living inside the Custom graphs flyout; selecting it still routes
 * through the custom graph path (runMode "custom" + the builtin id).
 */
export const AUTO_V2_COMPOSER_GRAPH = {
  id: "builtin:react_v2",
  name: "Auto V2",
  color: DEFAULT_CUSTOM_GRAPH_COLOR,
} as const;

/** Builtin entries are hoisted to top-level rows — never listed in the flyout. */
const isBuiltinComposerGraphId = (id: string): boolean =>
  id.startsWith("builtin:");

export type TaskComposerOptions = {
  placeholder: string;
  ariaLabel: string;
  /** Extra class on the composer root (e.g. layout variant). */
  className?: string;
  /** Optional content above the input, sharing the composer's outer frame. */
  header?: HTMLElement;
  /**
   * Minimum visible rows while empty / short. Default 1.
   * Grows with content up to {@link TASK_COMPOSER_MAX_ROWS}.
   */
  rows?: number;
};

/** Max visible lines before the textarea scrolls. */
export const TASK_COMPOSER_MAX_ROWS = 5;

export type ComposerProviderOption = {
  id: string;
  name: string;
  modelId: string;
  baseUrl?: string;
};

export type ComposerAttachmentChip = {
  id: string;
  name: string;
  kind: string;
  sizeBytes?: number;
};

type ModeMenuItem = {
  mode: ComposerRunMode;
  button: HTMLButtonElement;
  check: HTMLElement;
};

type PermissionMenuItem = {
  full: boolean;
  button: HTMLButtonElement;
};

type CheckboxMenuItem = {
  button: HTMLButtonElement;
  check: HTMLElement;
};

/**
 * Shared prompt composer — plus menu / provider switcher / send ring.
 */
export class TaskComposerView {
  readonly root: HTMLElement;
  readonly textarea: HTMLTextAreaElement;
  readonly plusButton: HTMLButtonElement;
  readonly plusMenu: HTMLElement;
  /** Reasoning-effort segmented picker inside the provider dropdown (top). */
  readonly reasoningSeg: EffortSegView;
  /** Image attach action inside the plus menu. */
  readonly imagesButton: HTMLButtonElement;
  /** File path attach action inside the plus menu. */
  readonly attachmentsButton: HTMLButtonElement;
  readonly providerButton: HTMLButtonElement;
  readonly providerMenu: HTMLElement;
  readonly sendWrap: HTMLElement;
  readonly sendButton: HTMLButtonElement;
  private readonly attachmentsStrip: HTMLElement;
  /** Grid wrapper that collapses textarea + attachments in voice mode. */
  private readonly collapseWrap: HTMLElement;
  private readonly collapseInner: HTMLElement;
  /** Flexible toolbar middle — waveform + status while recording. */
  private readonly voiceStrip: HTMLElement;
  private readonly voiceStatus: HTMLElement;
  private readonly voiceWaveform: VoiceWaveform;
  private readonly sendControl: ComposerSendButtonView;
  private readonly providerLabel: HTMLElement;
  /** Pill on the provider button showing the active effort level. */
  private readonly providerEffortChip: HTMLElement;
  private readonly providerMenuList: HTMLElement;
  /** Read-only banner shown at the top of the provider menu while a turn runs. */
  private readonly providerLockedHint: HTMLElement;
  private readonly reasoningRow: HTMLElement;
  private readonly plusWrap: HTMLElement;
  private readonly providerWrap: HTMLElement;
  private readonly modeItems: ModeMenuItem[];
  /** Top-level Auto V2 row (built-in react_v2), directly under Auto. */
  private readonly autoV2Button: HTMLButtonElement;
  private readonly customGraphsWrap: HTMLElement;
  private readonly customGraphsButton: HTMLButtonElement;
  private readonly customGraphsCheck: HTMLElement;
  private readonly customGraphsSubmenu: HTMLElement;
  private customGraphId: string | null = null;
  private customGraphName: string | null = null;
  /** Stored identity color of the selected custom graph (null → default). */
  private customGraphColor: string | null = null;
  private customSubmenuCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private onCustomGraphSelect:
    | ((graph: { id: string; name: string; color?: string | undefined }) => void)
    | null = null;
  /** Slash command autocomplete popup above the composer. */
  private readonly slashMenu: HTMLElement;
  private slashMenuOpen = false;
  private slashMenuCommands: SlashCommand[] = [];
  /** Optional popup scope (e.g. New Task shows only /opt); null = registry. */
  private slashCommandScope: Set<string> | null = null;
  private slashMenuItems: HTMLButtonElement[] = [];
  private slashMenuSelected = -1;
  private slashMenuCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private onSlashCommand: ((command: SlashCommand) => boolean) | null = null;
  /** Infinite budget switch row inside the provider menu (any run mode). */
  private readonly infiniteRow: HTMLElement;
  /** Switch button on the Infinite row (same style as Reasoning Max). */
  private readonly infiniteSwitchButton: HTMLButtonElement;
  private readonly permissionItems: PermissionMenuItem[];
  private readonly autoSkillSummarizeItem: CheckboxMenuItem;
  private readonly handoffItem: CheckboxMenuItem;
  private readonly healthDot: HTMLSpanElement;
  private readonly sendIcon = createLucideIcon(ArrowUp, { size: 16 });
  private readonly stopIcon = createLucideIcon(Square, { size: 12 });
  private readonly micIcon = createLucideIcon(Mic, { size: 16 });
  private stopMode = false;
  private voiceMode = false;
  private voiceRecording = false;
  /** True while a turn is in flight (ripple); independent of Stop vs Send. */
  private turnRunning = false;
  private steerSendLabel = false;
  private providers: ComposerProviderOption[] = [];
  private activeProviderId = "";
  private runMode: ComposerRunMode = "agent";
  private infiniteEnabled = false;
  private reasoningEffort: ReasoningEffortLevel = "low";
  private fullPermissions = false;
  private autoSkillSummarize = false;
  private handoffEnabled = false;
  private onProviderSelect: ((providerId: string) => void) | null = null;
  private onRunModeSelect: ((mode: ComposerRunMode) => void) | null = null;
  private onInfiniteSelect: ((enabled: boolean) => void) | null = null;
  private onReasoningEffortSelect:
    | ((level: ReasoningEffortLevel) => void)
    | null = null;
  private onPermissionsSelect: ((fullPermissions: boolean) => void) | null =
    null;
  private onAutoSkillSummarizeSelect: ((enabled: boolean) => void) | null =
    null;
  private onHandoffSelect: ((enabled: boolean) => void) | null = null;
  private onRemoveAttachment: ((id: string) => void) | null = null;
  private providerMenuOpen = false;
  private plusMenuOpen = false;
  private plusMenuCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private providerMenuCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private healthOk = false;
  private displayedContextUsage: ContextUsage = {
    usedTokens: 0,
    limitTokens: 128_000,
  };
  private readonly minRows: number;
  private resizeObserver: ResizeObserver | null = null;
  private initialResizeRafId: number | null = null;
  private lastComposerWidth = -1;
  private readonly documentClickHandler = (event: MouseEvent): void => {
    const target = event.target as Node;
    if (this.providerMenuOpen && !this.providerWrap.contains(target)) {
      this.setProviderMenuOpen(false);
    }
    if (this.plusMenuOpen && !this.plusWrap.contains(target)) {
      this.setPlusMenuOpen(false);
    }
  };

  constructor(options: TaskComposerOptions) {
    this.root = document.createElement("div");
    this.root.className = ["task-composer", options.className]
      .filter(Boolean)
      .join(" ");

    this.attachmentsStrip = document.createElement("div");
    this.attachmentsStrip.className = "composer-attachments";
    this.attachmentsStrip.hidden = true;
    this.attachmentsStrip.setAttribute("aria-label", "Attachments");

    this.textarea = document.createElement("textarea");
    this.textarea.className = "task-composer-input";
    this.minRows = Math.max(1, Math.min(options.rows ?? 1, TASK_COMPOSER_MAX_ROWS));
    this.textarea.rows = this.minRows;
    this.textarea.placeholder = options.placeholder;
    this.textarea.setAttribute("aria-label", options.ariaLabel);

    const toolbar = document.createElement("div");
    toolbar.className = "task-composer-toolbar";

    const left = document.createElement("div");
    left.className = "task-composer-left";

    this.plusWrap = document.createElement("div");
    this.plusWrap.className = "composer-plus-wrap";

    this.plusButton = document.createElement("button");
    this.plusButton.type = "button";
    this.plusButton.className = "composer-round-btn composer-plus-btn";
    this.plusButton.setAttribute("aria-label", "More actions");
    this.plusButton.setAttribute("aria-haspopup", "menu");
    this.plusButton.setAttribute("aria-expanded", "false");
    this.plusButton.append(createLucideIcon(Plus, { size: 16 }));

    this.plusMenu = document.createElement("div");
    this.plusMenu.className = "composer-plus-menu";
    this.plusMenu.setAttribute("role", "menu");
    this.plusMenu.setAttribute("aria-label", "Composer actions");
    this.plusMenu.hidden = true;

    this.modeItems = [
      this.createModeMenuItem(
        "agent",
        "Auto",
        "Auto — ReAct loop with tools",
        Sparkle,
      ),
      this.createModeMenuItem(
        "ask",
        "Ask",
        "Ask mode — read-only Q&A, reasoning off",
        CircleQuestionMark,
      ),
      this.createModeMenuItem(
        "plan",
        "Plan",
        "Plan mode — Plan steps, then execute",
        NotebookPen,
      ),
    ];

    this.autoV2Button = this.createAutoV2MenuItem();

    const customBuilt = this.createCustomGraphsMenuItem();
    this.customGraphsWrap = customBuilt.wrap;
    this.customGraphsButton = customBuilt.button;
    this.customGraphsCheck = customBuilt.check;
    this.customGraphsSubmenu = customBuilt.submenu;

    const modeGroup = document.createElement("div");
    modeGroup.className = "composer-plus-menu-group";
    modeGroup.setAttribute("role", "group");
    modeGroup.setAttribute("aria-label", "Run mode");
    const [autoItem, ...restModeItems] = this.modeItems;
    modeGroup.append(
      autoItem!.button,
      // Auto V2 rides directly under Auto as a first-class run mode.
      this.autoV2Button,
      ...restModeItems.map((item) => item.button),
      this.customGraphsWrap,
    );

    const separator = document.createElement("div");
    separator.className = "composer-plus-menu-separator";
    separator.setAttribute("role", "separator");

    this.imagesButton = this.createPlusAttachMenuItem(
      "Image",
      "Attach images by path",
      ImageIcon,
    );
    this.attachmentsButton = this.createPlusAttachMenuItem(
      "Attachments",
      "Attach files by path",
      Paperclip,
    );

    const separatorPermissions = document.createElement("div");
    separatorPermissions.className = "composer-plus-menu-separator";
    separatorPermissions.setAttribute("role", "separator");

    this.permissionItems = [
      this.createPermissionMenuItem(
        false,
        "Safe mode",
        "Safe mode — level-1 tools require Bypass permissions",
        Shield,
      ),
      this.createPermissionMenuItem(
        true,
        "Bypass permissions",
        "Bypass permissions — level-1 tools allowed for this process",
        ShieldOff,
      ),
    ];
    const permissionsGroup = document.createElement("div");
    permissionsGroup.className = "composer-plus-menu-group";
    permissionsGroup.setAttribute("role", "group");
    permissionsGroup.setAttribute("aria-label", "Permissions");
    for (const item of this.permissionItems) {
      permissionsGroup.append(item.button);
    }

    const separatorSkill = document.createElement("div");
    separatorSkill.className = "composer-plus-menu-separator";
    separatorSkill.setAttribute("role", "separator");

    this.autoSkillSummarizeItem = this.createCheckboxMenuItem(
      "Self-learning",
      "After eligible turns, distill a reusable skill if worth keeping (requires Bypass permissions)",
      Sparkles,
      () => {
        this.onAutoSkillSummarizeSelect?.(!this.autoSkillSummarize);
      },
    );

    // Session-scoped gate — hidden until a controller wires a live session
    // (New Task has no session row to pin onto).
    this.handoffItem = this.createCheckboxMenuItem(
      "Turn Handoff",
      "When this turn ends, auto-start the next one with the chosen FSM Graph",
      FastForward,
      () => {
        this.onHandoffSelect?.(!this.handoffEnabled);
      },
    );
    this.handoffItem.button.hidden = true;

    this.plusMenu.append(
      modeGroup,
      separator,
      this.imagesButton,
      this.attachmentsButton,
      separatorPermissions,
      permissionsGroup,
      separatorSkill,
      this.autoSkillSummarizeItem.button,
      this.handoffItem.button,
    );
    this.plusWrap.append(this.plusButton, this.plusMenu);

    left.append(this.plusWrap);

    const right = document.createElement("div");
    right.className = "task-composer-right";

    this.providerWrap = document.createElement("div");
    this.providerWrap.className = "composer-provider-wrap";

    this.providerButton = document.createElement("button");
    this.providerButton.type = "button";
    this.providerButton.className = "composer-provider-btn is-down";
    this.providerButton.setAttribute("aria-haspopup", "listbox");
    this.providerButton.setAttribute("aria-expanded", "false");
    this.providerButton.setAttribute("aria-label", "Select LLM provider");
    this.healthDot = document.createElement("span");
    this.healthDot.className = "composer-provider-health";
    this.healthDot.setAttribute("aria-hidden", "true");
    this.providerLabel = document.createElement("span");
    this.providerLabel.className = "composer-provider-label";
    this.providerLabel.textContent = "Default";
    this.providerEffortChip = document.createElement("span");
    this.providerEffortChip.className = "composer-provider-effort-chip";
    this.providerEffortChip.setAttribute("aria-hidden", "true");
    this.providerEffortChip.hidden = true;
    this.providerButton.append(
      this.healthDot,
      this.providerLabel,
      this.providerEffortChip,
      createLucideIcon(ChevronDown, { size: 14 }),
    );

    this.providerMenu = document.createElement("div");
    this.providerMenu.className = "composer-provider-menu";
    this.providerMenu.hidden = true;

    this.reasoningRow = document.createElement("div");
    this.reasoningRow.className = "composer-reasoning-effort-row";
    const reasoningIcon = document.createElement("span");
    reasoningIcon.className = "composer-row-icon";
    reasoningIcon.setAttribute("aria-hidden", "true");
    reasoningIcon.append(createLucideIcon(Zap, { size: 14 }));
    const reasoningLabel = document.createElement("span");
    reasoningLabel.className = "composer-reasoning-effort-label";
    reasoningLabel.textContent = "Effort";
    const reasoningHead = document.createElement("span");
    reasoningHead.className = "composer-row-head";
    reasoningHead.append(reasoningIcon, reasoningLabel);
    this.reasoningSeg = new EffortSegView({
      onSelect: (level) => {
        this.onReasoningEffortSelect?.(level);
      },
      ariaLabel: "Effort",
    });
    this.reasoningRow.append(reasoningHead, this.reasoningSeg.root);

    this.infiniteRow = document.createElement("div");
    this.infiniteRow.className = "composer-infinite-row";
    const infiniteIcon = document.createElement("span");
    infiniteIcon.className = "composer-row-icon";
    infiniteIcon.setAttribute("aria-hidden", "true");
    infiniteIcon.append(createLucideIcon(InfinityIcon, { size: 14 }));
    const infiniteLabel = document.createElement("span");
    infiniteLabel.className = "composer-infinite-label";
    infiniteLabel.textContent = "Infinite";
    const infiniteHead = document.createElement("span");
    infiniteHead.className = "composer-row-head";
    infiniteHead.append(infiniteIcon, infiniteLabel);
    this.infiniteSwitchButton = document.createElement("button");
    this.infiniteSwitchButton.type = "button";
    this.infiniteSwitchButton.className = "composer-switch";
    this.infiniteSwitchButton.setAttribute("role", "switch");
    this.infiniteSwitchButton.setAttribute("aria-checked", "false");
    this.infiniteSwitchButton.setAttribute("aria-label", "Infinite");
    this.infiniteSwitchButton.title =
      "Infinite — no round or token limits in any mode (⌘⇧M toggles Infinite + Effort MAX)";
    const infiniteThumb = document.createElement("span");
    infiniteThumb.className = "composer-switch-thumb";
    infiniteThumb.setAttribute("aria-hidden", "true");
    this.infiniteSwitchButton.append(infiniteThumb);
    this.infiniteRow.append(infiniteHead, this.infiniteSwitchButton);
    this.infiniteRow.addEventListener("click", (event) => {
      event.stopPropagation();
      if (
        event.target === this.infiniteSwitchButton ||
        this.infiniteSwitchButton.contains(event.target as Node)
      ) {
        return;
      }
      this.infiniteSwitchButton.click();
    });
    this.infiniteSwitchButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.turnRunning) return;
      this.onInfiniteSelect?.(!this.infiniteEnabled);
    });

    this.providerMenuList = document.createElement("div");
    this.providerMenuList.className = "composer-provider-menu-list";
    this.providerMenuList.setAttribute("role", "listbox");
    this.providerMenuList.setAttribute("aria-label", "LLM providers");

    // Read-only notice — the menu stays inspectable while a turn runs, but
    // provider / effort / Infinite edits are blocked (see setTurnRunning).
    this.providerLockedHint = document.createElement("div");
    this.providerLockedHint.className = "composer-provider-locked-hint";
    this.providerLockedHint.setAttribute("role", "status");
    this.providerLockedHint.hidden = true;
    const lockedIcon = document.createElement("span");
    lockedIcon.className = "composer-row-icon";
    lockedIcon.setAttribute("aria-hidden", "true");
    lockedIcon.append(createLucideIcon(Lock, { size: 12 }));
    const lockedText = document.createElement("span");
    lockedText.textContent = "Read-only while running";
    this.providerLockedHint.append(lockedIcon, lockedText);

    this.providerMenu.append(
      this.providerLockedHint,
      this.reasoningRow,
      this.infiniteRow,
      this.providerMenuList,
    );
    this.providerWrap.append(this.providerButton, this.providerMenu);

    this.sendControl = new ComposerSendButtonView();
    this.sendWrap = this.sendControl.root;
    this.sendButton = this.sendControl.button;
    this.sendButton.append(this.sendIcon);
    right.append(this.providerWrap, this.sendWrap);
    this.voiceStrip = document.createElement("div");
    this.voiceStrip.className = "composer-voice-strip";
    this.voiceWaveform = new VoiceWaveform(this.voiceStrip);
    this.voiceStatus = document.createElement("span");
    this.voiceStatus.className = "composer-voice-status";
    this.voiceStatus.hidden = true;
    this.voiceStrip.append(this.voiceStatus);

    this.collapseInner = document.createElement("div");
    this.collapseInner.className = "composer-collapse-inner";
    this.collapseInner.append(this.attachmentsStrip, this.textarea);
    this.collapseWrap = document.createElement("div");
    this.collapseWrap.className = "composer-collapse";
    this.collapseWrap.append(this.collapseInner);

    // Slash command autocomplete — floats above the whole composer
    // (anchored to the root, like the + menu anchors to its wrap).
    this.slashMenu = document.createElement("div");
    this.slashMenu.className = "composer-slash-menu";
    this.slashMenu.setAttribute("role", "listbox");
    this.slashMenu.setAttribute("aria-label", "Slash commands");
    this.slashMenu.hidden = true;

    toolbar.append(left, this.voiceStrip, right);
    if (options.header) {
      const body = document.createElement("div");
      body.className = "task-composer-body";
      body.append(this.collapseWrap, toolbar);
      this.root.classList.add("has-header");
      this.root.append(options.header, body, this.slashMenu);
    } else {
      this.root.append(this.collapseWrap, toolbar, this.slashMenu);
    }

    this.textarea.addEventListener("input", () => {
      this.syncTextareaHeight();
      this.refreshSlashMenu();
    });
    // Width changes (window / sidebar) reflow wrapped lines — remeasure height.
    this.resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(width - this.lastComposerWidth) < 0.5) return;
      this.lastComposerWidth = width;
      this.syncTextareaHeight();
    });
    this.resizeObserver.observe(this.root);
    // First paint after layout so line-height is measurable.
    this.initialResizeRafId = requestAnimationFrame(() => {
      this.initialResizeRafId = null;
      this.syncTextareaHeight();
    });

    this.plusButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setPlusMenuOpen(!this.plusMenuOpen);
    });

    this.providerButton.addEventListener("click", (event) => {
      event.stopPropagation();
      // Turn running: the menu still opens — read-only (setTurnRunning).
      if (this.providerButton.disabled) return;
      this.setProviderMenuOpen(!this.providerMenuOpen);
    });

    document.addEventListener("click", this.documentClickHandler);

    this.textarea.addEventListener("blur", () => {
      this.setSlashMenuOpen(false);
    });

    // Registered in the constructor, i.e. BEFORE any controller listener on
    // the same textarea — so menu keys and slash submission win the key and
    // can stop the normal submit path via stopImmediatePropagation.
    this.textarea.addEventListener("keydown", (event) => {
      if (this.slashMenuOpen && this.handleSlashMenuKeydown(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !isImeComposing(event) &&
        this.trySubmitSlashCommand()
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    });

    // Intercept the send click the same way: registered first, so an exact
    // slash command runs instead of a normal submit / steer.
    this.sendButton.addEventListener("click", (event) => {
      if (this.trySubmitSlashCommand()) {
        event.stopImmediatePropagation();
      }
    });

    this.setComposerRunMode("agent");
    this.setPermissionsEnabled(false);
    this.setAutoSkillSummarizeEnabled(false);
  }

  private createPlusAttachMenuItem(
    labelText: string,
    title: string,
    icon: IconNode,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "composer-plus-menu-item";
    button.setAttribute("role", "menuitem");
    button.title = title;
    button.setAttribute("aria-label", labelText);
    const leading = document.createElement("span");
    leading.className = "composer-plus-menu-item-leading";
    leading.append(createLucideIcon(icon, { size: 16 }));
    const label = document.createElement("span");
    label.className = "composer-plus-menu-item-label";
    label.textContent = labelText;
    button.append(leading, label);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setPlusMenuOpen(false);
    });
    return button;
  }

  private createCheckboxMenuItem(
    label: string,
    tip: string,
    icon: Parameters<typeof createLucideIcon>[0],
    onToggle: () => void,
  ): CheckboxMenuItem {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "composer-plus-menu-item composer-plus-checkbox-item";
    button.setAttribute("role", "menuitemcheckbox");
    button.setAttribute("aria-checked", "false");
    button.title = tip;
    button.setAttribute("aria-label", label);

    const leading = document.createElement("span");
    leading.className = "composer-plus-menu-item-leading";
    leading.append(createLucideIcon(icon, { size: 16 }));

    const text = document.createElement("span");
    text.className = "composer-plus-menu-item-label";
    text.textContent = label;

    const check = document.createElement("span");
    check.className = "composer-plus-menu-item-check";
    check.setAttribute("aria-hidden", "true");
    check.append(createLucideIcon(Check, { size: 14 }));

    button.append(leading, text, check);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setPlusMenuOpen(false);
      onToggle();
    });
    return { button, check };
  }

  private createPermissionMenuItem(
    full: boolean,
    label: string,
    tip: string,
    icon: Parameters<typeof createLucideIcon>[0],
  ): PermissionMenuItem {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "composer-plus-menu-item composer-plus-permission-item" +
      (full ? " is-full-option" : " is-safe-option");
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", "false");
    button.title = tip;
    button.setAttribute("aria-label", label);

    const leading = document.createElement("span");
    leading.className = "composer-plus-menu-item-leading";
    leading.append(createLucideIcon(icon, { size: 16 }));

    const text = document.createElement("span");
    text.className = "composer-plus-menu-item-label";
    text.textContent = label;

    const check = document.createElement("span");
    check.className = "composer-plus-menu-item-check";
    check.setAttribute("aria-hidden", "true");
    check.append(createLucideIcon(Check, { size: 14 }));

    button.append(leading, text, check);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setPlusMenuOpen(false);
      if (full !== this.fullPermissions) {
        this.onPermissionsSelect?.(full);
      }
    });
    return { full, button };
  }

  private createModeMenuItem(
    mode: ComposerRunMode,
    label: string,
    tip: string,
    icon: Parameters<typeof createLucideIcon>[0],
  ): ModeMenuItem {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "composer-plus-menu-item composer-plus-mode-item";
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", "false");
    button.dataset.mode = mode;
    button.title = tip;
    button.setAttribute("aria-label", label);

    const leading = document.createElement("span");
    leading.className = "composer-plus-menu-item-leading";
    leading.append(createLucideIcon(icon, { size: 16 }));

    const text = document.createElement("span");
    text.className = "composer-plus-menu-item-label";
    text.textContent = label;

    const check = document.createElement("span");
    check.className = "composer-plus-menu-item-check";
    check.setAttribute("aria-hidden", "true");
    check.append(createLucideIcon(Check, { size: 14 }));

    button.append(leading, text, check);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setPlusMenuOpen(false);
      if (mode !== this.runMode) {
        this.onRunModeSelect?.(mode);
      }
    });
    return { mode, button, check };
  }

  /**
   * Auto V2 is a top-level sibling under Auto, but data-wise still the
   * built-in library graph — its selection routes through the custom
   * graph path (onCustomGraphSelect with the builtin id).
   */
  private createAutoV2MenuItem(): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "composer-plus-menu-item composer-plus-mode-item composer-plus-autov2-item";
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", "false");
    button.title =
      "Auto V2 — previews substantial UI changes for your approval before implementation; other tasks run directly";
    button.setAttribute("aria-label", "Auto V2");

    const leading = document.createElement("span");
    leading.className = "composer-plus-menu-item-leading";
    leading.append(createLucideIcon(Sparkle, { size: 16 }));

    const text = document.createElement("span");
    text.className = "composer-plus-menu-item-label";
    text.textContent = "Auto V2";

    const check = document.createElement("span");
    check.className = "composer-plus-menu-item-check";
    check.setAttribute("aria-hidden", "true");
    check.append(createLucideIcon(Check, { size: 14 }));

    button.append(leading, text, check);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setPlusMenuOpen(false);
      const selected =
        this.runMode === "custom" &&
        this.customGraphId === AUTO_V2_COMPOSER_GRAPH.id;
      if (!selected) {
        this.onCustomGraphSelect?.({ ...AUTO_V2_COMPOSER_GRAPH });
      }
    });
    return button;
  }

  private createCustomGraphsMenuItem(): {
    wrap: HTMLElement;
    button: HTMLButtonElement;
    check: HTMLElement;
    submenu: HTMLElement;
  } {
    const wrap = document.createElement("div");
    wrap.className = "composer-plus-custom-wrap";

    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "composer-plus-menu-item composer-plus-mode-item composer-plus-custom-trigger";
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", "false");
    button.setAttribute("aria-haspopup", "menu");
    button.title = "Custom graphs — run a saved FSM graph";
    button.setAttribute("aria-label", "Custom graphs");

    const leading = document.createElement("span");
    leading.className = "composer-plus-menu-item-leading";
    leading.append(createLucideIcon(Workflow, { size: 16 }));

    const text = document.createElement("span");
    text.className = "composer-plus-menu-item-label";
    text.textContent = "Custom graphs";

    const check = document.createElement("span");
    check.className = "composer-plus-menu-item-check";
    check.setAttribute("aria-hidden", "true");
    check.append(createLucideIcon(Check, { size: 14 }));

    const chevron = document.createElement("span");
    chevron.className = "composer-plus-custom-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.append(createLucideIcon(ChevronDown, { size: 14 }));

    button.append(leading, text, check, chevron);

    const submenu = document.createElement("div");
    submenu.className = "composer-plus-custom-submenu";
    submenu.setAttribute("role", "menu");
    submenu.setAttribute("aria-label", "Custom graphs");
    submenu.hidden = true;

    wrap.append(button, submenu);
    const openSub = () => {
      if (this.customSubmenuCloseTimer !== null) {
        clearTimeout(this.customSubmenuCloseTimer);
        this.customSubmenuCloseTimer = null;
      }
      submenu.hidden = false;
      void this.refreshCustomGraphsSubmenu();
    };
    const closeSub = () => {
      if (this.customSubmenuCloseTimer !== null) {
        clearTimeout(this.customSubmenuCloseTimer);
      }
      // Brief grace so the pointer can cross into the flyout without the
      // menu collapsing mid-travel (absolute children don't fill gaps).
      this.customSubmenuCloseTimer = setTimeout(() => {
        this.customSubmenuCloseTimer = null;
        submenu.hidden = true;
      }, 180);
    };
    wrap.addEventListener("mouseenter", openSub);
    wrap.addEventListener("mouseleave", closeSub);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (submenu.hidden) openSub();
      else {
        if (this.customSubmenuCloseTimer !== null) {
          clearTimeout(this.customSubmenuCloseTimer);
          this.customSubmenuCloseTimer = null;
        }
        submenu.hidden = true;
      }
    });

    return { wrap, button, check, submenu };
  }

  private async refreshCustomGraphsSubmenu(): Promise<void> {
    const submenu = this.customGraphsSubmenu;
    submenu.replaceChildren();
    const bridge = window.jellybot;
    if (!bridge?.listFsmGraphs) {
      const empty = document.createElement("div");
      empty.className = "composer-plus-custom-empty";
      empty.textContent = "No custom graphs";
      submenu.append(empty);
      return;
    }
    let entries: Array<{ id: string; name: string; color?: string }> = [];
    try {
      entries = enabledGraphEntries(
        await (bridge.listComposerGraphs ?? bridge.listFsmGraphs)(),
      ).filter((entry) => !isBuiltinComposerGraphId(entry.id));
    } catch {
      entries = [];
    }
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "composer-plus-custom-empty";
      empty.textContent = "No custom graphs";
      submenu.append(empty);
      return;
    }
    for (const entry of entries) {
      const color = normalizeHexColor(entry.color) ?? DEFAULT_CUSTOM_GRAPH_COLOR;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "composer-plus-menu-item composer-plus-mode-item composer-plus-custom-item";
      row.setAttribute("role", "menuitemradio");
      const selected =
        this.runMode === "custom" && this.customGraphId === entry.id;
      row.classList.toggle("is-selected", selected);
      row.setAttribute("aria-checked", selected ? "true" : "false");
      row.title = entry.name;
      const leading = document.createElement("span");
      leading.className = "composer-plus-menu-item-leading";
      leading.append(createLucideIcon(Workflow, { size: 16 }));
      const label = document.createElement("span");
      label.className = "composer-plus-menu-item-label";
      label.textContent = entry.name;
      const rowCheck = document.createElement("span");
      rowCheck.className = "composer-plus-menu-item-check";
      rowCheck.setAttribute("aria-hidden", "true");
      rowCheck.append(createLucideIcon(Check, { size: 14 }));
      row.append(leading, label, rowCheck);
      row.addEventListener("click", (event) => {
        event.stopPropagation();
        this.setPlusMenuOpen(false);
        this.onCustomGraphSelect?.({ id: entry.id, name: entry.name, color });
      });
      submenu.append(row);
    }
  }

  setOnRemoveAttachment(handler: ((id: string) => void) | null): void {
    this.onRemoveAttachment = handler;
  }

  setOnRunModeSelect(handler: ((mode: ComposerRunMode) => void) | null): void {
    this.onRunModeSelect = handler;
  }

  setOnCustomGraphSelect(
    handler:
      | ((
          graph: { id: string; name: string; color?: string | undefined },
        ) => void)
      | null,
  ): void {
    this.onCustomGraphSelect = handler;
  }

  /**
   * Slash command handler (`/pause` `/resume` `/compact`). When the
   * submitted prompt exactly matches a registered command, the handler
   * runs; returning true consumes the prompt (cleared, no normal submit).
   * A null handler — or false — falls through to a normal message submit.
   */
  setOnSlashCommand(
    handler: ((command: SlashCommand) => boolean) | null,
  ): void {
    this.onSlashCommand = handler;
  }

  /** Restrict the slash popup to specific command names (null = registry). */
  setSlashCommandScope(names: readonly string[] | null): void {
    this.slashCommandScope = names ? new Set(names) : null;
    this.refreshSlashMenu();
  }

  /**
   * Submit interception, callable from a controller's send path too: if the
   * current prompt exactly matches a slash command and a handler consumes
   * it, clears the composer and returns true (caller must NOT submit).
   */
  trySubmitSlashCommand(): boolean {
    if (!this.onSlashCommand) return false;
    const command = matchSlashCommand(this.textarea.value);
    if (!command) return false;
    if (!this.onSlashCommand(command)) return false;
    this.textarea.value = "";
    this.syncTextareaHeight();
    this.setSlashMenuOpen(false);
    return true;
  }

  /** Re-filter the slash popup from the current textarea value. */
  private refreshSlashMenu(): void {
    // No handler wired (e.g. the New Task composer) — commands are inert
    // there; never pop the menu.
    if (this.voiceMode || !this.onSlashCommand) {
      this.setSlashMenuOpen(false);
      return;
    }
    const filtered = filterSlashCommands(this.textarea.value);
    const scope = this.slashCommandScope;
    const matches = scope
      ? filtered.filter((command) => scope.has(command.name))
      : filtered;
    if (matches.length === 0) {
      this.setSlashMenuOpen(false);
      return;
    }
    this.renderSlashMenu(matches);
    this.setSlashMenuOpen(true);
  }

  private renderSlashMenu(matches: SlashCommand[]): void {
    const items: HTMLButtonElement[] = [];
    for (const command of matches) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "composer-slash-item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");
      item.title = command.description;
      const name = document.createElement("span");
      name.className = "composer-slash-item-name";
      name.textContent = command.name;
      const desc = document.createElement("span");
      desc.className = "composer-slash-item-desc";
      desc.textContent = command.description;
      item.append(name, desc);
      // Mousedown keeps the textarea focus — a blur must not close the
      // menu before the click lands.
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        this.applySlashCompletion(command);
      });
      items.push(item);
    }
    this.slashMenu.replaceChildren(...items);
    this.slashMenuItems = items;
    this.slashMenuCommands = matches;
    this.slashMenuSelected = -1;
  }

  /**
   * Menu keys while the popup is open. Returns true when the key is
   * consumed (caller prevents default + stops propagation).
   */
  private handleSlashMenuKeydown(event: KeyboardEvent): boolean {
    if (isImeComposing(event)) return false;
    switch (event.key) {
      case "ArrowDown":
        this.moveSlashSelection(1);
        return true;
      case "ArrowUp":
        this.moveSlashSelection(-1);
        return true;
      case "Tab": {
        if (event.metaKey || event.ctrlKey || event.altKey) return false;
        this.applySlashSelection();
        return true;
      }
      case "Enter": {
        if (event.shiftKey) return false;
        // Without an active selection Enter is not a completion — it
        // falls through to the submit path below (exact command → run,
        // anything else → normal message).
        if (this.slashMenuSelected < 0) return false;
        this.applySlashSelection();
        return true;
      }
      case "Escape":
        this.setSlashMenuOpen(false);
        return true;
      default:
        return false;
    }
  }

  /** Move the keyboard selection, wrapping across both ends. */
  private moveSlashSelection(delta: number): void {
    const count = this.slashMenuItems.length;
    if (count === 0) return;
    const next =
      this.slashMenuSelected < 0
        ? delta > 0
          ? 0
          : count - 1
        : (this.slashMenuSelected + delta + count) % count;
    this.setSlashSelection(next);
  }

  /** Complete the highlighted item — or the first when nothing is. */
  private applySlashSelection(): void {
    const index = this.slashMenuSelected >= 0 ? this.slashMenuSelected : 0;
    const command = this.slashMenuCommands[index];
    if (!command) return;
    this.applySlashCompletion(command);
  }

  /** Replace the prompt with the command and re-filter (menu stays for
   * the exact match; Enter then submits the command). Arg commands keep an
   * already-typed argument (`/opt fix this` → only the command token is
   * canonicalized) and otherwise open an argument slot (`/opt `). */
  private applySlashCompletion(command: SlashCommand): void {
    let next = command.name;
    if (command.acceptsArgs === true) {
      const trimmed = this.textarea.value.trimStart();
      const rest = trimmed.slice(command.name.length);
      next = /^\s/.test(rest) ? command.name + rest : `${command.name} `;
    }
    this.textarea.value = next;
    this.syncTextareaHeight();
    this.textarea.setSelectionRange(next.length, next.length);
    this.refreshSlashMenu();
    this.textarea.focus();
  }

  private setSlashSelection(index: number): void {
    this.slashMenuSelected = index;
    for (const [i, item] of this.slashMenuItems.entries()) {
      const selected = i === index;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-selected", selected ? "true" : "false");
    }
  }

  /** Open/close with the same enter fade and 180ms close grace as the
   * + menu, so nothing snaps in or out. */
  private setSlashMenuOpen(open: boolean): void {
    if (this.slashMenuOpen === open) return;
    this.slashMenuOpen = open;
    if (open) {
      if (this.slashMenuCloseTimer !== null) {
        clearTimeout(this.slashMenuCloseTimer);
        this.slashMenuCloseTimer = null;
      }
      this.slashMenu.hidden = false;
      // Force a reflow so the enter transition starts from the closed state.
      void this.slashMenu.offsetWidth;
      this.slashMenu.classList.add("is-open");
    } else {
      this.slashMenu.classList.remove("is-open");
      if (this.slashMenuCloseTimer === null) {
        this.slashMenuCloseTimer = setTimeout(() => {
          this.slashMenuCloseTimer = null;
          this.slashMenu.hidden = true;
        }, 180);
      }
    }
  }

  setOnInfiniteSelect(
    handler: ((enabled: boolean) => void) | null,
  ): void {
    this.onInfiniteSelect = handler;
  }

  setOnPermissionsSelect(
    handler: ((fullPermissions: boolean) => void) | null,
  ): void {
    this.onPermissionsSelect = handler;
  }

  setOnAutoSkillSummarizeSelect(
    handler: ((enabled: boolean) => void) | null,
  ): void {
    this.onAutoSkillSummarizeSelect = handler;
  }

  setOnHandoffSelect(
    handler: ((enabled: boolean) => void) | null,
  ): void {
    this.onHandoffSelect = handler;
  }

  /** Session-scoped: shown only where a live session row backs the toggle. */
  setHandoffVisible(visible: boolean): void {
    this.handoffItem.button.hidden = !visible;
  }

  /** Highlight while OS files are dragged over the composer (drop → attach). */
  setFileDragOver(active: boolean): void {
    this.root.classList.toggle("is-file-drag", active);
  }

  setAttachments(items: ComposerAttachmentChip[]): void {
    this.attachmentsStrip.replaceChildren();
    this.attachmentsStrip.hidden = items.length === 0;

    const imageCount = items.filter((item) => item.kind === "image").length;
    const fileCount = items.length - imageCount;
    this.imagesButton.classList.toggle("is-active", imageCount > 0);
    this.imagesButton.title =
      imageCount > 0 ? `Image (${imageCount})` : "Image";
    this.imagesButton.setAttribute(
      "aria-label",
      imageCount > 0 ? `Image, ${imageCount} selected` : "Image",
    );
    this.attachmentsButton.classList.toggle("is-active", fileCount > 0);
    this.attachmentsButton.title =
      fileCount > 0 ? `Attachments (${fileCount})` : "Attachments";
    this.attachmentsButton.setAttribute(
      "aria-label",
      fileCount > 0 ? `Attachments, ${fileCount} selected` : "Attachments",
    );

    for (const item of items) {
      const chip = document.createElement("div");
      chip.className = "composer-attachment-chip";
      chip.title = item.name;
      if (item.kind === "image") {
        chip.classList.add("is-image");
      }

      const icon = createLucideIcon(iconForAttachmentKind(item.kind), {
        size: 12,
      });
      icon.classList.add("composer-attachment-chip-icon");

      const label = document.createElement("span");
      label.className = "composer-attachment-chip-name";
      label.textContent = item.name;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "composer-attachment-chip-remove";
      remove.setAttribute("aria-label", `Remove ${item.name}`);
      remove.append(createLucideIcon(X, { size: 12 }));
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        this.onRemoveAttachment?.(item.id);
      });

      chip.append(icon, label, remove);
      this.attachmentsStrip.append(chip);
    }
  }

  setPlusMenuOpen(open: boolean): void {
    this.plusMenuOpen = open;
    this.plusButton.setAttribute("aria-expanded", open ? "true" : "false");
    this.plusButton.setAttribute(
      "aria-label",
      open ? "Close actions" : "More actions",
    );
    this.plusButton.classList.toggle("is-open", open);
    this.root.classList.toggle("is-plus-open", open);
    if (open) {
      if (this.plusMenuCloseTimer !== null) {
        clearTimeout(this.plusMenuCloseTimer);
        this.plusMenuCloseTimer = null;
      }
      this.plusMenu.hidden = false;
      // Force a reflow so the enter transition starts from the closed state.
      void this.plusMenu.offsetWidth;
      this.plusMenu.classList.add("is-open");
      this.setProviderMenuOpen(false);
      void this.refreshCustomGraphsSubmenu();
    } else {
      if (this.customSubmenuCloseTimer !== null) {
        clearTimeout(this.customSubmenuCloseTimer);
        this.customSubmenuCloseTimer = null;
      }
      this.customGraphsSubmenu.hidden = true;
      this.plusMenu.classList.remove("is-open");
      if (this.plusMenuCloseTimer === null) {
        this.plusMenuCloseTimer = setTimeout(() => {
          this.plusMenuCloseTimer = null;
          this.plusMenu.hidden = true;
        }, 180);
      }
    }
  }

  /** @deprecated Prefer setPlusMenuOpen. */
  setActionsExpanded(expanded: boolean): void {
    this.setPlusMenuOpen(expanded);
  }

  setPermissionsEnabled(enabled: boolean): void {
    this.fullPermissions = enabled;
    for (const item of this.permissionItems) {
      const selected = item.full === enabled;
      item.button.classList.toggle("is-selected", selected);
      item.button.setAttribute("aria-checked", selected ? "true" : "false");
    }
  }

  setAutoSkillSummarizeEnabled(enabled: boolean): void {
    this.autoSkillSummarize = enabled;
    this.autoSkillSummarizeItem.button.classList.toggle("is-selected", enabled);
    this.autoSkillSummarizeItem.button.setAttribute(
      "aria-checked",
      enabled ? "true" : "false",
    );
  }

  setHandoffEnabled(enabled: boolean): void {
    this.handoffEnabled = enabled;
    this.handoffItem.button.classList.toggle("is-selected", enabled);
    this.handoffItem.button.setAttribute(
      "aria-checked",
      enabled ? "true" : "false",
    );
  }

  setComposerRunMode(mode: ComposerRunMode): void {
    this.runMode = mode;
    if (mode !== "custom") {
      this.customGraphId = null;
      this.customGraphName = null;
      this.customGraphColor = null;
    }
    for (const item of this.modeItems) {
      const selected = item.mode === mode;
      item.button.classList.toggle("is-selected", selected);
      item.button.setAttribute("aria-checked", selected ? "true" : "false");
    }
    // Auto V2 owns its own top-level row — while it is the active mode the
    // Custom graphs trigger stays unselected and keeps its default label.
    const customSelected = mode === "custom";
    const autoV2Selected =
      customSelected && this.customGraphId === AUTO_V2_COMPOSER_GRAPH.id;
    this.autoV2Button.classList.toggle("is-selected", autoV2Selected);
    this.autoV2Button.setAttribute(
      "aria-checked",
      autoV2Selected ? "true" : "false",
    );
    const triggerSelected = customSelected && !autoV2Selected;
    this.customGraphsButton.classList.toggle("is-selected", triggerSelected);
    this.customGraphsButton.setAttribute(
      "aria-checked",
      triggerSelected ? "true" : "false",
    );
    const label =
      triggerSelected && this.customGraphName
        ? `Custom graphs · ${this.customGraphName}`
        : "Custom graphs";
    this.customGraphsButton.setAttribute("aria-label", label);
    const labelEl = this.customGraphsButton.querySelector(
      ".composer-plus-menu-item-label",
    );
    if (labelEl) {
      labelEl.textContent =
        triggerSelected && this.customGraphName
          ? this.customGraphName
          : "Custom graphs";
    }
    this.applyModeAccent();
  }

  /** Select a custom library graph (peer of Auto / Ask / Plan). */
  setCustomGraphSelection(
    graph:
      | { id: string; name: string; color?: string | null | undefined }
      | null,
  ): void {
    if (!graph) {
      if (this.runMode === "custom") this.setComposerRunMode("agent");
      return;
    }
    this.customGraphId = graph.id;
    this.customGraphName = graph.name;
    this.customGraphColor = normalizeHexColor(graph.color);
    this.setComposerRunMode("custom");
  }

  /**
   * Border identity color: Ask → blue, Plan → amber, custom → the graph's
   * stored color (violet fallback). Auto clears the override so the composer
   * keeps the dynamic app tint exactly as before.
   */
  private applyModeAccent(): void {
    const accent = composerAccentColor(this.runMode, this.customGraphColor);
    if (accent) {
      this.root.style.setProperty("--composer-accent", accent);
      this.root.classList.add("has-accent");
    } else {
      this.root.style.removeProperty("--composer-accent");
      this.root.classList.remove("has-accent");
    }
  }

  /** Infinite budget switch — applies in any run mode. */
  setInfiniteEnabled(enabled: boolean): void {
    this.infiniteEnabled = enabled === true;
    this.infiniteSwitchButton.classList.toggle("is-on", this.infiniteEnabled);
    this.infiniteSwitchButton.setAttribute(
      "aria-checked",
      this.infiniteEnabled ? "true" : "false",
    );
    const label = this.infiniteEnabled ? "Infinite on" : "Infinite";
    this.infiniteSwitchButton.title = this.infiniteEnabled
      ? "Infinite on — no round or token limits in any mode"
      : "Infinite — no round or token limits in any mode (⌘⇧M toggles Infinite + Effort MAX)";
    this.infiniteSwitchButton.setAttribute("aria-label", label);
    this.sendWrap.classList.toggle("is-infinite", this.infiniteEnabled);
  }

  /** @deprecated Prefer setComposerRunMode. */
  setPlanModeEnabled(enabled: boolean): void {
    this.setComposerRunMode(enabled ? "plan" : "agent");
  }

  setReasoningEffort(level: ReasoningEffortLevel): void {
    this.reasoningEffort = level;
    this.reasoningSeg.setLevel(level);
    const active =
      this.providers.find((p) => p.id === this.activeProviderId) ??
      this.providers[0];
    this.refreshProviderLabel(active);
    this.updateProviderTitle(active);
    this.renderProviderMenu();
  }

  setOnReasoningEffortSelect(
    handler: ((level: ReasoningEffortLevel) => void) | null,
  ): void {
    this.onReasoningEffortSelect = handler;
  }

  setSendEnabled(enabled: boolean): void {
    // Voice mode keeps the mic pressable regardless of composer emptiness:
    // transcript-driven syncs (input cleared mid-recording, post-submit
    // reset) land here and must not disable the push-to-talk control.
    if (this.stopMode || this.voiceMode) {
      this.sendButton.disabled = false;
      return;
    }
    this.sendButton.disabled = !enabled;
  }

  /**
   * Turn-in-flight indicator (context-ring ripple). Does not disable input —
   * callers decide Stop vs Send / steer via setStopMode. The provider menu
   * stays openable while the turn runs — read-only, so the in-flight turn
   * keeps its bound LLM but the choice stays inspectable.
   */
  setTurnRunning(running: boolean): void {
    this.turnRunning = running;
    this.sendWrap.classList.toggle("is-running", running);
    this.providerMenu.classList.toggle("is-locked", running);
    this.providerLockedHint.hidden = !running;
    this.reasoningSeg.setDisabled(running);
    this.infiniteSwitchButton.disabled = running;
    const active =
      this.providers.find((p) => p.id === this.activeProviderId) ??
      this.providers[0];
    this.updateProviderTitle(active);
    if (running) this.setProviderMenuOpen(false);
  }

  setStopMode(stop: boolean, options?: { steer?: boolean }): void {
    this.stopMode = stop;
    this.steerSendLabel = !stop && options?.steer === true;
    this.syncSendButtonFace();
    this.sendButton.classList.toggle("is-stop", stop);
    this.sendWrap.classList.toggle("is-running", this.turnRunning);
    if (stop) {
      this.sendButton.disabled = false;
    }
  }

  /**
   * Voice input mode — collapses the textarea / attachments area to the
   * single action row and swaps the send button to a mic. Exiting restores
   * the send/stop face from the current turn state.
   */
  setVoiceMode(on: boolean): void {
    if (this.voiceMode === on) return;
    this.voiceMode = on;
    this.root.classList.toggle("voice-mode", on);
    this.setSlashMenuOpen(false);
    this.syncSendButtonFace();
    if (on) {
      // The mic face is push-to-talk: it must stay pressable even with an
      // empty composer (the transcript fills and submits on release). The
      // controllers' syncSendEnabled() restores the real state on exit.
      this.sendButton.disabled = false;
    } else if (!this.stopMode) {
      // Defensive fallback for callers that skip the syncSendEnabled
      // callback: content-derived enablement instead of the mic's forced
      // state lingering on an empty composer. A wired controller
      // immediately re-syncs the authoritative state after this.
      this.sendButton.disabled = this.textarea.value.trim().length === 0;
    }
  }

  /**
   * Push-to-talk recording state. `level` (0..1) arrives ~15Hz while
   * active and only feeds the waveform meter — updates stay cheap.
   */
  setVoiceRecording(state: { active: boolean; level?: number }): void {
    if (state.active) {
      if (!this.voiceRecording) {
        this.voiceRecording = true;
        this.root.classList.add("voice-recording");
        this.setPlusMenuOpen(false);
        this.setProviderMenuOpen(false);
        this.voiceWaveform.setActive(true);
        this.syncSendButtonFace();
      }
      if (typeof state.level === "number") {
        this.voiceWaveform.pushLevel(state.level);
      }
      return;
    }
    if (this.voiceRecording) {
      this.voiceRecording = false;
      this.root.classList.remove("voice-recording");
      this.voiceWaveform.setActive(false);
      this.syncSendButtonFace();
    }
  }

  /**
   * Transient status inside the waveform area (speech model download,
   * microphone errors). `null` clears.
   */
  setVoiceStatus(
    status: { kind: "waiting" | "error"; message: string } | null,
  ): void {
    this.voiceStatus.classList.toggle("is-error", status?.kind === "error");
    this.voiceStatus.textContent = status?.message ?? "";
    this.voiceStatus.hidden = status === null;
  }

  /**
   * Send-button face: mic while in voice mode — except a running turn
   * swaps it to Stop (same face and click path as text mode); a take in
   * flight keeps the mic face so push-to-talk stays visually honest.
   * Without voice mode it is stop/send per the current turn state.
   */
  private syncSendButtonFace(): void {
    if (this.voiceMode) {
      if (this.stopMode && !this.voiceRecording) {
        this.sendButton.replaceChildren(this.stopIcon);
        this.sendButton.setAttribute("aria-label", "Stop");
        return;
      }
      this.sendButton.replaceChildren(this.micIcon);
      this.sendButton.setAttribute("aria-label", "Voice input");
      return;
    }
    this.sendButton.replaceChildren(
      this.stopMode ? this.stopIcon : this.sendIcon,
    );
    this.sendButton.setAttribute(
      "aria-label",
      this.stopMode
        ? "Stop"
        : this.steerSendLabel
          ? "Queue for after this turn"
          : "Send",
    );
  }

  setInputDisabled(disabled: boolean): void {
    this.textarea.disabled = disabled;
  }

  setPlaceholder(text: string): void {
    this.textarea.placeholder = text;
  }

  setPrompt(text: string): void {
    this.textarea.value = text;
    this.syncTextareaHeight();
  }

  isTurnRunning(): boolean {
    return this.turnRunning;
  }

  setContextUsage(usage: ContextUsage): void {
    const previous = this.displayedContextUsage.usedTokens;
    this.displayedContextUsage = mergeContextUsage(
      this.displayedContextUsage,
      usage,
    );
    if (
      previous !== this.displayedContextUsage.usedTokens ||
      (usage.usedTokens === 0 && previous > 0)
    ) {
      console.debug("[context-usage] composer ring", {
        incoming: usage,
        previous,
        displayed: this.displayedContextUsage,
      });
    }
    this.sendControl.setContextUsage(this.displayedContextUsage);
  }

  setOnProviderSelect(handler: ((providerId: string) => void) | null): void {
    this.onProviderSelect = handler;
  }

  setProviders(
    providers: ComposerProviderOption[],
    activeProviderId: string,
  ): void {
    this.providers = providers.map((p) => ({ ...p }));
    this.activeProviderId = activeProviderId;
    const active =
      this.providers.find((p) => p.id === activeProviderId) ??
      this.providers[0];
    this.refreshProviderLabel(active);
    this.updateProviderTitle(active);
    this.renderProviderMenu();
  }

  setHealthOk(ok: boolean): void {
    this.healthOk = ok;
    this.providerButton.classList.toggle("is-ok", ok);
    this.providerButton.classList.toggle("is-down", !ok);
    const active =
      this.providers.find((p) => p.id === this.activeProviderId) ??
      this.providers[0];
    this.updateProviderTitle(active);
  }

  private refreshProviderLabel(active?: ComposerProviderOption): void {
    this.providerLabel.textContent = active?.name ?? "Provider";
    const level = this.reasoningEffort;
    this.providerEffortChip.hidden = level === "low";
    this.providerEffortChip.textContent = level.toUpperCase();
    this.providerEffortChip.classList.toggle("is-max", level === "max");
    this.providerEffortChip.dataset.level = level;
    this.providerButton.classList.toggle("has-effort", level !== "low");
  }

  private updateProviderTitle(active?: ComposerProviderOption): void {
    const health = this.healthOk ? "connected" : "unavailable";
    const levelSuffix =
      this.reasoningEffort === "low"
        ? ""
        : ` · ${this.reasoningEffort.toUpperCase()}`;
    const base = active
      ? `${active.name} (${active.modelId}${levelSuffix})`
      : "Select LLM provider";
    const readonlySuffix = this.turnRunning ? " · read-only while running" : "";
    this.providerButton.title = `${base} · ${health}${readonlySuffix}`;
    this.providerButton.setAttribute(
      "aria-label",
      `${base}, LLM ${health}${readonlySuffix}`,
    );
  }

  private setProviderMenuOpen(open: boolean): void {
    this.providerMenuOpen = open;
    this.providerButton.setAttribute("aria-expanded", open ? "true" : "false");
    this.providerButton.classList.toggle("is-open", open);
    if (open) {
      if (this.providerMenuCloseTimer !== null) {
        clearTimeout(this.providerMenuCloseTimer);
        this.providerMenuCloseTimer = null;
      }
      this.providerMenu.hidden = false;
      // Force a reflow so the enter transition starts from the closed state.
      void this.providerMenu.offsetWidth;
      this.providerMenu.classList.add("is-open");
      this.setPlusMenuOpen(false);
    } else {
      this.providerMenu.classList.remove("is-open");
      if (this.providerMenuCloseTimer === null) {
        this.providerMenuCloseTimer = setTimeout(() => {
          this.providerMenuCloseTimer = null;
          this.providerMenu.hidden = true;
        }, 180);
      }
    }
  }

  private renderProviderMenu(): void {
    this.providerMenuList.replaceChildren();
    for (const provider of this.providers) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "composer-provider-item";
      item.setAttribute("role", "option");
      if (provider.id === this.activeProviderId) {
        item.classList.add("is-active");
        item.setAttribute("aria-selected", "true");
      } else {
        item.setAttribute("aria-selected", "false");
      }
      const brand = matchModelBrand(provider);
      const brandIcon = brand ? createBrandIcon(brand, 14) : null;
      const name = document.createElement("span");
      name.className = "composer-provider-item-name";
      name.textContent = provider.name;
      const nameRow = document.createElement("span");
      nameRow.className = "composer-provider-item-name-row";
      if (brandIcon) nameRow.append(brandIcon);
      nameRow.append(name);
      const model = document.createElement("span");
      model.className = "composer-provider-item-model";
      const levelSuffix =
        this.reasoningEffort !== "low" &&
        provider.id === this.activeProviderId
          ? ` · ${this.reasoningEffort.toUpperCase()}`
          : "";
      model.textContent = `${provider.modelId}${levelSuffix}`;
      item.append(nameRow, model);
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        this.setProviderMenuOpen(false);
        if (this.turnRunning || this.providerButton.disabled) return;
        if (provider.id !== this.activeProviderId) {
          this.onProviderSelect?.(provider.id);
        }
      });
      this.providerMenuList.append(item);
    }
  }

  getPrompt(): string {
    return this.textarea.value;
  }

  clearPrompt(): void {
    this.textarea.value = "";
    this.syncTextareaHeight();
    this.setSlashMenuOpen(false);
  }

  isStopMode(): boolean {
    return this.stopMode;
  }

  focusInput(): void {
    this.textarea.focus();
  }

  /** Release document-global listeners, observers, and delayed UI work. */
  destroy(): void {
    this.voiceWaveform.destroy();
    document.removeEventListener("click", this.documentClickHandler);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.initialResizeRafId !== null) {
      cancelAnimationFrame(this.initialResizeRafId);
      this.initialResizeRafId = null;
    }
    for (const timer of [
      this.customSubmenuCloseTimer,
      this.slashMenuCloseTimer,
      this.plusMenuCloseTimer,
      this.providerMenuCloseTimer,
    ]) {
      if (timer !== null) clearTimeout(timer);
    }
    this.customSubmenuCloseTimer = null;
    this.slashMenuCloseTimer = null;
    this.plusMenuCloseTimer = null;
    this.providerMenuCloseTimer = null;
    this.onProviderSelect = null;
    this.onRunModeSelect = null;
    this.onInfiniteSelect = null;
    this.onPermissionsSelect = null;
    this.onAutoSkillSummarizeSelect = null;
    this.onHandoffSelect = null;
    this.onRemoveAttachment = null;
    this.onCustomGraphSelect = null;
    this.onSlashCommand = null;
  }

  /**
   * Grow the textarea with content up to {@link TASK_COMPOSER_MAX_ROWS} lines,
   * then scroll. Also shrinks when text is deleted.
   */
  private syncTextareaHeight(): void {
    const el = this.textarea;
    const style = getComputedStyle(el);
    const fontSize = parseFloat(style.fontSize) || 14;
    let lineHeight = parseFloat(style.lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
      lineHeight = fontSize * 1.5;
    }
    const paddingY =
      (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const borderY =
      (parseFloat(style.borderTopWidth) || 0) +
      (parseFloat(style.borderBottomWidth) || 0);
    const minHeight = lineHeight * this.minRows + paddingY + borderY;
    const maxHeight =
      lineHeight * TASK_COMPOSER_MAX_ROWS + paddingY + borderY;

    // Collapse first so scrollHeight reflects content (not prior tall height).
    el.style.height = "0px";
    const contentHeight = el.scrollHeight;
    const next = Math.min(Math.max(contentHeight, minHeight), maxHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = contentHeight > maxHeight + 0.5 ? "auto" : "hidden";
  }
}

function iconForAttachmentKind(kind: string): IconNode {
  switch (kind) {
    case "image":
      return FileImage;
    case "audio":
      return FileAudio;
    case "video":
      return FileVideo;
    case "source_code":
      return FileCode;
    case "file":
      return FileIcon;
    default:
      return Paperclip;
  }
}
