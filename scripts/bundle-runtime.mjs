#!/usr/bin/env node
/**
 * Build the standalone Pi Studio runtime asset.
 *
 * This script creates the versioned Node.js + Pi archive that electron-builder
 * embeds in the desktop installer and writes its integrity manifest into
 * resources/. All pruning is implemented with Node's filesystem APIs so it is
 * deterministic on Windows (where `find` is not GNU find and `rm` is absent).
 */

import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const EXPECTED_PI_VERSION = process.env.PI_RUNTIME_VERSION || APP_PACKAGE.piRuntimeVersion;
if (!EXPECTED_PI_VERSION) throw new Error("package.json must specify piRuntimeVersion");
const STAGE = join(ROOT, ".runtime-stage");
const RUNTIME_OUT = join(ROOT, "runtime-release");
const MANIFEST_OUT = join(ROOT, "resources", "runtime-manifest.json");
const PLATFORM_SLUGS = { win32: "win", darwin: "mac" };
const SUPPORTED_ARCHES = new Set(["x64", "arm64"]);

function log(message) {
  console.log(`[bundle-runtime] ${message}`);
}

function nodeExe() {
  return process.platform === "win32" ? "node.exe" : "node";
}

function tarBinary() {
  if (process.platform === "win32") return join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return "tar";
}

function npmBinary() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function directoryStats(root) {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        files++;
        try {
          bytes += statSync(abs).size;
        } catch {
          /* best effort stats only */
        }
      }
    }
  };
  walk(root);
  return { files, bytes };
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function pruneTree(root) {
  const removableDirs = new Set([
    ".github",
    "__mocks__",
    "__tests__",
    "benchmark",
    "benchmarks",
    "coverage",
    "docs",
    "example",
    "examples",
    "test",
    "tests",
  ]);

  const shouldRemoveFile = (name) =>
    /\.(?:map|d\.ts|d\.mts|d\.cts|ts|mts|cts)$/i.test(name) ||
    /^(?:README|CHANGELOG|HISTORY|CONTRIBUTING)(?:\.(?:md|markdown|txt|rst)|$)/i.test(name);

  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "@types" || removableDirs.has(entry.name)) {
          rmSync(abs, { recursive: true, force: true });
          continue;
        }
        walk(abs);
      } else if (entry.isFile() && shouldRemoveFile(entry.name)) {
        rmSync(abs, { force: true });
      }
    }
    try {
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a concurrent scanner may briefly hold the directory */
    }
  };

  walk(root);
}

function readPiVersion(dir) {
  try {
    const packageJson = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return typeof packageJson.version === "string" ? packageJson.version : null;
  } catch {
    return null;
  }
}

function isExpectedPiPackage(dir) {
  return existsSync(join(dir, "dist", "cli.js")) && readPiVersion(dir) === EXPECTED_PI_VERSION;
}

function locatePiPackage() {
  const explicit = process.env.PI_PACKAGE_DIR?.trim();
  if (explicit) {
    if (isExpectedPiPackage(explicit)) return explicit;
    const actualVersion = readPiVersion(explicit) || "unknown";
    throw new Error(`PI_PACKAGE_DIR must contain Pi v${EXPECTED_PI_VERSION}; found v${actualVersion}: ${explicit}`);
  }

  const localPackage = join(ROOT, ".runtime-source", "node_modules", "@earendil-works", "pi-coding-agent");
  if (isExpectedPiPackage(localPackage)) return localPackage;

  try {
    const globalRoot = execFileSync(npmBinary(), ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const globalPackage = join(globalRoot, "@earendil-works", "pi-coding-agent");
    if (isExpectedPiPackage(globalPackage)) return globalPackage;
  } catch {
    /* fall through to PATH scan */
  }

  const pathDirs = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  for (const dir of pathDirs) {
    const shim = join(dir, process.platform === "win32" ? "pi.cmd" : "pi");
    const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(shim) && isExpectedPiPackage(candidate)) return candidate;
  }
  return null;
}

function bundleNode() {
  const dest = join(STAGE, "node", nodeExe());
  mkdirSync(dirname(dest), { recursive: true });
  log(`copying Node.js: ${process.execPath} -> ${dest}`);
  cpSync(process.execPath, dest);
  if (process.platform !== "win32") {
    chmodSync(dest, statSync(process.execPath).mode & 0o777);
  }
}

function bundlePi(source) {
  const destination = join(STAGE, "pi");
  mkdirSync(destination, { recursive: true });
  log(`copying pi dist and dependencies from ${source}`);
  cpSync(join(source, "dist"), join(destination, "dist"), { recursive: true });
  cpSync(join(source, "node_modules"), join(destination, "node_modules"), { recursive: true });
  cpSync(join(source, "package.json"), join(destination, "package.json"));
  flattenLocalHoistedDeps(source, join(destination, "node_modules"));

  const before = directoryStats(destination);
  pruneTree(destination);
  const after = directoryStats(destination);
  log(`pruned pi runtime: ${before.files} files/${formatSize(before.bytes)} -> ${after.files} files/${formatSize(after.bytes)}`);

  const packageJson = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || !packageJson.version) throw new Error("pi package has no version");
  return packageJson.version;
}

/** True when `child` is inside `parent` (both resolved absolute paths). */
function isInside(parent, child) {
  const base = resolve(parent) + sep;
  return resolve(child).startsWith(base);
}

/**
 * npm hoists dependencies next to the package for a *local* install
 * (`npm install --prefix .runtime-source`): only the dependencies that conflict
 * stay under `pi-coding-agent/node_modules`, everything else lands in
 * `.runtime-source/node_modules`. The bundled runtime is copied as a
 * self-contained tree, so those hoisted siblings must be flattened back under
 * `pi/node_modules` — otherwise the packaged pi cannot resolve e.g. `undici`.
 *
 * Only the project-local runtime directory is flattened: a globally installed
 * package already keeps its dependencies nested, and a global `node_modules`
 * may contain unrelated packages that must not ship.
 */
function flattenLocalHoistedDeps(source, destinationModules) {
  const localRoot = join(ROOT, ".runtime-source", "node_modules");
  if (!isInside(localRoot, source)) return;
  let entries = [];
  try {
    entries = readdirSync(localRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const copied = [];
  const copyPackage = (relative) => {
    const from = join(localRoot, relative);
    const to = join(destinationModules, relative);
    if (existsSync(to)) return;
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
    copied.push(relative);
  };
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    if (entry.name.startsWith("@")) {
      let children = [];
      try {
        children = readdirSync(join(localRoot, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory()) continue;
        // The installed pi package itself is already the bundle root.
        if (`${entry.name}/${child.name}` === "@earendil-works/pi-coding-agent") continue;
        copyPackage(join(entry.name, child.name));
      }
      continue;
    }
    copyPackage(entry.name);
  }
  if (copied.length) log(`flattened ${copied.length} hoisted dependencies into pi/node_modules`);
}

/**
 * The archive is worthless if pi cannot boot from it. A missing dependency is
 * otherwise only discovered by users after installing the app, so fail the
 * build here instead.
 */
function verifyBundledRuntime() {
  const node = join(STAGE, "node", nodeExe());
  const cli = join(STAGE, "pi", "dist", "cli.js");
  try {
    const version = execFileSync(node, [cli, "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    }).trim();
    if (version !== EXPECTED_PI_VERSION) {
      throw new Error(`reported version ${version}, expected ${EXPECTED_PI_VERSION}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `bundled runtime cannot start (${detail}). ` +
        `Install the Pi package as a self-contained tree, e.g. ` +
        `"npm install --global --prefix .runtime-source @earendil-works/pi-coding-agent@${EXPECTED_PI_VERSION}".`,
    );
  }
  log(`verified bundled runtime: pi ${EXPECTED_PI_VERSION} starts`);
}

function sha512Base64(file) {
  const hash = createHash("sha512");
  hash.update(readFileSync(file));
  return hash.digest("base64");
}

function main() {
  const platformSlug = PLATFORM_SLUGS[process.platform];
  if (!platformSlug || !SUPPORTED_ARCHES.has(process.arch)) {
    throw new Error(`Unsupported standalone runtime target: ${process.platform}/${process.arch}. Use Windows or macOS on x64 or arm64.`);
  }

  const source = locatePiPackage();
  if (!source) {
    throw new Error(`Could not locate @earendil-works/pi-coding-agent v${EXPECTED_PI_VERSION}. Set PI_PACKAGE_DIR to a matching package or install that version globally.`);
  }

  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });
  rmSync(RUNTIME_OUT, { recursive: true, force: true });
  mkdirSync(RUNTIME_OUT, { recursive: true });
  bundleNode();
  const runtimeVersion = bundlePi(source);
  if (runtimeVersion !== EXPECTED_PI_VERSION) {
    throw new Error(`Pi runtime version mismatch: expected v${EXPECTED_PI_VERSION}, found v${runtimeVersion}`);
  }
  verifyBundledRuntime();
  const fileName = `Pi-Studio-Runtime-${runtimeVersion}-${platformSlug}-${process.arch}.tar.gz`;
  const archive = join(RUNTIME_OUT, fileName);
  rmSync(archive, { force: true });

  log(`creating archive ${archive}`);
  execFileSync(tarBinary(), ["-czf", archive, "-C", STAGE, "."], { stdio: "inherit" });
  const size = statSync(archive).size;
  const manifest = {
    schema: 2,
    embedded: true,
    runtimeVersion,
    platform: process.platform,
    arch: process.arch,
    fileName,
    size,
    sha512: sha512Base64(archive),
  };
  mkdirSync(dirname(MANIFEST_OUT), { recursive: true });
  writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  log(`runtime asset: ${fileName} (${formatSize(size)})`);
  log(`manifest: ${MANIFEST_OUT}`);
  log("done.");
}

try {
  main();
} finally {
  rmSync(STAGE, { recursive: true, force: true });
}
