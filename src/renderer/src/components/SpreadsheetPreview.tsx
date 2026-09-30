import { useEffect, useRef, useState } from "react";
import { createUniver, defaultTheme, LifecycleStages, LocaleType } from "@univerjs/presets";
import { CalculationMode, UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import EnUS from "@univerjs/preset-sheets-core/locales/en-US";
import ZhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import "@univerjs/preset-sheets-core/lib/index.css";
import type { IWorkbookData } from "@univerjs/core";
import { loadOfficeWorkbook } from "../lib/office-workbook";
import "./office-preview.css";

// The same mount path is exercised in the real Electron renderer tests.
export async function createSpreadsheetPreview(container: HTMLElement, data: IWorkbookData, language: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const locale = language === "zh" ? LocaleType.ZH_CN : LocaleType.EN_US;
  const runtime = createUniver({
    locale,
    locales: { [LocaleType.EN_US]: EnUS, [LocaleType.ZH_CN]: ZhCN },
    theme: { ...defaultTheme, primary: { ...defaultTheme.primary, 500: "#36865c", 600: "#2e7d52", 700: "#266844" } },
    presets: [UniverSheetsCorePreset({
      container, header: true, toolbar: false, contextMenu: false,
      formulaBar: true, disableAutoFocus: true,
      footer: { sheetBar: true, statisticBar: false, menus: false, zoomSlider: false, addSheetButtonConfig: { show: false } },
      // Preview the saved results, including formulas unsupported by Univer.
      formula: { initialFormulaComputing: CalculationMode.NO_CALCULATION },
    })],
  });
  const abort = () => runtime.univer.dispose();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const workbook = runtime.univerAPI.createWorkbook(data);
    await workbook.getWorkbookPermission().setReadOnly();
    // Zoom/render controllers are registered after the first render, not
    // immediately after createWorkbook. Keep controls disabled until then.
    if (runtime.univerAPI.getCurrentLifecycleStage() < LifecycleStages.Rendered) {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer); listener.dispose(); signal?.removeEventListener("abort", cancelled);
          if (error) reject(error); else resolve();
        };
        const cancelled = () => finish(new DOMException("Preview closed", "AbortError"));
        const timer = setTimeout(() => finish(new Error("Spreadsheet rendering timed out")), 10000);
        const listener = runtime.univerAPI.addEvent(runtime.univerAPI.Event.LifeCycleChanged, ({ stage }) => {
          if (stage >= LifecycleStages.Rendered) finish();
        });
        signal?.addEventListener("abort", cancelled, { once: true });
        if (signal?.aborted) cancelled();
      });
    }
    signal?.throwIfAborted();
    return { ...runtime, workbook };
  } catch (error) {
    runtime.univer.dispose();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export default function SpreadsheetPreview({ base64, text, name, language }: { base64?: string; text?: string; name?: string; language: string }) {
  const container = useRef<HTMLDivElement>(null);
  const runtime = useRef<Awaited<ReturnType<typeof createSpreadsheetPreview>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [limited, setLimited] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [zoom, setZoom] = useState(100);
  useEffect(() => {
    let cancelled = false;
    let instance: Awaited<ReturnType<typeof createSpreadsheetPreview>> | undefined;
    let themeObserver: MutationObserver | undefined;
    let sheetListener: { dispose(): void } | undefined;
    const controller = new AbortController();
    setLoading(true); setError(""); setLimited(false); setUnsupported(false); setZoom(100);
    // Give each async mount its own host: a slow disposed import must never
    // clear or render into the next file's live container.
    const host = document.createElement("div");
    host.className = "office-univer-host";
    container.current?.appendChild(host);
    (async () => {
      try {
        const data = await loadOfficeWorkbook({ base64, text, name, language });
        if (cancelled) return;
        instance = await createSpreadsheetPreview(host, data.workbook, language, controller.signal);
        if (cancelled) { instance.univer.dispose(); return; }
        runtime.current = instance;
        sheetListener = instance.univerAPI.addEvent(instance.univerAPI.Event.ActiveSheetChanged, ({ activeSheet }) => setZoom(Math.round(activeSheet.getZoom() * 100)));
        const syncTheme = () => instance?.univerAPI.toggleDarkMode(document.documentElement.dataset.theme === "dark");
        syncTheme();
        themeObserver = new MutationObserver(syncTheme);
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        setLimited(data.limited); setUnsupported(data.unsupported); setLoading(false);
      } catch (e: any) {
        if (!cancelled) { setError(e?.message || "Spreadsheet preview failed"); setLoading(false); }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      themeObserver?.disconnect();
      sheetListener?.dispose();
      if (runtime.current === instance) runtime.current = null;
      instance?.univer.dispose();
      host.remove();
    };
  }, [base64, text, name, language]);
  const changeZoom = (value: number) => {
    runtime.current?.workbook.getActiveSheet()?.zoom(value / 100);
    setZoom(value);
  };
  return (
    <div className="office-preview office-sheet-preview">
      <div className="office-preview-toolbar">
        <span className="office-preview-readonly">{language === "zh" ? "只读预览" : "Read-only preview"}</span>
        <label>{language === "zh" ? "缩放" : "Zoom"}
          <select aria-label={language === "zh" ? "表格缩放" : "Spreadsheet zoom"} value={zoom} disabled={loading || !!error} onChange={e => changeZoom(Number(e.target.value))}>
            {[50, 75, 100, 125, 150, 200].map(value => <option key={value} value={value}>{value}%</option>)}
          </select>
        </label>
      </div>
      {limited && <div className="office-preview-notice">{language === "zh" ? "文件较大，仅预览前 32 个工作表、每表 10,000 行 / 512 列，合计最多 100,000 个单元格。" : "Large workbook: preview is limited to 32 sheets, 10,000 rows / 512 columns per sheet and 100,000 cells total."}</div>}
      {unsupported && <div className="office-preview-notice">{language === "zh" ? "此文件包含图表、图片、条件格式或透视表，部分内容未在预览中还原。" : "This workbook contains drawings, conditional formatting or pivots that are not fully rendered."}</div>}
      <div className="office-sheet-stage">
        <div ref={container} className="office-univer-container" aria-label={language === "zh" ? "电子表格预览" : "Spreadsheet preview"} />
        {loading && <div className="office-preview-overlay"><span className="spinner" /></div>}
        {error && <div className="office-preview-overlay office-preview-error" role="alert">{error}</div>}
      </div>
    </div>
  );
}
