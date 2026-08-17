import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getConfig } from "./config";
import { getAgentDir, getSessionsDir } from "./session-store";
import { isAppManagedRuntime, resolvePiRuntime, runtimeKind } from "./pi-bridge";
import { toPiRuntimeProvider, toPiRuntimeProviders, toSettingsProviders } from "./model-url-compat";
import type { Diagnostics, ModelsFile, ProviderDef, ThinkingDefaults } from "../renderer/src/lib/types";

/**
 * Safe read/write access to pi's `models.json` and the thinking-related slice
 * of `settings.json`, plus a diagnostics snapshot for the Settings panel.
 *
 * Round-trip safety: we never rebuild these files from a fixed schema. We parse
 * the existing file, mutate only the subtree we own, and write back — so any
 * hand-written advanced fields (per-model `compat`, `thinkingFormat`, custom
 * `headers`, unknown top-level keys, etc.) survive untouched. Writes are atomic
 * (write to a sibling .tmp then rename) so a crash mid-write cannot corrupt the
 * file pi is about to reload.
 */

export function getModelsPath(): string {
  return join(getAgentDir(), "models.json");
}
export function getSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}
export function getAuthPath(): string {
  return join(getAgentDir(), "auth.json");
}

function readJson<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

/* ---------------- models.json ---------------- */

export function readModelsFile(): ModelsFile {
  const parsed = readJson<ModelsFile>(getModelsPath());
  if (!parsed || typeof parsed !== "object") return { providers: {} };
  if (!parsed.providers || typeof parsed.providers !== "object") parsed.providers = {};
  return { ...parsed, providers: toSettingsProviders(parsed.providers) };
}

/**
 * Replace the `providers` subtree while preserving any other top-level keys the
 * user may have added by hand. `providers` is the renderer's edited copy; each
 * provider/model object inside it is preserved (unknown fields included), with
 * only protocol-specific URL compatibility normalized for Pi at write time.
 */
export function writeModelsProviders(providers: Record<string, ProviderDef>): ModelsFile {
  const existing = readJson<Record<string, unknown>>(getModelsPath()) || {};
  const next: Record<string, unknown> = { ...existing, providers: toPiRuntimeProviders(providers) };
  writeJsonAtomic(getModelsPath(), next);
  return next as ModelsFile;
}

export interface ModelAvailabilityResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

const MODEL_TEST_TIMEOUT_MS = 120_000;

function conciseModelTestError(stdout: string, stderr: string, fallback: string, secret?: string): string {
  const candidates: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line);
      const message =
        value?.message?.errorMessage ||
        value?.error?.message ||
        value?.error ||
        (value?.type === "error" ? value?.message : undefined);
      if (typeof message === "string" && message.trim()) candidates.push(message.trim());
    } catch {
      // JSON output may contain non-event startup lines; stderr is checked next.
    }
  }
  const stderrText = stderr.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (stderrText) candidates.push(stderrText.split(/\r?\n/).filter(Boolean).slice(-3).join(" "));
  candidates.push(fallback);
  let message = candidates.find((value) => value.trim()) || "Model request failed.";
  if (secret && !secret.startsWith("$") && !secret.startsWith("!")) message = message.split(secret).join("[redacted]");
  return message.length > 600 ? message.slice(0, 597) + "..." : message;
}

/**
 * Run a real, minimal inference against an edited provider/model definition.
 * The isolated agent directory lets unsaved Settings changes be tested without
 * modifying the user's models.json or creating a thread/session.
 */
export async function testModelAvailability(
  providerId: string,
  provider: ProviderDef,
  modelId: string,
): Promise<ModelAvailabilityResult> {
  const started = Date.now();
  const testDir = mkdtempSync(join(tmpdir(), "pi-studio-model-test-"));
  try {
    const targetModel = (provider.models || []).find((model) => model.id === modelId);
    // Some reasoning-only gateways reject enable_thinking=false outright.
    // Keep the test cheap with the lowest supported level, but do not send an
    // invalid "off" request for models explicitly configured for reasoning.
    const testThinkingLevel = targetModel?.reasoning ? "minimal" : "off";
    writeFileSync(
      join(testDir, "models.json"),
      JSON.stringify({ providers: { [providerId]: toPiRuntimeProvider(provider) } }, null, 2) + "\n",
      "utf8",
    );
    const authPath = getAuthPath();
    if (existsSync(authPath)) copyFileSync(authPath, join(testDir, "auth.json"));
    const runtime = await resolvePiRuntime(getConfig().piCliPath);
    const args = [
      runtime.cli,
      "--provider",
      providerId,
      "--model",
      modelId,
      "--thinking",
      testThinkingLevel,
      "--system-prompt",
      "You are a connectivity probe. Do not reason. Reply only with ok.",
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--offline",
      "测试连通性，不要思考，回复我ok即可",
    ];
    return await new Promise<ModelAvailabilityResult>((resolve) => {
      const child = spawn(runtime.node, args, {
        cwd: testDir,
        windowsHide: true,
        env: {
          ...process.env,
          PI_AGENT_DIR: testDir,
          PI_CODING_AGENT_DIR: testDir,
          PI_CODING_AGENT_SESSION_DIR: join(testDir, "sessions"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdoutBuffer = "";
      let stdoutTail = "";
      let stderr = "";
      let result: ModelAvailabilityResult | null = null;
      let resolved = false;

      const settleOnExit = (next: ModelAvailabilityResult, stopEarly = false) => {
        if (result) return;
        result = next;
        clearTimeout(timeout);
        if (stopEarly && !child.killed) child.kill();
      };
      const finish = (next: ModelAvailabilityResult) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        resolve(next);
      };
      const success = () =>
        settleOnExit(
          {
            ok: true,
            latencyMs: Date.now() - started,
            message: "Model started responding successfully.",
          },
          true,
        );
      const failure = (message: string, stopEarly = false) =>
        settleOnExit(
          {
            ok: false,
            latencyMs: Date.now() - started,
            message: conciseModelTestError(stdoutTail, stderr, message, provider.apiKey),
          },
          stopEarly,
        );

      const inspectEvent = (line: string) => {
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event?.type === "message_update") {
          const update = event.assistantMessageEvent;
          if ((update?.type === "text_delta" || update?.type === "thinking_delta") && update.delta) success();
          return;
        }
        if (event?.type === "message_end" && event.message?.role === "assistant") {
          if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
            failure(event.message.errorMessage || `Request ${event.message.stopReason}`, true);
          } else {
            success();
          }
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdoutTail = (stdoutTail + text).slice(-32 * 1024);
        stdoutBuffer += text;
        while (true) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (line) inspectEvent(line);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-32 * 1024);
      });
      child.on("error", (error) => {
        finish({
          ok: false,
          latencyMs: Date.now() - started,
          message: conciseModelTestError(stdoutTail, stderr, error.message, provider.apiKey),
        });
      });
      child.on("close", (code) => {
        if (stdoutBuffer.trim()) inspectEvent(stdoutBuffer.trim());
        if (result) {
          finish(result);
          return;
        }
        finish({
          ok: false,
          latencyMs: Date.now() - started,
          message: conciseModelTestError(
            stdoutTail,
            stderr,
            code === 0 ? "The model process exited without producing a response." : `Model test process exited with code ${code}.`,
            provider.apiKey,
          ),
        });
      });

      const timeout = setTimeout(() => {
        failure("The model did not start responding within 120 seconds.", true);
      }, MODEL_TEST_TIMEOUT_MS);
    });
  } catch (error: any) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: conciseModelTestError("", "", error?.message || String(error), provider.apiKey),
    };
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
}

/* ---------------- settings.json (thinking slice) ---------------- */

const THINK_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel", "hideThinkingBlock"] as const;

export function readThinking(): ThinkingDefaults {
  const parsed = readJson<Record<string, unknown>>(getSettingsPath()) || {};
  const out: ThinkingDefaults = {};
  for (const k of THINK_KEYS) {
    if (parsed[k] !== undefined) (out as any)[k] = parsed[k];
  }
  return out;
}

/**
 * Merge a partial patch into settings.json. `undefined` values are skipped (keep
 * current); any other value (including `null`/`""`) is written as-is so the user
 * can clear a default by setting it to an empty string.
 */
export function writeThinking(patch: Partial<ThinkingDefaults>): ThinkingDefaults {
  const parsed = readJson<Record<string, unknown>>(getSettingsPath()) || {};
  const next: Record<string, unknown> = { ...parsed };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null || v === "") delete next[k];
    else next[k] = v;
  }
  writeJsonAtomic(getSettingsPath(), next);
  return readThinking();
}

/* ---------------- diagnostics ---------------- */

function readPiVersion(cli: string | null): string | null {
  if (!cli) return null;
  try {
    const pkgPath = join(dirname(dirname(cli)), "package.json");
    const pkg = readJson<{ version?: string }>(pkgPath);
    return pkg?.version || null;
  } catch {
    return null;
  }
}

function probeNodeVersion(node: string | null): Promise<string | null> {
  if (!node) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(node, ["-v"], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.trim().replace(/^v/, "") || null);
    });
  });
}

export async function getDiagnostics(): Promise<Diagnostics> {
  const agentDir = getAgentDir();
  const sessionsDir = getSessionsDir();
  const settingsPath = getSettingsPath();
  const authPath = getAuthPath();
  const modelsPath = getModelsPath();
  const base: Diagnostics = {
    node: null,
    cli: null,
    nodeVersion: null,
    piVersion: null,
    agentDir,
    sessionsDir,
    settingsPath,
    authPath,
    modelsPath,
    settingsExists: existsSync(settingsPath),
    authExists: existsSync(authPath),
    modelsExists: existsSync(modelsPath),
    runtimeKind: "unknown",
    bundled: false,
    error: null,
  };
  try {
    const rt = await resolvePiRuntime();
    base.node = rt.node;
    base.cli = rt.cli;
    base.piVersion = readPiVersion(rt.cli);
    base.nodeVersion = await probeNodeVersion(rt.node);
    // Must be read AFTER resolution: the kind is only known once cached.
    base.runtimeKind = runtimeKind() || "unknown";
    base.bundled = isAppManagedRuntime();
  } catch (e: any) {
    base.error = e?.message || String(e);
  }
  return base;
}
