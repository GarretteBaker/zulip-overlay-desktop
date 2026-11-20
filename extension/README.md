# Iliad Overlay as a browser extension

The same overlay the desktop app injects (`app/overlay/overlay.js`, `overlay.css`), run as a
content script on `alignment-theory.zulipchat.com`. Nothing else is installed and no second
browser engine runs.

| File | Job |
| --- | --- |
| `bridge.js` | Gives the overlay script the `zulip_overlay.request` call the desktop app's preload script provides. |
| `background.js` | Relays those requests to the overlay service; the Zulip page's content security policy does not let the page do it. |
| `build.mjs` | Writes `dist/chromium` and `dist/firefox` (they differ only in the manifest). `--test` adds builds that run logged out on chat.zulip.org against a service on this machine. |
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

## Publishing (not done yet; needs Garrett's accounts)

- **Chrome Web Store**: a developer account (5 USD once), upload the chromium zip. Reviewed before
  listing and on every update.
- **Firefox Add-ons**: an account at addons.mozilla.org, upload the firefox zip (listed), or
  `web-ext sign --channel unlisted` with API keys for a signed file to hand out. The manifest's
  add-on id is `overlay@iliad.ac`; it declares that sign-in information and website activity
  (votes, inline reactions) go to the overlay service.

Once listed, the browser updates the extension itself.

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
