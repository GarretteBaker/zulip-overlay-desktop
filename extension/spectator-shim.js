// TEST BUILD ONLY (build.mjs --test). Lets the overlay run on a web-public
// Zulip page while logged out, as harness/harness.cjs does for the desktop
// script: a spectator has no account, so "who am I" and "is this channel
// private" are answered here, and message fetches go through the web-public
// narrow. Never part of a build people install.

// The overlay uses content.fetch in Firefox and fetch elsewhere.
const firefox = typeof globalThis.content?.fetch === "function";
const realFetch = firefox
  ? globalThis.content.fetch.bind(globalThis.content)
  : globalThis.fetch.bind(globalThis);
const shimmed = async (input, init) => {
  const target = String(input);
  if (target.startsWith("/json/users/me")) {
    return new Response(JSON.stringify({user_id: 424242}), {status: 200});
  }

  if (/^\/json\/streams\/\d+$/.test(target)) {
    return new Response(JSON.stringify({stream: {invite_only: false}}), {
      status: 200,
    });
  }

  if (target.startsWith("/json/messages?")) {
    const parameters = new URLSearchParams(target.slice(target.indexOf("?") + 1));
    const narrow = JSON.parse(parameters.get("narrow") ?? "[]");
    narrow.push({operator: "channels", operand: "web-public"});
    parameters.set("narrow", JSON.stringify(narrow));
    return realFetch(`/json/messages?${parameters}`, init);
  }

  return realFetch(input, init);
};

if (firefox) {
  globalThis.content.fetch = shimmed;
} else {
  globalThis.fetch = shimmed;
}
