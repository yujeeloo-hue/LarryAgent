/**
 * Lazy electron.nativeImage accessor shared by the vision pipeline
 * (src/llm/prepareVisionImage.ts) and object-storage image embedding
 * (src/objectStorage/imageResize.ts).
 *
 * Desktop resolves the real module; headless nodes (jellybot-agentd) have no
 * Electron — the loader resolves to null and callers degrade gracefully (raw
 * bytes passthrough / no-op resize). The dynamic-only import keeps `electron`
 * out of the static module graph, which build-agentd.mjs asserts.
 *
 * NOTE: this is not a session-runtime host concern (see src/host/adapter.ts);
 * it is the image-codec probe for two specific pipelines.
 */

/** Structural subset of electron's NativeImage used by our callers. */
export interface NativeImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: {
    width: number;
    height: number;
    quality: "good" | "better" | "best";
  }): NativeImageLike;
  toJPEG(quality: number): Buffer;
  toPNG(): Buffer;
}

export interface NativeImageModule {
  createFromPath(path: string): NativeImageLike;
  createFromBuffer(bytes: Buffer): NativeImageLike;
}

let nativeImagePromise: Promise<NativeImageModule | null> | null = null;

/** Resolve electron.nativeImage, or null when unavailable (headless). */
export function loadNativeImage(): Promise<NativeImageModule | null> {
  nativeImagePromise ??= (async () => {
    try {
      const mod = (await import("electron")) as {
        nativeImage?: NativeImageModule;
      };
      return typeof mod?.nativeImage?.createFromPath === "function"
        ? mod.nativeImage
        : null;
    } catch {
      return null;
    }
  })();
  return nativeImagePromise;
}
