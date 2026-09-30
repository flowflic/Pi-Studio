import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { UsageReport } from "../../../main/usage-service";
import "./usage-settings.css";
import { formatTokens } from "../lib/token-format";
import { PlanQuotaCards, UsageCostDetails, UsagePricingSettings } from "./UsageCostDetails";

const dateString = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const number = (n: number) => n.toLocaleString();
const colors = ["var(--control)", "var(--accent-soft)", "color-mix(in srgb, var(--accent) 40%, var(--surface))", "color-mix(in srgb, var(--accent) 70%, var(--surface))", "var(--accent)"];
type ActivityCell = { date: string; value: number; tokens: number; cost: number; valid: boolean };
export function UsageSettings({ language }: { language: string }) {
  const zh = language === "zh";
  const [preset, setPreset] = useState("year");
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 364); return dateString(d); });
  const [to, setTo] = useState(() => dateString(new Date()));
  const [mode, setMode] = useState<"daily" | "weekly" | "cumulative">("daily");
  const [report, setReport] = useState<UsageReport>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const tooltipId = useId();
  const [hovered, setHovered] = useState<{ cell: ActivityCell; left: number; top: number; below: boolean } | null>(null);
  const showTooltip = (cell: ActivityCell, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 24);
    const below = rect.top < 180;
    setHovered({ cell, left: Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12)), top: below ? rect.bottom + 8 : rect.top - 8, below });
  };
  useEffect(() => { setHovered(null); }, [from, to, mode, revision]);
  useEffect(() => {
    const clear = () => setHovered(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
    window.addEventListener("scroll", clear, true);
    window.addEventListener("resize", clear);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("scroll", clear, true); window.removeEventListener("resize", clear); window.removeEventListener("keydown", escape); };
  }, []);
  useEffect(() => {
    let disposed = false;
    const start = new Date(`${from}T00:00:00`), end = new Date(`${to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    setError(""); setBusy(true);
    if (!Number.isFinite(+start) || !Number.isFinite(+end) || +start >= +end) { setError(zh ? "请选择有效的时间范围" : "Choose a valid date range"); setBusy(false); return; }
    window.pi.settings.getUsage({ from: +start, to: +end }).then(r => { if (!disposed) setReport(r); }).catch(e => { if (!disposed) setError(String(e.message || e)); }).finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, [from, to, revision, zh]);
  const calendar = useMemo(() => {
    const end = new Date(`${to}T00:00:00`);
    const earliest = preset === "all" ? report?.days[0]?.date || dateString(new Date(end.getFullYear() - 1, end.getMonth(), end.getDate())) : from;
    const first = new Date(`${earliest}T00:00:00`);
    const limit = new Date(end); limit.setFullYear(limit.getFullYear() - 5);
    if (first < limit) first.setTime(+limit);
    const values = new Map(report?.days.map(d => [d.date, d]) || []);
    const cells: ActivityCell[] = [];
    if (!Number.isFinite(+first) || !Number.isFinite(+end) || first > end) return { cells, weeks: 0, max: 0 };
    first.setDate(first.getDate() - first.getDay());
    let cumulative = (report?.days || []).filter(day => day.date < dateString(first)).reduce((sum, day) => sum + day.tokens, 0);
    // Limit rendered calendar to five years; aggregation still covers the selected range.
    const count = Math.min(1834, Math.ceil((+end - +first) / 86400000) + 1);
    for (let i = 0; i < Math.ceil(count / 7) * 7; i++) {
      const d = new Date(first); d.setDate(first.getDate() + i);
      const date = dateString(d), day = values.get(date);
      cumulative += day?.tokens || 0;
      cells.push({ date, value: mode === "cumulative" ? cumulative : day?.tokens || 0, tokens: day?.tokens || 0, cost: day?.cost || 0, valid: date >= from && date <= to });
    }
    if (mode === "weekly") for (let i = 0; i < cells.length; i += 7) {
      const sum = cells.slice(i, i + 7).reduce((a, c) => a + c.tokens, 0);
      for (let j = i; j < i + 7; j++) cells[j].value = sum;
    }
    return { cells, weeks: cells.length / 7, max: Math.max(0, ...cells.filter(c => c.valid).map(c => c.value)) };
  }, [from, to, report, mode, preset]);
  const choosePreset = (value: string) => {
    setPreset(value);
    if (value === "custom") return;
    const end = new Date(), start = new Date();
    if (value === "all") start.setFullYear(2000, 0, 1);
    else start.setDate(start.getDate() - ({ today: 0, week: 6, month: 29, year: 364 }[value] || 0));
    setFrom(dateString(start)); setTo(dateString(end));
  };
  return <div className="usage-settings">
    <PlanQuotaCards language={language} />
    <div className="activity-toolbar">
      <select className="set-input" value={preset} onChange={e => choosePreset(e.target.value)}>
        {[["today", zh ? "今天" : "Today"], ["week", zh ? "近 7 天" : "Last 7 days"], ["month", zh ? "近 30 天" : "Last 30 days"], ["year", zh ? "近一年" : "Last year"], ["all", zh ? "全部" : "All time"], ["custom", zh ? "自定义" : "Custom"]].map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
      <input aria-label={zh ? "开始日期" : "Start date"} className="set-input" type="date" value={from} onChange={e => { setFrom(e.target.value); setPreset("custom"); }} />
      <span>—</span>
      <input aria-label={zh ? "结束日期" : "End date"} className="set-input" type="date" value={to} onChange={e => { setTo(e.target.value); setPreset("custom"); }} />
      <button className="set-btn" disabled={busy} onClick={() => setRevision(r => r + 1)}>{busy ? (zh ? "读取中…" : "Loading…") : (zh ? "刷新" : "Refresh")}</button>
    </div>
    {error && <div role="alert" className="set-json-err">{error}</div>}
    {!error && report && <>
      <div className="set-card activity-card" aria-busy={busy}>
        <div className="activity-heading"><h3>{zh ? "Token 活动" : "Token activity"}</h3><div className="activity-modes">{(["daily", "weekly", "cumulative"] as const).map(m => <button key={m} aria-pressed={mode === m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>{zh ? ({ daily: "每日", weekly: "每周", cumulative: "累计" }[m]) : ({ daily: "Daily", weekly: "Weekly", cumulative: "Cumulative" }[m])}</button>)}</div></div>
        <div className="activity-scroll">
          <div className="activity-grid" style={{ gridTemplateColumns: `repeat(${calendar.weeks}, minmax(0, 1fr))`, maxWidth: calendar.weeks * 18 }}>
            {calendar.cells.map(c => {
              const level = c.value === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(c.value / (calendar.max || 1) * 4)));
              const label = `${c.date} · ${formatTokens(c.tokens)} tokens (${number(c.tokens)}) · $${c.cost.toFixed(4)}${mode !== "daily" ? ` · ${zh ? "视图用量" : "View usage"}: ${formatTokens(c.value)}` : ""}`;
              return <button key={c.date} className="activity-cell" disabled={!c.valid} aria-label={label} aria-describedby={hovered?.cell.date === c.date ? tooltipId : undefined} onMouseEnter={event => showTooltip(c, event.currentTarget)} onMouseLeave={() => setHovered(null)} onFocus={event => showTooltip(c, event.currentTarget)} onBlur={() => setHovered(null)} style={{ background: colors[level], visibility: c.valid ? "visible" : "hidden" }} />;
            })}
          </div>
          <div className="activity-months" style={{ gridTemplateColumns: `repeat(${calendar.weeks}, minmax(0, 1fr))`, maxWidth: calendar.weeks * 18 }}>{Array.from({ length: calendar.weeks }, (_, i) => {
            const cell = calendar.cells.slice(i * 7, i * 7 + 7).find(c => c.valid) || calendar.cells[i * 7];
            const previousWeek = Math.max(0, (i - 1) * 7);
            const prev = calendar.cells.slice(previousWeek, previousWeek + 7).find(c => c.valid) || calendar.cells[previousWeek];
            const show = i === 0 || cell.date.slice(0, 7) !== prev.date.slice(0, 7);
            return show ? <span key={i} style={{ gridColumn: `${i + 1} / span ${Math.min(4, calendar.weeks - i)}`, gridRow: 1 }}>{new Date(`${cell.date}T00:00:00`).toLocaleDateString(zh ? "zh-CN" : "en-US", { month: "short" })}</span> : null;
          })}</div>
        </div>
        <div className="activity-legend"><span>{zh ? "少" : "Less"}</span>{colors.map(color => <i key={color} style={{ background: color }} />)}<span>{zh ? "多" : "More"}</span></div>
      </div>
      <div className="activity-totals">{[[zh ? "总 Token" : "Total tokens", formatTokens(report.tokens), number(report.tokens)], [zh ? "输入 / 输出" : "Input / output", `${formatTokens(report.input)} / ${formatTokens(report.output)}`, `${number(report.input)} / ${number(report.output)}`], [zh ? "缓存读取 / 写入" : "Cache read / write", `${formatTokens(report.cacheRead)} / ${formatTokens(report.cacheWrite)}`, `${number(report.cacheRead)} / ${number(report.cacheWrite)}`], [zh ? "估算费用" : "Estimated cost", `$${report.cost.toFixed(4)}`, ""]].map(([label, value, exact]) => <div className="set-card" key={label}><span className="muted">{label}</span><strong title={exact}>{value}</strong></div>)}</div>
      <UsageCostDetails report={report} language={language} />
      <p className="set-hint">{zh ? "费用为估算，不是账单：已有正值会话费用优先保留，缺失或零值按价格目录补算；自定义价格优先于两者。订阅等值费用不计入 API 费用，未定价请求会明确标注。按本地日期汇总，分支复制记录去重，删除的会话不计入。" : "Estimates, not invoices: positive saved estimates are preserved; missing/zero estimates use catalog rates. Custom rates override both. Plan equivalents are excluded from API costs; unpriced requests are marked. Uses local dates and fork deduplication; deleted sessions are excluded."}</p>
      {(report.unreadableFiles > 0 || calendar.weeks > 260) && <p role="status">{report.unreadableFiles > 0 ? `${report.unreadableFiles} ${zh ? "个文件未能读取，统计可能不完整。" : "files could not be read; totals may be incomplete."}` : (zh ? "热力图最多显示最近五年；汇总覆盖整个时间范围。" : "The heatmap shows the most recent five years; totals cover the full range.")}</p>}
    </>}
    <UsagePricingSettings language={language} onSaved={() => setRevision(r => r + 1)} />
    {hovered && createPortal(<div id={tooltipId} role="tooltip" className="activity-tooltip" style={{ left: hovered.left, top: hovered.top, transform: hovered.below ? undefined : "translateY(-100%)" }}>
      <strong>{hovered.cell.date}</strong>
      <div>{zh ? "当日用量" : "Daily usage"}: <b>{formatTokens(hovered.cell.tokens)}</b> tokens</div>
      <div className="activity-tooltip-exact">{number(hovered.cell.tokens)} tokens</div>
      {mode !== "daily" && <div>{mode === "weekly" ? (zh ? "本周合计" : "Weekly total") : (zh ? "累计用量" : "Cumulative usage")}: <b>{formatTokens(hovered.cell.value)}</b> tokens</div>}
      <div>{zh ? "当日估算费用" : "Daily estimated cost"}: ${hovered.cell.cost.toFixed(4)}</div>
    </div>, document.body)}
  </div>;
}
