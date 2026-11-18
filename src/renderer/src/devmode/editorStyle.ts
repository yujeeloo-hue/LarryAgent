import type { editor } from "monaco-editor";

// Keep scrollbar tracks and thumbs the same size in every editor view.
export const devModeEditorScrollbar: editor.IEditorScrollbarOptions = {
  verticalScrollbarSize: 12,
  verticalSliderSize: 12,
  horizontalScrollbarSize: 12,
  horizontalSliderSize: 12,
};

export const devModeDiffLayout = {
  renderSideBySide: true,
  enableSplitViewResizing: true,
  // The separate hunk toolbar inserts its own sash. Keep revert actions in the glyph margin.
  renderGutterMenu: false,
  renderMarginRevertIcon: true,
} satisfies editor.IDiffEditorOptions;

export const devModeScrollbarColors = {
  "scrollbarSlider.background": "#ffffff55",
  "scrollbarSlider.hoverBackground": "#ffffff80",
  "scrollbarSlider.activeBackground": "#00e5ff99",
};

export const devModeBlueScrollbarColors = {
  ...devModeScrollbarColors,
  "scrollbarSlider.activeBackground": "#007affb3",
};
