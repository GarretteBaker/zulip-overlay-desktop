import process from "node:process";

// The overlay script is injected only into these Zulip organizations.
// Every other organization added to the app renders as stock Zulip.
export const overlayHosts = (
  process.env.ZULIP_OVERLAY_HOSTS ?? "alignment-theory.zulipchat.com"
).split(",");

// Where the overlay service (votes, scores) lives. The prototype default is
// a service running on this machine.
export const overlayServiceUrl =
  process.env.ZULIP_OVERLAY_SERVICE ?? "http://127.0.0.1:8377";

// PROTOTYPE, dev only: act as this Zulip user id without asking Zulip who is
// signed in. Lets the app be exercised on a public Zulip page while logged
// out. Goes away with dev sign-in when the real identity exchange lands.
export const overlayDevUserId = process.env.ZULIP_OVERLAY_DEV_USER_ID;

export function isOverlayUrl(url: string): boolean {
  return URL.canParse(url) && overlayHosts.includes(new URL(url).host);
}
