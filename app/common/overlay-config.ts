import process from "node:process";

// The overlay script is injected only into these Zulip organizations.
// Every other organization added to the app renders as stock Zulip.
export const overlayHosts = (
  process.env.ZULIP_OVERLAY_HOSTS ?? "alignment-theory.zulipchat.com"
).split(",");

// Where the overlay service (votes, scores, inline reactions) lives. Set
// ZULIP_OVERLAY_SERVICE to use one running on this machine for development.
export const overlayServiceUrl =
  process.env.ZULIP_OVERLAY_SERVICE ?? "https://mcp.iliad.ac/overlay";

export function isOverlayUrl(url: string): boolean {
  return URL.canParse(url) && overlayHosts.includes(new URL(url).host);
}
