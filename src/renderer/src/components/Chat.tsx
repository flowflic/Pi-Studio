import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getDisplayThreadTitle, normalizeThreadFile, parseSkillBlock, useStore } from "../store";
import { Markdown } from "../lib/markdown";
import { formatClock, formatTokens } from "../lib/format";
import { collectFileArtifacts } from "../lib/artifacts";
import { useOutsideClose } from "../lib/useOutsideClose";
import type { ContentBlock, ToolRun, ViewMessage } from "../lib/types";
import { Composer } from "./Composer";
import { ExtUiPromptCard } from "./ExtUiPromptCard";
import { Sidebar, PanelRight, Copy, ThumbUp, ThumbDown, Refresh, Edit, Folder, Files, Gauge, Branch } from "./icons";
import appIconUrl from "../../../../resources/icon.png";

export function Chat() {
  const activeThreadId = useStore((s) => s.activeThreadId);
  const thread = useStore((s) => (activeThreadId ? s.threads[activeThreadId] : null));
  const projects = useStore((s) => s.projects);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const togglePreview = useStore((s) => s.togglePreview);
  const newSessionInThread = useStore((s) => s.newSessionInThread);
  const renameThread = useStore((s) => s.renameThread);
  const switchThreadFolder = useStore((s) => s.switchThreadFolder);
  const scrollRef = useRef<HTMLDivElement>(null);
  const highlightedUserMessageRef = useRef<HTMLElement | null>(null);
  const jumpHighlightTimerRef = useRef<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const language = useStore((s) => s.config?.language || "en");

  // context-usage popover
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxStats, setCtxStats] = useState<any>(null);
  const [ctxLoading, setCtxLoading] = useState(false);
  const ctxRef = useRef<HTMLDivElement>(null);
  useOutsideClose(ctxRef, ctxOpen, () => setCtxOpen(false));

  const streaming = thread?.streaming;
  const count = (thread?.messages.length || 0) + (streaming ? 1 : 0);

  // auto-scroll to bottom on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (near) el.scrollTop = el.scrollHeight;
  }, [count, streaming?.blocks?.length, thread?.messages.length]);

  useEffect(() => {
    if (!previewImage) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setPreviewImage(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [previewImage]);

  useEffect(() => {
    return () => {
      if (jumpHighlightTimerRef.current !== null) window.clearTimeout(jumpHighlightTimerRef.current);
    };
  }, []);

  if (!thread || !activeThreadId) return null;

  // Optimistic open: the pi process is still booting. Show the chrome plus a
  // spinner immediately instead of leaving the previous view frozen.
  if (thread.loading) {
    return (
      <section className="main">
        <div className="chat-head">
          <button className="iconbtn" title="Toggle sidebar" onClick={toggleSidebar}>
            <Sidebar size={16} />
          </button>
          <div className="chat-head-titlewrap">
            <div className="chat-head-title">New Thread</div>
          </div>
          <div className="spacer" />
        </div>
        <div className="chat-loading">
          <span className="spinner" />
          正在启动 pi 进程…
        </div>
      </section>
    );
  }

  const firstUserText = thread.messages.find((m) => m.role === "user")?.text || "";
  const isEmptyDraft = thread.messages.length === 0 && !thread.streaming;
  const titleFile = thread.sessionFile || activeThreadId;
  const sidebarTitle = activeThreadId
    ? projects
        .flatMap((project) => project.threads)
        .find((summary) => normalizeThreadFile(summary.file || summary.id) === normalizeThreadFile(titleFile))?.title || ""
    : "";
  // A stale fresh-session flag must never hide the title of a real transcript.
  // Once this view has messages, derive the header from this thread itself;
  // only an actually empty draft uses the default label.
  const title = isEmptyDraft
    ? "New Thread"
    : (sidebarTitle || getDisplayThreadTitle(thread.sessionName, firstUserText)).slice(0, 40) || "New Thread";

  // Group consecutive assistant messages into one visual turn: a single agent
  // round emits many assistant messages (think -> tool -> ... -> final reply)
  // separated only by tool results, which are not rendered as bubbles. They
  // share ONE avatar; a user message starts a new group. thread.messages keeps
  // a stable identity during token streaming, so this memo only recomputes when
  // a message finalizes.
  const groups = useMemo(() => groupMessages(thread.messages), [thread.messages]);
  const lastGroup = groups[groups.length - 1];
  const streamingExtends = !!streaming && !!lastGroup && lastGroup.role === "assistant";
  const headGroups = streamingExtends ? groups.slice(0, -1) : groups;
  const userGroups = useMemo(
    () => groups.filter((group) => group.items[0]?.role === "user"),
    [groups],
  );

  const jumpToUserMessage = (key: string) => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const target = Array.from(scroll.querySelectorAll<HTMLElement>("[data-user-message-key]"))
      .find((node) => node.dataset.userMessageKey === key);
    if (!target) return;

    const scrollRect = scroll.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const targetOffset = targetRect.top - scrollRect.top - (scroll.clientHeight - targetRect.height) / 2;
    const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const nextScrollTop = Math.min(maxScrollTop, Math.max(0, scroll.scrollTop + targetOffset));
    scroll.scrollTo({
      top: nextScrollTop,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });

    highlightedUserMessageRef.current?.classList.remove("message-jump-target");
    target.classList.remove("message-jump-target");
    void target.offsetWidth;
    target.classList.add("message-jump-target");
    highlightedUserMessageRef.current = target;
    if (jumpHighlightTimerRef.current !== null) window.clearTimeout(jumpHighlightTimerRef.current);
    jumpHighlightTimerRef.current = window.setTimeout(() => {
      target.classList.remove("message-jump-target");
      if (highlightedUserMessageRef.current === target) highlightedUserMessageRef.current = null;
      jumpHighlightTimerRef.current = null;
    }, 900);
  };

  const startRename = () => {
    setEditValue(thread.sessionName || "");
    setEditing(true);
    requestAnimationFrame(() => editInputRef.current?.focus());
  };

  const commitRename = () => {
    setEditing(false);
    const v = editValue.trim();
    if (v) renameThread(activeThreadId, v);
  };

  const cancelRename = () => {
    setEditing(false);
  };

  const loadCtx = async () => {
    if (!activeThreadId) return;
    setCtxLoading(true);
    try {
      const id = await useStore.getState().ensureConnected(activeThreadId);
      setCtxStats(id ? await window.pi.thread.getStats(id) : null);
    } catch {
      setCtxStats(null);
    }
    setCtxLoading(false);
  };
  const toggleCtx = () => {
    const next = !ctxOpen;
    setCtxOpen(next);
    if (next) loadCtx();
  };

  const ctxUsage = ctxStats?.contextUsage;
  const ctxUsed = ctxUsage?.tokens ?? 0;
  const ctxTotal = ctxUsage?.contextWindow ?? 0;
  const ctxRemaining = Math.max(0, ctxTotal - ctxUsed);
  const ctxPct = ctxUsage ? ctxUsage.percent ?? (ctxTotal ? Math.round((ctxUsed / ctxTotal) * 100) : 0) : 0;

  return (
    <section className="main">
      <div className="chat-head">
        <button className="iconbtn" title="Toggle sidebar" onClick={toggleSidebar}>
          <Sidebar size={16} />
        </button>
        <div className="chat-head-titlewrap">
          {editing ? (
            <input
              ref={editInputRef}
              className="chat-head-input"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") cancelRename();
              }}
              onBlur={commitRename}
            />
          ) : (
            <>
              <div key={`${activeThreadId}:${title}`} className="chat-head-title" title={title} onDoubleClick={startRename}>
                {title}
              </div>
              {thread.cwd && (
                <button
                  className="chat-head-folder"
                  title={`在文件管理器中打开：${thread.cwd}`}
                  onClick={() => {
                    window.pi.settings.openPath(thread.cwd).catch(() => {});
                  }}
                >
                  <Folder size={11} />
                  <span className="chat-head-folder-path">{thread.cwd}</span>
                </button>
              )}
            </>
          )}
        </div>
        {!thread.connected && (
          <span className="chat-connecting" title="pi 进程连接中；历史已可浏览，发送消息会自动等待连接完成">
            <span className="spinner" /> 连接中
          </span>
        )}
        <button className="iconbtn" title="重命名" onClick={startRename}>
          <Edit size={14} />
        </button>
        <div className="spacer" />
        <div className="ctx-wrap" ref={ctxRef}>
          <button className={`iconbtn ${ctxOpen ? "on" : ""}`} title="当前线程上下文用量" onClick={toggleCtx}>
            <Gauge size={15} />
          </button>
          {ctxOpen && (
            <div className="ctx-pop">
              <div className="ctx-pop-head">
                <span>上下文</span>
                <button className="ctx-refresh" title="刷新" onClick={loadCtx}>
                  <Refresh size={12} />
                </button>
              </div>
              {ctxLoading ? (
                <div className="ctx-loading">
                  <span className="spinner" />
                </div>
              ) : ctxUsage ? (
                <>
                  <div className="ctx-bignum">
                    {formatTokens(ctxUsed)}
                    <span className="ctx-of"> / {formatTokens(ctxTotal)}</span>
                  </div>
                  <div className={`ctx-bar ${ctxPct >= 85 ? "hi" : ctxPct >= 60 ? "mid" : ""}`}>
                    <div className="ctx-bar-fill" style={{ width: `${Math.min(100, ctxPct)}%` }} />
                  </div>
                  <div className="ctx-rows">
                    <div className="ctx-row">
                      <span>已使用</span>
                      <b>{formatTokens(ctxUsed)}</b>
                    </div>
                    <div className="ctx-row">
                      <span>总上下文</span>
                      <b>{formatTokens(ctxTotal)}</b>
                    </div>
                    <div className="ctx-row">
                      <span>剩余</span>
                      <b>{formatTokens(ctxRemaining)}</b>
                    </div>
                  </div>
                </>
              ) : (
                <div className="ctx-empty">暂无上下文数据</div>
              )}
            </div>
          )}
        </div>
        <button className="iconbtn" title="切换工作文件夹" onClick={() => switchThreadFolder(activeThreadId)}>
          <Folder size={15} />
        </button>
        <button className="iconbtn" title="新会话" onClick={() => newSessionInThread(activeThreadId)}>
          <Refresh size={15} />
        </button>
        <button className="iconbtn" title="切换预览" onClick={togglePreview}>
          <PanelRight size={16} />
        </button>
      </div>

      <div className="chat-stage">
        <div className="chat-scroll" ref={scrollRef}>
          <div className="messages">
            {headGroups.map((g) => (
              <MessageGroup key={g.key} threadId={activeThreadId} group={g} toolRuns={thread.toolRuns} locked={thread.isStreaming} onPreviewImage={setPreviewImage} />
            ))}
            {streaming && streamingExtends && lastGroup && (
              <MessageGroup
                key={lastGroup.key}
                threadId={activeThreadId}
                group={{ key: lastGroup.key, role: "assistant", items: [...lastGroup.items, streaming] }}
                toolRuns={thread.toolRuns}
                locked
                streaming
                onPreviewImage={setPreviewImage}
              />
            )}
            {streaming && !streamingExtends && (
              <MessageGroup
                key={streaming.key}
                threadId={activeThreadId}
                group={{ key: streaming.key, role: "assistant", items: [streaming] }}
                toolRuns={thread.toolRuns}
                locked
                streaming
                onPreviewImage={setPreviewImage}
              />
            )}
            {thread.error && (
              <div className="msg system">
                <div className="msg-body">⚠ {thread.error}</div>
              </div>
            )}
          </div>
        </div>
        {userGroups.length > 5 && (
          <UserMessageNav groups={userGroups} language={language} onJump={jumpToUserMessage} />
        )}
      </div>

      <div className="composer-confirmation-region" aria-live="assertive">
        <ExtUiPromptCard threadId={activeThreadId} />
      </div>
      <Composer threadId={activeThreadId} />
      {previewImage && (
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onMouseDown={() => setPreviewImage(null)}>
          <button className="image-lightbox-close" title="关闭" onClick={() => setPreviewImage(null)}>×</button>
          <img src={previewImage} alt="图片预览" onMouseDown={(e) => e.stopPropagation()} />
        </div>
      )}
    </section>
  );
}

/** Tool-run ids a message actually renders — for targeted re-render checks. */
function referencedRunIds(m: ViewMessage): string[] {
  if (!m.blocks) return [];
  const ids: string[] = [];
  for (const b of m.blocks) if (b.type === "toolCall") ids.push(b.id);
  return ids;
}

/** A visual turn: one user message, or a run of consecutive assistant messages
 *  (a whole agent round) rendered under a single avatar. */
interface MsgGroup {
  key: string;
  role: "user" | "assistant";
  items: ViewMessage[];
}

function groupMessages(messages: ViewMessage[]): MsgGroup[] {
  const groups: MsgGroup[] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    if (m.role === "assistant" && last && last.role === "assistant") {
      last.items.push(m);
    } else {
      groups.push({ key: m.key, role: m.role === "assistant" ? "assistant" : "user", items: [m] });
    }
  }
  return groups;
}

function userMessagePreview(group: MsgGroup, language: string): string {
  const text = (group.items[0]?.text || "").replace(/\s+/g, " ").trim();
  if (!text) return language === "zh" ? "图片消息" : "Image message";
  const chars = Array.from(text);
  return chars.length > 20 ? `${chars.slice(0, 20).join("")}…` : text;
}

function UserMessageNav({
  groups,
  language,
  onJump,
}: {
  groups: MsgGroup[];
  language: string;
  onJump: (key: string) => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  const [hovered, setHovered] = useState<{ text: string; top: number } | null>(null);

  if (groups.length <= 5) return null;

  return (
    <nav
      ref={navRef}
      className="user-message-nav"
      aria-label={language === "zh" ? "用户消息导航" : "User message navigation"}
    >
      <div className="user-message-nav-scroll">
        {groups.map((group, index) => {
          const preview = userMessagePreview(group, language);
          return (
            <button
              key={group.key}
              type="button"
              className="user-message-nav-dot"
              aria-label={language === "zh" ? `跳转到第 ${index + 1} 条用户消息：${preview}` : `Jump to user message ${index + 1}: ${preview}`}
              title={preview}
              onClick={() => onJump(group.key)}
              onMouseEnter={(event) => {
                const nav = navRef.current;
                if (!nav) return;
                const navRect = nav.getBoundingClientRect();
                const dotRect = event.currentTarget.getBoundingClientRect();
                setHovered({ text: preview, top: dotRect.top - navRect.top + dotRect.height / 2 });
              }}
              onMouseLeave={() => setHovered(null)}
              onFocus={(event) => {
                const nav = navRef.current;
                if (!nav) return;
                const navRect = nav.getBoundingClientRect();
                const dotRect = event.currentTarget.getBoundingClientRect();
                setHovered({ text: preview, top: dotRect.top - navRect.top + dotRect.height / 2 });
              }}
              onBlur={() => setHovered(null)}
            >
              <span aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {hovered && <div className="user-message-nav-tooltip" style={{ top: hovered.top }}>{hovered.text}</div>}
    </nav>
  );
}

/**
 * Memoized on (group identity, streaming flag, and only the tool runs this
 * group references). Past groups are immutable in the store, so during
 * streaming only the live group re-renders — not the whole history.
 */
const MessageGroup = memo(MessageGroupInner, (prev, next) => {
  if (
    prev.group !== next.group ||
    prev.threadId !== next.threadId ||
    prev.locked !== next.locked ||
    !!prev.streaming !== !!next.streaming
    || prev.onPreviewImage !== next.onPreviewImage
  ) {
    return false;
  }
  for (const m of prev.group.items) {
    for (const id of referencedRunIds(m)) {
      if (prev.toolRuns[id] !== next.toolRuns[id]) return false;
    }
  }
  return true;
});

function MessageGroupInner({
  threadId,
  group,
  toolRuns,
  locked,
  streaming,
  onPreviewImage,
}: {
  threadId: string;
  group: MsgGroup;
  toolRuns: Record<string, ToolRun>;
  locked?: boolean;
  streaming?: boolean;
  onPreviewImage: (src: string) => void;
}) {
  const forkThreadFromAgentReply = useStore((s) => s.forkThreadFromAgentReply);
  const cloneThread = useStore((s) => s.cloneThread);
  const openPreview = useStore((s) => s.openPreview);
  const cwd = useStore((s) => s.threads[threadId]?.cwd || "");
  const language = useStore((s) => s.config?.language || "en");
  const [branching, setBranching] = useState<"fork" | "clone" | null>(null);
  const artifacts = useMemo(
    () => (group.role === "assistant" ? collectFileArtifacts(group.items, toolRuns, cwd) : []),
    [cwd, group.items, group.role, toolRuns],
  );
  const artifactCheckKey = useMemo(() => {
    const paths = artifacts.map((artifact) => artifact.path.toLowerCase()).join("|");
    const toolStates = group.items
      .flatMap((message) => (message.blocks || []).filter((block) => block.type === "toolCall"))
      .map((block) => {
        const run = toolRuns[block.id];
        return `${block.id}:${run?.running ? "running" : run?.completed ? "done" : "pending"}:${run?.isError ? "error" : "ok"}`;
      })
      .join("|");
    return `${paths}::${toolStates}`;
  }, [artifacts, group.items, toolRuns]);
  const [artifactExists, setArtifactExists] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    if (!artifacts.length) {
      setArtifactExists({});
      return () => {
        cancelled = true;
      };
    }
    void Promise.all(
      artifacts.map(async (artifact) => {
        const key = artifact.path.toLowerCase();
        try {
          const exists = await window.pi.app.fileExists(artifact.path);
          return [key, !!exists] as const;
        } catch {
          // Keep the historical artifact visible when an existence probe is
          // unavailable; the click handler will perform the same safe check.
          return [key, true] as const;
        }
      }),
    ).then((results) => {
      if (!cancelled) setArtifactExists(Object.fromEntries(results));
    });
    return () => {
      cancelled = true;
    };
  }, [artifactCheckKey]);

  const visibleArtifacts = artifacts.filter((artifact) => artifactExists[artifact.path.toLowerCase()] !== false);

  if (group.role === "user") {
    const m = group.items[0];
    const skillBlock = m.text ? parseSkillBlock(m.text) : null;
    return (
      <div className="msg user" data-user-message-key={group.key}>
        <div className="msg-user-stack">
          <div className="msg-body">
            {m.sendKind && (
              <div className={`msg-kind ${m.sendKind}`}>{m.sendKind === "steer" ? "steering" : "follow-up"}</div>
            )}
            {skillBlock ? (
              <>
                <SkillInvocation name={skillBlock.name} />
                {skillBlock.userMessage && <div className="msg-user-text msg-user-skill-request">{skillBlock.userMessage}</div>}
              </>
            ) : (
              m.text && <div className="msg-user-text">{m.text}</div>
            )}
            {m.images && m.images.length > 0 && (
              <div className="msg-user-imgs">
                {m.images.map((im, i) => (
                  <button key={i} className="msg-user-img-button" onClick={() => onPreviewImage(im.dataUrl)} title="图片预览">
                    <img className="msg-user-img" src={im.dataUrl} alt="attachment" />
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="msg-user-actions">
            <button
              disabled={!m.text}
              title="复制这条用户消息"
              onClick={() => m.text && navigator.clipboard?.writeText(m.text)}
            >
              <Copy size={11} /> 复制
            </button>
          </div>
        </div>
        <div className="msg-avatar" aria-label="用户">
          <span className="msg-user-character" aria-hidden="true">
            🧑
          </span>
        </div>
      </div>
    );
  }

  // Assistant round: ONE avatar shared by every assistant message in the group.
  const last = group.items[group.items.length - 1];
  const hasBlocks = group.items.some((m) => m.blocks && m.blocks.length > 0);
  const openArtifact = async (artifact: (typeof artifacts)[number]) => {
    try {
      const exists = await window.pi.app.fileExists(artifact.path);
      if (!exists) {
        setArtifactExists((current) => ({ ...current, [artifact.path.toLowerCase()]: false }));
        return;
      }
    } catch {
      // Fall through to the normal preview path if the probe is unavailable.
    }
    openPreview(artifact.path, cwd);
  };
  const runBranchAction = async (kind: "fork" | "clone") => {
    if (locked || branching || !last.branchEntryId) return;
    setBranching(kind);
    try {
      if (kind === "fork") await forkThreadFromAgentReply(threadId, last.branchEntryId);
      else await cloneThread(threadId, last.branchEntryId);
    } finally {
      setBranching(null);
    }
  };
  return (
    <div className="msg assistant">
      <div className="msg-avatar" aria-label="Pi Studio Agent">
        <img className="msg-app-icon" src={appIconUrl} alt="" />
      </div>
      <div className="msg-body">
        {renderAssistantBlocks(group.items, toolRuns)}
        {streaming && !hasBlocks && <span className="muted">思考中</span>}
        {streaming && <span className="streaming-dot" />}
        {last.errorMessage && <div style={{ color: "#c0392b", marginTop: 6 }}>{last.errorMessage}</div>}
        {visibleArtifacts.length > 0 && (
          <section className="msg-artifacts" aria-label={language === "zh" ? "文件产物" : "File outputs"}>
            <div className="msg-artifacts-head">
              <Files size={13} />
              <span>{language === "zh" ? "文件产物" : "File outputs"}</span>
              <span className="msg-artifacts-count">{visibleArtifacts.length}</span>
            </div>
            <div className="msg-artifacts-list">
              {visibleArtifacts.map((artifact) => (
                <button
                  key={artifact.path.toLowerCase()}
                  className="msg-artifact"
                  title={`${language === "zh" ? "在 Pi Studio 中查看" : "View in Pi Studio"} · ${artifact.path}`}
                  onClick={() => void openArtifact(artifact)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void window.pi.app.showFileContextMenu(artifact.path);
                  }}
                >
                  <span className="msg-artifact-icon" aria-hidden="true">
                    {artifact.ext ? artifact.ext.slice(1, 5).toUpperCase() : <Files size={14} />}
                  </span>
                  <span className="msg-artifact-copy">
                    <span className="msg-artifact-name">{artifact.name}</span>
                    <span className="msg-artifact-path">{artifact.displayPath}</span>
                  </span>
                  <span className={`msg-artifact-action ${artifact.action}`}>
                    {language === "zh"
                      ? artifact.action === "created"
                        ? "已生成"
                        : "已更新"
                      : artifact.action === "created"
                        ? "Created"
                        : "Updated"}
                  </span>
                  <PanelRight size={14} className="msg-artifact-open" />
                </button>
              ))}
            </div>
          </section>
        )}
        {!streaming && (
          <div className="msg-footer">
            {last.model && <span>{last.model}</span>}
            {last.timestamp && <span>{formatClock(last.timestamp)}</span>}
            <span className="msg-actions">
              <button title="Copy" onClick={() => navigator.clipboard?.writeText(plainOfGroup(group))}>
                <Copy size={12} />
              </button>
              <button title="Good">
                <ThumbUp size={12} />
              </button>
              <button title="Bad">
                <ThumbDown size={12} />
              </button>
            </span>
            <span className="msg-branch-actions" aria-label="从此 Agent 回复分支">
              <button
                disabled={locked || !!branching || !last.branchEntryId}
                title={last.branchEntryId ? "从这条 Agent 回复开始创建新分支" : "连接并保存会话后可 Fork"}
                onClick={() => runBranchAction("fork")}
              >
                <Branch size={11} /> {branching === "fork" ? "Forking…" : "Fork"}
              </button>
              <button
                disabled={locked || !!branching || !last.branchEntryId}
                title={last.branchEntryId ? "复制截至这条 Agent 回复的分支" : "连接并保存会话后可 Clone"}
                onClick={() => runBranchAction("clone")}
              >
                <Copy size={11} /> {branching === "clone" ? "Cloning…" : "Clone"}
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function plainOfGroup(g: MsgGroup): string {
  return g.items
    .map((m) =>
      (m.blocks || [])
        .map((b) => (b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : ""))
        .filter(Boolean)
        .join("\n\n")
    )
    .filter(Boolean)
    .join("\n\n");
}

function renderAssistantBlocks(items: ViewMessage[], toolRuns: Record<string, ToolRun>): ReactNode[] {
  const toolCount = items
    .flatMap((message) => message.blocks || [])
    .filter((block) => block.type === "toolCall")
    .length;
  let activityShown = false;
  const nodes: ReactNode[] = [];
  items.forEach((message) => {
    (message.blocks || []).forEach((block, index) => {
      const key = `${message.key}:${index}`;
      if (block.type === "toolCall" && !activityShown) {
        activityShown = true;
        nodes.push(
          <div className="tool-activity-summary" key={`${key}:activity`}>
            <span className="tool-activity-label">Tool activity</span>
            <span className="tool-activity-count">{toolCount} {toolCount === 1 ? "call" : "calls"}</span>
          </div>,
        );
      }
      nodes.push(<BlockView key={key} block={block} toolRuns={toolRuns} />);
    });
  });
  return nodes;
}

function BlockView({ block, toolRuns }: { block: ContentBlock; toolRuns: Record<string, ToolRun> }) {
  if (block.type === "text") return <Markdown text={block.text} />;
  if (block.type === "thinking") return <Thinking text={block.thinking} />;
  const run = toolRuns[block.id];
  return <ToolCard id={block.id} name={effectiveToolName(block.name, run)} run={run} />;
}

const SkillInvocation = memo(function SkillInvocation({ name }: { name: string }) {
  return (
    <div className="skill-invocation" role="status" aria-label={`skill: ${name}`}>
        <span className="skill-invocation-label">skill: {name}</span>
    </div>
  );
});

const Thinking = memo(function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const displayText = normalizeTranscriptText(text);
  return (
    <div className="thinking">
      <button className="thinking-toggle" onClick={() => setOpen((v) => !v)}>
        <span style={{ transform: open ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform .12s" }}>›</span>
        思考过程 · {displayText.length} 字
      </button>
      {open && (
        <div className="thinking-body">
          <Markdown text={displayText} />
        </div>
      )}
    </div>
  );
});

function effectiveToolName(blockName: string, run?: ToolRun): string {
  const runtimeName = typeof run?.name === "string" ? run.name.trim() : "";
  if (runtimeName && runtimeName.toLowerCase() !== "tool") return runtimeName;
  const fallbackName = typeof blockName === "string" ? blockName.trim() : "";
  return fallbackName || runtimeName || "tool";
}

type ToolStatus = "queued" | "running" | "done" | "error";

function toolStatus(run?: ToolRun): ToolStatus {
  if (!run) return "queued";
  if (run.running) return "running";
  if (run.isError) return "error";
  if (run.completed) return "done";
  return "queued";
}

function firstLine(value: unknown, maxLength = 120): string {
  const text = normalizeTranscriptText(value)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function toolSummary(name: string, run?: ToolRun): string {
  const args = parseToolArgs(run);
  const command = toolArg(args, ["command", "cmd", "script"]);
  if (typeof command === "string" && command.trim()) return firstLine(command);

  const path = toolArg(args, ["path", "filePath", "file_path", "filename", "file"]);
  if (typeof path === "string" && path.trim()) return normalizeTranscriptText(path);

  const result = run?.resultText ?? run?.partialText;
  const resultLine = firstLine(result);
  if (resultLine) return resultLine;

  if (args && Object.keys(args).length > 0) {
    const count = Object.keys(args).length;
    return `${count} argument${count === 1 ? "" : "s"}`;
  }
  if (run?.argsStr) return firstLine(run.argsStr);
  return name === "tool" ? "Waiting for tool data" : "";
}

function toolDuration(run?: ToolRun): string {
  if (!run?.startedAt) return "";
  const end = run.endedAt || Date.now();
  const seconds = Math.max(0, (end - run.startedAt) / 1000);
  return seconds < 1 ? "<1s" : `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

const ToolCard = memo(function ToolCard({ id, name, run }: { id: string; name: string; run?: ToolRun }) {
  const [open, setOpen] = useState(false);
  const running = run?.running;
  const argsView = renderToolArgs(name, run);
  const result = run?.resultText ?? run?.partialText ?? "";
  const status = toolStatus(run);
  const summary = toolSummary(name, run);
  const duration = toolDuration(run);
  const detailsId = `tool-details-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const showOutput = Boolean(run?.running || run?.completed || run?.isError || result);
  const emptyMessage = !run
    ? "Waiting for execution data"
    : running
      ? "Output will appear here while the tool runs"
      : "No output returned";
  return (
    <div className={`tool-card state-${status} ${open ? "is-open" : ""}`}>
      <button
        className="tool-head"
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ transform: open ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform .12s" }}>›</span>
        <span className="tool-name">{name}</span>
        {summary && <span className="tool-summary" title={summary}>{summary}</span>}
        <span className={`tool-status state-${status}`}>
          {running ? <span className="spinner" /> : status}
        </span>
        {duration && <span className="tool-duration">{duration}</span>}
      </button>
      {open && (
        <div className="tool-details" id={detailsId}>
          {argsView && (
            <section className="tool-section">
              <div className="tool-section-label">Arguments</div>
              <div className="tool-args">{argsView}</div>
            </section>
          )}
          {showOutput && (
            <section className="tool-section">
              <div className="tool-section-label">Output</div>
              {result ? (
                <div className={`tool-result ${run?.isError ? "err" : ""}`}>
                  <ToolCode text={normalizeTranscriptText(result)} language={languageForResult(name, run)} />
                </div>
              ) : (
                <div className="tool-empty compact">{emptyMessage}</div>
              )}
            </section>
          )}
          {!argsView && !showOutput && <div className="tool-empty">{emptyMessage}</div>}
        </div>
      )}
    </div>
  );
});

/**
 * Tool arguments arrive in two forms: a parsed object after toolcall_end, or
 * an escaped JSON fragment while the call is still streaming. Keep the
 * session data untouched and normalize only the visible representation.
 */
function normalizeTranscriptText(value: unknown): string {
  if (value == null) return "";
  let text = typeof value === "string" ? value : String(value);
  text = text.replace(/\r\n?/g, "\n");

  const trimmed = text.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") text = parsed.replace(/\r\n?/g, "\n");
    } catch {
      /* Keep the original text when it is not a complete JSON string. */
    }
  }

  // A partial toolcall or older transcript may still contain transport-level
  // escape sequences. Decode them only when there are no real line breaks, so
  // source code containing a literal "\\n" remains intact.
  if (!text.includes("\n") && /\\(?:r\\n|n|r|t|\")/.test(text)) {
    text = text
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"');
  }
  return text;
}

function parseToolArgs(run?: ToolRun): Record<string, unknown> | null {
  const candidate = run?.args;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    if (Object.keys(candidate).length > 0 || !run?.argsStr) return candidate as Record<string, unknown>;
  }

  const raw = typeof candidate === "string" ? candidate : run?.argsStr;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toolArg(args: Record<string, unknown> | null, names: string[]): unknown {
  if (!args) return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(args, name)) return args[name];
  }
  return undefined;
}

function matchesTool(name: string, names: string[]): boolean {
  const normalized = name.toLowerCase();
  return names.some((candidate) =>
    new RegExp(`(^|[-_:])${candidate}(?:$|[-_:])`, "i").test(normalized),
  );
}

function languageForPath(path: string): string | undefined {
  const ext = path.toLowerCase().split(/[./\\]/).pop() || "";
  const languages: Record<string, string> = {
    js: "javascript",
    jsx: "jsx",
    ts: "typescript",
    tsx: "tsx",
    json: "json",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    less: "less",
    py: "python",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    ps1: "powershell",
    psm1: "powershell",
    psd1: "powershell",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
    xml: "xml",
    sql: "sql",
    java: "java",
    go: "go",
    rs: "rust",
  };
  return languages[ext];
}

function languageForTool(name: string): string | undefined {
  if (matchesTool(name, ["python"])) return "python";
  if (matchesTool(name, ["powershell", "pwsh"])) return "powershell";
  if (matchesTool(name, ["bash", "shell", "sh", "zsh"])) return "bash";
  return undefined;
}

function languageForResult(name: string, run?: ToolRun): string | undefined {
  const toolLanguage = languageForTool(name);
  if (toolLanguage) return toolLanguage;
  const args = parseToolArgs(run);
  const path = toolArg(args, ["path", "filePath", "file_path", "filename", "file"]);
  return typeof path === "string" ? languageForPath(normalizeTranscriptText(path)) : undefined;
}

function codeFence(text: string, language?: string): string {
  const normalized = normalizeTranscriptText(text);
  const longest = Math.max(2, ...((normalized.match(/`+/g) || []).map((part) => part.length)));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language || ""}\n${normalized}${normalized.endsWith("\n") ? "" : "\n"}${fence}`;
}

function ToolCode({ text, language }: { text: string; language?: string }) {
  return <Markdown text={codeFence(text, language)} />;
}

function renderToolArgs(name: string, run?: ToolRun): ReactNode {
  if (!run) return null;
  const args = parseToolArgs(run);
  const command = toolArg(args, ["command", "cmd", "script"]);
  if (matchesTool(name, ["bash", "shell", "sh", "zsh", "exec", "execute", "command", "run", "python"])) {
    const text = typeof command === "string" ? normalizeTranscriptText(command) : typeof run.argsStr === "string" ? normalizeTranscriptText(run.argsStr) : "";
    return text ? <ToolCode text={text} language={languageForTool(name)} /> : null;
  }

  const isEdit = matchesTool(name, ["edit", "patch", "replace", "update"]);
  const isWrite = matchesTool(name, ["write", "create", "save", "export"]);
  if (isEdit || isWrite) {
    const path = normalizeTranscriptText(toolArg(args, ["path", "filePath", "file_path", "filename", "file"]));
    const oldText = normalizeTranscriptText(toolArg(args, ["oldText", "old_text", "old", "before", "original"]));
    const newText = normalizeTranscriptText(toolArg(args, ["newText", "new_text", "new", "after", "replacement", "content", "text"]));
    const patch = normalizeTranscriptText(toolArg(args, ["patch", "diff"]));
    const content = isEdit ? newText || patch : normalizeTranscriptText(toolArg(args, ["content", "text", "data", "newText", "new_text"]));
    const language = languageForPath(path);
    const sections: ReactNode[] = [];
    if (isEdit && oldText) {
      sections.push(
        <div className="tool-code-section" key="old">
          <div className="tool-code-label removed">原内容</div>
          <ToolCode text={oldText} language={language} />
        </div>,
      );
    }
    if (content) {
      sections.push(
        <div className="tool-code-section" key="new">
          <div className="tool-code-label">{isEdit ? "新内容" : "写入内容"}</div>
          <ToolCode text={content} language={language} />
        </div>,
      );
    }
    if (!sections.length && run.argsStr) {
      return <ToolCode text={normalizeTranscriptText(run.argsStr)} language="json" />;
    }
    if (!sections.length && !path) return null;
    return (
      <div className="tool-operation">
        <div className="tool-operation-title">{isEdit ? "编辑" : "写入"}{path ? ` · ${path}` : ""}</div>
        {sections}
      </div>
    );
  }

  if (args && Object.keys(args).length > 0) {
    let generic = "";
    try {
      generic = JSON.stringify(args, null, 2);
    } catch {
      generic = String(args);
    }
    return <ToolCode text={generic} language="json" />;
  }

  return run.argsStr ? <ToolCode text={normalizeTranscriptText(run.argsStr)} language="json" /> : null;
}
