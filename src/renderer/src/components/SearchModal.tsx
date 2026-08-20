import { useEffect, useRef, useState, type ReactNode } from "react";
import { localizeAutomationThreadTitle, useStore } from "../store";
import type { ThreadSearchHit } from "../lib/types";
import { Search, Close, Folder } from "./icons";

/** Split text around case-insensitive matches of `query` and wrap them in <mark>. */
function highlight(text: string, query: string): ReactNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [text];
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let idx = lower.indexOf(q);
  let key = 0;
  while (idx !== -1) {
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={key++} className="hl">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
    idx = lower.indexOf(q, i);
  }
  if (i < text.length) parts.push(text.slice(i));
  return parts;
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString([], { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function SearchModal() {
  const open = useStore((s) => s.searchOpen);
  const close = useStore((s) => s.closeSearch);
  const goToThread = useStore((s) => s.goToThread);
  const language = useStore((s) => s.config?.language || "en");

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ThreadSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);

  // reset + focus each time the palette opens
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSearched(false);
      setLoading(false);
      setActive(0);
      reqId.current++;
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // debounced search with a stale-response guard
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearched(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    const myId = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const res = await window.pi.app.searchThreads(q);
        if (reqId.current !== myId) return;
        setResults(res);
        setSearched(true);
        setActive(0);
      } catch {
        if (reqId.current !== myId) return;
        setResults([]);
        setSearched(true);
      } finally {
        if (reqId.current === myId) setLoading(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [query]);

  // keep the highlighted row in view while arrowing
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Esc closes even when focus is elsewhere in the modal
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  const go = async (hit: ThreadSearchHit) => {
    close();
    await goToThread(hit.cwd, hit.file);
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[active];
      if (hit) go(hit);
    }
  };

  const q = query.trim();

  return (
    <div className="search-backdrop" onMouseDown={close}>
      <div className="search-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="搜索线程">
        <div className="search-input-row">
          <span className="search-ico">
            <Search size={17} />
          </span>
          <input
            ref={inputRef}
            className="search-input"
            placeholder="搜索所有线程中的关键词…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            spellCheck={false}
          />
          {loading ? (
            <span className="spinner search-spin" />
          ) : query ? (
            <button className="search-clear" title="清空" onClick={() => setQuery("")}>
              <Close size={14} />
            </button>
          ) : (
            <span className="kbd">{language === "zh" ? "退出" : "Esc"}</span>
          )}
        </div>

        <div className="search-results" ref={listRef}>
          {!q && (
            <div className="search-empty">
              输入关键词，在全部项目的线程对话中搜索。
              <br />
              <span className="muted">匹配线程标题与用户 / 助手消息内容。</span>
            </div>
          )}

          {q && searched && results.length === 0 && !loading && (
            <div className="search-empty">
              未找到包含 <b>“{q}”</b> 的线程。
            </div>
          )}

          {results.map((hit, i) => {
            const title = localizeAutomationThreadTitle(hit.title, language);
            return (
              <button
                key={hit.file}
                data-idx={i}
                className={`search-item ${i === active ? "active" : ""}`}
                style={{ animationDelay: `${Math.min(i, 10) * 22}ms` }}
                onClick={() => go(hit)}
                onMouseEnter={() => setActive(i)}
              >
                <div className="search-item-top">
                  <span className="search-item-title">{highlight(title, q)}</span>
                  <span className="search-item-count">{hit.matchCount} 处匹配</span>
                </div>
                <div className="search-item-snippet">{highlight(hit.snippet, q)}</div>
                <div className="search-item-meta">
                  <span className="search-item-proj">
                    <Folder size={11} /> {hit.projectName}
                  </span>
                  <span>{hit.messageCount} 条</span>
                  <span>{fmtDate(hit.updatedAt)}</span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="search-foot">
          <span>
            <span className="kbd">↑</span> <span className="kbd">↓</span> 选择
          </span>
          <span>
            <span className="kbd">{language === "zh" ? "回车" : "Enter"}</span> {language === "zh" ? "打开" : "Open"}
          </span>
          <span>
            <span className="kbd">{language === "zh" ? "退出" : "Esc"}</span> {language === "zh" ? "关闭" : "Close"}
          </span>
          <span className="search-foot-n">{results.length > 0 ? `${results.length} 个线程` : ""}</span>
        </div>
      </div>
    </div>
  );
}
