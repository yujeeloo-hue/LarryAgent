import awsSvg from "../assets/storage-icons/aws.svg?raw";
import tencentCloudSvg from "../assets/storage-icons/tencent-cloud.svg?raw";

/**
 * Object storage provider brands with a bundled icon (Amazon S3, Tencent COS).
 * Keep in sync with `ObjectStorageProviderKind` in src/settings/types.ts.
 */
export type StorageProviderBrandKey = "amazon" | "tencent";

const STORAGE_BRAND_ICONS: Record<StorageProviderBrandKey, string> = {
  amazon: awsSvg,
  tencent: tencentCloudSvg,
};

/**
 * Create a span wrapping the provider brand SVG, sized via inline styles.
 * SVG-internal ids are uniquified per instance so multiple icons of the same
 * brand can coexist on one page (mirrors createBrandIcon in modelBrand.ts).
 */
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
  /* Mono glyphs (aws) use currentColor — adopt the text color so light
     themes render them dark instead of inheriting an invisible white. */
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
