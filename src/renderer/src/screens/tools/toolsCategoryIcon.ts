import { colorIconSources } from "../../../../shared/icons/colorIcons.js";
import type { ToolCategoryId } from "../../../../tools/catalog.js";

const artwork = colorIconSources.tools satisfies Record<
  ToolCategoryId | "mcp-servers",
  string
>;

/** Unknown future categories retain the caller's original icon fallback. */
export function createToolsCategoryIcon(id: string): HTMLImageElement | null {
  if (!Object.hasOwn(artwork, id)) return null;

  const image = document.createElement("img");
  image.className = "tools-category-artwork";
  image.src = artwork[id as keyof typeof artwork];
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  image.width = 16;
  image.height = 16;
  image.draggable = false;
  return image;
}
