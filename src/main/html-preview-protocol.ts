import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { protocol } from "electron";

const SCHEME = "pi-preview";
const MAX_SESSIONS = 64;

type PreviewSession = {
  root: string;
  createdAt: number;
};

const sessions = new Map<string, PreviewSession>();

/**
 * The HTML preview runs in a sandboxed iframe, so the renderer cannot inspect
 * its DOM directly. This small bridge stays inactive until the renderer turns
 * on annotation mode and reports only a compact description of the selected
 * element through postMessage.
 */
const HTML_ANNOTATION_BRIDGE = `<script>
(() => {
  const SOURCE = "pi-studio-html-preview";
  let enabled = false;
  let editable = false;
  let editing = false;
  let hovered = null;
  let selected = null;

  const style = document.createElement("style");
  style.textContent = [
    "html[data-pi-preview-annotate-active], html[data-pi-preview-annotate-active] * { cursor: crosshair !important; }",
    "html[data-pi-preview-edit-active], html[data-pi-preview-edit-active] * { cursor: text !important; }",
    "[data-pi-preview-hover] { outline: 2px solid #4b8df8 !important; outline-offset: 2px !important; }",
    "[data-pi-preview-selected] { outline: 2px solid #e2764b !important; outline-offset: 3px !important; box-shadow: 0 0 0 4px rgba(226, 118, 75, .18) !important; }",
    "[data-pi-preview-editing], [data-pi-preview-editing] * { cursor: text !important; }",
  ].join("");
  (document.head || document.documentElement).appendChild(style);

  function post(type, payload) {
    try {
      window.parent.postMessage(Object.assign({ source: SOURCE, type }, payload || {}), "*");
    } catch (_) {
      // The parent may disappear while the preview is being replaced.
    }
  }

  function clearMarker(element, attribute) {
    if (element) element.removeAttribute(attribute);
  }

  function clearHover() {
    clearMarker(hovered, "data-pi-preview-hover");
    hovered = null;
  }

  function clearEditing() {
    clearMarker(selected, "data-pi-preview-editing");
    if (selected) {
      selected.removeAttribute("contenteditable");
      selected.removeAttribute("spellcheck");
    }
    editing = false;
  }

  function updateModeMarkers() {
    document.documentElement.toggleAttribute("data-pi-preview-annotate-active", enabled && !editing);
    document.documentElement.toggleAttribute("data-pi-preview-edit-active", enabled && editing);
  }

  function setEditMode(value) {
    const next = value === true && enabled && editable && !!selected;
    if (next === editing) return;
    if (!next) {
      clearEditing();
    } else {
      editing = true;
      selected.setAttribute("data-pi-preview-editing", "true");
      selected.setAttribute("contenteditable", "true");
      selected.setAttribute("spellcheck", "false");
      selected.focus();
    }
    updateModeMarkers();
    post("edit-state", { editing, hasSelection: !!selected });
  }

  function clearSelection() {
    clearEditing();
    clearMarker(selected, "data-pi-preview-selected");
    selected = null;
  }

  function escapeSelector(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  }

  function selectorFor(element) {
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== document.documentElement && parts.length < 8) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += "#" + escapeSelector(current.id);
        parts.unshift(part);
        break;
      }
      const classes = Array.from(current.classList || [])
        .filter((name) => name && !name.startsWith("data-pi-preview-"))
        .slice(0, 2);
      if (classes.length) part += classes.map((name) => "." + escapeSelector(name)).join("");
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (sameTag.length > 1) part += ":nth-of-type(" + (sameTag.indexOf(current) + 1) + ")";
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ") || "body";
  }

  function elementFromEvent(event) {
    const target = event && event.target;
    return target && target.nodeType === 1 ? target.closest("*") : null;
  }

  function compactText(value, limit) {
    return String(value || "").replace(/\\s+/g, " ").trim().slice(0, limit);
  }

  function describe(element) {
    const computed = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      selector: selectorFor(element),
      tagName: element.tagName.toLowerCase(),
      id: element.id || "",
      classes: compactText(element.className && typeof element.className === "string" ? element.className : "", 180),
      text: compactText(element.innerText || element.textContent || "", 240),
      outerHTML: compactText(element.outerHTML || "", 700),
      styles: {
        backgroundColor: computed.backgroundColor,
        color: computed.color,
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        lineHeight: computed.lineHeight,
        display: computed.display,
        position: computed.position,
        padding: computed.padding,
        margin: computed.margin,
        gap: computed.gap,
        borderRadius: computed.borderRadius,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }

  function setEnabled(value, canEdit, requestedEdit) {
    enabled = value === true;
    editable = enabled && canEdit === true;
    if (!enabled) {
      clearHover();
      clearSelection();
    } else {
      clearHover();
      setEditMode(editable && requestedEdit === true);
    }
    updateModeMarkers();
    post("mode-state", { enabled, editable, editing, hasSelection: !!selected });
  }

  function selectElement(event) {
    if (!enabled || editing || event.button !== 0) return;
    const element = elementFromEvent(event);
    if (!element || element === document.documentElement || element === document.head || element === document.body) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    const snapshot = describe(element);
    clearHover();
    clearSelection();
    selected = element;
    selected.setAttribute("data-pi-preview-selected", "true");
    post("element-selected", { element: snapshot });
  }

  document.addEventListener("pointermove", (event) => {
    if (!enabled || editing) {
      clearHover();
      return;
    }
    const element = elementFromEvent(event);
    if (element === hovered || element === selected || !element || element === document.documentElement || element === document.body) return;
    clearHover();
    hovered = element;
    hovered.setAttribute("data-pi-preview-hover", "true");
  }, true);
  document.addEventListener("pointerdown", selectElement, true);
  document.addEventListener("click", (event) => {
    if (!enabled || editing) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
  }, true);
  document.addEventListener("dblclick", (event) => {
    if (!enabled || editing || !editable || event.button !== 0) return;
    const element = elementFromEvent(event);
    if (!selected || element !== selected) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    setEditMode(true);
  }, true);
  document.addEventListener("input", (event) => {
    if (!enabled || !editing || !selected) return;
    const target = event && event.target;
    if (!target || (target !== selected && !selected.contains(target))) return;
    post("element-edited", {
      selector: selectorFor(selected),
      innerHTML: selected.innerHTML,
    });
  }, true);
  document.addEventListener("wheel", (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    post("zoom-wheel", { deltaY: Number(event.deltaY) || 0 });
  }, { capture: true, passive: false });
  document.addEventListener("keydown", (event) => {
    if (enabled && event.key === "Escape") {
      event.preventDefault();
      if (editing) {
        setEditMode(false);
      } else {
        setEnabled(false, false, false);
      }
      return;
    }
    if (enabled && !editing && editable && selected && (event.key === "Enter" || event.key === "F2")) {
      event.preventDefault();
      setEditMode(true);
    }
  }, true);
  window.addEventListener("message", (event) => {
    const data = event && event.data;
    if (!data || data.source !== SOURCE || data.type !== "set-mode") return;
    setEnabled(data.enabled === true, data.editable === true, data.editMode === true);
  });

  post("ready");
})();
</script>`;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

export function registerHtmlPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

function response(status: number, body: string | Buffer, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(body as BodyInit, {
    status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function pruneSessions(): void {
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) break;
    sessions.delete(oldest[0]);
  }
}

function injectHtmlAnnotationBridge(body: string): string {
  const closingBody = /<\/body\s*>/i;
  return closingBody.test(body)
    ? body.replace(closingBody, (closing) => `${HTML_ANNOTATION_BRIDGE}${closing}`)
    : `${body}${HTML_ANNOTATION_BRIDGE}`;
}

export function createHtmlPreviewUrl(absPath: string, requestedRoot?: string): string {
  const file = realpathSync(absPath);
  if (!statSync(file).isFile() || ![".html", ".htm"].includes(extname(file).toLowerCase())) {
    throw new Error("HTML preview requires an .html or .htm file");
  }

  let root = dirname(file);
  if (requestedRoot && existsSync(requestedRoot)) {
    const candidate = realpathSync(requestedRoot);
    if (statSync(candidate).isDirectory() && inside(candidate, file)) root = candidate;
  }

  pruneSessions();
  const token = randomUUID();
  sessions.set(token, { root, createdAt: Date.now() });
  const rel = relative(root, file)
    .split(sep)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${SCHEME}://${token}/${rel}?v=${statSync(file).mtimeMs}`;
}

export function registerHtmlPreviewProtocol(): void {
  protocol.handle(SCHEME, (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return response(405, "Method not allowed");
      const url = new URL(request.url);
      const session = sessions.get(url.hostname);
      if (!session) return response(404, "Preview session expired");

      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "").replace(/\//g, sep);
      let target = resolve(session.root, rel);
      if (existsSync(target) && statSync(target).isDirectory()) target = resolve(target, "index.html");
      if (!existsSync(target)) return response(404, "Preview resource not found");

      const realTarget = realpathSync(target);
      if (!inside(session.root, realTarget)) return response(403, "Resource is outside the preview project");
      const type = MIME_TYPES[extname(realTarget).toLowerCase()];
      if (!type) return response(415, "Resource type is not available in HTML preview");

      let body: string | Buffer = request.method === "HEAD" ? "" : readFileSync(realTarget);
      if (request.method !== "HEAD" && [".html", ".htm"].includes(extname(realTarget).toLowerCase())) {
        body = injectHtmlAnnotationBridge(body.toString("utf8"));
      }
      return response(200, body, type);
    } catch (error: any) {
      return response(400, error?.message || "Invalid preview request");
    }
  });
}
