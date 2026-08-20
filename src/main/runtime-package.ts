import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { app } from "electron";
import { getConfigDir } from "./config";

/**
 * The runtime archive is embedded in the desktop installer and extracted once
 * into userData. Keeping the extracted copy versioned still lets app-managed
 * Pi updates switch runtimes without replacing files held by live processes.
 */
export interface RuntimeManifest {
  schema: 2;
  embedded: true;
  runtimeVersion: string;
  platform: RuntimePlatform;
  arch: RuntimeArch;
  fileName: string;
  size: number;
  sha512: string;
}

type RuntimePlatform = "win32" | "darwin";
type RuntimeArch = "x64" | "arm64";

function supportsEmbeddedRuntime(): boolean {
  return (
    (process.platform === "win32" || process.platform === "darwin") &&
    (process.arch === "x64" || process.arch === "arm64")
  );
}

export interface RuntimePaths {
  node: string;
  cli: string;
}

export type RuntimeProgressStage = "checking" | "installing" | "activating" | "done" | "error";

export interface RuntimeProgress {
  stage: RuntimeProgressStage;
  message: string;
  pct?: number;
}

type ProgressFn = (progress: RuntimeProgress) => void;

interface RuntimePointer {
  schema: 1;
  version: string;
}

let installPromise: Promise<string | null> | null = null;

export function runtimeBaseDir(): string {
  const dir = getConfigDir();
  if (!dir) throw new Error("config not loaded; cannot resolve runtime dir");
  return join(dir, "runtime");
}

export function runtimeVersionsDir(): string {
  return join(runtimeBaseDir(), "versions");
}

function runtimePointerPath(): string {
  return join(runtimeBaseDir(), "current.json");
}

function nodeFileName(): string {
  return process.platform === "win32" ? "node.exe" : "node";
}

function isValidRuntimeVersion(version: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version);
}

function runtimeRootForVersion(version: string): string {
  if (!isValidRuntimeVersion(version)) throw new Error(`invalid runtime version: ${version}`);
  return join(runtimeVersionsDir(), version);
}

function isUsableRuntimeRoot(root: string): boolean {
  return existsSync(join(root, "node", nodeFileName())) && existsSync(join(root, "pi", "dist", "cli.js"));
}

export function runtimePathsForRoot(root: string): RuntimePaths | null {
  const paths = {
    node: join(root, "node", nodeFileName()),
    cli: join(root, "pi", "dist", "cli.js"),
  };
  return existsSync(paths.node) && existsSync(paths.cli) ? paths : null;
}

function readPointer(): RuntimePointer | null {
  try {
    const parsed = JSON.parse(readFileSync(runtimePointerPath(), "utf8")) as Partial<RuntimePointer>;
    if (parsed.schema !== 1 || typeof parsed.version !== "string" || !isValidRuntimeVersion(parsed.version)) return null;
    return { schema: 1, version: parsed.version };
  } catch {
    return null;
  }
}

/**
 * Resolve the active runtime. The old runtime/pi layout remains supported so
 * an existing installation keeps working after the app itself is upgraded.
 */
export function getActiveRuntimeRoot(): string | null {
  try {
    const pointer = readPointer();
    if (pointer) {
      const pointed = runtimeRootForVersion(pointer.version);
      if (isUsableRuntimeRoot(pointed)) return pointed;
    }

    const legacy = join(runtimeBaseDir(), "pi");
    if (existsSync(join(legacy, "dist", "cli.js"))) return legacy;
  } catch {
    /* config may not be loaded yet */
  }
  return null;
}

export function getActiveRuntimeVersion(): string | null {
  const pointer = readPointer();
  if (pointer && isUsableRuntimeRoot(runtimeRootForVersion(pointer.version))) return pointer.version;
  const root = getActiveRuntimeRoot();
  if (!root) return null;
  try {
    const packagePath = existsSync(join(root, "pi", "package.json"))
      ? join(root, "pi", "package.json")
      : join(root, "package.json");
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export function getActiveRuntimePaths(): RuntimePaths | null {
  const root = getActiveRuntimeRoot();
  return root ? runtimePathsForRoot(root) : null;
}

/** Atomically switch new processes to a versioned runtime directory. */
export function activateRuntimeRoot(root: string, version: string): void {
  const base = resolve(runtimeBaseDir());
  const candidate = resolve(root);
  if (candidate !== base && !candidate.startsWith(base + "\\") && !candidate.startsWith(base + "/")) {
    throw new Error("runtime root is outside the app runtime directory");
  }
  if (!isUsableRuntimeRoot(candidate)) throw new Error(`runtime package is incomplete: ${candidate}`);

  mkdirSync(base, { recursive: true });
  const pointerPath = runtimePointerPath();
  const tempPath = `${pointerPath}.${process.pid}.${Date.now()}.tmp`;
  const pointer: RuntimePointer = { schema: 1, version };
  writeFileSync(tempPath, JSON.stringify(pointer, null, 2), "utf8");
  try {
    // Windows rename does not replace an existing file. The pointer is tiny,
    // and removing it here leaves only a short, recoverable gap.
    rmSafe(pointerPath);
    renameSync(tempPath, pointerPath);
  } catch (error) {
    rmSafe(tempPath);
    throw error;
  }
}

function runtimeManifestPath(): string | null {
  if (!app.isPackaged || !supportsEmbeddedRuntime()) return null;
  const resourcesPath = (process as any).resourcesPath as string | undefined;
  return resourcesPath ? join(resourcesPath, "runtime-manifest.json") : null;
}

export function getRuntimePackageManifest(): RuntimeManifest | null {
  const path = runtimeManifestPath();
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeManifest>;
    if (
      parsed.schema !== 2 ||
      parsed.embedded !== true ||
      !supportsEmbeddedRuntime() ||
      parsed.platform !== process.platform ||
      parsed.arch !== process.arch ||
      typeof parsed.runtimeVersion !== "string" ||
      !isValidRuntimeVersion(parsed.runtimeVersion) ||
      typeof parsed.fileName !== "string" ||
      !/^[A-Za-z0-9._+-]+\.tar\.gz$/.test(parsed.fileName) ||
      typeof parsed.size !== "number" ||
      parsed.size <= 0 ||
      typeof parsed.sha512 !== "string"
    ) {
      return null;
    }
    return parsed as RuntimeManifest;
  } catch {
    return null;
  }
}

function embeddedRuntimeArchivePath(manifest: RuntimeManifest): string {
  const resourcesPath = (process as any).resourcesPath as string | undefined;
  if (!app.isPackaged || !resourcesPath) {
    throw new Error("embedded Pi runtime is only available in a packaged app");
  }
  const archive = join(resourcesPath, "runtime-package", manifest.fileName);
  if (!existsSync(archive)) {
    throw new Error(`embedded Pi runtime package is missing: ${archive}`);
  }
  return archive;
}

function rmSafe(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  } catch {
    /* best effort; stale paths are retried on the next launch */
  }
}

function tarBinary(): string {
  if (process.platform === "win32") return join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return "tar";
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`));
    });
  });
}

async function sha512File(file: string): Promise<string> {
  const hash = createHash("sha512");
  const input = createReadStream(file);
  for await (const chunk of input) hash.update(chunk as Buffer);
  return hash.digest("base64");
}

function archiveRoot(extracted: string): string {
  if (isUsableRuntimeRoot(extracted)) return extracted;
  const entries = readdirSync(extracted).filter((name) => !name.startsWith("."));
  if (entries.length === 1) {
    const nested = join(extracted, entries[0]);
    if (isUsableRuntimeRoot(nested)) return nested;
  }
  throw new Error("runtime archive is missing node/node.exe or pi/dist/cli.js");
}

/** Verify, extract and activate the runtime archive embedded in the installer. */
export async function installRuntimePackage(manifest: RuntimeManifest, onProgress?: ProgressFn): Promise<string> {
  if (!supportsEmbeddedRuntime()) {
    throw new Error("standalone Pi runtime supports Windows and macOS on x64 or arm64");
  }
  const progress = onProgress || (() => undefined);
  const target = runtimeRootForVersion(manifest.runtimeVersion);
  if (isUsableRuntimeRoot(target)) {
    activateRuntimeRoot(target, manifest.runtimeVersion);
    progress({ stage: "done", message: `Pi 运行时 v${manifest.runtimeVersion} 已就绪`, pct: 100 });
    return target;
  }

  const base = runtimeBaseDir();
  const embeddedArchive = embeddedRuntimeArchivePath(manifest);
  const staging = join(base, `.runtime-staging-${process.pid}-${Date.now()}`);
  const archive = join(staging, manifest.fileName);
  const extracted = join(staging, "extracted");
  try {
    rmSafe(staging);
    mkdirSync(extracted, { recursive: true });
    progress({ stage: "checking", message: `正在准备内置 Pi 运行时 v${manifest.runtimeVersion}` });
    copyFileSync(embeddedArchive, archive);
    const actualSize = statSync(archive).size;
    if (actualSize !== manifest.size) throw new Error(`runtime package size mismatch: expected ${manifest.size}, got ${actualSize}`);
    const actualHash = await sha512File(archive);
    if (actualHash !== manifest.sha512) throw new Error("runtime package integrity check failed");

    progress({ stage: "installing", message: "正在解压内置 Pi 运行时", pct: 0 });
    await runCommand(tarBinary(), ["-xzf", archive, "-C", extracted]);
    const root = archiveRoot(extracted);
    mkdirSync(runtimeVersionsDir(), { recursive: true });
    rmSafe(target);
    renameSync(root, target);
    if (!isUsableRuntimeRoot(target)) throw new Error("runtime package activation produced an incomplete directory");
    progress({ stage: "activating", message: `正在激活 Pi 运行时 v${manifest.runtimeVersion}` });
    activateRuntimeRoot(target, manifest.runtimeVersion);
    progress({ stage: "done", message: `Pi 运行时 v${manifest.runtimeVersion} 已就绪`, pct: 100 });
    return target;
  } finally {
    rmSafe(staging);
  }
}

/** Ensure the runtime embedded in the installer is present on first launch. */
export function ensureRuntimePackage(onProgress?: ProgressFn): Promise<string | null> {
  const active = getActiveRuntimePaths();
  if (active) return Promise.resolve(getActiveRuntimeRoot());
  const manifest = getRuntimePackageManifest();
  if (!manifest) return Promise.resolve(null);
  if (!installPromise) {
    installPromise = installRuntimePackage(manifest, onProgress).catch((error) => {
      installPromise = null;
      throw error;
    });
  }
  return installPromise;
}

/** Remove superseded version directories after no child process can hold them. */
export function cleanupRuntimeVersions(): void {
  let versions: string[];
  try {
    versions = readdirSync(runtimeVersionsDir());
  } catch {
    return;
  }
  const active = getActiveRuntimeRoot();
  for (const version of versions) {
    const candidate = join(runtimeVersionsDir(), version);
    if (candidate !== active) rmSafe(candidate);
  }
}
