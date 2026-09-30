import type { ICellData, IStyleData, IWorkbookData, IWorksheetData } from "@univerjs/core";
import JSZip from "jszip";
import * as XLSX from "xlsx";

// Bound rendered content, not the used-range rectangle: a formatted empty
// sheet can claim all 1,048,576 Excel rows. Never allocate that rectangle.
const MAX_ROWS = 10000;
const MAX_COLS = 512;
const MAX_CELLS = 100000;
const MAX_SHEETS = 32;
export type WorkbookPreview = { workbook: IWorkbookData; limited: boolean; unsupported: boolean };

const descendants = (node: Document | Element, tag: string): Element[] => Array.from(node.getElementsByTagNameNS("*", tag));
const child = (node: Element | undefined, tag: string) => node && Array.from(node.children).find(c => c.localName === tag);
const number = (node: Element | undefined, attr: string, fallback = 0) => {
  const value = node?.getAttribute(attr);
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : fallback;
};
function xml(text: string): Document {
  if (text.length > 20000000) throw new Error("Workbook metadata is too large");
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.getElementsByTagName("parsererror").length) throw new Error("Invalid workbook XML");
  return document;
}
function resolvePart(base: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : `${base}/${target}`).split("/");
  const result: string[] = [];
  for (const part of parts) {
    if (part === "..") result.pop();
    else if (part && part !== ".") result.push(part);
  }
  return result.join("/");
}

const indexedColors = ["000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF", "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF"];
function color(node: Element | undefined, theme: string[]): { rgb: string } | undefined {
  if (!node) return undefined;
  let rgb = node.getAttribute("rgb")?.slice(-6);
  if (!rgb && node.hasAttribute("theme")) rgb = theme[number(node, "theme")];
  if (!rgb && node.hasAttribute("indexed")) rgb = indexedColors[number(node, "indexed")];
  if (!rgb || !/^[0-9a-f]{6}$/i.test(rgb)) return undefined;
  const tint = Math.max(-1, Math.min(1, number(node, "tint")));
  if (tint) rgb = rgb.match(/../g)!.map(hex => {
    const value = parseInt(hex, 16);
    return Math.round(tint < 0 ? value * (1 + tint) : value + (255 - value) * tint).toString(16).padStart(2, "0");
  }).join("");
  return { rgb: `#${rgb}` };
}

function parseStyles(document: Document, theme: string[]): Record<string, IStyleData> {
  const fonts = Array.from(descendants(document, "fonts")[0]?.children || []);
  const fills = Array.from(descendants(document, "fills")[0]?.children || []);
  const borders = Array.from(descendants(document, "borders")[0]?.children || []);
  const formats = new Map(descendants(document, "numFmt").map(n => [number(n, "numFmtId"), n.getAttribute("formatCode") || "General"]));
  const bases = Array.from(descendants(document, "cellStyleXfs")[0]?.children || []);
  const styles: Record<string, IStyleData> = {};
  const borderKinds: Record<string, number> = { thin: 1, hair: 2, dotted: 3, dashed: 4, dashDot: 5, dashDotDot: 6, double: 7, medium: 8, mediumDashed: 9, mediumDashDot: 10, mediumDashDotDot: 11, slantDashDot: 12, thick: 13 };
  Array.from(descendants(document, "cellXfs")[0]?.children || []).forEach((xf, index) => {
    const base = bases[number(xf, "xfId")];
    const attr = (key: string) => number(xf, key, number(base, key));
    const font = fonts[attr("fontId")];
    const style: IStyleData = {};
    const flag = (tag: string) => { const n = child(font, tag); return n && n.getAttribute("val") !== "0" && n.getAttribute("val") !== "false"; };
    const family = child(font, "name")?.getAttribute("val");
    if (family) style.ff = family;
    const size = number(child(font, "sz"), "val");
    if (size) style.fs = size;
    if (flag("b")) style.bl = 1;
    if (flag("i")) style.it = 1;
    if (flag("u")) style.ul = { s: 1 };
    if (flag("strike")) style.st = { s: 1 };
    const foreground = color(child(font, "color"), theme);
    if (foreground) style.cl = foreground;
    const pattern = child(fills[attr("fillId")], "patternFill");
    if (pattern?.getAttribute("patternType") === "solid") style.bg = color(child(pattern, "fgColor"), theme);
    const border = borders[attr("borderId")];
    for (const [tag, key] of [["top", "t"], ["bottom", "b"], ["left", "l"], ["right", "r"]] as const) {
      const side = child(border, tag);
      const kind = borderKinds[side?.getAttribute("style") || ""];
      if (kind) {
        style.bd ||= {};
        style.bd[key] = { s: kind, cl: color(child(side, "color"), theme) || { rgb: "#000000" } };
      }
    }
    const alignment = child(xf, "alignment") || child(base, "alignment");
    const horizontal: Record<string, number> = { left: 1, center: 2, right: 3, justify: 4, distributed: 6 };
    const vertical: Record<string, number> = { top: 1, center: 2, bottom: 3 };
    style.ht = horizontal[alignment?.getAttribute("horizontal") || ""];
    style.vt = vertical[alignment?.getAttribute("vertical") || ""];
    if (alignment?.hasAttribute("wrapText")) style.tb = number(alignment, "wrapText") ? 3 : 1;
    if (alignment?.hasAttribute("shrinkToFit")) style.stf = number(alignment, "shrinkToFit") ? 1 : 0;
    const formatId = attr("numFmtId");
    const format = formats.get(formatId) || XLSX.SSF.get_table()[formatId];
    if (format && format !== "General") style.n = { pattern: format };
    styles[`xlsx-${index}`] = style;
  });
  return styles;
}

type SheetMetadata = { styles: Map<string, string>; rows: IWorksheetData["rowData"]; cols: IWorksheetData["columnData"]; freeze?: IWorksheetData["freeze"]; showGridlines?: 0 | 1; defaultRowHeight?: number; tabColor?: string; unsupported: boolean };
async function readMetadata(bytes: Uint8Array): Promise<{ styles: Record<string, IStyleData>; sheets: Map<string, SheetMetadata> }> {
  const zip = await JSZip.loadAsync(bytes);
  const read = async (path: string) => { const file = zip.file(path); return file ? xml(await file.async("string")) : undefined; };
  const wb = await read("xl/workbook.xml");
  const rels = await read("xl/_rels/workbook.xml.rels");
  const themeXml = await read("xl/theme/theme1.xml");
  const scheme = themeXml && descendants(themeXml, "clrScheme")[0];
  // Spreadsheet theme indexing starts light1,dark1,light2,dark2.
  const theme = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"].map(name => {
    const entry = child(scheme, name)?.firstElementChild;
    return entry?.getAttribute("lastClr") || entry?.getAttribute("val") || "000000";
  });
  const stylesXml = await read("xl/styles.xml");
  const styles = stylesXml ? parseStyles(stylesXml, theme) : {};
  const sheets = new Map<string, SheetMetadata>();
  const targets = new Map(rels ? descendants(rels, "Relationship").filter(r => r.getAttribute("TargetMode") !== "External").map(r => [r.getAttribute("Id"), r.getAttribute("Target") || ""]) : []);
  for (const sheet of (wb ? descendants(wb, "sheet") : []).slice(0, MAX_SHEETS)) {
    const target = targets.get(sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || sheet.getAttribute("r:id"));
    if (!target) continue;
    const document = await read(resolvePart("xl", target));
    if (!document) continue;
    const metadata: SheetMetadata = { styles: new Map(), rows: {}, cols: {}, unsupported: ["drawing", "legacyDrawing", "conditionalFormatting", "pivotTableParts"].some(tag => descendants(document, tag).length > 0) };
    for (const c of descendants(document, "c")) {
      if (c.hasAttribute("s")) metadata.styles.set(c.getAttribute("r") || "", `xlsx-${number(c, "s")}`);
    }
    for (const r of descendants(document, "row")) {
      const index = number(r, "r") - 1;
      if (index < 0 || index >= MAX_ROWS) continue;
      metadata.rows[index] = { ...(r.hasAttribute("ht") ? { h: number(r, "ht") * 4 / 3, ia: 0 as const } : {}), ...(number(r, "hidden") ? { hd: 1 as const } : {}), ...(r.hasAttribute("s") ? { s: `xlsx-${number(r, "s")}` } : {}) };
    }
    for (const c of descendants(document, "col")) {
      for (let index = Math.max(0, number(c, "min") - 1); index < Math.min(MAX_COLS, number(c, "max")); index++) {
        metadata.cols[index] = { ...(c.hasAttribute("width") ? { w: Math.max(0, number(c, "width") * 7 + 5) } : {}), ...(number(c, "hidden") ? { hd: 1 as const } : {}), ...(c.hasAttribute("style") ? { s: `xlsx-${number(c, "style")}` } : {}) };
      }
    }
    const view = descendants(document, "sheetView")[0];
    if (view?.hasAttribute("showGridLines")) metadata.showGridlines = number(view, "showGridLines") ? 1 : 0;
    const pane = descendants(document, "pane")[0];
    if (pane?.getAttribute("state")?.startsWith("frozen")) {
      const x = Math.min(MAX_COLS - 1, number(pane, "xSplit")), y = Math.min(MAX_ROWS - 1, number(pane, "ySplit"));
      metadata.freeze = { xSplit: x, ySplit: y, startColumn: x ? x - 1 : -1, startRow: y ? y - 1 : -1 };
    }
    const format = descendants(document, "sheetFormatPr")[0];
    if (format?.hasAttribute("defaultRowHeight")) metadata.defaultRowHeight = number(format, "defaultRowHeight") * 4 / 3;
    metadata.tabColor = color(descendants(document, "tabColor")[0], theme)?.rgb;
    sheets.set(sheet.getAttribute("name") || "", metadata);
  }
  return { styles, sheets };
}

export async function loadOfficeWorkbook({ base64, text, name = "Workbook", language = "en" }: { base64?: string; text?: string; name?: string; language?: string }): Promise<WorkbookPreview> {
  const bytes = base64 ? Uint8Array.from(atob(base64), c => c.charCodeAt(0)) : undefined;
  let source: XLSX.WorkBook;
  if (text?.trim().startsWith('{"format":"pi-studio-xlsx-v1"')) {
    const snapshot = JSON.parse(text);
    source = XLSX.utils.book_new();
    for (const sheet of snapshot.sheets) XLSX.utils.book_append_sheet(source, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  } else {
    source = bytes ? XLSX.read(bytes, { type: "array", cellStyles: true, cellNF: true, sheetRows: MAX_ROWS }) : XLSX.read(text || "", { type: "string", cellStyles: true, cellNF: true, sheetRows: MAX_ROWS });
  }
  // Binary XLS and CSV have no OOXML metadata. Do not suppress corrupt XLSX
  // metadata errors: a partial preview must not masquerade as faithful import.
  const metadata = bytes?.[0] === 0x50 && bytes?.[1] === 0x4b ? await readMetadata(bytes) : { styles: {}, sheets: new Map<string, SheetMetadata>() };
  const workbook: IWorkbookData = { id: `preview-${crypto.randomUUID()}`, name, appVersion: "1.0.3", locale: (language === "zh" ? "zhCN" : "enUS") as IWorkbookData["locale"], styles: metadata.styles, sheetOrder: [], sheets: {}, ...(source.Workbook?.WBProps?.date1904 ? { dateSystem: "date1904" as IWorkbookData["dateSystem"] } : {}) };
  let limited = source.SheetNames.length > MAX_SHEETS, unsupported = false, totalCells = 0;
  for (const [index, sheetName] of source.SheetNames.slice(0, MAX_SHEETS).entries()) {
    const sheet = source.Sheets[sheetName], meta = metadata.sheets.get(sheetName);
    const id = `sheet-${index}`, cellData: IWorksheetData["cellData"] = {};
    const range = XLSX.utils.decode_range(sheet["!fullref"] || sheet["!ref"] || "A1");
    if (range.e.r >= MAX_ROWS || range.e.c >= MAX_COLS) limited = true;
    for (const address of Object.keys(sheet)) {
      if (address.startsWith("!")) continue;
      if (totalCells >= MAX_CELLS) { limited = true; break; }
      const { r, c } = XLSX.utils.decode_cell(address);
      if (r >= MAX_ROWS || c >= MAX_COLS) { limited = true; continue; }
      const value = sheet[address] as XLSX.CellObject;
      const cell: ICellData = { v: value.v instanceof Date ? value.v.toISOString() : value.v ?? "", t: value.t === "n" ? 2 : value.t === "b" ? 3 : 1 };
      if (value.f) cell.f = `=${value.f}`;
      const styleId = meta?.styles.get(address);
      if (styleId && workbook.styles[styleId]) cell.s = styleId;
      else if (value.z && value.z !== "General") cell.s = { n: { pattern: String(value.z) } };
      (cellData[r] ||= {})[c] = cell;
      totalCells++;
    }
    const rowData = { ...meta?.rows }, columnData = { ...meta?.cols };
    (sheet["!rows"] || []).slice(0, MAX_ROWS).forEach((r, i) => {
      if (r) rowData[i] = { ...rowData[i], ...(r.hpx ? { h: r.hpx, ia: 0 } : r.hpt ? { h: r.hpt * 4 / 3, ia: 0 } : {}), ...(r.hidden ? { hd: 1 } : {}) };
    });
    (sheet["!cols"] || []).slice(0, MAX_COLS).forEach((c, i) => {
      if (c) columnData[i] = { ...columnData[i], ...(c.wpx !== undefined ? { w: c.wpx } : {}), ...(c.hidden ? { hd: 1 } : {}) };
    });
    const mergeData = (sheet["!merges"] || []).filter(m => {
      const fits = m.e.r < MAX_ROWS && m.e.c < MAX_COLS;
      if (!fits) limited = true;
      return fits;
    }).map(m => ({ startRow: m.s.r, endRow: m.e.r, startColumn: m.s.c, endColumn: m.e.c }));
    const hidden = source.Workbook?.Sheets?.[index]?.Hidden || 0;
    workbook.sheetOrder.push(id);
    workbook.sheets[id] = { id, name: sheetName, cellData, rowData, columnData, mergeData, rowCount: Math.min(MAX_ROWS, Math.max(100, range.e.r + 21)), columnCount: Math.min(MAX_COLS, Math.max(26, range.e.c + 6)), defaultColumnWidth: 96, defaultRowHeight: meta?.defaultRowHeight || 24, rowHeader: { width: 46 }, columnHeader: { height: 25 }, showGridlines: meta?.showGridlines ?? 1, hidden, zoomRatio: 1, freeze: meta?.freeze || { xSplit: 0, ySplit: 0, startRow: -1, startColumn: -1 }, tabColor: meta?.tabColor || "", scrollTop: 0, scrollLeft: 0, rightToLeft: 0 };
    unsupported ||= meta?.unsupported || false;
  }
  if (!workbook.sheetOrder.length) throw new Error("Workbook contains no worksheets");
  if (workbook.sheetOrder.every(id => workbook.sheets[id].hidden)) workbook.sheets[workbook.sheetOrder[0]].hidden = 0;
  return { workbook, limited, unsupported };
}
