
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
