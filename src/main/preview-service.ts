import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import XLSX from "xlsx";

/**
 * Reads a file and returns a renderer-friendly preview payload. Heavy parsing
 * (pdf/docx/xlsx) is done in the renderer with pdfjs / mammoth / sheetjs; here
 * we only classify by extension and return either text or base64 bytes. The
 * remote companion uses readRemotePreview below for a bounded table snapshot
 * instead of receiving the raw workbook binary.
 */

export type PreviewPayload = {
  name: string;
  ext: string;
  size: number;
  kind:
    | "text"
    | "markdown"
    | "html"
    | "image"
    | "docx"
    | "xlsx"
    | "pptx"
    | "unsupported"
    | "toobig"
    | "missing";
  mime?: string;
  text?: string;
  base64?: string;
  lang?: string;
  truncated?: boolean;
  message?: string;
  previewUrl?: string;
};

const TEXT_EXTS: Record<string, string> = {
  ".txt": "plaintext",
  ".log": "plaintext",
  ".json": "json",
  ".jsonc": "json",
  ".mdx": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "ini",
  ".xml": "xml",
  ".svg": "xml",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".ps1": "powershell",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".vue": "xml",
  ".svelte": "xml",
  ".ini": "ini",
  ".env": "bash",
  ".gitignore": "bash",
  ".dockerfile": "dockerfile",
  ".makefile": "makefile",
  ".c": "cpp",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".h": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".swift": "swift",
  ".lua": "lua",
  ".r": "r",
  ".csv": "csv",
  ".tsv": "csv",
};

const MARKDOWN_EXTS = new Set([".md", ".markdown", ".mdown"]);
const IMAGE_EXTS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};
// NOTE: PDF preview is intentionally not supported in this build (pdfjs-dist
// omitted to keep the bundle small). .pdf falls through to "unsupported".
const DOCX_EXTS = new Set([".docx"]);
const XLSX_EXTS = new Set([".xlsx", ".xls"]);
const PPTX_EXTS = new Set([".pptx"]);

const TEXT_MAX = 2_000_000; // 2 MB of text
const BIN_MAX = 40_000_000; // 40 MB binary
const HTML_WRITE_MAX = 10_000_000;

function pathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

export function readPreview(absPath: string): PreviewPayload {
  const name = basename(absPath);
  const ext = extname(name).toLowerCase();
  const base = { name, ext, size: 0 } as PreviewPayload;

  if (!existsSync(absPath)) return { ...base, kind: "missing", message: "File not found" };

  let st;
  try {
    st = statSync(absPath);
  } catch (e: any) {
    return { ...base, kind: "missing", message: e?.message || "stat failed" };
  }
  if (st.isDirectory()) return { ...base, kind: "unsupported", message: "This is a folder" };
  base.size = st.size;

  // images
  if (ext in IMAGE_EXTS && ext !== ".svg") {
    if (st.size > BIN_MAX) return { ...base, kind: "toobig" };
    const buf = readFileSync(absPath);
    return { ...base, kind: "image", mime: IMAGE_EXTS[ext], base64: buf.toString("base64") };
  }

  // docx / xlsx -> base64 for renderer-side parsing
  if (DOCX_EXTS.has(ext)) {
    if (st.size > BIN_MAX) return { ...base, kind: "toobig" };
    return {
      ...base,
      kind: "docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      base64: readFileSync(absPath).toString("base64"),
    };
  }
  if (XLSX_EXTS.has(ext)) {
    if (st.size > BIN_MAX) return { ...base, kind: "toobig" };
    return {
      ...base,
      kind: "xlsx",
      mime: ext === ".xls"
        ? "application/vnd.ms-excel"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64: readFileSync(absPath).toString("base64"),
    };
  }
  if (PPTX_EXTS.has(ext)) {
    if (st.size > BIN_MAX) return { ...base, kind: "toobig" };
    return {
      ...base,
      kind: "pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      base64: readFileSync(absPath).toString("base64"),
    };
  }

  // markdown
  if (MARKDOWN_EXTS.has(ext)) {
    if (st.size > TEXT_MAX) {
      const buf = readFileSync(absPath, { encoding: "utf8" }).slice(0, TEXT_MAX);
      return { ...base, kind: "markdown", text: buf, truncated: true, lang: "markdown" };
    }
    return { ...base, kind: "markdown", text: readFileSync(absPath, "utf8"), lang: "markdown" };
  }

  // html (also svg-as-text fallback handled below)
  if (ext === ".html" || ext === ".htm") {
    if (st.size > TEXT_MAX) {
      const buf = readFileSync(absPath, { encoding: "utf8" }).slice(0, TEXT_MAX);
      return { ...base, kind: "html", text: buf, truncated: true, lang: "html" };
    }
    return { ...base, kind: "html", text: readFileSync(absPath, "utf8"), lang: "html" };
  }

  // svg: show as image by default (vector preview)
  if (ext === ".svg") {
    if (st.size > BIN_MAX) return { ...base, kind: "toobig" };
    return { ...base, kind: "image", mime: "image/svg+xml", base64: readFileSync(absPath).toString("base64") };
  }

  // known text
  if (ext in TEXT_EXTS) {
    const buf = readFileSync(absPath);
    if (looksBinary(buf)) return { ...base, kind: "unsupported", message: "Binary file" };
    let text = buf.toString("utf8");
    let truncated = false;
    if (text.length > TEXT_MAX) {
      text = text.slice(0, TEXT_MAX);
      truncated = true;
    }
    const lang = TEXT_EXTS[ext];
    if (lang === "csv") return { ...base, kind: "xlsx", text, lang: "csv", truncated };
    return { ...base, kind: "text", text, lang, truncated };
  }

  // unknown extension: try as text if small and not binary
  if (st.size <= TEXT_MAX) {
    const buf = readFileSync(absPath);
    if (!looksBinary(buf)) {
      return { ...base, kind: "text", text: buf.toString("utf8"), lang: "plaintext" };
    }
  }
  return { ...base, kind: "unsupported", message: "No preview available for this file type" };
}

/** Persist an edited HTML preview after validating the requested file scope. */
export function writePreviewHtml(absPath: string, projectRoot: string | undefined, html: string): { ok: true; size: number } {
  if (!absPath || !isAbsolute(absPath)) throw new Error("An absolute HTML path is required");
  if (typeof html !== "string" || html.length > HTML_WRITE_MAX) throw new Error("HTML content is too large to save");

  const file = realpathSync(resolve(absPath));
  if (!statSync(file).isFile() || ![".html", ".htm"].includes(extname(file).toLowerCase())) {
    throw new Error("HTML preview edits require an .html or .htm file");
  }

  if (projectRoot) {
    const root = realpathSync(resolve(projectRoot));
    if (!statSync(root).isDirectory() || !pathInside(root, file)) {
      throw new Error("HTML preview file is outside the project root");
    }
  }

  writeFileSync(file, html, "utf8");
  return { ok: true, size: Buffer.byteLength(html, "utf8") };
}

const REMOTE_SHEET_MAX_SHEETS = 20;
const REMOTE_SHEET_MAX_ROWS = 200;
const REMOTE_SHEET_MAX_COLUMNS = 30;
const REMOTE_SHEET_MAX_CELL_CHARS = 240;
const REMOTE_SHEET_MAX_TEXT_CHARS = 900_000;
const REMOTE_SHEET_MAX_JSON_CHARS = 1_100_000;

/**
 * Convert Excel/CSV files into a bounded table snapshot for remote clients.
 * Android should not need to ship a second Office parser or receive the raw
 * workbook binary over the WebRTC data channel.
 */
export function readRemotePreview(absPath: string): PreviewPayload {
  const preview = readPreview(absPath);
  if (preview.kind !== "xlsx") return preview;

  try {
    const workbook = XLSX.readFile(absPath, { cellText: true, cellDates: true });
    let remainingChars = REMOTE_SHEET_MAX_TEXT_CHARS;
    let truncated = preview.truncated === true || workbook.SheetNames.length > REMOTE_SHEET_MAX_SHEETS;
    const sheets = workbook.SheetNames.slice(0, REMOTE_SHEET_MAX_SHEETS).flatMap((name) => {
      if (remainingChars <= 0) {
        truncated = true;
        return [];
      }
      const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
        header: 1,
        raw: false,
        defval: "",
        blankrows: false,
      }) as unknown[];
      if (rawRows.length > REMOTE_SHEET_MAX_ROWS) truncated = true;
      const rows: string[][] = [];
      for (const rawRow of rawRows.slice(0, REMOTE_SHEET_MAX_ROWS)) {
        if (remainingChars <= 0) {
          truncated = true;
          break;
        }
        if (!Array.isArray(rawRow)) continue;
        if (rawRow.length > REMOTE_SHEET_MAX_COLUMNS) truncated = true;
        const row: string[] = [];
        for (const value of rawRow.slice(0, REMOTE_SHEET_MAX_COLUMNS)) {
          let cell = String(value ?? "");
          if (cell.length > REMOTE_SHEET_MAX_CELL_CHARS) {
            cell = cell.slice(0, REMOTE_SHEET_MAX_CELL_CHARS);
            truncated = true;
          }
          if (cell.length > remainingChars) {
            cell = cell.slice(0, remainingChars);
            truncated = true;
          }
          remainingChars -= cell.length;
          row.push(cell);
        }
        rows.push(row);
      }
      return rows.length ? [{ name, rows }] : [];
    });
    const boundedSheets = sheets.map((sheet) => ({
      name: sheet.name,
      rows: sheet.rows.map((row) => [...row]),
    }));
    let text = JSON.stringify({ format: "pi-studio-xlsx-v1", sheets: boundedSheets });
    // Cell limits are counted before JSON escaping. Remove complete trailing
    // rows/sheets if escaping pushes the valid JSON envelope over the remote
    // transport budget; never slice JSON into an invalid document.
    while (text.length > REMOTE_SHEET_MAX_JSON_CHARS && boundedSheets.length > 0) {
      const lastSheet = boundedSheets[boundedSheets.length - 1];
      if (lastSheet.rows.length > 1) lastSheet.rows.pop();
      else boundedSheets.pop();
      truncated = true;
      text = JSON.stringify({ format: "pi-studio-xlsx-v1", sheets: boundedSheets });
    }
    const { base64: _base64, ...withoutBinary } = preview;
    return {
      ...withoutBinary,
      text,
      lang: "pi-studio-xlsx-v1",
      truncated,
    };
  } catch {
    const { base64: _base64, ...withoutBinary } = preview;
    return {
      ...withoutBinary,
      message: "Excel preview could not be parsed on the Pi Studio host",
    };
  }
}
