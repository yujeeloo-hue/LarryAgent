/** The landing page's character fire, scoped to the unauthenticated login view. */
type Shape = {
  x: number;
  width: number;
  height: number;
  bend: number;
  taper: number;
  strength: number;
};

type Tongue = {
  anchor: number;
  from: Shape;
  to: Shape;
  current: Shape;
  started: number;
  duration: number;
  phase: number;
};

const glyphs: [string[], string[], string[], string[]] = [
  Array.from(".:;+=*%#@/|~^"),
  Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"),
  Array.from("あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん"),
  Array.from("アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン"),
];
const anchors = [-1.05, -0.70, -0.36, 0, 0.35, 0.70, 1.05];
const firstHeights = [0.72, 0.59, 0.83, 0.94, 0.66, 0.87, 0.71];
type Rgb = readonly [number, number, number];
const violet: Rgb = [69, 26, 133];
const crimson: Rgb = [204, 23, 56];
const blueRim: Rgb = [18, 97, 168];
const warm: Rgb = [247, 125, 84];

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}
function smooth(low: number, high: number, value: number): number {
  const q = clamp((value - low) / (high - low), 0, 1);
  return q * q * (3 - 2 * q);
}
function hash(a: number, b: number, c: number): number {
  const n = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return n - Math.floor(n);
}
function mix(a: number, b: number, amount: number): number {
  return a + (b - a) * amount;
}
function newShape(anchor: number): Shape {
  return {
    x: anchor + (Math.random() - 0.5) * 0.19,
    width: 0.27 + Math.random() * 0.15,
    height: 0.57 + Math.random() * 0.39,
    bend: (Math.random() - 0.5) * 0.32,
    taper: 0.26 + Math.random() * 0.27,
    strength: 0.76 + Math.random() * 0.32,
  };
}

export function mountLoginFire(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return () => {};

  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  let width = 0;
  let height = 0;
  let cellX = 16;
  let cellY = 20;
  let columns = 0;
  let rows = 0;
  let timer: number | null = null;
  let active = true;
  const tongues: Tongue[] = anchors.map((anchor, index) => {
    const initial = newShape(anchor);
    initial.height = clamp((firstHeights[index] ?? 0.72) + (Math.random() - 0.5) * 0.10, 0.57, 0.96);
    return {
      anchor, from: initial, to: newShape(anchor), current: initial,
      started: performance.now() * 0.001, duration: 2.2 + Math.random() * 2.8,
      phase: Math.random() * Math.PI * 2,
    };
  });

  function updateShapes(time: number): void {
    for (const tongue of tongues) {
      if (time >= tongue.started + tongue.duration) {
        tongue.from = tongue.current;
        tongue.to = newShape(tongue.anchor);
        tongue.started = time;
        tongue.duration = 2.2 + Math.random() * 2.8;
      }
      const k = smooth(0, 1, (time - tongue.started) / tongue.duration);
      const a = tongue.from;
      const b = tongue.to;
      tongue.current = {
        x: mix(a.x, b.x, k), width: mix(a.width, b.width, k),
        height: mix(a.height, b.height, k), bend: mix(a.bend, b.bend, k),
        taper: mix(a.taper, b.taper, k), strength: mix(a.strength, b.strength, k),
      };
    }
  }

  function color(heat: number, blue: boolean): string {
    const amount = smooth(0.15, 0.98, heat);
    const a = amount < 0.58 ? violet : crimson;
    const b = amount < 0.58 ? crimson : warm;
    const k = amount < 0.58 ? amount / 0.58 : (amount - 0.58) / 0.42;
    let r = mix(a[0], b[0], k);
    let g = mix(a[1], b[1], k);
    let bl = mix(a[2], b[2], k);
    if (blue) {
      r = mix(r, blueRim[0], 0.72);
      g = mix(g, blueRim[1], 0.72);
      bl = mix(bl, blueRim[2], 0.72);
    }
    const opacity = clamp((heat - 0.10) * 1.20, 0, 0.88);
    return `rgba(${r.toFixed(0)},${g.toFixed(0)},${bl.toFixed(0)},${opacity.toFixed(2)})`;
  }

  function glyph(col: number, row: number, step: number): string {
    const kind = hash(col + 7, row - 11, step + 31);
    const group = glyphs[kind < 0.13 ? 0 : kind < 0.56 ? 1 : kind < 0.78 ? 2 : 3] ?? glyphs[1];
    return group[Math.floor(hash(col - 29, row + 47, step + 59) * group.length)] ?? ".";
  }

  function draw(time: number): void {
    ctx!.clearRect(0, 0, width, height);
    updateShapes(time);
    const step = Math.floor(time * 6);
    for (let row = 0; row < rows; row++) {
      const py = row * cellY + cellY * 0.5;
      const rise = (height - py) / height;
      if (rise > 0.96) continue;
      for (let col = 0; col < columns; col++) {
        const px = col * cellX + cellX * 0.5;
        const x = (px / width) * 2 - 1;
        const warp = 0.075 * Math.sin(rise * 17 + time * 1.25 + x * 5)
          + 0.040 * Math.sin(rise * 39 - time * 2.6 + x * 13);
        let heat = 0;
        for (const tongue of tongues) {
          const p = tongue.current;
          const tip = p.height + 0.045 * Math.sin(time * 1.25 + tongue.phase);
          const dx = (x - p.x - p.bend * rise - warp * (0.35 + rise)) / (p.width * (1 - p.taper * rise));
          const body = Math.exp(-1.8 * dx * dx);
          const heightMask = 1 - smooth(tip - 0.19, tip + 0.035, rise);
          const flicker = 0.86 + 0.14 * Math.sin(x * 15 + rise * 28 - time * 4 + tongue.phase);
          heat = Math.max(heat, body * heightMask * flicker * p.strength * (1.02 - 0.30 * rise));
        }
        heat += 0.22 * Math.exp(-rise * 13);
        const grain = hash(col, row, step);
        heat += (grain - 0.5) * 0.20;
        if (heat < 0.20 || hash(col + 19, row - step, 3) > smooth(0.12, 0.72, heat)) continue;
        const blueChance = 0.10 + 0.19 * smooth(0.35, 0.95, Math.abs(x));
        ctx!.fillStyle = color(heat, hash(col + 61, row - 17, step + 7) < blueChance);
        ctx!.fillText(glyph(col, row, step), px, py);
      }
    }
  }

  function resize(): void {
    width = Math.max(1, canvas.clientWidth || window.innerWidth);
    height = Math.max(1, canvas.clientHeight || window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    const scale = Math.max(1, width / 1600, height / 950);
    cellX = (width < 520 ? 13 : 16) * scale;
    cellY = (width < 520 ? 17 : 20) * scale;
    columns = Math.ceil(width / cellX) + 1;
    rows = Math.ceil(height / cellY) + 1;
    ctx!.textAlign = "center";
    ctx!.textBaseline = "middle";
    ctx!.font = `${(width < 520 ? 12 : 14) * scale}px SFMono-Regular, Menlo, Consolas, ui-monospace, "Hiragino Sans", "Yu Gothic", monospace`;
    draw(media.matches ? 1.7 : performance.now() * 0.001);
  }

  function stopTimer(): void {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  }
  function start(): void {
    stopTimer();
    if (!active) return;
    if (document.hidden || media.matches) {
      draw(1.7);
      return;
    }
    timer = window.setInterval(() => draw(performance.now() * 0.001), 1000 / 15);
  }

  window.addEventListener("resize", resize, { passive: true });
  document.addEventListener("visibilitychange", start);
  media.addEventListener("change", start);
  resize();
  start();
  return () => {
    active = false;
    stopTimer();
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", start);
    media.removeEventListener("change", start);
  };
}
