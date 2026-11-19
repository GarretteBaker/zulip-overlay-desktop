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

// The zulip-desktop release this fork is based on. Change it when merging a
// newer upstream release.
export const upstreamVersion = "5.14.2";

// Where people download this app. The updater's own address is the `publish`
// setting in package.json.
export const overlayDownloadUrl =
  "https://github.com/GarretteBaker/zulip-overlay-desktop/releases";

// Where the macOS updater looks for mac-update.json and the zip it names:
// the newest release that is not a pre-release. Must match the `publish`
// address in package.json, which the Windows and Linux updater uses.
// ILIAD_OVERLAY_UPDATE_URL points it elsewhere for the update test.
export const overlayUpdateUrl =
  process.env.ILIAD_OVERLAY_UPDATE_URL ??
  "https://github.com/GarretteBaker/zulip-overlay-desktop/releases/latest/download";

export function isOverlayUrl(url: string): boolean {
  return URL.canParse(url) && overlayHosts.includes(new URL(url).host);
}
