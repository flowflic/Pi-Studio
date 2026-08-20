import { useStore } from "../store";
import { translateUiText } from "../lib/i18n";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const language = useStore((s) => s.config?.language || "en");
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)} title={language === "zh" ? "关闭提示" : "Dismiss"}>
          {translateUiText(t.text, language)}
        </div>
      ))}
    </div>
  );
}
