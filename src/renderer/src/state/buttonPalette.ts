/** Button-only colors: theme accents stay intact for links and selection. */
type Rgb = readonly [number, number, number];

function rgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const channels = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function mix(hex: string, target: number, amount: number): string {
  return "#" + rgb(hex).map((channel) =>
    Math.round(channel + (target - channel) * amount).toString(16).padStart(2, "0"),
  ).join("");
}

function foreground(hex: string): string {
  const dark = contrast(hex, "#111111"), white = contrast(hex, "#ffffff");
  // Around the crossover neither near-black nor white quite clears AA.
  if (Math.max(dark, white) < 4.5) return "#000000";
  return dark >= white ? "#111111" : "#ffffff";
}

function lightFill(accent: string): string {
  if (contrast(accent, "#ffffff") >= 4.5) return accent;
  for (let step = 1; step <= 100; step++) {
    const candidate = mix(accent, 0, step / 100);
    if (contrast(candidate, "#ffffff") >= 4.6) return candidate;
  }
  return "#000000";
}

/** Every interaction state retains the same readable text color. */
export function buttonPaletteTokens(accent: string, light: boolean): Record<string, string> {
  const normalized = /^#[0-9a-f]{6}$/i.test(accent)
    ? accent.toLowerCase()
    : light ? "#006bd6" : "#00e5ff";
  const base = light ? lightFill(normalized) : normalized;
  const fg = light ? "#ffffff" : foreground(base);
  const target = fg === "#ffffff" ? 0 : 255;
  const primary = light && base === "#006bd6"
    ? [base, "#005fc2", "#0053ad"]
    : [base, mix(base, target, light ? 0.10 : 0.07), mix(base, target, light ? 0.20 : 0.14)];
  return {
    "--button-primary-bg": primary[0]!,
    "--button-primary-bg-hover": primary[1]!,
    "--button-primary-bg-active": primary[2]!,
    "--button-primary-fg": fg,
    "--button-danger-bg": light ? "#c93636" : "rgba(248, 81, 73, 0.14)",
    "--button-danger-bg-hover": light ? "#b82f2f" : "rgba(248, 81, 73, 0.20)",
    "--button-danger-bg-active": light ? "#a62929" : "rgba(248, 81, 73, 0.26)",
    "--button-danger-fg": light ? "#ffffff" : "#ff8580",
    "--button-danger-border": light ? "transparent" : "rgba(248, 81, 73, 0.25)",
    "--button-danger-list-bg": light ? "rgba(201, 54, 54, 0.10)" : "rgba(248, 81, 73, 0.14)",
    "--button-danger-list-bg-hover": light ? "rgba(201, 54, 54, 0.16)" : "rgba(248, 81, 73, 0.20)",
    "--button-danger-list-bg-active": light ? "rgba(201, 54, 54, 0.22)" : "rgba(248, 81, 73, 0.26)",
    "--button-danger-list-fg": light ? "#a62929" : "#ff8580",
    "--button-disabled-bg": light ? "#e5eaf0" : "#303030",
    "--button-disabled-fg": light ? "#647184" : "#a3a3a3",
    "--button-focus-ring": contrast(base, light ? "#ffffff" : "#141414") >= 3
      ? base : light ? "#006bd6" : "#8ab4f8",
  };
}

export function buttonPaletteCss(accent: string, light: boolean): string {
  return Object.entries(buttonPaletteTokens(accent, light))
    .map(([name, value]) => `${name}:${value};`).join("");
}
