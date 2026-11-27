import { contextBridge, ipcRenderer } from "electron";
import { COMPUTER_USE_TIPS_CHANNEL } from "../shared/computerUseOverlayChannel.js";

contextBridge.exposeInMainWorld("tipsBridge", {
  post: (message: unknown) => ipcRenderer.send(COMPUTER_USE_TIPS_CHANNEL, message),
});
