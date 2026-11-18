import {contextBridge} from "electron/renderer";

import electron_bridge, {BridgeEvent, bridgeEvents} from "./electron-bridge.ts";
import * as NetworkError from "./pages/network.ts";
import {ipcRenderer} from "./typed-ipc-renderer.ts";

contextBridge.exposeInMainWorld("electron_bridge", electron_bridge);

// Zulip overlay: the injected overlay script reaches the overlay service
// through the main process, which checks the calling page and is not
// subject to the page's content security policy.
contextBridge.exposeInMainWorld("zulip_overlay", {
  request: async (
    method: string,
    path: string,
    body: unknown,
    token: string | undefined,
  ) => ipcRenderer.invoke("overlay-request", method, path, body, token),
});

ipcRenderer.on("logout", () => {
  bridgeEvents.dispatchEvent(new BridgeEvent("logout"));
});

ipcRenderer.on("show-keyboard-shortcuts", () => {
  bridgeEvents.dispatchEvent(new BridgeEvent("show-keyboard-shortcuts"));
});

ipcRenderer.on("show-notification-settings", () => {
  bridgeEvents.dispatchEvent(new BridgeEvent("show-notification-settings"));
});

window.addEventListener("load", () => {
  if (!location.href.includes("app/renderer/network.html")) {
    return;
  }

  const $reconnectButton = document.querySelector("#reconnect")!;
  const $settingsButton = document.querySelector("#settings")!;
  NetworkError.init($reconnectButton, $settingsButton);
});
