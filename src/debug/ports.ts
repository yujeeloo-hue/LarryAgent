import { createServer, type AddressInfo } from "node:net";

export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      const port = addr?.port;
      server.close((err) => {
        if (err) reject(err);
        else if (!port) reject(new Error("Failed to allocate a loopback port"));
        else resolve(port);
      });
    });
  });
}

export async function allocateInspectPorts(): Promise<{
  inspectPort: number;
  remoteDebugPort: number;
}> {
  return {
    inspectPort: await allocateLoopbackPort(),
    remoteDebugPort: await allocateLoopbackPort(),
  };
}
