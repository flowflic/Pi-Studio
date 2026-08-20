import { useEffect } from "react";
import { useStore } from "../store";
import { Close, Shield } from "./icons";

export function ExtUiPromptCard({ threadId }: { threadId: string }) {
  const item = useStore((s) =>
    s.extuiQueue.find(
      (queued) => queued.threadId === threadId && (queued.request.method === "confirm" || queued.request.method === "select"),
    ),
  );
  const respond = useStore((s) => s.respondExtUi);
  const language = useStore((s) => s.config?.language || "en");
  const request = item?.request;

  useEffect(() => {
    if (!request?.timeout) return;
    const timer = setTimeout(
      () => respond(threadId, request.id, request.method === "confirm" ? { confirmed: false } : { cancelled: true }),
      request.timeout,
    );
    return () => clearTimeout(timer);
  }, [request?.id, request?.method, request?.timeout, respond, threadId]);

  if (!request) return null;
  const cancel = () =>
    respond(threadId, request.id, request.method === "confirm" ? { confirmed: false } : { cancelled: true });
  const fallbackTitle = language === "zh" ? "Pi 扩展" : "Pi extension";
  const titleParts = String(request.title || fallbackTitle).split(/\r?\n/);
  const title = titleParts.shift() || fallbackTitle;
  const detail = [...titleParts, request.message || ""].filter(Boolean).join("\n");
  const isSandbox = /sandbox|沙盒/i.test(title);

  return (
    <div className={`extui-card ${request.method} ${isSandbox ? "sandbox-card" : ""}`} role="alertdialog" aria-labelledby={`extui-title-${request.id}`}>
      <div className="extui-card-head">
        <div className="extui-card-heading">
          <span className="extui-card-icon" aria-hidden="true"><Shield size={15} /></span>
          <div>
            <div className="extui-card-kicker">
              {isSandbox
                ? language === "zh" ? "权限确认" : "Permission required"
                : request.method === "confirm"
                  ? language === "zh" ? "需要确认" : "Confirmation"
                  : language === "zh" ? "请选择" : "Choose an option"}
            </div>
            <div className="extui-card-title" id={`extui-title-${request.id}`}>{title}</div>
          </div>
        </div>
        <button className="extui-card-close" onClick={cancel} title={language === "zh" ? "拒绝并关闭" : "Deny and close"}>
          <Close size={14} />
        </button>
      </div>
      {detail && <div className="extui-card-message">{detail}</div>}
      {request.method === "confirm" ? (
        <div className="extui-card-actions">
          <button className="btn" onClick={cancel}>{language === "zh" ? "拒绝" : "Deny"}</button>
          <button className="btn primary" onClick={() => respond(threadId, request.id, { confirmed: true })}>
            {language === "zh" ? "仅允许本次" : "Allow once"}
          </button>
        </div>
      ) : (
        <div className="extui-card-options">
          {(request.options || []).map((option, index) => {
            const deny = /^(deny|拒绝)$/i.test(option);
            return (
              <button
                key={option}
                className={`${index === 0 ? "recommended" : ""} ${deny ? "deny" : ""}`}
                onClick={() => respond(threadId, request.id, { value: option })}
              >
                <span>{option}</span>
                {index === 0 && <small>{language === "zh" ? "推荐" : "Recommended"}</small>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
