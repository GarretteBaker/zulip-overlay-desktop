// Iliad Overlay browser extension: what the desktop app's preload script
// gives the overlay script (app/renderer/js/preload.ts), provided here by the
// extension. Loaded before overlay.js, in the same content-script world.

globalThis.zulip_overlay = {
  // The browser updates an extension by itself, so the overlay does not
  // tell the user about newer versions.
  updatesItself: true,
  request: async (method, path, body, token) =>
    chrome.runtime.sendMessage({
      type: "overlay-request",
      method,
      path,
      body,
      token,
    }),
};
