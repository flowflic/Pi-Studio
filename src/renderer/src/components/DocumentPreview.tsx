import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import "./office-preview.css";

export default function DocumentPreview({ base64, language }: { base64: string; language: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState("fit");
  const zoomRef = useRef("fit");
  const fitRef = useRef<(() => void) | null>(null);
  const [scale, setScale] = useState(1);
  const [pages, setPages] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let observer: ResizeObserver | undefined;
    setLoading(true); setError(""); setPages(0);
    const host = document.createElement("div");
    host.className = "office-doc-pages";
    // Isolate file-derived styles from the application and other documents.
    const shadow = host.attachShadow({ mode: "open" });
    const styles = document.createElement("div"), body = document.createElement("div");
    const css = document.createElement("style");
    css.textContent = ".docx-wrapper{padding:16px;background:transparent;display:flex;flex-direction:column;align-items:center;gap:16px}.docx-wrapper>section.docx{margin:0;flex:none;box-shadow:0 2px 12px #0002;color:#111;background:white}a{pointer-events:none}";
    shadow.append(styles, css, body);
    stage.current?.appendChild(host);
    (async () => {
      try {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        await renderAsync(bytes, body, styles, { className: "docx", breakPages: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, useBase64URL: true, renderAltChunks: false });
        if (cancelled) return;
        // Document relationships are untrusted; this viewer never navigates.
        for (const link of body.querySelectorAll("a")) { link.removeAttribute("href"); link.removeAttribute("target"); }
        setPages(body.querySelectorAll("section.docx").length);
        const fit = () => {
          const page = body.querySelector("section.docx") as HTMLElement | null;
          const width = page?.offsetWidth || 794;
          if (zoomRef.current === "fit") setScale(Math.min(1.25, Math.max(0.1, ((stage.current?.clientWidth || width) - 16) / (width + 32))));
        };
        fitRef.current = fit;
        observer = new ResizeObserver(fit);
        if (stage.current) observer.observe(stage.current);
        fit(); setLoading(false);
      } catch (e: any) {
        if (!cancelled) { setError(e?.message || "Document preview failed"); setLoading(false); }
      }
    })();
    return () => { cancelled = true; fitRef.current = null; observer?.disconnect(); host.remove(); };
  }, [base64]);
  return <div className="office-preview office-document-preview">
    <div className="office-preview-toolbar">
      <span className="office-preview-readonly">{language === "zh" ? "只读预览" : "Read-only preview"}{pages ? ` · ${pages} ${language === "zh" ? "页" : "pages"}` : ""}</span>
      <label>{language === "zh" ? "缩放" : "Zoom"}<select aria-label={language === "zh" ? "文档缩放" : "Document zoom"} value={zoom} onChange={e => { const value = e.target.value; setZoom(value); zoomRef.current = value; if (value === "fit") fitRef.current?.(); else setScale(Number(value) / 100); }}>
        <option value="fit">{language === "zh" ? "适应宽度" : "Fit width"}</option>
        {[50, 75, 100, 125, 150, 200].map(value => <option key={value} value={value}>{value}%</option>)}
      </select></label>
    </div>
    <div className="office-document-stage" ref={stage} style={{ "--office-doc-scale": scale } as React.CSSProperties}>
      {loading && <div className="office-preview-overlay"><span className="spinner" /></div>}
      {error && <div className="office-preview-overlay office-preview-error" role="alert">{error}</div>}
    </div>
  </div>;
}
