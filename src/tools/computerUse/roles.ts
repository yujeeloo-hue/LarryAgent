import type { ComputerUsePlatform } from "./types.js";

const AX_TO_UIA: Record<string, string> = {
  AXButton: "ButtonControl",
  AXCheckBox: "CheckBoxControl",
  AXRadioButton: "RadioButtonControl",
  AXComboBox: "ComboBoxControl",
  AXPopUpButton: "ComboBoxControl",
  AXTextField: "EditControl",
  AXTextArea: "EditControl",
  AXStaticText: "TextControl",
  AXMenuItem: "MenuItemControl",
  AXMenuBarItem: "MenuItemControl",
  AXMenu: "MenuControl",
  AXMenuBar: "MenuBarControl",
  AXWindow: "WindowControl",
  AXTabGroup: "TabControl",
  AXTab: "TabItemControl",
  AXGroup: "GroupControl",
  AXImage: "ImageControl",
  AXList: "ListControl",
  AXListItem: "ListItemControl",
  AXScrollBar: "ScrollBarControl",
  AXSlider: "SliderControl",
  AXSpinner: "SpinnerControl",
  AXTree: "TreeControl",
  AXTreeItem: "TreeItemControl",
  AXToolbar: "ToolBarControl",
  AXLink: "HyperlinkControl",
  AXTable: "TableControl",
  AXDockItem: "ButtonControl",
};

const UIA_TO_AX: Record<string, string> = {
  ButtonControl: "AXButton",
  CheckBoxControl: "AXCheckBox",
  RadioButtonControl: "AXRadioButton",
  ComboBoxControl: "AXComboBox",
  EditControl: "AXTextField",
  TextControl: "AXStaticText",
  MenuItemControl: "AXMenuItem",
  MenuControl: "AXMenu",
  MenuBarControl: "AXMenuBar",
  WindowControl: "AXWindow",
  TabControl: "AXTabGroup",
  TabItemControl: "AXRadioButton",
  GroupControl: "AXGroup",
  ImageControl: "AXImage",
  ListControl: "AXList",
  ListItemControl: "AXCell",
  ScrollBarControl: "AXScrollBar",
  SliderControl: "AXSlider",
  SpinnerControl: "AXIncrementor",
  TreeControl: "AXOutline",
  TreeItemControl: "AXRow",
  ToolBarControl: "AXToolbar",
  HyperlinkControl: "AXLink",
  TableControl: "AXTable",
};

/**
 * Accepts either vocabulary — macOS AX roles ("AXButton") or Windows UIA control types
 * ("ButtonControl" / "Button") — and returns the platform's native role name.
 */
export function normalizeRole(
  role: string | undefined,
  platform: ComputerUsePlatform,
): string | undefined {
  const raw = role?.trim();
  if (!raw) return undefined;
  if (platform === "windows") {
    if (AX_TO_UIA[raw]) return AX_TO_UIA[raw];
    const bare = raw.startsWith("AX") ? raw.slice(2) : raw;
    return bare.endsWith("Control") ? bare : `${bare}Control`;
  }
  if (raw.startsWith("AX")) return raw;
  const uia = raw.endsWith("Control") ? raw : `${raw}Control`;
  if (UIA_TO_AX[uia]) return UIA_TO_AX[uia];
  const bare = raw.endsWith("Control") ? raw.slice(0, -"Control".length) : raw;
  return `AX${bare.charAt(0).toUpperCase()}${bare.slice(1)}`;
}
