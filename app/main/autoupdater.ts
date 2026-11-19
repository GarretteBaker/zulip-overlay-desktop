import {shell} from "electron/common";
import {app, dialog} from "electron/main";
import process from "node:process";

import log from "electron-log/main";
import {
  type UpdateDownloadedEvent,
  type UpdateInfo,
  autoUpdater,
} from "electron-updater";

import * as ConfigUtil from "../common/config-util.ts";
import {overlayDownloadUrl} from "../common/overlay-config.ts";
import {t} from "../common/translation-util.ts";

let quitting = false;

export function shouldQuitForUpdate(): boolean {
  return quitting;
}

export async function appUpdater(updateFromMenu = false): Promise<void> {
  // Don't initiate auto-updates in development
  if (!app.isPackaged) {
    return;
  }

  // Zulip overlay: updates come from this fork's own GitHub releases (the
  // `publish` setting in package.json), never from Zulip's. Two cases cannot
  // update themselves: macOS, where the updater needs an Apple Developer ID
  // signature this build lacks, and a Linux copy that is not an AppImage.
  // There the overlay's in-page notice says when a newer version exists.
  if (
    process.platform === "darwin" ||
    (process.platform === "linux" && !("APPIMAGE" in process.env))
  ) {
    if (updateFromMenu) {
      const {response} = await dialog.showMessageBox({
        buttons: ["Open the download page", "Cancel"],
        message: `${app.name} ${app.getVersion()} cannot update itself on this system.`,
        detail: `Newer versions are at ${overlayDownloadUrl}`,
      });
      if (response === 0) {
        await shell.openExternal(overlayDownloadUrl);
      }
    }

    return;
  }

  let updateAvailable = false;

  // Log what's happening
  const updateLogger = log.create({logId: "updates"});
  updateLogger.transports.file.fileName = "updates.log";
  updateLogger.transports.file.level = "info";
  autoUpdater.logger = updateLogger;

  // Handle auto updates for beta/pre releases
  const isBetaUpdate = ConfigUtil.getConfigItem("betaUpdate", false);

  autoUpdater.allowPrerelease = isBetaUpdate;

  const eventsListenerRemove = [
    "update-available",
    "update-not-available",
  ] as const;
  autoUpdater.on("update-available", (info: UpdateInfo) => {
    if (updateFromMenu) {
      updateAvailable = true;

      // This is to prevent removal of 'update-downloaded' and 'error' event listener.
      for (const event of eventsListenerRemove) {
        autoUpdater.removeAllListeners(event);
      }

      void dialog.showMessageBox({
        message: t.__(
          "A new version {{{version}}} of Zulip Desktop is available.",
          {version: info.version},
        ),
        detail: t.__(
          "The update will be downloaded in the background. You will be notified when it is ready to be installed.",
        ),
      });
    }
  });

  autoUpdater.on("update-not-available", () => {
    if (updateFromMenu) {
      // Remove all autoUpdator listeners so that next time autoUpdator is manually called these
      // listeners don't trigger multiple times.
      autoUpdater.removeAllListeners();

      void dialog.showMessageBox({
        message: t.__("No updates available."),
        detail: t.__(
          "You are running the latest version of Zulip Desktop.\nVersion: {{{version}}}",
          {version: app.getVersion()},
        ),
      });
    }
  });

  autoUpdater.on("error", (error: Error) => {
    if (updateFromMenu) {
      // Remove all autoUpdator listeners so that next time autoUpdator is manually called these
      // listeners don't trigger multiple times.
      autoUpdater.removeAllListeners();

      const messageText = updateAvailable
        ? t.__("Unable to download the update.")
        : t.__("Unable to check for updates.");
      const link = overlayDownloadUrl;
      (async () => {
        const {response} = await dialog.showMessageBox({
          type: "error",
          buttons: [t.__("Manual Download"), t.__("Cancel")],
          message: messageText,
          detail: t.__(
            "Error: {{{error}}}\n\nThe latest version of Zulip Desktop is available at:\n{{{link}}}\nCurrent version: {{{version}}}",
            {error: error.message, link, version: app.getVersion()},
          ),
        });
        if (response === 0) {
          await shell.openExternal(link);
        }
      })();
    }
  });

  // Ask the user if update is available
  autoUpdater.on("update-downloaded", (event: UpdateDownloadedEvent) => {
    (async () => {
      // Ask user to update the app
      const {response} = await dialog.showMessageBox({
        type: "question",
        buttons: [t.__("Install and Relaunch"), t.__("Install Later")],
        defaultId: 0,
        message: t.__("A new update {{{version}}} has been downloaded.", {
          version: event.version,
        }),
        detail: t.__(
          "It will be installed the next time you restart the application.",
        ),
      });
      if (response === 0) {
        quitting = true;
        autoUpdater.quitAndInstall();
      }
    })();
  });
  // Init for updates
  await autoUpdater.checkForUpdates();
}
