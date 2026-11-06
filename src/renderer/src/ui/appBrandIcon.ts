import appIconUrl from "../assets/app-icon.png";
import dogHeadUrl from "../assets/dog-head-titlebar.png";
import dogHeadRetinaUrl from "../assets/dog-head-titlebar@2x.png";

/** Shared Windows top-left brand in normal mode and Dev Mode. */
export function createAppBrandIcon(): HTMLElement {
  if (window.jellybot?.platform === "win32") {
    const mark = document.createElement("span");
    mark.className = "app-brand-icon app-brand-icon-dog";
    mark.setAttribute("aria-hidden", "true");
    mark.style.setProperty(
      "--dog-head-mask",
      `image-set(url("${dogHeadUrl}") 1x, url("${dogHeadRetinaUrl}") 2x)`,
    );
    return mark;
  }
  const image = document.createElement("img");
  image.className = "app-brand-icon";
  image.src = appIconUrl;
  image.alt = "";
  return image;
}
