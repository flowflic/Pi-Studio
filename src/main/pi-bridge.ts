import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ensureRuntimePackage, getActiveRuntimeRoot, getRuntimePackageManifest, runtimePathsForRoot } from "./runtime-package";

/**
 * PiBridge
 * --------
 * Owns a single `pi --mode rpc` subprocess and translates between pi's JSONL
 * protocol (see pi docs/rpc.md) and the Electron IPC layer.
 *
 * Why we spawn `node <cli.js>` instead of the `pi` shim with shell:true:
 *   On Windows the npm `pi` shim is a `.cmd` batch file. child_process.spawn
 *   cannot run `.cmd` without shell:true, and shell:true forces cmd.exe
 *   argument splitting that breaks any argument containing spaces (session
 *   paths, project names). Resolving the real node binary + cli.js and using
 *   shell:false passes the argv array verbatim, which is correct on every OS.
 *
 * The bridge implements the full protocol surface the UI needs, including the
 * extension-UI sub-protocol (select/confirm/input/editor/notify/...) so that
 * pi extensions keep working inside the desktop app exactly as in the terminal.
 */

export interface ResolvedRuntime {
  node: string;
  cli: string;
}

/** Where the resolved runtime came from, in resolution-priority order. */
export type RuntimeKind = "override" | "userData" | "bundled" | "system";

let resolvedRuntime: ResolvedRuntime | null = null;
let resolvedKind: RuntimeKind | null = null;
let resolvingRuntime: Promise<ResolvedRuntime> | null = null;

/**
 * Locate the legacy bundled Node.js + pi-coding-agent layout. New releases
 * ship this pair as an embedded standalone runtime archive and extract it
 * under userData instead; the legacy lookup remains for older developer
 * builds and installed versions.
 *
 * Search order:
 *  1. PI_BUNDLED_DIR env var (set by the app at startup for dev convenience)
 *  2. process.resourcesPath/bundled (Electron packaged app)
 */
export function getBundledRuntime(): ResolvedRuntime | null {
  const candidates: string[] = [];
  if (process.env.PI_BUNDLED_DIR) candidates.push(process.env.PI_BUNDLED_DIR);
  // Electron sets process.resourcesPath in both dev and packaged mode.
  // In dev it points to electron's own resources; in packaged it's <app>/resources/.
  try {
    const rp = (process as any).resourcesPath as string | undefined;
    if (rp) candidates.push(join(rp, "bundled"));
  } catch { /* ignore */ }

  const nodeExe = process.platform === "win32" ? "node.exe" : "node";
  for (const dir of candidates) {
    const node = join(dir, "node", nodeExe);
    const cli = join(dir, "pi", "dist", "cli.js");
    if (existsSync(node) && existsSync(cli)) return { node, cli };
  }
  return null;
}

/** Split PATH into directories without spawning anything (cross-platform). */
function pathDirs(): string[] {
  const raw = process.env.PATH || process.env.Path || process.env.path || "";
  const sep = process.platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(sep)) {
    const d = part.trim().replace(/^"+|"+$/g, "");
    if (!d) continue;
    const key = d.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

function firstExistingFile(dirs: string[], names: string[]): string | null {
  for (const dir of dirs) {
    for (const n of names) {
      const p = join(dir, n);
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {
        /* ignore unreadable dir entry */
      }
    }
  }
  return null;
}

/**
 * Locate pi's cli.js by scanning PATH for the `pi` shim and reading its text.
 * npm-generated shims embed the package path, e.g. on Windows the .cmd contains
 *   "%_prog%"  "%dp0%\node_modules\@earendil-works\pi-coding-agent\dist\cli.js" %*
 * and on POSIX the shell script contains
 *   exec "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" "$@"
 * Parsing the shim text means we never have to spawn `npm`/`where` (which fail
 * with ENOENT on Windows because they are .cmd/.sh wrappers, not real binaries).
 */
function locatePiCli(): { cli: string; shimDir: string } | null {
  const dirs = pathDirs();
  const shimNames = process.platform === "win32" ? ["pi.cmd", "pi.bat", "pi.exe", "pi"] : ["pi"];
  const fixedRel = join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  for (const dir of dirs) {
    for (const n of shimNames) {
      const shim = join(dir, n);
      let isFile = false;
      try {
        isFile = existsSync(shim) && statSync(shim).isFile();
      } catch {
        continue;
      }
      if (!isFile) continue;

      let cliRel: string | null = null;
      try {
        const txt = readFileSync(shim, "utf8");
        const m = txt.match(/(node_modules[\\\/][^"'\r\n]*?pi-coding-agent[\\\/]dist[\\\/]cli\.js)/i);
        if (m) cliRel = m[1].replace(/^[\\\/]+/, "");
      } catch {
        /* unreadable shim; fall back to the fixed relative path */
      }
      const cli = cliRel ? join(dir, cliRel) : join(dir, fixedRel);
      if (existsSync(cli)) return { cli, shimDir: dir };
    }
  }
  return null;
}

/**
 * Locate a usable node binary without spawning `where`/`which`. Prefer a node
 * sitting next to the pi shim (some setups bundle one), otherwise scan PATH.
 */
function locateNode(shimDir?: string): string | null {
  if (shimDir) {
    const localName = process.platform === "win32" ? "node.exe" : "node";
    const local = join(shimDir, localName);
    try {
      if (existsSync(local) && statSync(local).isFile()) return local;
    } catch {
      /* ignore */
    }
  }
  const names = process.platform === "win32" ? ["node.exe", "node"] : ["node"];
  return firstExistingFile(pathDirs(), names);
}

/**
 * Locate the app-managed runtime under `<userData>/runtime/versions/<version>`
 * (or the legacy `<userData>/runtime/pi` layout). It takes precedence over the
 * legacy bundled copy: an update must win over the version shipped in the app.
 */
function locateUserDataRuntime(): ResolvedRuntime | null {
  const root = getActiveRuntimeRoot();
  if (!root) return null;

  // Standalone runtime packages contain both node and pi.
  const packaged = runtimePathsForRoot(root);
  if (packaged) return packaged;

  // Existing userData/runtime/pi installations contain only pi and relied on
  // the old bundled Node binary. Dev mode and old app builds keep using them;
  // a new packaged build promotes them through the standalone path below.
  const cli = join(root, "dist", "cli.js");
  if (!existsSync(cli)) return null;

  // A packaged release with a runtime manifest owns the runtime lifecycle.
  // Do not let a legacy runtime plus a system Node short-circuit the standalone
  // bootstrap; otherwise the app would keep using the old layout forever and
  // a later in-app Pi update would have no managed node.exe to copy forward.
  if (getRuntimePackageManifest()) return null;

  const node = getBundledRuntime()?.node || locateNode();
  return node ? { node, cli } : null;
}

/**
 * Resolve the node binary and pi cli.js once, caching the result.
 * Uses pure-JS PATH scanning + shim-text parsing so it works on Windows without
 * spawning npm/where (which are .cmd wrappers and would ENOENT under shell:false).
 *
 * Priority: explicit override → app-updated userData runtime → bundled → PATH.
 * @param cliOverride optional explicit cli.js path from app config.
 */
export async function resolvePiRuntime(cliOverride?: string): Promise<ResolvedRuntime> {
  if (resolvedRuntime) return resolvedRuntime;
  if (resolvingRuntime) return resolvingRuntime;
  resolvingRuntime = (async () => {
    // 1. Explicit user override (Settings > pi cli path)
    if (cliOverride && cliOverride.trim()) {
      const cli = cliOverride.trim();
      if (!existsSync(cli)) throw new Error(`Configured pi cli path does not exist: ${cli}`);
      const shimDir = dirname(cli);
      const node = locateNode(shimDir);
      if (!node) throw new Error("A system `node` binary was not found on PATH. Install Node.js, then restart Pi Studio.");
      resolvedRuntime = { node, cli };
      resolvedKind = "override";
      return resolvedRuntime;
    }

    // 2. App-updated runtime under userData (written by the core updater)
    const userData = locateUserDataRuntime();
    if (userData) {
      resolvedRuntime = userData;
      resolvedKind = "userData";
      return resolvedRuntime;
    }

    // 3. First launch of a new packaged app: extract and verify the embedded
    // standalone runtime described by resources/runtime-manifest.json. The
    // promise is shared so the warm bridge and renderer diagnostics never
    // install it twice.
    let runtimeBootstrapError: unknown = null;
    try {
      const installedRoot = await ensureRuntimePackage();
      const installed = installedRoot ? runtimePathsForRoot(installedRoot) : null;
      if (installed) {
        resolvedRuntime = installed;
        resolvedKind = "userData";
        return resolvedRuntime;
      }
    } catch (error) {
      runtimeBootstrapError = error;
      // eslint-disable-next-line no-console
      console.error("[pi] standalone runtime bootstrap failed:", (error as Error)?.message || String(error));
    }

    // 4. Legacy bundled runtime (old packaged app or dev with resources/bundled/)
    const bundled = getBundledRuntime();
    if (bundled) {
      resolvedRuntime = bundled;
      resolvedKind = "bundled";
      return resolvedRuntime;
    }

    // In a packaged release, a failed standalone bootstrap must not silently
    // fall through to a global PATH install. That would make the app-managed
    // update button operate on a different Pi installation than the app uses.
    if (runtimeBootstrapError && getRuntimePackageManifest()) {
      throw new Error(`Pi runtime package could not be installed: ${(runtimeBootstrapError as Error)?.message || String(runtimeBootstrapError)}`);
    }

    // 5. Fall back to PATH scanning (dev mode or user-installed pi).
    const loc = locatePiCli();
    if (!loc) {
      if (runtimeBootstrapError) {
        throw new Error(`Pi runtime package could not be installed: ${(runtimeBootstrapError as Error)?.message || String(runtimeBootstrapError)}`);
      }
      throw new Error(
        "pi was not found. Install it with `npm i -g @earendil-works/pi-coding-agent`, or set a custom cli.js path in Settings.",
      );
    }
    const cli = loc.cli;
    const node = locateNode(loc.shimDir);
    if (!node) {
      throw new Error("A system `node` binary was not found on PATH. Install Node.js, then restart Pi Studio.");
    }
    resolvedRuntime = { node, cli };
    resolvedKind = "system";
    return resolvedRuntime;
  })().finally(() => {
    resolvingRuntime = null;
  });
  return resolvingRuntime;
}

/** Forget cached runtime so the next open re-resolves (e.g. after settings change or core update). */
export function resetPiRuntime(): void {
  resolvedRuntime = null;
  resolvedKind = null;
  resolvingRuntime = null;
}

/** Which source the cached runtime came from (null before first resolution). */
export function runtimeKind(): RuntimeKind | null {
  return resolvedKind;
}

/**
 * True when the resolved runtime is managed by the app itself (bundled copy or
 * an app-updated copy under userData) — i.e. `pi update` cannot update it and
 * the in-app core updater must be used instead. Only valid after resolution.
 */
export function isAppManagedRuntime(): boolean {
  return resolvedKind === "bundled" || resolvedKind === "userData";
}

export interface PiBridgeOptions {
  cwd: string;
  piCliPath?: string;
  /** Resume an existing session file; omit to create a fresh session. */
  sessionFile?: string;
  /** Initial display name for a brand new session. */
  name?: string;
  /** Absolute paths to extension files loaded for this run (e.g. the sandbox permission gate). */
  extensions?: string[];
  /** Skill directories/files to load explicitly for deterministic discovery. */
  skills?: string[];
  /** Per-thread gate mode file exposed to the gate extension as
   * PI_STUDIO_GATE_MODE_FILE so sandbox/full can be toggled without a restart. */
  gateModeFile?: string;
  onEvent: (event: unknown) => void;
  onExtUi: (request: ExtUiRequest) => void;
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null; stderr: string; expected?: boolean }) => void;
  onError?: (err: Error) => void;
}

export interface ExtUiRequest {
  id: string;
  method: string;
  [key: string]: unknown;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  command: string;
}

export class PiBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readonly opts: PiBridgeOptions;
  private readonly pending = new Map<string, PendingRequest>();
  private reqCounter = 0;
  private stderrBuf = "";
  private started = false;
  private exited = false;
  /** True once stop() was called; the resulting exit is intentional, not a crash. */
  private stopRequested = false;

  constructor(opts: PiBridgeOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const rt = await resolvePiRuntime(this.opts.piCliPath);
    const args = ["--mode", "rpc"];
    if (this.opts.name) args.push("--name", this.opts.name);
    if (this.opts.sessionFile) args.push("--session", this.opts.sessionFile);
    for (const ext of this.opts.extensions || []) args.push("--extension", ext);
    for (const skill of this.opts.skills || []) args.push("--skill", skill);

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.opts.gateModeFile) env.PI_STUDIO_GATE_MODE_FILE = this.opts.gateModeFile;

    this.proc = spawn(rt.node, [rt.cli, ...args], {
      cwd: this.opts.cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutDecoder = new StringDecoder("utf8");
    let buf = "";
    this.proc.stdout.on("data", (chunk: Buffer) => {
      buf += stdoutDecoder.write(chunk);
      while (true) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length === 0) continue;
        this.handleLine(line);
      }
    });

    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuf += chunk.toString("utf8");
      if (this.stderrBuf.length > 64 * 1024) this.stderrBuf = this.stderrBuf.slice(-32 * 1024);
    });

    this.proc.on("error", (err) => {
      this.opts.onError?.(err);
      this.rejectAllPending(err);
    });

    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      // flush decoder
      buf += stdoutDecoder.end();
      if (buf.trim().length > 0) this.handleLine(buf.endsWith("\r") ? buf.slice(0, -1) : buf);
      const stderr = this.stderrBuf.trim();
      const detail = stderr ? `: ${stderr.slice(-4000)}` : "";
      this.rejectAllPending(new Error(`pi process exited (code=${code}, signal=${signal})${detail}`));
      this.opts.onExit({ code, signal, stderr: this.stderrBuf, expected: this.stopRequested });
    });
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      // not JSON; ignore stray output
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "response") {
      const id = typeof msg.id === "string" ? msg.id : null;
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        if (msg.success === false) p.reject(new Error(msg.error || `${p.command} failed`));
        else p.resolve(msg.data);
      }
      return;
    }

    if (msg.type === "extension_ui_request") {
      this.opts.onExtUi(msg as ExtUiRequest);
      return;
    }

    // everything else is an agent event
    this.opts.onEvent(msg);
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      p.reject(err);
      this.pending.delete(id);
    }
  }

  /** Send a command and resolve with its `data` payload. */
  send(command: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.exited) {
        reject(new Error("pi bridge is not running"));
        return;
      }
      const id = `r${++this.reqCounter}`;
      this.pending.set(id, { resolve, reject, command });
      const line = JSON.stringify({ id, type: command, ...payload }) + "\n";
      this.proc.stdin.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Reply to an extension UI dialog request (select/confirm/input/editor). */
  respondExtUi(id: string, payload: Record<string, unknown>): void {
    if (!this.proc || this.exited) return;
    this.proc.stdin.write(JSON.stringify({ type: "extension_ui_response", id, ...payload }) + "\n");
  }

  // ---- convenience wrappers -------------------------------------------------

  prompt(message: string, images?: unknown[]): Promise<unknown> {
    const payload: Record<string, unknown> = { message };
    if (images && images.length) payload.images = images;
    return this.send("prompt", payload);
  }
  steer(message: string, images?: unknown[]): Promise<unknown> {
    const payload: Record<string, unknown> = { message };
    if (images && images.length) payload.images = images;
    return this.send("steer", payload);
  }
  followUp(message: string, images?: unknown[]): Promise<unknown> {
    const payload: Record<string, unknown> = { message };
    if (images && images.length) payload.images = images;
    return this.send("follow_up", payload);
  }
  abort(): Promise<unknown> {
    return this.send("abort");
  }
  getState(): Promise<unknown> {
    return this.send("get_state");
  }
  getMessages(): Promise<unknown> {
    return this.send("get_messages");
  }
  getEntries(since?: string): Promise<unknown> {
    return this.send("get_entries", since ? { since } : {});
  }
  branchAt(entryId: string): Promise<unknown> {
    return this.prompt(`/pi-studio-branch-at ${entryId}`);
  }
  setModel(provider: string, modelId: string): Promise<unknown> {
    return this.send("set_model", { provider, modelId });
  }
  getAvailableModels(): Promise<unknown> {
    return this.send("get_available_models");
  }
  async refreshModels(): Promise<unknown> {
    await this.prompt("/pi-studio-refresh-models");
    return this.getAvailableModels();
  }
  setThinkingLevel(level: string): Promise<unknown> {
    return this.send("set_thinking_level", { level });
  }
  getAvailableThinkingLevels(): Promise<unknown> {
    return this.send("get_available_thinking_levels");
  }
  newSession(parentSession?: string): Promise<unknown> {
    return this.send("new_session", parentSession ? { parentSession } : {});
  }
  switchSession(sessionPath: string): Promise<unknown> {
    return this.send("switch_session", { sessionPath });
  }
  setSessionName(name: string): Promise<unknown> {
    return this.send("set_session_name", { name });
  }
  getCommands(): Promise<unknown> {
    return this.send("get_commands");
  }
  getSessionStats(): Promise<unknown> {
    return this.send("get_session_stats");
  }

  stop(): void {
    if (!this.proc || this.exited) return;
    this.stopRequested = true;
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
  }

  get running(): boolean {
    return !!this.proc && !this.exited;
  }

  get cwd(): string {
    return this.opts.cwd;
  }
}
