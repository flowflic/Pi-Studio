import type { HtmlElementReference } from "./types";

export interface ParsedHtmlReferenceText {
  text: string;
  references: HtmlElementReference[];
}

const HTML_REFERENCE_HEADER = /^\[(?:Selected HTML element|已选中的 HTML 元素)\]\s*$/gim;

function hashReference(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function fieldValue(block: string, name: string): string {
  const match = block.match(new RegExp(`^-\\s*${name}:\\s*(.*)$`, "im"));
  return match?.[1]?.trim() || "";
}

function codeValue(value: string): string {
  const match = value.match(/^`([\s\S]*)`$/);
  return (match ? match[1] : value).trim();
}

function textValue(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : raw;
  } catch {
    return raw.replace(/^"|"$/g, "");
  }
}

function parseStyles(value: string): Record<string, string> | undefined {
  if (!value) return undefined;
  const styles: Record<string, string> = {};
  for (const item of value.split(/;\s*/)) {
    const separator = item.indexOf(":");
    if (separator <= 0) continue;
    const name = item.slice(0, separator).trim();
    const styleValue = item.slice(separator + 1).trim();
    if (name && styleValue) styles[name] = styleValue;
  }
  return Object.keys(styles).length ? styles : undefined;
}

function parseReferenceBlock(block: string, index: number): HtmlElementReference | null {
  const selector = codeValue(fieldValue(block, "selector"));
  const tagName = fieldValue(block, "tag").replace(/^<|>$/g, "").trim().toLowerCase();
  const text = textValue(fieldValue(block, "text"));
  const outerHTML = codeValue(fieldValue(block, "HTML"));
  const styles = parseStyles(fieldValue(block, "current styles"));
  if (!selector && !tagName && !outerHTML) return null;
  return {
    id: `html-reference-${index}-${hashReference(block)}`,
    reference: block.trim(),
    selector,
    tagName,
    text,
    outerHTML,
    styles,
  };
}

/**
 * User prompts contain a plain-text HTML context block for Pi. Keep that
 * transport format intact, but recover its visible part and structured card
 * data when rendering the transcript. Invalid or user-authored lookalikes are
 * left untouched instead of being silently removed from the message.
 */
export function parseHtmlReferenceText(text: string): ParsedHtmlReferenceText {
  const normalized = (text || "").replace(/\r\n/g, "\n");
  const matches = Array.from(normalized.matchAll(HTML_REFERENCE_HEADER));
  if (!matches.length) return { text: normalized, references: [] };

  let visible = normalized;
  const references: HtmlElementReference[] = [];
  for (let i = matches.length - 1; i >= 0; i--) {
    const start = matches[i].index;
    if (start === undefined) continue;
    const nextStart = i + 1 < matches.length ? matches[i + 1].index : normalized.length;
    if (nextStart === undefined) continue;
    const block = normalized.slice(start, nextStart).trim();
    const reference = parseReferenceBlock(block, i);
    if (!reference) continue;
    references.unshift(reference);
    visible = `${visible.slice(0, start)}${visible.slice(nextStart)}`;
  }

  return {
    text: visible.replace(/\n{3,}/g, "\n\n").trim(),
    references,
  };
}
