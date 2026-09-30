import { useEffect, useState } from "react";
import type { UsageReport } from "../../../main/usage-service";
import type { PlanQuota } from "../../../main/plan-quotas";
import { formatTokens } from "../lib/token-format";

const money = (n = 0) => `$${n.toFixed(n > 0 && n < .0001 ? 8 : 4)}`;
export function UsageCostDetails({ report, language }: { report: UsageReport; language: string }) {
  const zh = language === "zh";
  const sourceLabel = { reported: zh ? "会话记录" : "Session estimate", catalog: zh ? "内置价格估算" : "Catalog estimate", custom: zh ? "自定义价格" : "Custom price", unpriced: zh ? "未定价" : "Unpriced", local: zh ? "本地 / 免费" : "Local / free" };
  const buckets = [["input", zh ? "输入" : "Input"], ["output", zh ? "输出" : "Output"], ["cacheRead", zh ? "缓存读取" : "Cache read"], ["cacheWrite", zh ? "缓存写入" : "Cache write"]] as const;
  return <div className="set-card usage-cost-details">
    <h3>{zh ? "供应商与模型费用详情" : "Provider and model costs"}</h3>
    <div className="usage-cost-summary"><span>{zh ? "会话记录费用" : "Session estimates"}: {money(report.reportedCost)}</span><span>{zh ? "按价格补算" : "Calculated estimates"}: {money(report.estimatedCost)}</span><span>{zh ? "订阅等值费用" : "Plan equivalent cost"}: {money(report.equivalentCost)}</span></div>
    {!!report.unpricedRequests && <p className="set-hint" role="status">{zh ? `${report.unpricedRequests} 次请求没有可用价格，费用汇总尚不完整；可在下方配置自定义价格。` : `${report.unpricedRequests} requests have no price; cost totals are incomplete. Add custom prices below.`}</p>}
    {report.models.map(model => <details className="usage-model-detail" key={`${model.provider}/${model.model}`}>
      <summary><span>{model.provider} / {model.model}</span><b>{money(model.cost)}</b><span>{formatTokens(model.tokens)} tokens · {model.requests} {zh ? "次" : "requests"}</span></summary>
      <div className="usage-cost-scroll"><table className="activity-table"><thead><tr><th>{zh ? "类型" : "Type"}</th><th>Token</th><th>{zh ? "费用 USD" : "Cost USD"}</th></tr></thead><tbody>{buckets.map(([key, label]) => <tr key={key}><td>{label}</td><td title={model[key].toLocaleString()}>{formatTokens(model[key])}</td><td>{model.pricing?.every(price => !!price.breakdown) ? money(model.pricing.reduce((sum, price) => sum + (price.breakdown?.[key] || 0), 0)) : "—"}</td></tr>)}</tbody></table></div>
      {model.pricing?.map((price, i) => <div className="usage-rate-detail" key={i}>
        <div><b>{sourceLabel[price.source]}</b> · {price.requests} {zh ? "次请求" : "requests"} · {price.billing === "plan" ? (zh ? "订阅等值 " : "Plan equivalent ") + money(price.equivalentCost) : money(price.cost)}</div>
        {price.rates && <p>{zh ? "单价 USD / 百万 Token" : "Rates USD / million tokens"}: {buckets.map(([key, label]) => `${label} ${price.rates![key]}`).join(" · ")}</p>}
        {price.checkedAt && <p>{zh ? "价格核对日期" : "Price checked"}: {price.checkedAt}</p>}
        {price.sourceUrl && <p className="usage-price-source">{zh ? "价格来源" : "Price source"}: {price.sourceUrl}</p>}
        {price.notes && <p>{price.notes}</p>}
        {price.billing === "plan" && <p>{zh ? "仅作 API 等值估算，不代表订阅实际扣款。" : "API equivalent estimate; not a subscription charge."}</p>}
      </div>)}
    </details>)}
    {!report.requests && <p className="muted">{zh ? "该时间段暂无使用记录" : "No usage in this period"}</p>}
  </div>;
}

export function PlanQuotaCards({ language }: { language: string }) {
  const zh = language === "zh";
  const [plans, setPlans] = useState<PlanQuota[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    const load = (force: boolean) => {
      setBusy(true); setError("");
      window.pi.settings.getPlanQuotas(force).then(value => { if (!disposed) setPlans(value); }).catch(() => { if (!disposed) setError(zh ? "额度查询失败，请稍后刷新。" : "Quota query failed. Try refreshing."); }).finally(() => { if (!disposed) setBusy(false); });
    };
    load(revision > 0);
    const timer = window.setInterval(() => { if (!document.hidden) load(false); }, 60000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [revision, zh]);
  const period = (name: string) => ({ rolling: zh ? "滚动 5 小时" : "Rolling 5 hours", five_hour: zh ? "5 小时" : "5 hours", fiveHour: zh ? "5 小时" : "5 hours", "5h": zh ? "5 小时" : "5 hours", weekly: zh ? "每周" : "Weekly", seven_day: zh ? "每周" : "Weekly", "7d": zh ? "7 天" : "7 days", monthly: zh ? "每月" : "Monthly" }[name] || name);
  return <section className="set-card plan-quota-section"><div className="activity-heading"><h3>Token Plan {zh ? "周期额度" : "quota windows"}</h3><button className="set-btn" disabled={busy} onClick={() => setRevision(r => r + 1)}>{busy ? (zh ? "查询中…" : "Loading…") : (zh ? "刷新额度" : "Refresh quotas")}</button></div>
    <p className="set-hint">{zh ? "从已配置的供应商、环境变量或 OpenCode 登录中读取凭据，每分钟刷新。已用与剩余以供应商接口返回的百分比为准，与本地 Token 估算分开。" : "Uses configured provider credentials, environment variables or OpenCode login; refreshes every minute. Percentages come from provider APIs, independently of local token estimates."}</p>
    {error && <p role="alert">{error}</p>}
    {plans.some(plan => plan.status === "missing") && <details className="plan-quota-missing"><summary>{zh ? "未配置的订阅" : "Unconfigured subscriptions"} ({plans.filter(plan => plan.status === "missing").length})</summary>{plans.filter(plan => plan.status === "missing").map(plan => <p className="set-hint" key={plan.id}>{plan.label}: {zh ? "在模型设置中配置，或设置环境变量 " : "Configure a provider or environment variable "}{plan.message}</p>)}</details>}
    <div className="plan-quota-grid">{plans.filter(plan => plan.status !== "missing").map(plan => <div className="plan-quota-card" key={plan.id}>
      <h4>{plan.label}</h4>
      {plan.status === "missing" && <p className="set-hint">{zh ? "未找到订阅凭据。可在模型设置中配置，或设置环境变量：" : "No subscription credential. Configure a provider or environment variable: "}{plan.message}</p>}
      {plan.status === "error" && <p className="set-json-err" role="status">{zh ? "查询失败，可能无订阅、凭据失效或接口暂不可用" : "Query failed: no subscription, expired credentials or unavailable API"} ({plan.message}){plan.windows.length > 0 && (zh ? "；以下为上次成功数据" : "; showing last successful data")}</p>}
      {plan.windows.map(window => <div className="plan-quota-window" key={window.name}>
        <strong>{period(window.name)}</strong>
        {window.unlimited ? <p>{zh ? "不限量" : "Unlimited"}</p> : <><div className="plan-quota-numbers"><span>{zh ? "已用" : "Used"} {window.usedPercent?.toFixed(1)}%</span><b>{zh ? "剩余" : "Remaining"} {window.remainingPercent?.toFixed(1)}%</b></div><progress max={100} value={Math.min(100, window.usedPercent || 0)} aria-label={`${plan.label} ${period(window.name)}`} /></>}
        {window.limit !== undefined && <small>{zh ? "额度（供应商口径）" : "Quota (provider units)"}: {zh ? "已用" : "Used"} {window.used?.toLocaleString() ?? "—"} / {zh ? "剩余" : "Remaining"} {window.remaining?.toLocaleString() ?? "—"} / {zh ? "总额" : "Limit"} {window.limit.toLocaleString()}</small>}
        <small>{zh ? "重置时间" : "Resets"}: {window.resetsAt && Number.isFinite(Date.parse(window.resetsAt)) ? new Date(window.resetsAt).toLocaleString() : zh ? "供应商未提供" : "Not provided"}</small>
      </div>)}
      {plan.fetchedAt && <small>{zh ? "更新于" : "Updated"}: {new Date(plan.fetchedAt).toLocaleString()}</small>}
    </div>)}</div>
  </section>;
}

export function UsagePricingSettings({ language, onSaved }: { language: string; onSaved: () => void }) {
  const zh = language === "zh";
  const [data, setData] = useState<Awaited<ReturnType<typeof window.pi.settings.getUsagePricing>>>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { let disposed = false; window.pi.settings.getUsagePricing().then(value => { if (!disposed) { setData(value); setDraft(JSON.stringify(value.config, null, 2)); } }).catch(() => { if (!disposed) setError(zh ? "价格配置读取失败" : "Could not read pricing configuration"); }); return () => { disposed = true; }; }, [zh]);
  const save = async () => { setSaving(true); setError(""); try { const config = await window.pi.settings.saveUsagePricing(JSON.parse(draft)); setDraft(JSON.stringify(config, null, 2)); onSaved(); } catch (e: any) { setError(String(e.message || e)); } finally { setSaving(false); } };
  return <details className="set-card usage-price-settings"><summary>{zh ? "价格目录与自定义计费" : "Price catalog and custom billing"} {data && `(${data.catalog.length})`}</summary>
    <p className="set-hint">{zh ? "内置目录来自 dsh-cost-meter，快照 " : "Bundled catalog from dsh-cost-meter, snapshot "}{data?.snapshot}。{zh ? "价格可能变化，自定义价格优先。金额单位为 USD / 百万 Token。" : "Prices may change; custom rates take precedence. Units: USD / million tokens."}</p>
    <p className="set-hint">{zh ? '自定义示例：{"overrides":[{"provider":"my-provider","model":"my-model","input":1,"output":3,"cacheRead":0.1,"cacheWrite":1.25,"billing":"api"}]}。billing 可为 api、plan（订阅等值）或 local（免费）。保存后按此价格重新统计所选范围。' : 'Example: {"overrides":[{"provider":"my-provider","model":"my-model","input":1,"output":3,"cacheRead":0.1,"cacheWrite":1.25,"billing":"api"}]}. billing: api, plan (equivalent) or local (free). Saving recalculates the selected range.'}</p>
    <textarea className="set-input usage-pricing-editor" aria-label={zh ? "自定义价格 JSON" : "Custom price JSON"} value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false} />
    {error && <p role="alert" className="set-json-err">{error}</p>}
    <button className="set-btn primary" disabled={!data || saving} onClick={save}>{saving ? (zh ? "保存中…" : "Saving…") : (zh ? "保存价格并重新统计" : "Save and recalculate")}</button>
    {data && <div className="usage-cost-scroll usage-catalog"><table className="activity-table"><thead><tr><th>{zh ? "供应商 / 模型" : "Provider / model"}</th><th>{zh ? "输入" : "Input"}</th><th>{zh ? "输出" : "Output"}</th><th>{zh ? "缓存读 / 写" : "Cache read / write"}</th></tr></thead><tbody>{data.catalog.map(row => <tr key={`${row.provider}/${row.model}`} title={row.price?.notes || row.price?.sourceUrl}><td>{row.provider} / {row.model}</td><td>{row.price?.cacheMiss ?? "—"}</td><td>{row.price?.output ?? "—"}</td><td>{row.price?.cacheHit ?? "—"} / {row.price?.cacheWrite ?? row.price?.cacheHit ?? "—"}</td></tr>)}</tbody></table></div>}
  </details>;
}
