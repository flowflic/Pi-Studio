import { BrowserWindow, Notification } from "electron";

export type NotificationLanguage = "en" | "zh";

export interface TaskCompletionNotification {
  language: NotificationLanguage;
  prompt?: string;
  reply?: string;
}

export interface SystemNotificationCenter {
  notifySandboxApproval(threadId: string, language: NotificationLanguage, operation?: string): void;
  notifyTaskComplete(threadId: string, details: TaskCompletionNotification): void;
}

type WindowGetter = () => BrowserWindow | null;

/** Keep native notification content compact enough for both Windows and macOS banners. */
export function truncateNotificationText(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

/** The permission gate identifies its actionable prompts through this stable title prefix. */
export function isSandboxApprovalRequest(request: unknown): boolean {
  if (!request || typeof request !== "object") return false;
  const value = request as { method?: unknown; title?: unknown };
  if (value.method !== "select" || typeof value.title !== "string") return false;
  return /^(?:Sandbox\s+authorization|Sandbox\s+请求授权|沙盒\s*请求授权|请求授权)\s*[:：]/i.test(value.title.trim());
}

/** Extract only the operation label; the full command remains inside Pi Studio. */
export function sandboxOperationFromTitle(title: unknown, language: NotificationLanguage = "en"): string {
  if (typeof title !== "string") return language === "zh" ? "命令行" : "Shell";
  const firstLine = title.split(/\r?\n/, 1)[0] || "";
  const operation = firstLine.replace(/^(?:Sandbox\s+(?:authorization|请求授权)|沙盒\s*请求授权|请求授权)\s*[:：]\s*/i, "").trim();
  return truncateNotificationText(operation || (language === "zh" ? "命令行" : "Shell"), 80);
}

function revealThread(getWindow: WindowGetter, threadId: string): void {
  const window = getWindow();
  if (!window || window.isDestroyed()) return;

  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();

  const sendFocus = () => {
    if (!window.isDestroyed()) window.webContents.send("app:focus-thread", { threadId });
  };
  if (window.webContents.isLoading()) window.webContents.once("did-finish-load", sendFocus);
  else sendFocus();
}

export function createSystemNotificationCenter(getWindow: WindowGetter): SystemNotificationCenter {
  // Keeping a reference until close makes the click handler reliable on Windows,
  // where the native toast can outlive the JavaScript call stack.
  const active = new Set<Notification>();

  const show = (
    threadId: string,
    language: NotificationLanguage,
    options: { title: string; subtitle?: string; body: string; persistent?: boolean },
  ) => {
    if (!Notification.isSupported()) return;
    const window = getWindow();
    // The in-app confirmation card and transcript are already visible when Pi
    // Studio owns the foreground. Native banners are for other apps/desktops.
    if (window && !window.isDestroyed() && window.isFocused()) return;

    let notification: Notification;
    try {
      notification = new Notification({
        title: options.title,
        subtitle: options.subtitle,
        body: options.body,
        silent: false,
        timeoutType: options.persistent ? "never" : "default",
      });
    } catch {
      return;
    }

    active.add(notification);
    notification.once("click", () => revealThread(getWindow, threadId));
    notification.once("close", () => active.delete(notification));
    notification.once("failed", (_event, error) => {
      active.delete(notification);
      // eslint-disable-next-line no-console
      console.warn(`[notification] native notification failed: ${error}`);
    });
    notification.show();
  };

  return {
    notifySandboxApproval(threadId, language, operation) {
      const label = truncateNotificationText(operation || (language === "zh" ? "命令行" : "Shell"), 80);
      show(threadId, language, {
        title: language === "zh" ? "Pi Studio · 需要确认" : "Pi Studio · Approval required",
        subtitle: label,
        body:
          language === "zh"
            ? `沙盒正在等待确认（${label}）。点击此提醒返回 Pi Studio。`
            : `Sandbox is waiting for approval (${label}). Click to return to Pi Studio.`,
        persistent: true,
      });
    },

    notifyTaskComplete(threadId, details) {
      const language = details.language;
      const prompt = truncateNotificationText(details.prompt, 72);
      const reply = truncateNotificationText(details.reply, 220);
      const body = reply || (language === "zh" ? "点击此提醒查看完整回复。" : "Click to view the completed reply.");
      show(threadId, language, {
        title: language === "zh" ? "Pi Studio · 任务完成" : "Pi Studio · Task completed",
        subtitle: prompt || undefined,
        body,
      });
    },
  };
}
