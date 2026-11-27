import tipsTemplate from "../../../native/macos-virtual-cursor/tips.html?raw";
import tipConfirmIcon from "../../../native/macos-virtual-cursor/icons/tip-confirm.svg?raw";
import tipDoneIcon from "../../../native/macos-virtual-cursor/icons/tip-done.svg?raw";
import tipNeutralIcon from "../../../native/macos-virtual-cursor/icons/tip-neutral.svg?raw";
import computerUseIcon from "../../renderer/src/assets/tools-categories/computer-use.svg?raw";
import cursorPage from "./cursor.html?raw";
import spotPage from "./spot.html?raw";

const TIP_ICONS: Record<string, string> = {
  "computer-use": computerUseIcon,
  "tip-confirm": tipConfirmIcon,
  "tip-done": tipDoneIcon,
  "tip-neutral": tipNeutralIcon,
};

function htmlDataUrl(html: string): string {
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`;
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

export function tipsPageHtml(template: string, icons: Record<string, string>): string {
  return template.replace(/\{\{icon:([a-z-]+)\}\}/g, (_, name: string) => {
    const icon = icons[name];
    if (icon === undefined) throw new Error(`Unknown tip icon: ${name}`);
    return svgDataUrl(icon);
  });
}

let tipsUrl: string | null = null;

export function tipsPageUrl(): string {
  return (tipsUrl ??= htmlDataUrl(tipsPageHtml(tipsTemplate, TIP_ICONS)));
}

export function cursorPageUrl(): string {
  return htmlDataUrl(cursorPage);
}

export function spotPageUrl(): string {
  return htmlDataUrl(spotPage);
}
