// Zulip overlay: self-update on macOS without an Apple Developer ID.
//
// The stock updater (Squirrel.Mac) only installs an update whose code
// signature matches the running app's identity. This build is signed ad hoc,
// which has no identity, so the stock updater cannot be used. This one does
// the same job by hand:
//
//   1. read mac-update.json from the fork's latest GitHub release;
//   2. if it names a newer version, download the zip for this processor and
//      check its SHA-512 against the manifest;
//   3. unpack it, check that the app inside is intact (codesign --verify) and
//      is this app at the promised version;
//   4. ask the user; on yes, quit, swap the new bundle into the place of the
//      running one, and open it.
//
// Trust: the manifest and the zip both come over HTTPS from the same GitHub
// release, so whoever can publish a release there can update every install.
// That is the same trust the Windows and Linux updaters place in it.
//
// It cannot update a copy that is run from the disk image, is "translocated"
// by macOS (opened from Downloads without being moved), or sits in a folder
// the user cannot write to; those keep the in-page notice.

import {shell} from "electron/common";
import {app, dialog} from "electron/main";
import {execFile, spawn} from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {promisify} from "node:util";

import log from "electron-log/main";
import * as semver from "semver";
import {z} from "zod";

import {overlayDownloadUrl, overlayUpdateUrl} from "../common/overlay-config.ts";

const run = promisify(execFile);
const workPrefix = "iliad-overlay-update-";
const bundleId = "ac.iliad.overlay";

const manifestSchema = z.object({
  version: z.string(),
  files: z.record(
    z.string(),
    z.object({name: z.string(), sha512: z.string(), size: z.number()}),
  ),
});

// After the app has quit: put the new bundle where the old one was and open
// it. If the new one cannot be moved in, the old one is put back. Arguments:
// the app's process id, the installed bundle, the new bundle, and where the
// old bundle is set aside.
const swapScript = `
while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
if mv "$2" "$4"; then
  mv "$3" "$2" || mv "$4" "$2"
fi
open "$2"
`;

async function plistValue(bundle: string, key: string): Promise<string> {
  const {stdout} = await run("/usr/bin/defaults", [
    "read",
    path.join(bundle, "Contents", "Info"),
    key,
  ]);
  return stdout.trim();
}

async function offerDownloadPage(reason: string): Promise<void> {
  const {response} = await dialog.showMessageBox({
    buttons: ["Open the download page", "Cancel"],
    message: `${app.name} ${app.getVersion()} cannot update itself: ${reason}.`,
    detail: `Newer versions are at ${overlayDownloadUrl}`,
  });
  if (response === 0) {
    await shell.openExternal(overlayDownloadUrl);
  }
}

async function writable(target: string): Promise<boolean> {
  return fs.promises.access(target, fs.constants.W_OK).then(
    () => true,
    () => false,
  );
}

// Why this copy of the app cannot replace itself, if it cannot.
async function obstacle(bundle: string): Promise<string | undefined> {
  if (!bundle.endsWith(".app")) {
    return "it is not running from an application bundle";
  }

  if (bundle.startsWith("/Volumes/")) {
    return "it is running from the disk image; drag it to Applications first";
  }

  if (bundle.includes("/AppTranslocation/")) {
    return "macOS is running it from a temporary copy; move it to Applications and open it again";
  }

  for (const target of [bundle, path.dirname(bundle)]) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await writable(target))) {
      return `your account cannot change ${target}`;
    }
  }

  return undefined;
}

export async function macUpdate(
  updateFromMenu: boolean,
  markQuitting: () => void,
): Promise<void> {
  const logger = log.create({logId: "mac-updates"});
  logger.transports.file.fileName = "updates.log";
  logger.transports.file.level = "info";

  // Work left over from an earlier update or an earlier "Install Later".
  for (const entry of await fs.promises.readdir(os.tmpdir())) {
    if (entry.startsWith(workPrefix)) {
      await fs.promises.rm(path.join(os.tmpdir(), entry), {
        recursive: true,
        force: true,
      });
    }
  }

  const bundle = path.resolve(app.getPath("exe"), "../../..");
  const blocked = await obstacle(bundle);
  if (blocked !== undefined) {
    logger.info(`Cannot self-update: ${blocked}`);
    if (updateFromMenu) {
      await offerDownloadPage(blocked);
    }

    return;
  }

  logger.info(`Checking ${overlayUpdateUrl}/mac-update.json`);
  const response = await fetch(`${overlayUpdateUrl}/mac-update.json`);
  if (!response.ok) {
    throw new Error(`mac-update.json: HTTP ${response.status}`);
  }

  const manifest = manifestSchema.parse(await response.json());
  if (!semver.gt(manifest.version, app.getVersion())) {
    logger.info(`Up to date (${app.getVersion()}, latest ${manifest.version})`);
    if (updateFromMenu) {
      await dialog.showMessageBox({
        message: "No updates available.",
        detail: `You are running the latest version of ${app.name}.\nVersion: ${app.getVersion()}`,
      });
    }

    return;
  }

  const file = manifest.files[process.arch];
  if (file === undefined) {
    throw new Error(`mac-update.json has no file for ${process.arch}`);
  }

  if (path.basename(file.name) !== file.name) {
    throw new Error(`mac-update.json names a path, not a file: ${file.name}`);
  }

  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), workPrefix));
  const zip = path.join(work, "update.zip");
  logger.info(`Found ${manifest.version}; downloading ${file.name}`);
  const download = await fetch(
    `${overlayUpdateUrl}/${encodeURIComponent(file.name)}`,
  );
  if (!download.ok || download.body === null) {
    throw new Error(`${file.name}: HTTP ${download.status}`);
  }

  const hash = crypto.createHash("sha512");
  const out = await fs.promises.open(zip, "w");
  const reader = download.body.getReader();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const {done, value} = await reader.read();
    if (done) {
      break;
    }

    hash.update(value);
    // eslint-disable-next-line no-await-in-loop
    await out.write(value);
  }

  await out.close();
  const digest = hash.digest("hex");
  if (digest !== file.sha512) {
    throw new Error(
      `${file.name} does not match its checksum (got ${digest}); not installing`,
    );
  }

  const unpacked = path.join(work, "new");
  await run("/usr/bin/ditto", ["-x", "-k", zip, unpacked]);
  const apps = (await fs.promises.readdir(unpacked)).filter((entry) =>
    entry.endsWith(".app"),
  );
  if (apps.length !== 1) {
    throw new Error(`expected one app in ${file.name}, found ${apps.length}`);
  }

  const fresh = path.join(unpacked, apps[0]!);
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", fresh]);
  const [freshId, freshVersion] = await Promise.all([
    plistValue(fresh, "CFBundleIdentifier"),
    plistValue(fresh, "CFBundleShortVersionString"),
  ]);
  if (freshId !== bundleId || freshVersion !== manifest.version) {
    throw new Error(
      `${file.name} holds ${freshId} ${freshVersion}, not ${bundleId} ${manifest.version}`,
    );
  }

  logger.info(`Version ${manifest.version} is downloaded and checked`);
  if (process.env.ILIAD_OVERLAY_UPDATE_AUTOINSTALL !== "1") {
    const {response: choice} = await dialog.showMessageBox({
      type: "question",
      buttons: ["Install and Relaunch", "Install Later"],
      defaultId: 0,
      message: `A new update ${manifest.version} has been downloaded.`,
      detail:
        "Installing replaces this copy of the app and opens the new one. Later asks again the next time the app starts.",
    });
    if (choice !== 0) {
      return;
    }
  }

  logger.info(`Installing ${manifest.version} over ${bundle}`);
  spawn(
    "/bin/sh",
    [
      "-c",
      swapScript,
      "sh",
      String(process.pid),
      bundle,
      fresh,
      path.join(work, "old.app"),
    ],
    {detached: true, stdio: "ignore"},
  ).unref();
  markQuitting();
  app.quit();
}
