import {
  AppWindow,
  Archive,
  ArchiveRestore,
  Atom,
  ArrowUp,
  ArrowDown,
  ArrowRight,
  Bell,
  BookOpen,
  Braces,
  Bug,
  CaseSensitive,
  ChartLine,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  CircleDot,
  Clock,
  Code,
  CodeXml,
  Coins,
  Copy,
  Check,
  Download,
  ExternalLink,
  FileBox,
  Eye,
  EyeOff,
  FileDiff,
  FilePenLine,
  FileText,
  Filter,
  Folder,
  FolderOpen,
  GitCommitHorizontal,
  Globe,
  Hourglass,
  List,
  LoaderCircle,
  Lock,
  Map,
  MessageSquare,
  Minus,
  Package,
  PackageCheck,
  PackageOpen,
  PanelRightClose,
  Pause,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Regex,
  Replace,
  ReplaceAll,
  RotateCcwClock,
  SatelliteDish,
  ScrollText,
  Search,
  Send,
  Settings,
  Settings2,
  Sparkles,
  Square,
  SquareFunction,
  SquareStack,
  SquareTerminal,
  Summary,
  Terminal,
  Trash2,
  TriangleAlert,
  Variable,
  WholeWord,
  Workflow,
  Wrench,
  X,
  createElement,
  type IconNode,
} from "lucide";
import { functionalIconSvg, type FunctionalIconName } from "../../../shared/icons/functionalIcons.js";
import { desktopFunctionalIconNames } from "./functionalIconNames.js";

const DEFAULT_SIZE = 16;
const DEFAULT_STROKE = 1.75;

let functionalIconInstance = 0;

function scopeSvgIds(svg: string): string {
  const ids = new Set(Array.from(svg.matchAll(/\bid="([^"]+)"/g), (m) => m[1]!));
  if (ids.size === 0) return svg;
  const suffix = `-i${++functionalIconInstance}`;
  let out = svg;
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(id="|#)${escaped}(?=[")])`, "g"), `$1${id}${suffix}`);
  }
  return out;
}

export function createFunctionalIcon(name: FunctionalIconName, size = DEFAULT_SIZE): SVGElement {
  const template = document.createElement("template");
  template.innerHTML = scopeSvgIds(functionalIconSvg(name, size));
  return template.content.firstElementChild as SVGElement;
}

export function createLucideIcon(
  icon: IconNode,
  options?: { size?: number; strokeWidth?: number },
): SVGElement {
  const size = options?.size ?? DEFAULT_SIZE;
  const name = icon === FolderFill ? "Folder" : icon === FolderOpenFill ? "FolderOpen" : desktopFunctionalIconNames.get(icon);
  if (name && icon !== RefreshCw) return createFunctionalIcon(name, size);
  const strokeWidth = options?.strokeWidth ?? DEFAULT_STROKE;
  return createElement(icon, {
    width: size,
    height: size,
    "stroke-width": strokeWidth,
    "aria-hidden": "true",
  });
}

export const FolderFill: IconNode = Folder;
export const FolderOpenFill: IconNode = FolderOpen;

export const agentNavIcons = {
  "new-task": Plus,
  loop: RotateCcwClock,
  search: Search,
  tools: Wrench,
  skills: BookOpen,
  graphs: FileBox,
} as const satisfies Record<string, IconNode>;

export type { IconNode };
export {
  AppWindow,
  Archive,
  ArchiveRestore,
  Atom,
  ArrowUp,
  ArrowDown,
  ArrowRight,
  Bell,
  Braces,
  Bug,
  CaseSensitive,
  ChartLine,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  CircleDot,
  Clock,
  Code,
  CodeXml,
  Coins,
  Copy,
  Check,
  Download,
  Eye,
  ExternalLink,
  EyeOff,
  Folder,
  FolderOpen,
  FileDiff,
  FilePenLine,
  FileText,
  Filter,
  GitCommitHorizontal,
  Globe,
  Hourglass,
  List,
  LoaderCircle,
  Lock,
  Map,
  MessageSquare,
  Minus,
  Package,
  PackageCheck,
  PackageOpen,
  PanelRightClose,
  Pause,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Regex,
  Replace,
  ReplaceAll,
  SatelliteDish,
  ScrollText,
  Search,
  Send,
  Settings,
  Settings2,
  Sparkles,
  Square,
  SquareFunction,
  SquareStack,
  SquareTerminal,
  Summary,
  Terminal,
  Trash2,
  TriangleAlert,
  Variable,
  WholeWord,
  Workflow,
  Wrench,
  X,

};
