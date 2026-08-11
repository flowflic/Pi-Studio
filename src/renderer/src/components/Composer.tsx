import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { modelShort } from "../lib/format";
import { reasoningLevelLabel } from "../lib/reasoning";
import { useOutsideClose } from "../lib/useOutsideClose";
import type { ModelInfo, PendingFile, PendingImage } from "../lib/types";
import { Plus, Paperclip, ImageIcon, Send, Stop, Smile, At, Shield, Edit, Zap, Folder, Search, Check, ChevronRight } from "./icons";

let _pid = 0;
const pid = () => `p${_pid++}`;

function fileToImage(file: File): Promise<PendingImage | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith("image/")) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const base64 = dataUrl.split(",")[1] || "";
      resolve({ id: pid(), dataUrl, base64, mimeType: file.type });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

export function Composer({ threadId }: { threadId: string }) {
  // Select only what the composer renders, as primitives / stable references.
  // Subscribing to the whole thread object made every streaming token
  // re-render the entire composer (textarea included).
  const isStreaming = useStore((s) => !!s.threads[threadId]?.isStreaming);
  const pending = useStore((s) => s.threads[threadId]?.pendingFollowUp || null);
  const injected = useStore((s) => s.threads[threadId]?.pendingEditorText);
  const permission = useStore((s) => s.threads[threadId]?.permission);
  const language = useStore((s) => s.config?.language || "en");
  const commands = useStore((s) => s.threads[threadId]?.commands);
  const models = useStore((s) => s.threads[threadId]?.models);
  const levels = useStore((s) => s.threads[threadId]?.levels);
  const model = useStore((s) => s.threads[threadId]?.model);
  const thinking = useStore((s) => s.threads[threadId]?.thinking);
  const cwd = useStore((s) => s.threads[threadId]?.cwd || "");
  const isDraftTask = useStore(
    (s) => !s.threads[threadId]?.messages.some((message) => message.role === "user" || message.role === "assistant"),
  );
  const projects = useStore((s) => s.projects);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const abortThread = useStore((s) => s.abortThread);
  const setModel = useStore((s) => s.setModel);
  const setThinking = useStore((s) => s.setThinking);
  const setPermission = useStore((s) => s.setPermission);
  const setPendingFollowUp = useStore((s) => s.setPendingFollowUp);
  const sendPendingSteering = useStore((s) => s.sendPendingSteering);
  const changeDraftThreadFolder = useStore((s) => s.changeDraftThreadFolder);

  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});
  const [cmdOpen, setCmdOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [permOpen, setPermOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const permRef = useRef<HTMLDivElement>(null);
  const cmdRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const projectRef = useRef<HTMLDivElement>(null);

  // close popups on outside click / Escape
  useOutsideClose(permRef, permOpen, () => setPermOpen(false));
  useOutsideClose(cmdRef, cmdOpen, () => setCmdOpen(false));
  useOutsideClose(modelRef, modelOpen, () => setModelOpen(false));
  useOutsideClose(projectRef, projectOpen, () => setProjectOpen(false));

  // extension-injected editor text
  const lastInjected = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (injected && injected !== lastInjected.current) {
      lastInjected.current = injected;
      setText(injected);
      requestAnimationFrame(() => taRef.current?.focus());
    }
  }, [injected]);

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
  };
  useEffect(autoGrow, [text]);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files;
    if (!dropped?.length) return;
    const imgs: PendingImage[] = [];
    const fs: PendingFile[] = [];
    for (const f of Array.from(dropped)) {
      if (f.type.startsWith("image/")) {
        const im = await fileToImage(f);
        if (im) imgs.push(im);
      } else {
        // dropped files have no reliable absolute path in renderer; read as image or skip
        const im = await fileToImage(f);
        if (im) imgs.push(im);
      }
    }
    setImages((p) => [...p, ...imgs]);
    setFiles((p) => [...p, ...fs]);
  };

  const addFiles = async () => {
    const paths = await window.pi.app.showOpenDialog("files");
    if (!paths || !Array.isArray(paths)) return;
    const names = paths.map((p) => p.split(/[\\/]/).pop() || p);
    setFiles((p) => [...p, ...paths.map((abs, i) => ({ abs, name: names[i] }))]);
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imgs: PendingImage[] = [];
    for (const it of Array.from(items)) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) {
          const im = await fileToImage(f);
          if (im) imgs.push(im);
        }
      }
    }
    if (imgs.length) {
      e.preventDefault();
      setImages((p) => [...p, ...imgs]);
    }
  };

  const send = async (mode?: "steer" | "followUp") => {
    const t = text.trim();
    if (!t && !images.length && !files.length) return;
    const imgs = images.map((im) => ({ data: im.base64, mimeType: im.mimeType }));
    const atts = files.map((f) => ({ abs: f.abs, name: f.name }));
    setText("");
    setImages([]);
    setFiles([]);
    await sendPrompt(threadId, t, imgs.length ? imgs : undefined, atts.length ? atts : undefined, mode);
  };

  // While streaming, Enter stages the message as a pending follow-up card
  // instead of sending it. It is delivered when the agent settles, unless the
  // user re-edits it or promotes it to steering first.
  const queuePending = () => {
    const t = text.trim();
    if (!t && !images.length && !files.length) return;
    if (pending) {
      // A follow-up is already staged; queue this one straight into pi.
      const imgs = images.map((im) => ({ data: im.base64, mimeType: im.mimeType }));
      const atts = files.map((f) => ({ abs: f.abs, name: f.name }));
      setText("");
      setImages([]);
      setFiles([]);
      sendPrompt(threadId, t, imgs.length ? imgs : undefined, atts.length ? atts : undefined, "followUp");
      return;
    }
    setPendingFollowUp(threadId, { text: t, images, files });
    setText("");
    setImages([]);
    setFiles([]);
  };

  const reEditPending = () => {
    if (!pending) return;
    setText(pending.text);
    setImages(pending.images);
    setFiles(pending.files);
    setPendingFollowUp(threadId, null);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      autoGrow();
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (slashMenuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((index) => (index + 1) % slashItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((index) => (index - 1 + slashItems.length) % slashItems.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && slashItems.length > 0) {
        e.preventDefault();
        chooseSlashCommand(slashItems[slashIndex] || slashItems[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isStreaming) {
        // Alt+Enter interrupts now (steering); Enter stages a pending follow-up.
        if (e.altKey) send("steer");
        else queuePending();
      } else {
        send();
      }
    }
  };

  const modelList = models || [];
  const modelGroups = useMemo(() => {
    const grouped = new Map<string, ModelInfo[]>();
    for (const item of modelList) {
      const providerModels = grouped.get(item.provider) || [];
      providerModels.push(item);
      grouped.set(item.provider, providerModels);
    }
    return Array.from(grouped, ([provider, providerModels]) => ({ provider, models: providerModels }));
  }, [modelList]);
  const levelList = (levels || []).filter((l) => l !== "off");
  const thinkLabel = thinking === "off" ? "" : reasoningLevelLabel(thinking, language);
  const mappedThinkingLevel = (level: string) => {
    const mapped = model?.thinkingLevelMap?.[level];
    return mapped && mapped !== level ? mapped : null;
  };
  const projectName = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd || "No project";
  const visibleProjects = projects.filter((project) => {
    const query = projectQuery.trim().toLowerCase();
    return !query || project.name.toLowerCase().includes(query) || project.cwd.toLowerCase().includes(query);
  });
  // A slash command may be typed after an existing prompt. Only inspect the
  // final whitespace-delimited token so ordinary text (and paths/URLs) does
  // not open the menu prematurely.
  const slashMatch = text.match(/(?:^|\s)\/([^\s]*)$/);
  const slashQuery = (slashMatch?.[1] || "").toLowerCase();
  const slashItems = useMemo(
    () =>
      (commands || [])
        .filter((command: any) => {
          const displayName = command.source === "skill" ? String(command.name).replace(/^skill:/, "") : String(command.name);
          return (
            !slashQuery ||
            displayName.toLowerCase().includes(slashQuery) ||
            (command.source !== "skill" && String(command.description || "").toLowerCase().includes(slashQuery))
          );
        })
        .slice(0, 30),
    [commands, slashQuery],
  );
  const commandItems = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    return (commands || [])
      .filter((command: any) => {
        const rawName = String(command.name || "");
        const displayName = command.source === "skill" ? rawName.replace(/^skill:/, "") : rawName;
        const haystack = [rawName, displayName, String(command.description || ""), String(command.source || "")]
          .join(" ")
          .toLowerCase();
        return !query || haystack.includes(query);
      })
      .slice(0, 50);
  }, [commands, commandQuery]);
  const slashMenuOpen = !!slashMatch && !slashDismissed && slashItems.length > 0;

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  const chooseSlashCommand = (command: any) => {
    // Replace only the current slash token and keep any prompt text before it.
    setText((current) => current.replace(/\/[^\s]*$/, `/${command.name} `));
    setSlashDismissed(true);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const toggleCommands = () => {
    setCmdOpen((open) => {
      if (open) setCommandQuery("");
      return !open;
    });
  };

  const chooseProject = async (nextCwd: string) => {
    setProjectOpen(false);
    setProjectQuery("");
    await changeDraftThreadFolder(threadId, nextCwd);
  };

  const chooseNewProject = async () => {
    const path = await window.pi.app.showOpenDialog("folder");
    if (!path || Array.isArray(path)) return;
    await chooseProject(path);
  };

  return (
    <div className="composer-wrap" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <div className="composer">
        {isDraftTask && !isStreaming && (
          <div className="composer-project-row" ref={projectRef}>
            <button
              className={`composer-project-pill ${projectOpen ? "open" : ""}`}
              onClick={() => setProjectOpen((value) => !value)}
              title={cwd}
              aria-haspopup="menu"
              aria-expanded={projectOpen}
            >
              <Folder size={14} />
              <span>{projectName}</span>
              <ChevronRight className="project-pill-caret" size={12} />
            </button>
            {projectOpen && (
              <div className="composer-project-menu" role="menu">
                <label className="project-menu-search">
                  <Search size={15} />
                  <input
                    autoFocus
                    value={projectQuery}
                    onChange={(event) => setProjectQuery(event.target.value)}
                    placeholder="搜索项目"
                  />
                </label>
                <div className="project-menu-list">
                  {visibleProjects.map((project) => {
                    const active = project.cwd.toLowerCase() === cwd.toLowerCase();
                    return (
                      <button
                        key={project.cwd}
                        className={`project-menu-option ${active ? "active" : ""}`}
                        onClick={() => chooseProject(project.cwd)}
                        role="menuitemradio"
                        aria-checked={active}
                        title={project.cwd}
                      >
                        <Folder size={16} />
                        <span>{project.name}</span>
                        {active && <Check className="project-menu-check" size={16} />}
                      </button>
                    );
                  })}
                  {visibleProjects.length === 0 && <div className="project-menu-empty">没有匹配的项目</div>}
                </div>
                <div className="project-menu-divider" />
                <button className="project-menu-new" onClick={chooseNewProject}>
                  <Plus size={16} />
                  <span>新建项目</span>
                </button>
              </div>
            )}
          </div>
        )}
        {slashMenuOpen && (
          <div className="slash-menu" role="listbox" aria-label="Slash commands">
            <div className="slash-menu-head">Commands, plugins &amp; skills</div>
            <div className="slash-menu-list">
              {slashItems.map((command: any, index: number) => {
                const isSkill = command.source === "skill";
                const displayName = isSkill ? String(command.name).replace(/^skill:/, "") : command.name;
                const kind = isSkill ? "Skill" : command.source === "extension" ? "Plugin" : "Prompt";
                return (
                  <button
                    key={`${command.source || "command"}:${command.name}`}
                    className={`slash-menu-item ${index === slashIndex ? "active" : ""}`}
                    role="option"
                    aria-selected={index === slashIndex}
                    onMouseEnter={() => setSlashIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseSlashCommand(command)}
                  >
                    <span className="slash-command-name">{displayName}</span>
                    <span className={`slash-command-kind ${command.source || "command"}`}>{kind}</span>
                    {!isSkill && command.description && (
                      <span className="slash-command-description">{command.description}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {(images.length > 0 || files.length > 0) && (
          <div className="composer-attachments">
            {images.map((im) => (
              <div key={im.id} className="attach-chip">
                <img src={im.dataUrl} alt="" />
                <span className="nm">image</span>
                <button className="rm" onClick={() => setImages((p) => p.filter((x) => x.id !== im.id))}>
                  ×
                </button>
              </div>
            ))}
            {files.map((f) => (
              <div key={f.abs} className="attach-chip">
                <span>📎</span>
                <span className="nm" title={f.abs}>
                  {f.name}
                </span>
                <button className="rm" onClick={() => setFiles((p) => p.filter((x) => x.abs !== f.abs))}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {pending && (
          <div className="pending-fu">
            <div className="pf-main">
              <div className="pf-label">
                <span className="pf-dot" />
                待处理 follow-up
                <span className="pf-sub">· 当前任务完成后自动发送</span>
              </div>
              <div className="pf-text">{pending.text || `${pending.images.length + pending.files.length} 个附件`}</div>
            </div>
            <div className="pf-actions">
              <button className="pf-btn" title="重新编辑" onClick={reEditPending}>
                <Edit size={14} />
              </button>
              <button className="pf-btn steer" title="立即 steering（尽快插入上下文执行）" onClick={() => sendPendingSteering(threadId)}>
                <Zap size={14} />
              </button>
            </div>
          </div>
        )}

        <div className="composer-input">
          <textarea
            ref={taRef}
            rows={1}
            placeholder={isStreaming ? "输入插话… Enter 存为待处理 follow-up（完成后发送），Alt+Enter 立即 steering（中断当前）" : "随心输入  ·  粘贴/拖拽图片  ·  + 添加文件"}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSlashDismissed(false);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>

        <div className="composer-bar">
          <div className="cb-left">
            <button className="iconbtn" title="Add files" onClick={addFiles}>
              <Plus size={17} />
            </button>
            <div className="pill perm-pill composer-optional-action" ref={permRef}>
              <button
                className={`pill-btn perm-btn ${permission === "full" ? "perm-full" : ""}`}
                title="权限级别：sandbox 仅自动放行明确只读的 shell 命令，并限制项目外写入；完全权限为 pi 默认 unrestricted 模式"
                onClick={() => setPermOpen((v) => !v)}
              >
                <Shield size={13} /> {permission === "full" ? "完全权限" : "sandbox"} ▾
              </button>
              {permOpen && (
                <div className="pill-pop perm-pop">
                  <button
                    className={`opt ${permission !== "full" ? "active" : ""}`}
                    onClick={() => {
                      setPermOpen(false);
                      setPermission(threadId, "sandbox");
                    }}
                  >
                    <span className="o1">sandbox</span>
                    <span className="o2">敏感命令执行前需确认（默认）</span>
                  </button>
                  <button
                    className={`opt ${permission === "full" ? "active" : ""}`}
                    onClick={() => {
                      setPermOpen(false);
                      setPermission(threadId, "full");
                    }}
                  >
                    <span className="o1">完全权限</span>
                    <span className="o2">pi 默认，不拦截任何操作</span>
                  </button>
                </div>
              )}
            </div>
            <div className="pill composer-optional-action" ref={cmdRef}>
              <button className="pill-btn" title="Slash commands / skills" onClick={toggleCommands}>
                <At size={14} /> 命令
              </button>
              {cmdOpen && (
                <div className="pill-pop command-pop">
                  <label className="command-search">
                    <Search size={13} />
                    <input
                      autoFocus
                      value={commandQuery}
                      onChange={(event) => setCommandQuery(event.target.value)}
                      placeholder="搜索命令、插件或 skill"
                      aria-label="搜索命令、插件或 skill"
                    />
                  </label>
                  <div className="command-list">
                    {(commands || []).length === 0 && <div className="ft-empty">无可用命令</div>}
                    {(commands || []).length > 0 && commandItems.length === 0 && <div className="ft-empty">没有匹配的命令</div>}
                    {commandItems.map((c: any) => (
                      <button
                        key={`${c.source || "command"}:${c.name}`}
                        className="opt"
                        onClick={() => {
                          setText((t) => (t ? t + " " : "") + `/${c.name} `);
                          setCommandQuery("");
                          setCmdOpen(false);
                          taRef.current?.focus();
                        }}
                      >
                        <span className="o1">{c.source === "skill" ? String(c.name).replace(/^skill:/, "") : c.name}</span>
                        {c.source !== "skill" && c.description && <span className="o2">{c.description}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="cb-right">
            <div className="pill composer-model-pill" ref={modelRef}>
              <button className="pill-btn" onClick={() => setModelOpen((v) => !v)} title="模型与思考等级">
                {modelShort(model)}
                {thinkLabel && <span className="pill-think-tag">{thinkLabel}</span>}
                <span className="pill-caret">▾</span>
              </button>
              {modelOpen && (
                <div className="pill-pop model-pop">
                  <div className="pop-head">模型</div>
                  {modelList.length === 0 && <div className="ft-empty">无可用模型（检查 auth）</div>}
                  {modelGroups.map((group) => {
                    const expanded = expandedProviders[group.provider] === true;
                    const active = model?.provider === group.provider;
                    return (
                      <div className={`model-provider-group ${expanded ? "expanded" : ""}`} key={group.provider}>
                        <button
                          type="button"
                          className={`model-provider-toggle ${active ? "active" : ""}`}
                          onClick={() =>
                            setExpandedProviders((current) => ({
                              ...current,
                              [group.provider]: !expanded,
                            }))
                          }
                          aria-expanded={expanded}
                        >
                          <ChevronRight className="model-provider-chevron" size={13} />
                          <span className="model-provider-name">{group.provider}</span>
                          <span className="model-provider-count">{group.models.length}</span>
                        </button>
                        {expanded && (
                          <div className="model-provider-models">
                            {group.models.map((m) => (
                              <button
                                type="button"
                                key={`${m.provider}/${m.id}`}
                                className={`opt ${model?.id === m.id && model?.provider === m.provider ? "active" : ""}`}
                                onClick={() => setModel(threadId, m.provider, m.id)}
                              >
                                <span className="o1">{m.name || m.id}</span>
                                <span className="o2">{m.id}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {levelList.length > 0 && (
                    <>
                      <div className="pop-divider" />
                      <div className="pop-head">思考等级</div>
                      <div className="think-chips">
                        {(["off", ...levelList] as string[]).map((l) => {
                          const mapped = mappedThinkingLevel(l);
                          return (
                            <button
                              key={l}
                              className={`think-chip ${thinking === l ? "active" : ""}`}
                              onClick={() => {
                                setThinking(threadId, l);
                                setModelOpen(false);
                              }}
                            >
                              <span>{reasoningLevelLabel(l, language)}</span>
                              {mapped && <span className="think-chip-map">→ {mapped}</span>}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {isStreaming ? (
              <>
                <button
                  className="send-btn"
                  title="存为待处理 follow-up（Enter）；Alt+Enter 立即 steering"
                  onClick={() => queuePending()}
                  disabled={!text.trim() && !images.length && !files.length}
                >
                  <Send size={15} />
                </button>
                <button className="send-btn stop" title="Stop" onClick={() => abortThread(threadId)}>
                  <Stop size={14} />
                </button>
              </>
            ) : (
              <button className="send-btn" title="Send" onClick={() => send()} disabled={!text.trim() && !images.length && !files.length}>
                <Send size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
