import hunyuanSvg from "../assets/model-icons/hunyuan.svg?raw";
import glmSvg from "../assets/model-icons/glm.svg?raw";
import grokSvg from "../assets/model-icons/grok.svg?raw";
import doubaoSvg from "../assets/model-icons/doubao.svg?raw";
import geminiSvg from "../assets/model-icons/gemini.svg?raw";
import nvidiaSvg from "../assets/model-icons/nvidia.svg?raw";
import openaiSvg from "../assets/model-icons/openai.svg?raw";
import deepseekSvg from "../assets/model-icons/deepseek.svg?raw";
import claudeSvg from "../assets/model-icons/claude.svg?raw";
import kimiSvg from "../assets/model-icons/kimi.svg?raw";
import minimaxSvg from "../assets/model-icons/minimax.svg?raw";
import mistralSvg from "../assets/model-icons/mistral.svg?raw";
import museSparkSvg from "../assets/model-icons/muse-spark.svg?raw";
import qwenSvg from "../assets/model-icons/qwen.svg?raw";

/** Known LLM vendor brands with a bundled icon. */
export type ModelBrandKey =
  | "hunyuan"
  | "glm"
  | "grok"
  | "doubao"
  | "gemini"
  | "openai"
  | "deepseek"
  | "claude"
  | "kimi"
  | "minimax"
  | "mistral"
  | "nvidia"
  | "muse-spark"
  | "qwen";

const BRAND_ICONS: Record<ModelBrandKey, string> = {
  hunyuan: hunyuanSvg,
  glm: glmSvg,
  grok: grokSvg,
  doubao: doubaoSvg,
  gemini: geminiSvg,
  openai: openaiSvg,
  deepseek: deepseekSvg,
  claude: claudeSvg,
  kimi: kimiSvg,
  minimax: minimaxSvg,
  mistral: mistralSvg,
  nvidia: nvidiaSvg,
  "muse-spark": museSparkSvg,
  qwen: qwenSvg,
};

type BrandMatcher = {
  brand: ModelBrandKey;
  /** Matched against modelId (most specific — e.g. glm-5.2 via LKEAP). */
  modelRe: RegExp;
  /** Matched against baseUrl host (e.g. api.deepseek.com). */
  hostRe: RegExp;
  /** Matched against the display name (fallback). */
  nameRe: RegExp;
};

/**
 * Muse Spark (Meta / Muse family): the words "muse" and "meta" alone, plus the
 * combined mark in any separator spelling (muse-spark / muse_spark / muse.spark
 * / "Muse Spark" / musespark / meta-spark). Bare "muse"/"meta" only match as
 * whole tokens — the boundary is start/end or one of `. _ / : -` or a space —
 * so unrelated words (metadata, metaso, prometheus) don't pick it up. Bare
 * "spark" is deliberately NOT here: it belongs to other vendors (iFlytek 星火).
 */
const MUSE_SPARK_RE =
  /(?:muse|meta)[\s._/-]?spark|(?:^|[\s._/:/-])(?:muse|meta)(?:$|[\s._/:/-])/i;

const MATCHERS: BrandMatcher[] = [
  { brand: "openai", modelRe: /(^|[._-])(gpt|o1|o3|o4|chatgpt)|openai/i, hostRe: /openai/i, nameRe: /openai|chatgpt|\bgpt\b/i },
  { brand: "claude", modelRe: /claude/i, hostRe: /anthropic/i, nameRe: /claude|anthropic/i },
  { brand: "deepseek", modelRe: /deep[- ]?seek/i, hostRe: /deepseek/i, nameRe: /deepseek|深度求索/i },
  { brand: "glm", modelRe: /(^|[._-])glm|chatglm/i, hostRe: /bigmodel|zhipu/i, nameRe: /glm|智谱/i },
  { brand: "hunyuan", modelRe: /hunyuan/i, hostRe: /hunyuan/i, nameRe: /hunyuan|混元/i },
  { brand: "qwen", modelRe: /qwen/i, hostRe: /dashscope|aliyun|alibaba/i, nameRe: /qwen|通义/i },
  { brand: "kimi", modelRe: /kimi|moonshot/i, hostRe: /moonshot/i, nameRe: /kimi|moonshot|月之暗面/i },
  { brand: "doubao", modelRe: /doubao|^ark|ark:/i, hostRe: /volces|volcengine/i, nameRe: /doubao|豆包/i },
  { brand: "grok", modelRe: /grok/i, hostRe: /(^|[./])x\.ai|grok/i, nameRe: /grok/i },
  {
    brand: "gemini",
    modelRe: /gemini/i,
    hostRe: /generativelanguage|googleapis|ai\.google/i,
    nameRe: /gemini|google ai/i,
  },
  {
    brand: "nvidia",
    modelRe: /nemotron|nvidia|llama[- ]?3[-.]?1[- ]?nemotron/i,
    hostRe: /nvidia|build\.nvidia|integrate\.api\.nvidia/i,
    nameRe: /nvidia|nemotron|英伟达/i,
  },
  {
    brand: "minimax",
    modelRe: /minimax|abab|hailuo/i,
    hostRe: /minimax/i,
    nameRe: /minimax|海螺/i,
  },
  {
    brand: "mistral",
    modelRe: /mistral|codestral|ministral|devstral|magistral|pixtral/i,
    hostRe: /mistral/i,
    nameRe: /mistral|ministral|codestral/i,
  },
  {
    brand: "muse-spark",
    modelRe: MUSE_SPARK_RE,
    hostRe: MUSE_SPARK_RE,
    nameRe: MUSE_SPARK_RE,
  },
];

export type ModelBrandSource = {
  baseUrl?: string;
  modelId?: string;
  name?: string;
};

/**
 * Resolve the vendor brand for a provider, or null when unknown.
 * modelId wins, then baseUrl host, then display name.
 */
export function matchModelBrand({
  baseUrl,
  modelId,
  name,
}: ModelBrandSource): ModelBrandKey | null {
  const host = (baseUrl ?? "").toLowerCase();
  const model = (modelId ?? "").toLowerCase();
  const label = (name ?? "").toLowerCase();
  for (const pass of [model, host, label]) {
    if (!pass) continue;
    for (const m of MATCHERS) {
      const re =
        pass === model ? m.modelRe : pass === host ? m.hostRe : m.nameRe;
      if (re.test(pass)) return m.brand;
    }
  }
  return null;
}

/** Per-brand visual scale — full-bleed tile icons read smaller next to glyph icons. */
const BRAND_SCALE: Partial<Record<ModelBrandKey, number>> = {
  glm: 1.15,
  kimi: 1.15,
  /* The official mark is 256×171, so in a square box it only fills ~67% of
     the height; scale it back up to sit level with the square tiles. */
  "muse-spark": 1.2,
};

/**
 * Suffix SVG ids (and fragment refs) so multiple copies of the same brand
 * can sit on one page. Also rewrites `href="#id"` / `xlink:href="#id"` used
 * by pattern-fill exports; data: URLs are left alone.
 */
function uniquifySvgIds(raw: string, uid: string): string {
  return raw
    .replace(/id="([^"]+)"/g, (_m, id: string) => `id="${id}-${uid}"`)
    .replace(/url\(#([^)]+)\)/g, (_m, id: string) => `url(#${id}-${uid})`)
    .replace(
      /(xlink:href|href)="#([^"]+)"/g,
      (_m, attr: string, id: string) => `${attr}="#${id}-${uid}"`,
    );
}

/**
 * Create a span wrapping the brand SVG, sized via inline styles.
 * SVG-internal ids (masks/filters) are uniquified per instance so multiple
 * icons of the same brand can coexist on one page (e.g. doubao filters).
 */
export function createBrandIcon(
  brand: ModelBrandKey,
  size = 14,
): HTMLSpanElement {
  const wrap = document.createElement("span");
  wrap.className = "model-brand-icon";
  wrap.style.display = "inline-flex";
  wrap.style.alignItems = "center";
  wrap.style.flex = "none";
  wrap.style.lineHeight = "0";
  /* Mono glyphs (openai/qwen/grok) use currentColor — the wrap adopts the
     text color so light themes flip them dark instead of rendering white. */
  wrap.style.color = "var(--fg, currentColor)";
  const uid = Math.random().toString(36).slice(2, 8);
  const raw = BRAND_ICONS[brand];
  const svg = uniquifySvgIds(raw, uid);
  wrap.innerHTML = svg;
  const el = wrap.firstElementChild as SVGElement | null;
  if (el) {
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.display = "block";
    const scale = BRAND_SCALE[brand];
    if (scale) {
      el.style.transform = `scale(${scale})`;
      el.style.transformOrigin = "center";
    }
  }
  return wrap;
}
