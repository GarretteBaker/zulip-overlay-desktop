# Iliad Overlay as a browser extension

The same overlay the desktop app injects (`app/overlay/overlay.js`, `overlay.css`), run as a
content script on `alignment-theory.zulipchat.com`. Nothing else is installed and no second
browser engine runs.

| File | Job |
| --- | --- |
| `bridge.js` | Gives the overlay script the `zulip_overlay.request` call the desktop app's preload script provides. |
| `background.js` | Relays those requests to the overlay service; the Zulip page's content security policy does not let the page do it. |
| `build.mjs` | Writes `dist/chromium`, `dist/firefox` and `dist/firefox-selfhosted` (they differ only in the manifest). `--test` adds builds that run logged out on chat.zulip.org against a service on this machine. |
| `spectator-shim.js` | Test builds only. |

The extension asks for no permissions beyond running on the organization's Zulip pages. The
overlay service accepts cross-origin calls, which a token authorises, not a cookie.

## Install without a store

    node extension/build.mjs

- **Chrome, Chromium, Brave, Edge, Arc, Vivaldi**: `chrome://extensions` → Developer mode →
  "Load unpacked" → `extension/dist/chromium` (or the unzipped release zip). It stays installed;
  the browser may remind you about developer-mode extensions. It does not update itself.
- **Firefox**: `about:debugging` → This Firefox → "Load Temporary Add-on" →
  `extension/dist/firefox/manifest.json`. Firefox removes it on restart; a permanent install needs
  the add-on signed by Mozilla.

## Self-update

A browser only updates an extension it got from a source it trusts. "Load unpacked" and temporary
add-ons never update.

- **Firefox: on since 20 November 2026.** The repository secrets `AMO_JWT_ISSUER` and
  `AMO_JWT_SECRET` belong to a Mozilla account made for this (muse.iliad@gmail.com, display name
  "Iliad"; its sign-in details are in `~/.config/muse-accounts/` on Garrett's laptop). The release
  workflow has Mozilla sign `dist/firefox-selfhosted` for distribution outside its store and
  publishes `Iliad-Overlay-firefox-<version>.xpi` with `firefox-updates.json`. People install the
  `.xpi` once; Firefox then updates it from each new release. 0.3.4 was signed by hand with the same
  command and attached to its release; the workflow's own signing step first runs with 0.3.5.
  Mozilla refuses to sign the same version twice.
- **Chrome and the rest of that family: not done.** Only the Chrome Web Store updates extensions on
  Windows and macOS. It takes a developer account (5 USD once) and a review before the first
  listing and each update; the listing can be "unlisted" (reachable only by link). Upload the
  chromium zip.
- **A listing on addons.mozilla.org** instead of self-distribution: upload `dist/firefox` (it has
  no update address; Mozilla refuses one and updates listed add-ons itself).

The manifest's Firefox add-on id is `overlay@iliad.ac`; it declares that sign-in information and
website activity (votes, inline reactions) go to the overlay service.

## Checking a change

    (cd ../service && OVERLAY_DEV_AUTH=1 OVERLAY_ALLOW_SELF_VOTES=1 uv run python overlay_service.py) &
    node extension/build.mjs --test
    chromium-browser --user-data-dir=/some/empty/dir --load-extension=$PWD/extension/dist/test-chromium \
        --disable-features=DisableLoadExtensionCommandLineSwitch 'https://chat.zulip.org/#narrow/channel/137-feedback'
    pnpm dlx web-ext run --source-dir extension/dist/test-firefox \
        --start-url 'https://chat.zulip.org/#narrow/channel/137-feedback'
    pnpm dlx web-ext lint --source-dir extension/dist/firefox

Checked on 20 November 2026 in Chromium and Firefox 160 with the test builds: the overlay draws,
a vote reaches the service through the relay. Not checked: a signed-in session on the real
organization in either browser (the sign-in message to the bot, replies, threads, reactions).
