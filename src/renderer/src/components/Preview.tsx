import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import hljs from "highlight.js/lib/core";
import { useStore } from "../store";
import { Markdown } from "../lib/markdown";
import { CODE_LANGUAGE_ALIASES, CODE_LANGUAGES } from "../lib/code-languages";
import { formatBytes } from "../lib/format";
import { translateUiText } from "../lib/i18n";
import { Close, Contract, Copy, Expand, Refresh } from "./icons";

Object.entries(CODE_LANGUAGES).forEach(([name, grammar]) => hljs.registerLanguage(name, grammar as any));
Object.entries(CODE_LANGUAGE_ALIASES).forEach(([name, aliases]) => {
  hljs.registerAliases(aliases, { languageName: name });
});

const PREVIEW_WIDTH_KEY = "pi-studio.preview-width";
const PREVIEW_DEFAULT_WIDTH = 420;
const PREVIEW_MIN_WIDTH = 300;
const PREVIEW_MAX_WIDTH = 900;

function clampPreviewWidth(width: number): number {
  const sidebarWidth = document.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect().width || 0;
  const available = Math.max(PREVIEW_MIN_WIDTH, window.innerWidth - sidebarWidth - 320);
  return Math.min(Math.min(PREVIEW_MAX_WIDTH, available), Math.max(PREVIEW_MIN_WIDTH, width));
}

function initialPreviewWidth(): number {
  try {
    const saved = Number(localStorage.getItem(PREVIEW_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampPreviewWidth(saved) : clampPreviewWidth(PREVIEW_DEFAULT_WIDTH);
  } catch {
    return PREVIEW_DEFAULT_WIDTH;
  }
}

export function Preview() {
  const open = useStore((s) => s.previewOpen);
  const path = useStore((s) => s.previewPath);
  const root = useStore((s) => s.previewRoot);
  const payload = useStore((s) => s.previewPayload);
  const loading = useStore((s) => s.previewLoading);
  const expanded = useStore((s) => s.previewExpanded);
  const openPreview = useStore((s) => s.openPreview);
  const toggleExpanded = useStore((s) => s.togglePreviewExpanded);
  const close = useStore((s) => s.closePreview);
  const language = useStore((s) => s.config?.language || "en");
  const [previewWidth, setPreviewWidth] = useState(initialPreviewWidth);
  const resizeRef = useRef<{ startX: number; startWidth: number; width: number; element: HTMLDivElement } | null>(null);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = resizeRef.current;
      if (!drag) return;
      drag.width = clampPreviewWidth(drag.startWidth + drag.startX - event.clientX);
      setPreviewWidth(drag.width);
    };
    const onPointerUp = (event: PointerEvent) => {
      const drag = resizeRef.current;
      if (!drag) return;
      resizeRef.current = null;
      document.body.classList.remove("preview-resizing");
      if (drag.element.hasPointerCapture(event.pointerId)) drag.element.releasePointerCapture(event.pointerId);
      try {
        localStorage.setItem(PREVIEW_WIDTH_KEY, String(Math.round(drag.width)));
      } catch {
        // Resizing still works when persistent storage is unavailable.
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.body.classList.remove("preview-resizing");
    };
  }, []);

  const persistPreviewWidth = (width: number) => {
    const next = clampPreviewWidth(width);
    setPreviewWidth(next);
    try {
      localStorage.setItem(PREVIEW_WIDTH_KEY, String(Math.round(next)));
    } catch {
      // See pointer-up persistence note above.
    }
  };

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || expanded) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      startX: event.clientX,
      startWidth: previewWidth,
      width: previewWidth,
      element: event.currentTarget,
    };
    document.body.classList.add("preview-resizing");
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      persistPreviewWidth(previewWidth + 16);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      persistPreviewWidth(previewWidth - 16);
    } else if (event.key === "Home") {
      event.preventDefault();
      persistPreviewWidth(PREVIEW_DEFAULT_WIDTH);
    }
  };

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      toggleExpanded();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded, toggleExpanded]);

  if (!open) return null;
  const name = path?.split(/[\\/]/).pop() || "Preview";

  return (
    <aside
      className={`preview ${expanded ? "expanded" : ""}`}
      style={expanded ? undefined : { width: previewWidth, flexBasis: previewWidth }}
    >
      {!expanded && (
        <div
          className="preview-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={language === "zh" ? "调整预览栏宽度" : "Resize preview pane"}
          aria-valuemin={PREVIEW_MIN_WIDTH}
          aria-valuemax={PREVIEW_MAX_WIDTH}
          aria-valuenow={Math.round(previewWidth)}
          tabIndex={0}
          onPointerDown={beginResize}
          onKeyDown={resizeWithKeyboard}
          onDoubleClick={() => persistPreviewWidth(PREVIEW_DEFAULT_WIDTH)}
          title={language === "zh" ? "拖动调整预览栏宽度；双击恢复默认" : "Drag to resize; double-click to reset"}
        />
      )}
      <div className="preview-head">
        <span className="preview-title" title={path || ""}>{name}</span>
        {payload && <span className="muted preview-size">{formatBytes(payload.size)}</span>}
        {payload && <span className="preview-kind">{previewKindLabel(payload)}</span>}
        {!expanded ? (
          <button
            className="iconbtn preview-expand-btn"
            title={language === "zh" ? "展开预览" : "Expand preview"}
            aria-label={language === "zh" ? "展开预览" : "Expand preview"}
            aria-pressed={false}
            onClick={toggleExpanded}
          >
            <Expand size={15} />
          </button>
        ) : (
          <button
            className="iconbtn preview-collapse-btn"
            title={language === "zh" ? "收缩到侧边栏" : "Restore side preview"}
            aria-label={language === "zh" ? "收缩到侧边栏" : "Restore side preview"}
            aria-pressed={true}
            onClick={toggleExpanded}
          >
            <Contract size={15} />
            <span>{language === "zh" ? "收缩" : "Restore"}</span>
          </button>
        )}
        <button
          className="iconbtn"
          title={language === "zh" ? "刷新预览" : "Refresh preview"}
          disabled={!path || loading}
          onClick={() => path && openPreview(path, root || undefined)}
        >
          <Refresh size={14} />
        </button>
        <button className="iconbtn" title={language === "zh" ? "关闭" : "Close"} onClick={close}>
          <Close size={15} />
        </button>
      </div>
      <div className={`preview-body ${payload?.kind === "html" ? "html-preview-active" : ""}`}>
        {loading ? <div className="pv-loading"><span className="spinner" /></div> : <PreviewBody payload={payload} language={language} />}
      </div>
    </aside>
  );
}

function previewKindLabel(payload: any): string {
  if (payload.kind === "html") return "HTML · CSS · JS";
  if (payload.kind === "docx") return "WORD";
  if (payload.kind === "xlsx") return "EXCEL";
  if (payload.kind === "pptx") return "POWERPOINT";
  if (payload.kind === "markdown") return "MARKDOWN";
  if (payload.kind === "image") return "IMAGE";
  return (payload.lang || payload.ext?.slice(1) || "FILE").toUpperCase();
}

function PreviewBody({ payload, language }: { payload: any; language: string }) {
  if (!payload) {
    return (
      <div className="pv-empty">
        {language === "zh" ? "从左侧文件树选择文件进行预览。" : "Select a file from the sidebar to preview it."}
        <br />
        {language === "zh"
          ? "支持代码、Markdown、HTML、图片、Word、Excel 和 PowerPoint。"
          : "Supports code, Markdown, HTML, images, Word, Excel, and PowerPoint."}
      </div>
    );
  }
  switch (payload.kind) {
    case "text":
      return <CodePreview text={payload.text || ""} lang={payload.lang || "plaintext"} truncated={payload.truncated} language={language} />;
    case "markdown":
      return <div className="pv-md"><Markdown text={payload.text || ""} /></div>;
    case "html":
      return <HtmlPreview url={payload.previewUrl} language={language} />;
    case "image":
      return <div className="pv-img"><img src={`data:${payload.mime};base64,${payload.base64}`} alt={payload.name} /></div>;
    case "docx":
      return <DocxPreview base64={payload.base64} />;
    case "xlsx":
      return <XlsxPreview base64={payload.base64} text={payload.text} />;
    case "pptx":
      return <PptxPreview base64={payload.base64} language={language} />;
    case "toobig":
      return <div className="pv-unsupported">{language === "zh" ? "文件过大，无法预览。" : "This file is too large to preview."}</div>;
    case "missing":
      return <div className="pv-unsupported">{payload.message ? translateUiText(payload.message, language as "en" | "zh") : language === "zh" ? "文件不存在。" : "File not found."}</div>;
    default:
      return <div className="pv-unsupported">{payload.message ? translateUiText(payload.message, language as "en" | "zh") : language === "zh" ? "暂不支持预览该格式。" : "Preview is not available for this format."}</div>;
  }
}

function CodePreview({
  text,
  lang,
  truncated,
  language,
}: {
  text: string;
  lang: string;
  truncated?: boolean;
  language: string;
}) {
  const [copied, setCopied] = useState(false);
  const highlighted = useMemo(() => {
    try {
      return hljs.getLanguage(lang)
        ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(text).value;
    } catch {
      return text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] || char);
    }
  }, [lang, text]);
  const lines = highlighted.split("\n");
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="pv-code">
      <div className="pv-code-toolbar">
        <span className="pv-code-language">{lang}</span>
        <span className="pv-code-lines">{lines.length} {language === "zh" ? "行" : "lines"}</span>
        <button onClick={copy}>
          <Copy size={12} />
          {copied ? (language === "zh" ? "已复制" : "Copied") : language === "zh" ? "复制" : "Copy"}
        </button>
      </div>
      <pre className="pv-code-content">
        <code>
          {lines.map((line, index) => (
            <span className="pv-code-line" key={index}>
              <span className="pv-code-number" aria-hidden="true">{index + 1}</span>
              <span className="pv-code-source" dangerouslySetInnerHTML={{ __html: line || " " }} />
            </span>
          ))}
        </code>
      </pre>
      {truncated && <div className="pv-code-truncated">{language === "zh" ? "文件过大，已截断。" : "Large file; preview truncated."}</div>}
    </div>
  );
}

function HtmlPreview({ url, language }: { url?: string; language: string }) {
  if (!url) return <div className="pv-unsupported">{language === "zh" ? "无法创建 HTML 预览地址。" : "Could not create the HTML preview URL."}</div>;
  return (
    <div className="pv-html">
      <iframe
        key={url}
        title="html-preview"
        src={url}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock"
      />
    </div>
  );
}

function DocxPreview({ base64 }: { base64: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mammoth = await import("mammoth");
        const buf = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const res = await mammoth.default.convertToHtml({ arrayBuffer: buf.buffer as ArrayBuffer });
        if (!cancelled) setHtml(res.value);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "docx parse failed");
      }
    })();
    return () => { cancelled = true; };
  }, [base64]);
  if (err) return <div className="pv-unsupported">{err}</div>;
  if (html == null) return <div className="pv-loading"><span className="spinner" /></div>;
  return <div className="pv-docx" dangerouslySetInnerHTML={{ __html: html }} />;
}

function XlsxPreview({ base64, text }: { base64?: string; text?: string }) {
  const [sheets, setSheets] = useState<{ name: string; html: string }[]>([]);
  const [active, setActive] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const XLSX = await import("xlsx");
        const wb = text
          ? XLSX.read(text, { type: "string" })
          : XLSX.read(Uint8Array.from(atob(base64 || ""), (c) => c.charCodeAt(0)), { type: "array" });
        const out = wb.SheetNames.map((name) => ({
          name,
          html: XLSX.utils.sheet_to_html(wb.Sheets[name], { editable: false }),
        }));
        if (!cancelled) setSheets(out);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "xlsx parse failed");
      }
    })();
    return () => { cancelled = true; };
  }, [base64, text]);
  if (err) return <div className="pv-unsupported">{err}</div>;
  if (!sheets.length) return <div className="pv-loading"><span className="spinner" /></div>;
  return (
    <div className="pv-xlsx">
      <div className="sheet-tabs">
        {sheets.map((sheet, index) => (
          <button key={sheet.name} className={`sheet-tab ${index === active ? "active" : ""}`} onClick={() => setActive(index)}>
            {sheet.name}
          </button>
        ))}
      </div>
      <div className="pv-xlsx-sheet" dangerouslySetInnerHTML={{ __html: sheets[active]?.html || "" }} />
    </div>
  );
}

type PptxSlide = {
  number: number;
  title: string;
  paragraphs: string[];
  images: { src: string; alt: string }[];
};

function normalizeZipPath(path: string): string {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function imageMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg"
    : ext === "gif" ? "image/gif"
      : ext === "svg" ? "image/svg+xml"
        : ext === "webp" ? "image/webp"
          : "image/png";
}

function PptxPreview({ base64, language }: { base64: string; language: string }) {
  const [slides, setSlides] = useState<PptxSlide[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const JSZip = (await import("jszip")).default;
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const zip = await JSZip.loadAsync(bytes);
        const slidePaths = Object.keys(zip.files)
          .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
          .sort((a, b) => Number(a.match(/slide(\d+)/i)?.[1]) - Number(b.match(/slide(\d+)/i)?.[1]));
        const parsed: PptxSlide[] = [];

        for (let index = 0; index < slidePaths.length; index++) {
          const slidePath = slidePaths[index];
          const xml = await zip.file(slidePath)!.async("text");
          const doc = new DOMParser().parseFromString(xml, "application/xml");
          const paragraphs = Array.from(doc.getElementsByTagName("a:p"))
            .map((paragraph) =>
              Array.from(paragraph.getElementsByTagName("a:t"))
                .map((node) => node.textContent || "")
                .join("")
                .trim()
            )
            .filter(Boolean);

          const relPath = slidePath.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels";
          const relFile = zip.file(relPath);
          const relationTargets = new Map<string, string>();
          if (relFile) {
            const relXml = await relFile.async("text");
            const relDoc = new DOMParser().parseFromString(relXml, "application/xml");
            for (const relation of Array.from(relDoc.getElementsByTagName("Relationship"))) {
              const id = relation.getAttribute("Id");
              const target = relation.getAttribute("Target");
              if (id && target) relationTargets.set(id, normalizeZipPath(`ppt/slides/${target}`));
            }
          }

          const images: PptxSlide["images"] = [];
          for (const blip of Array.from(doc.getElementsByTagName("a:blip"))) {
            const relationshipId = blip.getAttribute("r:embed");
            const target = relationshipId ? relationTargets.get(relationshipId) : null;
            const file = target ? zip.file(target) : null;
            if (!target || !file) continue;
            const encoded = await file.async("base64");
            images.push({ src: `data:${imageMime(target)};base64,${encoded}`, alt: target.split("/").pop() || "slide image" });
          }

          parsed.push({
            number: index + 1,
            title: paragraphs[0] || `${language === "zh" ? "幻灯片" : "Slide"} ${index + 1}`,
            paragraphs: paragraphs.slice(1),
            images,
          });
        }
        if (!cancelled) setSlides(parsed);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "pptx parse failed");
      }
    })();
    return () => { cancelled = true; };
  }, [base64, language]);

  if (err) return <div className="pv-unsupported">{err}</div>;
  if (!slides.length) return <div className="pv-loading"><span className="spinner" /></div>;
  return (
    <div className="pv-pptx">
      <div className="pv-pptx-summary">{slides.length} {language === "zh" ? "张幻灯片" : slides.length === 1 ? "slide" : "slides"}</div>
      {slides.map((slide) => (
        <article className="pv-slide" key={slide.number}>
          <div className="pv-slide-number">{String(slide.number).padStart(2, "0")}</div>
          <div className="pv-slide-canvas">
            <h2>{slide.title}</h2>
            {slide.paragraphs.length > 0 && (
              <div className="pv-slide-copy">
                {slide.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
              </div>
            )}
            {slide.images.length > 0 && (
              <div className="pv-slide-images">
                {slide.images.map((image, index) => <img src={image.src} alt={image.alt} key={`${image.alt}-${index}`} />)}
              </div>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
