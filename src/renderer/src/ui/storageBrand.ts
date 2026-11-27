import awsSvg from "../assets/storage-icons/aws.svg?raw";
import tencentCloudSvg from "../assets/storage-icons/tencent-cloud.svg?raw";

export type StorageProviderBrandKey = "amazon" | "tencent";

const STORAGE_BRAND_ICONS: Record<StorageProviderBrandKey, string> = {
  amazon: awsSvg,
  tencent: tencentCloudSvg,
};

export function createStorageProviderBrandIcon(
  brand: StorageProviderBrandKey,
  size = 14,
): HTMLSpanElement {
  const wrap = document.createElement("span");
  wrap.className = "model-brand-icon";
  wrap.style.display = "inline-flex";
  wrap.style.alignItems = "center";
  wrap.style.flex = "none";
  wrap.style.lineHeight = "0";
  wrap.style.color = "var(--fg, currentColor)";
  const uid = Math.random().toString(36).slice(2, 8);
  const raw = STORAGE_BRAND_ICONS[brand];
  const svg = raw
    .replace(/id="([^"]+)"/g, (_m, id: string) => `id="${id}-${uid}"`)
    .replace(/url\(#([^)]+)\)/g, (_m, id: string) => `url(#${id}-${uid})`);
  wrap.innerHTML = svg;
  const el = wrap.firstElementChild as SVGElement | null;
  if (el) {
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.display = "block";
  }
  return wrap;
}
