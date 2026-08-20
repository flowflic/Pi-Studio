import { useState } from "react";
import { useStore } from "../store";
import type { AutomationTask, ScheduleFrequency, TaskSchedule } from "../lib/types";
import { Close, Plus, Clock, Folder, Play } from "./icons";

const DAY_NAMES = {
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  zh: ["日", "一", "二", "三", "四", "五", "六"],
} as const;
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun

const uid = () => `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function newTask(): AutomationTask {
  return {
    id: uid(),
    name: "",
    cwd: "",
    prompt: "",
    schedule: { frequency: "daily", time: "09:00" },
    enabled: true,
    permission: "sandbox",
  };
}

function summarize(s: TaskSchedule, language: "en" | "zh"): string {
  if (language === "en") {
    if (s.frequency === "hourly") return `Hourly at minute ${s.minute ?? 0}`;
    if (s.frequency === "daily") return `Daily at ${s.time || "00:00"}`;
    const days = (s.days || []).map((d) => DAY_NAMES.en[d]).join(", ");
    return `Weekly on ${days || "—"} at ${s.time || "00:00"}`;
  }
  if (s.frequency === "hourly") return `每小时 第 ${s.minute ?? 0} 分钟`;
  if (s.frequency === "daily") return `每天 ${s.time || "00:00"}`;
  const days = (s.days || []).map((d) => DAY_NAMES.zh[d]).join("、");
  return `每周 ${days || "—"} ${s.time || "00:00"}`;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`set-toggle ${checked ? "on" : ""}`} aria-checked={checked} role="switch" onClick={() => onChange(!checked)}>
      <span className="set-toggle-knob" />
    </button>
  );
}

export function AutomationPanel() {
  const open = useStore((s) => s.automationOpen);
  const close = useStore((s) => s.closeAutomation);
  const tasks = useStore((s) => s.tasks);
  const saveTask = useStore((s) => s.saveTask);
  const deleteTask = useStore((s) => s.deleteTask);
  const runTaskNow = useStore((s) => s.runTaskNow);
  const language = useStore((s) => s.config?.language || "en");

  const [draft, setDraft] = useState<AutomationTask | null>(null);

  if (!open) return null;

  const patch = (p: Partial<AutomationTask>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const patchSchedule = (p: Partial<TaskSchedule>) => setDraft((d) => (d ? { ...d, schedule: { ...d.schedule, ...p } } : d));

  const pickFolder = async () => {
    const p = await window.pi.app.showOpenDialog("folder");
    if (p && !Array.isArray(p)) patch({ cwd: p });
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) return useStore.getState().pushToast("warning", "请填写任务名称");
    if (!draft.cwd) return useStore.getState().pushToast("warning", "请选择工作文件夹");
    if (!draft.prompt.trim()) return useStore.getState().pushToast("warning", "请填写要执行的提示词");
    await saveTask(draft);
    setDraft(null);
  };

  const toggleDay = (day: number) => {
    if (!draft) return;
    const days = new Set(draft.schedule.days || []);
    days.has(day) ? days.delete(day) : days.add(day);
    patchSchedule({ days: [...days].sort((a, b) => a - b) });
  };

  const setFreq = (frequency: ScheduleFrequency) => {
    if (frequency === "hourly") patchSchedule({ frequency, minute: draft?.schedule.minute ?? 0 });
    else patchSchedule({ frequency, time: draft?.schedule.time || "09:00", days: draft?.schedule.days || (frequency === "weekly" ? [1] : undefined) });
  };

  return (
    <div className="settings-backdrop" onMouseDown={close}>
      <div className="plugins-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="plugins-head">
          <div className="plugins-head-title">
            <span className="set-brand-mark">
              <Clock size={18} />
            </span>
            <div>
              <div className="set-brand-title">自动化</div>
              <div className="set-brand-sub">{language === "zh" ? "定时执行可使用技能的自定义提示词（仅在 Pi Studio 运行时调度）" : "Schedule custom prompts that can use skills (runs while Pi Studio is open)"}</div>
            </div>
          </div>
          <button className="set-iconbtn" title="关闭" onClick={close}>
            <Close size={16} />
          </button>
        </header>

        <div className="plugins-body">
          {!draft && (
            <>
              <div className="plugins-install">
                <span className="muted">{language === "zh" ? `共 ${tasks.length} 个任务` : `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`}</span>
                <button className="set-btn primary" onClick={() => setDraft(newTask())}>
                  <Plus size={14} /> 新建任务
                </button>
              </div>

              {tasks.length === 0 && <div className="set-empty">尚无定时任务。点“新建任务”创建一个。</div>}
              {tasks.map((t) => (
                <div className="plugins-row auto-task" key={t.id}>
                  <div className="plugins-row-main">
                    <span className="plugins-row-name">{t.name || "未命名任务"}</span>
                    <span className="auto-freq">{summarize(t.schedule, language)}</span>
                    <span className={`auto-freq ${t.permission === "full" ? "plugins-off" : ""}`}>
                      {t.permission === "full" ? (language === "zh" ? "完全权限" : "Full access") : language === "zh" ? "沙盒" : "Sandbox"}
                    </span>
                    {t.lastStatus === "error" && <span className="plugins-off" title={t.lastError}>上次失败</span>}
                  </div>
                  <div className="plugins-row-sub" title={t.cwd}>
                    📁 {t.cwd}
                  </div>
                  <div className="plugins-row-sub auto-prompt">{t.prompt}</div>
                  <div className="plugins-row-actions">
                    {t.lastRunAt && <span className="muted auto-last">{new Date(t.lastRunAt).toLocaleString()}</span>}
                    <button className="set-iconbtn" title="立即运行" onClick={() => runTaskNow(t.id)}>
                      <Play size={14} />
                    </button>
                    <Toggle checked={t.enabled} onChange={(v) => saveTask({ ...t, enabled: v })} />
                    <button className="set-iconbtn" title="编辑" onClick={() => setDraft({ ...t })}>
                      ✎
                    </button>
                    <button
                      className="set-iconbtn danger"
                      title="删除"
                      onClick={() => {
                        const question = language === "zh" ? `删除任务 “${t.name}”？` : `Delete task “${t.name}”?`;
                        if (window.confirm(question)) deleteTask(t.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          {draft && (
            <div className="auto-editor">
              <div className="set-row wide">
                <label className="set-label">任务名称</label>
                <div className="set-control">
                  <input className="set-input" placeholder="例如：每日晨报" value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
                </div>
              </div>

              <div className="set-row wide">
                <label className="set-label">工作文件夹</label>
                <div className="set-control">
                  <div className="auto-folder">
                    <input className="set-input" placeholder="选择任务运行的项目目录" value={draft.cwd} onChange={(e) => patch({ cwd: e.target.value })} />
                    <button className="set-btn" onClick={pickFolder}>
                      <Folder size={14} /> 选择
                    </button>
                  </div>
                </div>
              </div>

              <div className="set-row wide">
                <label className="set-label">{language === "zh" ? "提示词" : "Prompt"}</label>
                <div className="set-control">
                  <textarea
                    className="set-json"
                    style={{ minHeight: 110 }}
                    placeholder={language === "zh"
                      ? "要执行的指令，可调用技能，例如：\n/standup 生成今日 standup 报告并写入 docs/"
                      : "Instructions to run. Skills are supported, for example:\n/standup Create today's standup report in docs/"}
                    value={draft.prompt}
                    onChange={(e) => patch({ prompt: e.target.value })}
                  />
                  <div className="set-hint">触发时在该文件夹新建一个 pi 会话执行，完成后保存为可查看的线程。</div>
                </div>
              </div>

              <div className="set-row wide">
                <label className="set-label">重复</label>
                <div className="set-control">
                  <div className="auto-permission-block">
                    <strong>{language === "zh" ? "运行权限" : "Run permission"}</strong>
                    <div className="auto-freq-tabs">
                      <button
                        className={`set-btn ${draft.permission !== "full" ? "primary" : "ghost"}`}
                        onClick={() => patch({ permission: "sandbox" })}
                      >
                        {language === "zh" ? "沙盒" : "Sandbox"}
                      </button>
                      <button
                        className={`set-btn ${draft.permission === "full" ? "primary" : "ghost"}`}
                        onClick={() => patch({ permission: "full" })}
                      >
                        {language === "zh" ? "完全权限" : "Full access"}
                      </button>
                    </div>
                    <div className="set-hint">
                      {language === "zh"
                        ? "自动化无法等待授权。沙盒会阻止需要确认的操作；完全权限仅用于你明确信任的任务。"
                        : "Automations cannot wait for approval. Sandbox blocks operations that require confirmation; use Full access only for explicitly trusted tasks."}
                    </div>
                  </div>
                  <div className="auto-freq-tabs">
                    {(["hourly", "daily", "weekly"] as ScheduleFrequency[]).map((f) => (
                      <button key={f} className={`set-btn ${draft.schedule.frequency === f ? "primary" : "ghost"}`} onClick={() => setFreq(f)}>
                        {f === "hourly" ? "按小时" : f === "daily" ? "每天" : "每周"}
                      </button>
                    ))}
                  </div>

                  {draft.schedule.frequency === "hourly" && (
                    <div className="auto-sched-line">
                      <span>每小时第</span>
                      <input
                        className="set-input num"
                        type="number"
                        min={0}
                        max={59}
                        style={{ width: 80 }}
                        value={draft.schedule.minute ?? 0}
                        onChange={(e) => patchSchedule({ minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })}
                      />
                      <span>分钟执行</span>
                    </div>
                  )}

                  {draft.schedule.frequency !== "hourly" && (
                    <div className="auto-sched-line">
                      <span>时刻</span>
                      <input className="set-input" type="time" style={{ width: 130 }} value={draft.schedule.time || "09:00"} onChange={(e) => patchSchedule({ time: e.target.value })} />
                    </div>
                  )}

                  {draft.schedule.frequency === "weekly" && (
                    <div className="auto-days">
                      {WEEK_ORDER.map((d) => (
                        <button
                          key={d}
                          className={`auto-day ${(draft.schedule.days || []).includes(d) ? "on" : ""}`}
                          onClick={() => toggleDay(d)}
                        >
                          {DAY_NAMES[language][d]}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="auto-editor-actions">
                <button className="set-btn ghost" onClick={() => setDraft(null)}>
                  取消
                </button>
                <button className="set-btn primary" onClick={save}>
                  保存任务
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
