import { colorIconSources } from "../../../shared/icons/colorIcons.js";
import type { AgentNavId } from "../navigation/types.js";
import { agentNavIcons, createLucideIcon } from "../ui/icons.js";
import { createCocoIcon } from "../ui/cocoIcon.js";

const artwork = {
  "new-task": colorIconSources.navigation["new-task"],
  loop: colorIconSources.navigation.coco,
  tools: colorIconSources.navigation.tools,
  skills: colorIconSources.navigation.skills,
  graphs: colorIconSources.navigation.graphs,
} satisfies Record<Exclude<AgentNavId, "search">, string>;

/** Navigation keeps the approved full-color artwork in every selection state. */
export function createAgentNavIcon(id: AgentNavId): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "agent-nav-icon";
  icon.setAttribute("aria-hidden", "true");

  if (id === "loop") {
    icon.append(createCocoIcon(17, "global"));
    return icon;
  }

  if (id === "search") {
    icon.append(createLucideIcon(agentNavIcons.search));
    return icon;
  }

  const image = document.createElement("img");
  image.className = "agent-nav-artwork";
  image.src = artwork[id];
  image.alt = "";
  image.width = 17;
  image.height = 17;
  image.draggable = false;
  icon.append(image);
  return icon;
}
