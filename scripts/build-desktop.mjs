import { build } from "esbuild";
import { rebuild } from "@electron/rebuild";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("This release target requires an Apple Silicon Mac.");
}
const stage = resolve(".desktop-stage");
mkdirSync(stage, { recursive: true });
const source = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = {
  name: "claudio", productName: "Claudio", version: source.version, private: true, type: "module",
  description: "A personal AI music radio for your desktop.", main: "main.cjs",
  dependencies: source.dependencies,
};
writeFileSync(`${stage}/package.json`, JSON.stringify(manifest, null, 2) + "\n");
// A separate install keeps Electron's SQLite ABI rebuild away from the Node development server.
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
lock.name = manifest.name;
lock.packages[""] = { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies };
writeFileSync(`${stage}/package-lock.json`, JSON.stringify(lock, null, 2) + "\n");
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit" });
const hostAddon = resolve("node_modules/better-sqlite3/build/Release/better_sqlite3.node");
const fingerprint = () => existsSync(hostAddon) ? createHash("sha256").update(readFileSync(hostAddon)).digest("hex") : null;
const before = fingerprint();
await rebuild({ buildPath: stage, projectRootPath: stage, electronVersion: source.devDependencies.electron,
  arch: "arm64", onlyModules: ["better-sqlite3"] });
if (before !== fingerprint()) throw new Error("Desktop rebuild modified the development SQLite addon");
await build({ entryPoints: ["desktop/main.ts"], outfile: `${stage}/main.cjs`, bundle: true,
  platform: "node", format: "cjs", target: "node22", external: ["electron"] });
await build({ entryPoints: ["desktop/preload.ts"], outfile: `${stage}/preload.cjs`, bundle: true,
  platform: "node", format: "cjs", target: "node22", external: ["electron"] });
await build({ entryPoints: ["server/desktop-runtime.ts"], outfile: `${stage}/backend.mjs`, bundle: true,
  platform: "node", format: "esm", target: "node22", packages: "external" });
cpSync("dist", `${stage}/web`, { recursive: true });
for (const file of ["README.md", "public/ambient/CREDITS.txt", "public/fonts/OFL-IBMPlexMono.txt", "public/fonts/OFL-NotoSansSC.txt"]) {
  if (existsSync(file)) cpSync(file, `${stage}/${file.split("/").at(-1)}`);
}
console.log(`Desktop staging ready: ${stage}`);
