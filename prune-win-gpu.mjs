/**
 * electron-builder afterPack hook (Windows): drop GPU binaries that no code
 * path in this app can reach.
 *
 * Lives at the repo root (not scripts/, which .gitignore excludes) because
 * electron-builder resolves this path at package time — an untracked hook
 * would break dist:win on a fresh clone.
 *
 * dxcompiler.dll (24.4MB) + dxil.dll (1.4MB) are Chromium's DirectX Shader
 * Compiler, used *only* to translate WGSL into DXIL for Dawn (WebGPU). This
 * app never touches WebGPU:
 *   - src/ has zero navigator.gpu / requestAdapter / WebGL calls;
 *   - Monaco bundles an experimental WebGPU renderer, but it is gated behind
 *     the editor option `experimentalGpuAcceleration`, which defaults to
 *     "off" and is never set here;
 *   - cytoscape's webgl renderer is likewise opt-in (`webgl: false` default).
 * Without WebGPU, Dawn never initializes and these DLLs are never loaded.
 *
 * Deliberately KEPT:
 *   - d3dcompiler_47.dll — ANGLE's HLSL compiler, used by ordinary 2D canvas
 *     and compositing on the D3D11 backend.
 *   - vk_swiftshader.dll / vulkan-1.dll / libGLESv2.dll / libEGL.dll — the
 *     software-rendering fallback that keeps the UI alive under RDP, VMs and
 *     blocklisted drivers.
 *
 * Failing loudly matters: a silent no-op here would let a future Electron
 * bump quietly re-add the payload, so a missing file is an error, not a warn.
 */
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Dawn/WebGPU-only shader toolchain. */
const PRUNE = ["dxcompiler.dll", "dxil.dll"];

export default async function pruneWinGpu(context) {
  if (context.electronPlatformName !== "win32") return;

  let freed = 0;
  for (const name of PRUNE) {
    const target = join(context.appOutDir, name);
    const { size } = await stat(target).catch(() => {
      throw new Error(
        `[prune-win-gpu] expected ${name} in ${context.appOutDir} but it is missing — ` +
          `Electron's payload changed; re-check whether this prune is still correct.`,
      );
    });
    await rm(target);
    freed += size;
  }

  console.log(
    `  • pruned unused GPU binaries  files=${PRUNE.length} freed=${(freed / 1024 / 1024).toFixed(1)}MB`,
  );
}
