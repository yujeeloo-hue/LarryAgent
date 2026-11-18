# Shared functional icons

The desktop client uses `src/shared/icons/functionalIcons.ts`. Its editable sources are in `src/shared/icons/svg/`; run `node src/shared/icons/generate.mjs` after changing artwork. This also updates CSS masks and the shared sources for the approved color icons.

The custom filled library retains 60 SVG source files with current UI usage. Compatibility names remain available without duplicate SVG files; names without retained custom artwork fall back to the original icon library. All functional silhouettes use filled geometry, rounded corners and transparent negative space. Existing brand, provider, model and programming language marks are preserved. Approved navigation and Settings category artwork stays in color.

The complete Lucide identifier registry is kept for original-icon surfaces and shared tool metadata. It is not a list of custom filled assets. CoCo palette SVGs remain required inputs to `assets/coco/generate-motion.mjs`, even though the running UI uses their generated animation frames.

## Adapters

- Desktop: `src/renderer/src/ui/functionalIconNames.ts` maps the existing Lucide identifiers to shared artwork. Existing sizing, labels, events, state colors and animation classes remain at their call sites.
- Relay: `relay/web/src/icons.ts` retains its original inline outline artwork, independently of the desktop filled library.
- Tool cards and Thinking hints: `src/shared/icons/toolIconCatalog.ts` owns the 60 tool mappings used by both clients. Expansion defaults remain unchanged.
- Navigation, Settings and Tools categories: `src/shared/icons/colorIcons.ts` contains the approved desktop color artwork. Tools category sources live in `src/renderer/src/assets/tools-categories/`, including the approved V4 Orchestration ribbon. Relay's New Task entry retains its original plus icon.

## Original artwork in developer and conversation surfaces

Dev Mode, the File Reader toolbar, the Detail drawer, Composer controls, Tools and Skills pages, the FSM Graph editor (toolbar, action lists, inspector and parameter forms), version control views, workspace disclosure arrows, and all conversation content (including attachments, retry cards, prompt clamps, and queued messages) retain the original Lucide artwork. The Tools secondary-navigation categories are an approved color exception; Tools toolbar actions and tool rows retain their original artwork. Their desktop components use `src/renderer/src/ui/originalIcons.ts`; Dev Mode also keeps the original two-tone folders and inline search/copy glyphs. The New Task create-workspace action also keeps its original icon. Refresh controls, workspace folder actions, the backup file chooser and the Device ID fingerprint also retain their original outlines. Other application surfaces continue using the filled library, including the approved title-bar actions and Settings icons.

Relay uses its original `icon()` adapter throughout, including tool/Thinking cards and Composer. The tool labels stay shared, while the Relay artwork and original 2-unit stroke remain independent. Desktop `src/shared/icons/originalIcons.ts` preserves its original Lucide nodes; regenerate it with `node --import tsx scripts/generate-original-icons.mjs` when those sources change.

## Optical sizing

| Placement | Size | Notes |
| --- | --- | --- |
| Main window's five top-right actions | 14px | Existing 24px button regions retained |
| Settings card title icons | 20px | Dark `#abb3bf`, Light `#5b6573` |
| PROJECTS actions | Existing 13–14px | Existing button regions retained |
| Approved navigation | 16px | Full color in every state, saturation 150% |
| Approved Settings categories | 17px | Full color, saturation 150% |
| Approved Tools categories | 16px | Full color in every state, saturation 150% |

Search has a smaller circle, shorter handle and lighter mass. Archive has a wider lid and fuller body. Trash has a wider body with less taper. These are adjustments to the silhouette inside the shared 24-unit grid rather than changes to the button dimensions.

## Coverage

| Area | Examples |
| --- | --- |
| Projects and navigation | Add, search, archive, restore, trash, rename, disclosure |
| Main window and Settings | Signal pulse, notifications, developer mode, details, gear, providers, vision, shield, storage, backup |
| Composer and messages | Send, stop, attachment, microphone, copy, edit, effort stepper, status marks |
| Files and development | Files, folders, packages, code, terminal, diff, commit, panels |
| Tools, plans and workflows | Tool cards, Thinking dock, plan steps, MCP, skills, memory, agents, route, graph zoom and remove |
| Relay and devices | Devices, connection, keys, sign out, remote management, maintenance |

Data visualizations, user-supplied SVG content, syntax glyphs and internal editor decorations remain content rather than application action icons.

## Validation

`functionalIcons.test.ts` checks source synchronization, mask references, coverage of production desktop Lucide identifiers, exact artwork in the desktop adapter, and all 60 desktop tool mappings. Verify Light/Dark at small sizes after editing the SVGs. Browser previews validate local rendering; they do not publish the online Relay.
