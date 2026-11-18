import auto from "../assets/library/graph-auto.svg";
import ask from "../assets/library/graph-ask.svg";
import plan from "../assets/library/graph-plan.svg";
import subagent from "../assets/library/graph-subagent.svg";
import graph from "../assets/library/graph.svg";
import skill from "../assets/library/skill.svg";
import "./library.css";

const templateSources = { react: auto, react_v2: auto, ask, plan_execute: plan, subagent };

export function createGraphTemplateIcon(mode: keyof typeof templateSources): HTMLImageElement {
  const icon = document.createElement("img");
  icon.src = templateSources[mode];
  icon.width = icon.height = 20;
  icon.alt = "";
  icon.draggable = false;
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

export function createLibraryBadge(kind: "graph" | "skill"): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "library-icon-badge";
  badge.setAttribute("aria-hidden", "true");
  const icon = document.createElement("span");
  icon.className = "app-mono-icon";
  icon.style.setProperty("--app-mono-source", `url("${kind === "graph" ? graph : skill}")`);
  badge.append(icon);
  return badge;
}
