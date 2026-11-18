import { colorIconSources } from "../../../../shared/icons/colorIcons.js";

const artwork = colorIconSources.settings;

export type SettingCategoryId = keyof typeof artwork;

const sources = artwork;

export function createSettingCategoryIcon(id: SettingCategoryId): HTMLImageElement {
  const image = document.createElement("img");
  image.className = "setting-category-artwork";
  image.src = sources[id];
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  image.width = 17;
  image.height = 17;
  image.draggable = false;
  return image;
}
