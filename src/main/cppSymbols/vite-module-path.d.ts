/** electron-vite bundles a node worker and exposes its output path. */
declare module "*?modulePath" {
  const workerModulePath: string;
  export default workerModulePath;
}
