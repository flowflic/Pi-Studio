import { getConfig, getConfigDir, reloadConfig, updateConfig, type AutomationTask, type TaskSchedule } from "./config";
import { PiBridge } from "./pi-bridge";
import { createGateModeFile, ensureGateExtension, removeGateModeFile } from "./permission-gate";

/**
 * Scheduled automation. Tasks are user-defined prompts (which may invoke
 * skills) run in a chosen working folder on an hourly/daily/weekly schedule.
 *
 * The scheduler lives in the main process and only runs while Pi Studio is
 * open. Each fire spawns a fresh pi session in the task's folder, sends the
 * prompt, and waits for `agent_settled`. pi persists the session automatically,
 * so the result appears in the sidebar as a normal, reviewable thread.
 *
 * Tasks default to sandbox. Since unattended jobs cannot answer approval
 * prompts, a sandbox task fails closed when a gated operation is attempted.
 * Full permission must be selected explicitly per task.
 */

export interface AutomationNotify {
  type: "start" | "done";
  taskId: string;
  name: string;
  ok?: boolean;
  error?: string;
}

interface AssistantMessageSummary {
  stopReason?: unknown;
  errorMessage?: unknown;
}

export function automationSessionName(taskName: string, language: "en" | "zh"): string {
  return `${language === "zh" ? "自动化" : "Automation"}: ${taskName}`;
}

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;
const running = new Set<string>();
const activeBridges = new Set<PiBridge>();
const activeBridgesByTask = new Map<string, Set<PiBridge>>();
let notify: ((p: AutomationNotify) => void) | null = null;

const pad = (n: number) => String(n).padStart(2, "0");

function matches(schedule: TaskSchedule, d: Date): boolean {
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (schedule.frequency === "hourly") return d.getMinutes() === (schedule.minute ?? 0);
  if (schedule.frequency === "daily") return hhmm === (schedule.time || "00:00");
  if (schedule.frequency === "weekly") return (schedule.days || []).includes(d.getDay()) && hhmm === (schedule.time || "00:00");
  return false;
}

/** A dedup key for the current slot so a task fires at most once per slot. */
function slotKey(schedule: TaskSchedule, d: Date): string {
  const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  if (schedule.frequency === "hourly") return `${day}-h${d.getHours()}`;
  return day; // daily / weekly: once per calendar day
}

function persist(tasks: AutomationTask[]): void {
  updateConfig({ automationTasks: tasks });
}

function persistedTasks(): AutomationTask[] {
  return reloadConfig().automationTasks;
}

function taskStillExists(id: string): boolean {
  return persistedTasks().some((task) => task.id === id);
}

function patchTask(id: string, patch: Partial<AutomationTask>): boolean {
  const tasks = persistedTasks();
  if (!tasks.some((task) => task.id === id)) return false;
  persist(tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  return true;
}

function tick(): void {
  const now = new Date();
  // The renderer normally deletes through this process, but another Pi Studio
  // process or an older build may have written config.json. Re-read before
  // every tick so a deleted task cannot continue from a stale memory snapshot.
  const tasks = persistedTasks();
  for (const task of tasks) {
    if (!task.enabled || running.has(task.id)) continue;
    if (!matches(task.schedule, now)) continue;
    const slot = slotKey(task.schedule, now);
    if (task.lastRunSlot === slot) continue;
    // Claim the slot before awaiting so a re-entrant tick can't double-fire.
    patchTask(task.id, { lastRunSlot: slot, lastRunAt: now.getTime() });
    void execute(task);
  }
}

/** Remove a task and stop a run that was already spawned for it. */
export function removeAutomationTask(id: string): void {
  const tasks = persistedTasks();
  if (tasks.some((task) => task.id === id)) persist(tasks.filter((task) => task.id !== id));

  const bridges = activeBridgesByTask.get(id);
  if (!bridges) return;
  for (const bridge of bridges) {
    try {
      bridge.stop();
    } catch {
      /* ignore cancellation races */
    }
  }
}

export function startScheduler(send: (p: AutomationNotify) => void): void {
  notify = send;
  if (timer) return;
  timer = setInterval(tick, 20_000);
  bootTimer = setTimeout(tick, 4_000);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  if (bootTimer) clearTimeout(bootTimer);
  timer = null;
  bootTimer = null;
}

/** Stop currently running automation child processes during app shutdown. */
export function stopAutomations(): void {
  for (const bridge of activeBridges) {
    try {
      bridge.stop();
    } catch {
      /* ignore shutdown races */
    }
  }
}

const RUN_TIMEOUT_MS = 30 * 60 * 1000;

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Return a failure only when the final assistant message proves that the run
 * did not finish normally. `agent_settled` alone is not enough: pi emits it
 * from a finally block even when a prompt throws or is aborted.
 */
function getAssistantFailure(message: AssistantMessageSummary | null): string | null {
  if (!message) return "Pi 未返回最终助手消息，任务未完成";

  const reason = textValue(message.stopReason);
  const detail = textValue(message.errorMessage);
  if (reason === "error") return detail ? `Pi 返回错误：${detail}` : "Pi 返回错误";
  if (reason === "aborted") {
    return detail && detail !== "Request was aborted" ? `任务被中止：${detail}` : "任务被中止";
  }
  if (reason === "length") return "模型输出达到最大长度限制，结果可能不完整";
  if (reason !== "stop") {
    return reason ? `Pi 在未完成任务时结束（stopReason=${reason}）` : "Pi 未返回有效的完成原因";
  }
  return null;
}

function formatProcessExit(info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }): string {
  const code = info.code === null ? "null" : String(info.code);
  const signal = info.signal ? `, signal=${info.signal}` : "";
  const stderr = textValue(info.stderr);
  const detail = stderr ? `：${stderr.slice(-4000)}` : "";
  return `Pi 进程在任务完成前退出（code=${code}${signal}）${detail}`;
}

async function execute(task: AutomationTask): Promise<void> {
  // A tick may have queued execute() just before the task was deleted. Do not
  // create a new Pi process for a task that no longer exists on disk.
  if (!taskStillExists(task.id)) return;
  running.add(task.id);
  patchTask(task.id, { lastStatus: undefined, lastError: undefined });
  notify?.({ type: "start", taskId: task.id, name: task.name });
  let bridge: PiBridge | null = null;
  let gateModeFile: string | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      let lastAssistantMessage: AssistantMessageSummary | null = null;
      let cancelledUiMethod: string | null = null;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        fn();
      };
      const timeout = setTimeout(() => {
        finish(() => reject(new Error("运行超时（30 分钟），任务已停止")));
        try {
          bridge?.stop();
        } catch {
          /* cleanup in finally */
        }
      }, RUN_TIMEOUT_MS);

      const permission = task.permission === "full" ? "full" : "sandbox";
      gateModeFile = createGateModeFile(getConfigDir(), permission);
      if (!taskStillExists(task.id)) {
        finish(() => resolve());
        return;
      }
      bridge = new PiBridge({
        cwd: task.cwd,
        piCliPath: getConfig().piCliPath,
        extensions: [ensureGateExtension(getConfigDir())],
        gateModeFile,
        name: automationSessionName(task.name, getConfig().language),
        onEvent: (e: any) => {
          if (e?.type === "message_end" && e.message?.role === "assistant") {
            lastAssistantMessage = {
              stopReason: e.message.stopReason,
              errorMessage: e.message.errorMessage,
            };
            return;
          }
          if (e?.type !== "agent_settled") return;

          finish(() => {
            if (cancelledUiMethod) {
              reject(new Error(`自动化任务需要人工交互（${cancelledUiMethod}），无人值守运行已停止`));
              return;
            }
            const failure = getAssistantFailure(lastAssistantMessage);
            if (failure) reject(new Error(failure));
            else resolve();
          });
        },
        onExtUi: (r: any) => {
          // Unattended runs cannot answer dialogs. Cancel it immediately and
          // surface a failure after the agent settles instead of reporting a
          // misleading success.
          const method = textValue(r?.method) || "extension UI";
          if (method !== "notify" && !cancelledUiMethod) cancelledUiMethod = method;
          bridge?.respondExtUi(r.id, { cancelled: true });
        },
        onExit: (info) => finish(() => reject(new Error(formatProcessExit(info)))),
        onError: (err) => finish(() => reject(err)),
      });
      activeBridges.add(bridge);
      let taskBridges = activeBridgesByTask.get(task.id);
      if (!taskBridges) {
        taskBridges = new Set<PiBridge>();
        activeBridgesByTask.set(task.id, taskBridges);
      }
      taskBridges.add(bridge);

      bridge
        .start()
        .then(() => bridge!.prompt(task.prompt))
        .catch((e) => finish(() => reject(e)));
    });
    if (taskStillExists(task.id)) {
      patchTask(task.id, { lastStatus: "ok", lastError: undefined });
      notify?.({ type: "done", taskId: task.id, name: task.name, ok: true });
    }
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (taskStillExists(task.id)) {
      patchTask(task.id, { lastStatus: "error", lastError: msg });
      // Keep failures visible in the main-process log as well as the settings UI.
      // eslint-disable-next-line no-console
      console.error(`[automation] ${task.name}: ${msg}`);
      notify?.({ type: "done", taskId: task.id, name: task.name, ok: false, error: msg });
    }
  } finally {
    const b = bridge as PiBridge | null;
    try {
      b?.stop();
    } catch {
      /* ignore */
    }
    if (b) {
      activeBridges.delete(b);
      const taskBridges = activeBridgesByTask.get(task.id);
      taskBridges?.delete(b);
      if (taskBridges && taskBridges.size === 0) activeBridgesByTask.delete(task.id);
    }
    if (gateModeFile) removeGateModeFile(gateModeFile);
    running.delete(task.id);
  }
}

/** Run a task immediately (the "Run now" button), bypassing the schedule. */
export async function runTaskNow(id: string): Promise<void> {
  const task = persistedTasks().find((t) => t.id === id);
  if (!task) throw new Error("Task not found");
  if (running.has(id)) return;
  patchTask(id, { lastRunAt: Date.now() });
  await execute(task);
}
