// Builds the Iliad Overlay browser extension from the same overlay script and
// stylesheet the desktop app bundles (app/overlay).
//
//   node extension/build.mjs           → extension/dist/chromium, firefox (for addons.mozilla.org)
//                                        and firefox-selfhosted (to be signed and handed out)
//   node extension/build.mjs --test    → extension/dist/test-chromium and test-firefox as well: run on
//                                        chat.zulip.org while logged out, against a
//                                        development service on this machine
//
// Load extension/dist/chromium with "Load unpacked" on chrome://extensions
// (Developer mode), or extension/dist/firefox/manifest.json with "Load
// Temporary Add-on" on about:debugging. To publish, zip the folder's contents.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.dirname(here);
const {version} = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);

function build(
  name,
  {hosts, service, firefox = false, shim = false, selfHosted = false},
) {
  const out = path.join(here, "dist", name);
  fs.rmSync(out, {recursive: true, force: true});
  fs.mkdirSync(out, {recursive: true});

  for (const file of ["overlay.js", "overlay.css"]) {
    fs.copyFileSync(path.join(root, "app/overlay", file), path.join(out, file));
  }

  fs.copyFileSync(path.join(here, "bridge.js"), path.join(out, "bridge.js"));
  if (shim) {
    fs.copyFileSync(
      path.join(here, "spectator-shim.js"),
      path.join(out, "spectator-shim.js"),
    );
  }

  fs.writeFileSync(
    path.join(out, "background.js"),
    fs
      .readFileSync(path.join(here, "background.js"), "utf8")
      .replace('"__OVERLAY_SERVICE__"', JSON.stringify(service))
      .replace("__OVERLAY_HOSTS__", JSON.stringify(hosts)),
  );
  for (const size of [16, 48, 128]) {
    fs.copyFileSync(
      path.join(here, `icon-${size}.png`),
      path.join(out, `icon-${size}.png`),
    );
  }

  const manifest = {
    manifest_version: 3,
    name: shim ? "Iliad Overlay (TEST BUILD)" : "Iliad Overlay",
    version,
    description:
      "Unofficial. Adds votes, replies, threads and inline reactions to the Alignment Theory Zulip organization.",
    icons: {16: "icon-16.png", 48: "icon-48.png", 128: "icon-128.png"},
    // No host permissions: the overlay service accepts cross-origin calls
    // (they are authorised by a token, not a cookie), and the Zulip page is
    // reached by the content script below.
    background: firefox
      ? {scripts: ["background.js"]}
      : {service_worker: "background.js"},
    content_scripts: [
      {
        matches: hosts.map((host) => `https://${host}/*`),
        js: [...(shim ? ["spectator-shim.js"] : []), "bridge.js", "overlay.js"],
        css: ["overlay.css"],
        run_at: "document_idle",
      },
    ],
    ...(firefox
      ? {
          browser_specific_settings: {
            gecko: {
              id: "overlay@iliad.ac",
              // Where a copy installed from a signed file looks for newer
              // versions; the release workflow writes that file when it
              // signs the add-on. A build for addons.mozilla.org must not
              // have it: Mozilla updates those itself and refuses the key.
              ...(!selfHosted
                ? {}
                : {
                    update_url:
                      "https://github.com/GarretteBaker/zulip-overlay-desktop/releases/latest/download/firefox-updates.json",
                  }),
              strict_min_version: "142.0",
              // What leaves the browser for the overlay service: the token
              // that signs the user in to it, and which topics, messages
              // and passages they vote on or react to.
              data_collection_permissions: {
                required: ["authenticationInfo", "websiteActivity"],
              },
            },
          },
        }
      : {}),
  };
  fs.writeFileSync(
    path.join(out, "manifest.json"),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
  );
  console.log(`${path.relative(root, out)}: ${manifest.name} ${version}`);
}

const real = {
  hosts: ["alignment-theory.zulipchat.com"],
  service: "https://mcp.iliad.ac/overlay",
};
build("chromium", real);
build("firefox", {...real, firefox: true});
build("firefox-selfhosted", {...real, firefox: true, selfHosted: true});
if (process.argv.includes("--test")) {
  const test = {
    hosts: ["chat.zulip.org"],
    service: "http://127.0.0.1:8377",
    shim: true,
  };
  build("test-chromium", test);
  build("test-firefox", {...test, firefox: true});
}
