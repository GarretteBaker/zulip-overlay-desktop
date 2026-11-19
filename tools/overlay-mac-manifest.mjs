// Writes mac-update.json beside the macOS zips electron-builder produced.
// The app's own macOS updater (app/main/mac-updater.ts) reads it.
//
//   node tools/overlay-mac-manifest.mjs [dist] [version]
//
// The version defaults to package.json's.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const directory = process.argv[2] ?? "dist";
const version =
  process.argv[3] ?? JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const files = {};
for (const arch of ["arm64", "x64"]) {
  const name = `Iliad-Overlay-${version}-${arch}.zip`;
  const file = path.join(directory, name);
  if (!fs.existsSync(file)) {
    continue;
  }

  const sha512 = crypto
    .createHash("sha512")
    .update(fs.readFileSync(file))
    .digest("hex");
  files[arch] = {name, sha512, size: fs.statSync(file).size};
}

if (Object.keys(files).length === 0) {
  throw new Error(`no Iliad-Overlay-${version}-<arch>.zip in ${directory}`);
}

const target = path.join(directory, "mac-update.json");
fs.writeFileSync(target, `${JSON.stringify({version, files}, undefined, 2)}\n`);
console.log(`${target}: ${version} ${Object.keys(files).join(", ")}`);
