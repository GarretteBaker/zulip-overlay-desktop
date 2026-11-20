// Iliad Overlay browser extension: background worker.
//
// The overlay script runs in the Zulip page, whose content security policy
// does not let it talk to the overlay service. It asks this worker instead,
// which is the extension's counterpart of the desktop app's main-process
// relay (app/main/index.ts, "overlay-request").
//
// SERVICE and HOSTS are filled in by build.mjs.

const SERVICE = "__OVERLAY_SERVICE__";
const HOSTS = __OVERLAY_HOSTS__;

async function relay({method, path, body, token}) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error(`overlay-request path must start with /: ${path}`);
  }

  // A status of 0 tells the overlay script the service is unreachable.
  const response = await fetch(SERVICE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token === undefined ? {} : {Authorization: `Bearer ${token}`}),
    },
    body: body === undefined ? null : JSON.stringify(body),
  }).catch((error) => {
    console.error("overlay service unreachable", error);
    return undefined;
  });
  if (response === undefined) {
    return {status: 0, body: undefined};
  }

  const text = await response.text();
  const isJson = response.headers
    .get("content-type")
    ?.startsWith("application/json");
  return {
    status: response.status,
    body: isJson
      ? JSON.parse(text)
      : {detail: `the overlay service failed (${response.status})`},
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "overlay-request") {
    return false;
  }

  // Only this extension's own content script, on a page of an overlay
  // organization, may use the relay.
  const from = URL.canParse(sender.url ?? "") ? new URL(sender.url).host : "";
  if (sender.id !== chrome.runtime.id || !HOSTS.includes(from)) {
    sendResponse({status: 0, body: undefined});
    return false;
  }

  relay(message).then(sendResponse, (error) => {
    console.error("overlay-request failed", error);
    sendResponse({status: 0, body: undefined});
  });
  return true; // The answer comes later.
});
