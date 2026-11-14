/**
 * 64 preset neon identity colors for the graph color picker (8×8 grid).
 *
 * Layout: two hue banks — warm (pink → indigo) then cool (azure → yellow) —
 * each × 4 rows bright→dark. HSL S=100, L=[75, 66, 57, 48], 16 hues:
 * [350, 320, 305, 288, 270, 252, 235, 220, 205, 192, 178, 165, 148, 125,
 *  95, 60]. Systematically generated (python3 colorsys) — regenerate the
 * grid instead of hand-editing single cells.
 */
export const NEON_PALETTE: readonly string[] = [
  // Bank 1: pink → indigo, bright → dark
  "#ff8095", "#ff80d4", "#ff80f4", "#e580ff", "#bf80ff", "#9980ff", "#808aff", "#80aaff",
  "#ff526f", "#ff52c5", "#ff52f1", "#dc52ff", "#a852ff", "#7452ff", "#5260ff", "#528bff",
  "#ff2448", "#ff24b6", "#ff24ed", "#d324ff", "#9124ff", "#5024ff", "#2436ff", "#246dff",
  "#f50029", "#f500a3", "#f500e0", "#c400f5", "#7a00f5", "#3100f5", "#0014f5", "#0052f5",
  // Bank 2: azure → yellow, bright → dark
  "#80caff", "#80e5ff", "#80fffb", "#80ffdf", "#80ffbb", "#80ff8a", "#b5ff80", "#ffff80",
  "#52b7ff", "#52dcff", "#52fff9", "#52ffd4", "#52ffa3", "#52ff60", "#9aff52", "#ffff52",
  "#24a4ff", "#24d3ff", "#24fff8", "#24ffc8", "#24ff8a", "#24ff36", "#7fff24", "#ffff24",
  "#008ff5", "#00c4f5", "#00f5ed", "#00f5b8", "#00f572", "#00f514", "#66f500", "#f5f500",
];
