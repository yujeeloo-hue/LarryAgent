import { functionalIconSvg, type FunctionalIconName } from "../../../shared/icons/functionalIcons.js";
import "./mono-icon.css";

const artwork = {
  appearance: "Palette", providers: "Server", vision: "Eye", imagegen: "ImagePlus",
  composer: "Composer", agent: "Bot", memory: "Memory", security: "ShieldCheck",
  "remote-control": "RemoteControl", "object-storage": "CloudUpload",
  storage: "Storage", backup: "Backup", update: "Update", "remote-console": "SatelliteDish",
  notifications: "Bell", "dev-mode": "Code", detail: "AppWindow", settings: "Settings",
} as const satisfies Record<string, FunctionalIconName>;

export type MonoIconName = keyof typeof artwork;

const sources = Object.fromEntries(
  Object.entries(artwork).map(([name, canonical]) => [name, `url("data:image/svg+xml,${encodeURIComponent(functionalIconSvg(canonical, 24))}")`]),
) as Record<MonoIconName, string>;

/** A filled, transparent silhouette that inherits its owner's theme/state color. */
export function createMonoIcon(name: MonoIconName, size: number): HTMLSpanElement {
  const icon = document.createElement("span");
  icon.className = "app-mono-icon";
  icon.dataset.functionalIcon = artwork[name];
  icon.setAttribute("aria-hidden", "true");
  icon.style.width = `${size}px`;
  icon.style.height = `${size}px`;
  icon.style.setProperty("--app-mono-source", sources[name]);
  return icon;
}
