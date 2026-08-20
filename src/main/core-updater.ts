import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getBundledRuntime, resetPiRuntime } from "./pi-bridge";
import {
  activateRuntimeRoot,
  cleanupRuntimeVersions,
  getActiveRuntimePaths,
  getActiveRuntimeRoot,
  getRuntimePackageManifest,
  installRuntimePackage,
  runtimeBaseDir as managedRuntimeBaseDir,
  runtimeVersionsDir,
} from "./runtime-package";

/**
 * In-app updater for the pi core that Pi Studio manages itself.
 *
 * The runtime managed by Pi Studio is NOT a global npm/pnpm install, so
 * `pi update` refuses to touch it (detectInstallMethod returns "unknown").
 * New releases embed a standalone runtime archive in the installer and use
 * the npm path only as a compatibility fallback when it does not match the
 * latest Pi:
 *
 *   1. Ask https://pi.dev/api/latest-version for the latest release
 *      (the same endpoint pi's own version check uses).
 *   2. Prefer the standalone runtime archive embedded in the app release.
 *   3. Download the npm tarball from the registry (integrity-verified) only
 *      when no matching standalone archive is available.
 *   4. The tarball does not include node_modules, but it ships
 *      npm-shrinkwrap.json (a full lockfile with `resolved` + `integrity`
 *      for every transitive dependency). We install each dependency the
 *      way `npm install --ignore-scripts` would: download its tarball,
 *      verify integrity, extract it under node_modules/<key>, skipping
 *      entries whose os/cpu don't match this platform. No npm needed.
 *   5. Activate by switching `<userData>/runtime/current.json` to a versioned
 *      tree. The pointer takes precedence over the legacy bundled copy and
 *      avoids fighting file locks on the running app's own resources.
 *
 * The previously active tree is renamed to `pi.old-<n>` rather than
 * deleted: a running thread may still hold native modules (.node addons)
 * open from it, which Windows refuses to delete. Startup cleans them up.
 */

const VERSION_URL = "https://pi.dev/api/latest-version";
const REGISTRY = "https://registry.npmjs.org";
const DEFAULT_PACKAGE = "@earendil-works/pi-coding-agent";
const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const DEP_CONCURRENCY = 8;
const RENAME_RETRY_COUNT = 10;
const RENAME_RETRY_BASE_DELAY_MS = 200;
const RENAME_RETRY_MAX_DELAY_MS = 1_500;

export type UpdateStage = "checking" | "downloading" | "installing" | "pruning" | "activating" | "done" | "error";

export interface CoreUpdateProgress {
  stage: UpdateStage;
  message: string;
  /** 0..100 within the current stage, when known. */
  pct?: number;
}

export interface CoreUpdateStatus {
  current: string | null;
  latest: string | null;
  hasUpdate: boolean;
  note?: string | null;
  /** Where the active app-managed runtime lives (legacy bundled dir or userData runtime). */
  source: "userData" | "bundled" | null;
  error?: string;
}

export interface CoreUpdateResult {
  ok: boolean;
  updated: boolean;
  from?: string | null;
  to?: string;
  message: string;
}

type ProgressFn = (p: CoreUpdateProgress) => void;

/* ------------------------------ locations ------------------------------ */

/** Root of the updatable runtime area under Electron's userData dir. */
export function runtimeBaseDir(): string {
  return managedRuntimeBaseDir();
}

/** Directory holding the active app-updated runtime, if any. */
export function activeRuntimeDir(): string {
  return getActiveRuntimeRoot() || join(runtimeBaseDir(), "pi");
}

interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  optional?: boolean;
  link?: boolean;
  os?: string[];
  cpu?: string[];
  engines?: { node?: string };
  hasInstallScript?: boolean;
}

/** Version of the runtime the app currently uses (userData copy wins over bundled). */
export function readManagedPiStatus(): { version: string | null; source: "userData" | "bundled" | null } {
  const activeRoot = getActiveRuntimeRoot();
  const activePkg = activeRoot
    ? existsSync(join(activeRoot, "pi", "package.json"))
      ? join(activeRoot, "pi", "package.json")
      : join(activeRoot, "package.json")
    : null;
  if (activePkg && existsSync(activePkg)) {
    try {
      const v = (JSON.parse(readFileSync(activePkg, "utf8")) as { version?: string }).version;
      if (v) return { version: v, source: "userData" };
    } catch {
      /* fall through to bundled */
    }
  }
  const bundled = getBundledRuntime();
  if (bundled) {
    try {
      const pkgPath = join(dirname(dirname(bundled.cli)), "package.json");
      const v = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version;
      if (v) return { version: v, source: "bundled" };
    } catch {
      /* ignore */
    }
  }
  return { version: null, source: null };
}

/* ------------------------------- helpers ------------------------------- */

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** ">=22.19.0" → "22.19.0" (we only ever see a single lower bound in practice). */
function parseMinNodeVersion(range: string): string | null {
  const m = /(\d+\.\d+\.\d+|\d+\.\d+|\d+)/.exec(range);
  return m ? m[1] : null;
}

async function fetchJson<T>(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "pi-studio-updater" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/** sha512-<base64> (npm "integrity") verification, streaming. */
async function verifyIntegrity(file: string, integrity?: string): Promise<void> {
  if (!integrity) return;
  const m = /^(sha\d+)-(.+)$/.exec(integrity);
  if (!m) return; // unknown scheme; npm would reject, but don't hard-fail here
  const hash = createHash(m[1]);
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(file);
    s.on("data", (d) => hash.update(d));
    s.on("end", () => resolve());
    s.on("error", reject);
  });
  const actual = hash.digest("base64");
  if (actual !== m[2]) throw new Error(`integrity check failed for ${file} (${m[1]})`);
}

/** Download url → dest with optional coarse progress (needs content-length). */
async function downloadFile(url: string, dest: string, onPct?: (pct: number) => void): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const body = res.body as unknown as { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } } | null;
  await new Promise<void>((resolve, reject) => {
    if (!body) {
      reject(new Error(`empty response body for ${url}`));
      return;
    }
    const reader = body.getReader();
    const out = createWriteStream(dest);
    let got = 0;
    let lastPct = -1;
    const pump = async (): Promise<void> => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value as Uint8Array);
        got += buf.length;
        if (!out.write(buf)) await new Promise<void>((r) => out.once("drain", () => r()));
        if (total && onPct) {
          const pct = Math.min(99, Math.floor((got / total) * 100));
          if (pct !== lastPct) {
            lastPct = pct;
            onPct(pct);
          }
        }
      }
      out.end(() => resolve());
      out.on("error", reject);
    };
    pump().catch((e) => {
      out.destroy();
      reject(e);
    });
  });
}

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let stderr = "";
    p.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args[0] || ""} exited with code ${code}${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`));
    });
  });
}

/**
 * rmSync that tolerates Windows file-lock races: antivirus/indexers
 * transiently hold handles on freshly written files, making plain recursive
 * rmSync fail with ENOTEMPTY/EBUSY. maxRetries makes Node back off and retry;
 * the outer try keeps cleanup paths from ever taking down the update flow —
 * leftovers are swept by cleanupOldRuntimes() on next launch.
 */
function rmSafe(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  } catch {
    /* best effort */
  }
}

function isRetryableRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOTEMPTY";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Windows Defender, indexers, and shell preview handlers can briefly retain a
 * handle to a freshly extracted directory. A single renameSync therefore
 * makes an otherwise valid update fail. Retry only the Windows-style
 * transient errors, and keep the destination replacement limited to the
 * disposable staging tree used by this updater.
 */
async function renameWithRetry(source: string, destination: string, replaceDestination = false): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RENAME_RETRY_COUNT; attempt++) {
    try {
      if (replaceDestination && existsSync(destination)) rmSafe(destination);
      renameSync(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRenameError(error) || attempt === RENAME_RETRY_COUNT) throw error;
      const delay = Math.min(RENAME_RETRY_MAX_DELAY_MS, RENAME_RETRY_BASE_DELAY_MS * 2 ** attempt);
      await wait(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Absolute path to a trustworthy tar. On Windows we must NOT take whatever
 * `tar` sits first on PATH: Git-for-Windows ships GNU tar, which parses the
 * colon in `C:\...` paths as a remote-host separator and fails with
 * "Cannot connect to C:". The OS-shipped bsdtar in System32 handles
 * drive-letter paths correctly and has been present since Windows 10 1803.
 */
function tarBinary(): string {
  if (process.platform === "win32") {
    return join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  }
  return "tar";
}

/** os/cpu filters honour npm semantics, including "!" negation entries. */
function platformMatches(e: LockEntry): boolean {
  const matches = (list: string[] | undefined, value: string): boolean => {
    if (!list || list.length === 0) return true;
    const neg = list.filter((x) => x.startsWith("!"));
    if (neg.length > 0) return !neg.some((x) => x.slice(1) === value);
    return list.includes(value);
  };
  return matches(e.os, process.platform) && matches(e.cpu, process.arch);
}

/** Recursive prune mirroring the standalone runtime builder. */
function pruneTree(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const abs = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (
        name === "@types" ||
        name === "test" ||
        name === "tests" ||
        name === "__tests__" ||
        name === ".github" ||
        name === "docs" ||
        name === "examples" ||
        name === "example" ||
        name === "benchmark" ||
        name === "benchmarks" ||
        name === "coverage" ||
        name === "__mocks__"
      ) {
        rmSafe(abs);
        continue;
      }
      pruneTree(abs);
    } else if (
      /\.(?:map|d\.ts|d\.mts|d\.cts|ts|mts|cts)$/i.test(name) ||
      /^(?:README|CHANGELOG|HISTORY|CONTRIBUTING)(?:\.(?:md|markdown|txt|rst)|$)/i.test(name)
    ) {
      rmSafe(abs);
    }
  }
}

/**
 * Bounded concurrency pool. On the first failure it stops handing out NEW
 * items but waits for the in-flight workers to settle before throwing — the
 * caller's cleanup (rmSafe on the staging dir) must not race workers that
 * are still writing inside it.
 */
async function mapPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  let firstError: unknown = null;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push(
      (async () => {
        for (;;) {
          if (failed) return;
          const i = next++;
          if (i >= items.length) return;
          try {
            await fn(items[i], i);
          } catch (e) {
            if (!failed) {
              failed = true;
              firstError = e;
            }
            return;
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  if (firstError) throw firstError;
}

/**
 * npm tarballs wrap contents in a single root folder — usually `package/`,
 * but not always (e.g. @types tarballs are packed as `<name> <version>/`).
 * Locate that folder instead of assuming a name.
 */
function singleRootDir(dir: string): string {
  const entries = readdirSync(dir).filter((n) => !n.startsWith("."));
  if (entries.length !== 1) {
    throw new Error(`unexpected tarball layout in ${dir}: expected one root folder, found [${entries.join(", ")}]`);
  }
  return join(dir, entries[0]);
}

/* ------------------------------ public API ------------------------------ */

/** Check pi.dev for the latest release and compare with the managed runtime. */
export async function checkForCoreUpdate(): Promise<CoreUpdateStatus> {
  const { version: current, source } = readManagedPiStatus();
  try {
    const rel = await fetchJson<{ version?: string; packageName?: string; note?: string | null }>(VERSION_URL);
    const latest = typeof rel.version === "string" ? rel.version.trim() : "";
    if (!latest) return { current, latest: null, hasUpdate: false, source, error: "版本检查返回为空" };
    const hasUpdate = current ? compareVersions(latest, current) > 0 : true;
    return { current, latest, hasUpdate, note: rel.note || null, source };
  } catch (e: any) {
    return { current, latest: null, hasUpdate: false, source, error: e?.message || String(e) };
  }
}

/**
 * Download and activate the latest pi core. Safe to call when already latest
 * (resolves with updated=false). Progress is reported via onProgress.
 */
export async function installCoreUpdate(onProgress?: ProgressFn): Promise<CoreUpdateResult> {
  const progress: ProgressFn = onProgress || (() => undefined);
  // Never reuse a failed staging tree in the same process. A previous attempt
  // may have left a locked package directory behind after its cleanup failed.
  const staging = join(runtimeBaseDir(), `.staging-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`);

  try {
    // ---- check -----------------------------------------------------------
    progress({ stage: "checking", message: "正在检查最新版本…" });
    const status = await checkForCoreUpdate();
    if (status.error) throw new Error(`检查更新失败：${status.error}`);
    if (!status.latest) throw new Error("无法获取最新版本信息");
    if (!status.hasUpdate) {
      return { ok: true, updated: false, from: status.current, message: `Pi 已是最新版本（v${status.current}）` };
    }
    const targetVersion = status.latest;
    const runtimeNode = getActiveRuntimePaths()?.node || getBundledRuntime()?.node || null;
    progress({ stage: "checking", message: `发现新版本 v${targetVersion}（当前 v${status.current || "?"}）` });

    // A release built with the standalone runtime already contains a verified
    // one-archive path. Use it when its Pi version is the requested version;
    // this avoids the old 139-request npm dependency installation.
    const standalone = getRuntimePackageManifest();
    if (standalone?.runtimeVersion === targetVersion) {
      const root = await installRuntimePackage(standalone, (p) => progress({ stage: p.stage, message: p.message, pct: p.pct }));
      resetPiRuntime();
      return {
        ok: true,
        updated: true,
        from: status.current,
        to: targetVersion,
        message: `Pi 运行时 v${targetVersion} 已作为独立包安装到应用数据目录：${root}`,
      };
    }

    // ---- resolve tarball -------------------------------------------------
    const manifest = await fetchJson<{ dist?: { tarball?: string; integrity?: string } }>(
      `${REGISTRY}/${DEFAULT_PACKAGE}/${targetVersion}`,
    );
    const tarballUrl = manifest.dist?.tarball;
    if (!tarballUrl) throw new Error("无法从 npm registry 获取安装包地址");

    // ---- stage area ------------------------------------------------------
    rmSafe(staging);
    mkdirSync(staging, { recursive: true });
    const tgz = join(staging, "pi.tgz");

    progress({ stage: "downloading", message: "正在下载 Pi 核心…", pct: 0 });
    await downloadFile(tarballUrl, tgz, (pct) =>
      progress({ stage: "downloading", message: "正在下载 Pi 核心…", pct }),
    );
    await verifyIntegrity(tgz, manifest.dist?.integrity);

    // ---- extract main package --------------------------------------------
    progress({ stage: "installing", message: "正在解压安装包…" });
    const extractDir = join(staging, "extracted");
    mkdirSync(extractDir, { recursive: true });
    await runCommand(tarBinary(), ["-xzf", tgz, "-C", extractDir]);
    const root = singleRootDir(extractDir);
    if (!existsSync(join(root, "dist", "cli.js"))) throw new Error("安装包内容异常：缺少 dist/cli.js");

    // ---- engine check ----------------------------------------------------
    const lockPath = join(root, "npm-shrinkwrap.json");
    if (!existsSync(lockPath)) throw new Error("安装包缺少 npm-shrinkwrap.json，无法安装依赖");
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { packages?: Record<string, LockEntry> };
    const packages = lock.packages || {};
    const requiredNode = packages[""]?.engines?.node;
    const bundled = runtimeNode ? { node: runtimeNode } : null;
    if (!runtimeNode) throw new Error("No managed Node runtime is available to install the Pi update");
    if (!bundled) throw new Error("未找到内置 Node 运行时，无法安装更新");
    if (requiredNode) {
      const min = parseMinNodeVersion(requiredNode);
      const nodeVersion = await runNodeVersion(bundled.node);
      if (min && nodeVersion && compareVersions(nodeVersion, min) < 0) {
        throw new Error(`新版本要求 Node ${requiredNode}，而内置 Node 为 v${nodeVersion}。请更新 Pi Studio 本体。`);
      }
    }

    // ---- install dependencies from the lockfile ---------------------------
    const deps = Object.entries(packages)
      .filter(([key, e]) => key !== "" && !e.link && !!e.resolved)
      .filter(([, e]) => platformMatches(e));

    let done = 0;
    const extractTmp = join(staging, "dep-tmp");
    mkdirSync(extractTmp, { recursive: true });
    await mapPool(deps, DEP_CONCURRENCY, async ([key, e], i) => {
      const dest = join(root, ...key.split("/"));
      const tmpDir = join(extractTmp, `d${i}`);
      const tmpTgz = join(extractTmp, `d${i}.tgz`);
      mkdirSync(tmpDir, { recursive: true });
      try {
        await downloadFile(e.resolved as string, tmpTgz);
        await verifyIntegrity(tmpTgz, e.integrity);
        await runCommand(tarBinary(), ["-xzf", tmpTgz, "-C", tmpDir]);
        mkdirSync(dirname(dest), { recursive: true });
        await renameWithRetry(singleRootDir(tmpDir), dest, true);
      } finally {
        rmSafe(tmpDir);
        rmSafe(tmpTgz);
      }
      done++;
      if (done % 5 === 0 || done === deps.length) {
        progress({
          stage: "installing",
          message: `正在安装依赖（${done}/${deps.length}）…`,
          pct: Math.floor((done / deps.length) * 100),
        });
      }
    });

    // ---- prune ------------------------------------------------------------
    progress({ stage: "pruning", message: "正在精简运行时文件…" });
    pruneTree(root);

    // ---- activate ---------------------------------------------------------
    progress({ stage: "activating", message: "正在激活新版本…" });
    const targetRoot = join(runtimeVersionsDir(), targetVersion);
    mkdirSync(runtimeVersionsDir(), { recursive: true });
    rmSafe(targetRoot);
    mkdirSync(targetRoot, { recursive: true });
    // The target version tree is disposable too: a previous interrupted run
    // may have left its `pi` directory behind while cleanup was still locked.
    await renameWithRetry(root, join(targetRoot, "pi"), true);
    const nodeName = process.platform === "win32" ? "node.exe" : "node";
    mkdirSync(join(targetRoot, "node"), { recursive: true });
    cpSync(runtimeNode, join(targetRoot, "node", nodeName));
    activateRuntimeRoot(targetRoot, targetVersion);
    rmSafe(staging);
    resetPiRuntime(); // next thread open resolves the new runtime

    progress({ stage: "done", message: `已更新到 v${targetVersion}` });
    return {
      ok: true,
      updated: true,
      from: status.current,
      to: targetVersion,
      message: `Pi 核心已更新到 v${targetVersion}，新开的线程将使用新版本。`,
    };
  } catch (e: any) {
    rmSafe(staging);
    const message = e?.message || String(e);
    progress({ stage: "error", message });
    return { ok: false, updated: false, message: `Pi 更新失败：${message}` };
  }
}

function runNodeVersion(node: string): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn(node, ["-v"], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    p.on("error", () => resolve(null));
    p.on("exit", () => resolve(out.trim().replace(/^v/, "") || null));
  });
}

/**
 * Best-effort removal of superseded runtime trees and stale staging dirs.
 * Called at startup, when no pi child process can hold files open.
 */
export function cleanupOldRuntimes(): void {
  let base: string;
  try {
    base = runtimeBaseDir();
  } catch {
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return; // runtime dir never created
  }
  for (const name of entries) {
    if (/^pi\.old-/.test(name) || /^\.staging-/.test(name)) {
      rmSafe(join(base, name)); // still locked → silently retried next launch
    }
  }
  cleanupRuntimeVersions();
}
