import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import type { SkillHubDetail, SkillHubSkill, SkillInfo } from "../lib/types";
import { Markdown } from "../lib/markdown";
import { AppStore, Check, Close, Plus, At, Refresh, Search } from "./icons";

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`set-toggle ${checked ? "on" : ""}`} aria-checked={checked} role="switch" onClick={() => onChange(!checked)}>
      <span className="set-toggle-knob" />
    </button>
  );
}

const KIND_LABEL: Record<string, string> = { npm: "npm", git: "git", local: "Local" };

function formatInstalls(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return new Intl.NumberFormat().format(value);
}

function skillKey(skill: SkillHubSkill): string {
  return `${skill.source}@${skill.skillId}`.toLowerCase();
}

function skillIsInstalled(skill: SkillHubSkill, installed: SkillInfo[], overrides: Set<string>): boolean {
  return overrides.has(skillKey(skill)) || installed.some((item) => item.name.toLowerCase() === skill.skillId.toLowerCase());
}

function SkillsHubPanel({ installedSkills, language }: { installedSkills: SkillInfo[]; language: "en" | "zh" }) {
  const installSkill = useStore((s) => s.installSkill);
  const zh = language === "zh";
  const [query, setQuery] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [results, setResults] = useState<SkillHubSkill[]>([]);
  const [selected, setSelected] = useState<SkillHubSkill | null>(null);
  const [detail, setDetail] = useState<SkillHubDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [installedOverrides, setInstalledOverrides] = useState<Set<string>>(() => new Set());
  const detailRequest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const items: SkillHubSkill[] = query.trim()
          ? await window.pi.plugins.searchSkillsHub(query.trim())
          : await window.pi.plugins.getSkillsHubLeaderboard();
        if (!cancelled) setResults([...items].sort((a, b) => b.installs - a.installs));
      } catch (e: any) {
        if (!cancelled) {
          setResults([]);
          setError(e?.message || (zh ? "无法加载 skills.sh 目录" : "Unable to load the skills.sh directory"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, query.trim() ? 260 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, refreshToken, zh]);

  const selectSkill = async (skill: SkillHubSkill) => {
    const request = ++detailRequest.current;
    setSelected(skill);
    setDetail(null);
    setDetailLoading(true);
    try {
      const payload: SkillHubDetail = await window.pi.plugins.getSkillDetails(skill);
      if (request === detailRequest.current) setDetail(payload);
    } catch (e: any) {
      if (request === detailRequest.current) {
        setDetail({
          ...skill,
          description: e?.message || (zh ? "详情加载失败" : "Unable to load skill details"),
          files: [],
          hash: null,
          installCommand: `npx skills add ${skill.source}@${skill.skillId} --agent pi --global --yes --copy`,
        });
      }
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  };

  const install = async (skill: SkillHubSkill) => {
    const key = skillKey(skill);
    if (installing || skillIsInstalled(skill, installedSkills, installedOverrides)) return;
    setInstalling(key);
    try {
      const ok = await installSkill(skill);
      if (ok) setInstalledOverrides((current) => new Set(current).add(key));
    } finally {
      setInstalling(null);
    }
  };

  const selectedInstalled = selected ? skillIsInstalled(selected, installedSkills, installedOverrides) : false;

  return (
    <div className="skills-hub-body">
      <div className="skills-hub-intro">
        <div>
          <div className="skills-hub-kicker">{zh ? "公开目录" : "PUBLIC DIRECTORY"}</div>
          <div className="skills-hub-copy">
            {zh ? "从 skills.sh 浏览公开技能，默认按下载量排序。" : "Browse public skills from skills.sh, ranked by installs by default."}
          </div>
        </div>
        <a className="skills-hub-link" href="https://skills.sh/" target="_blank" rel="noreferrer noopener">
          skills.sh ↗
        </a>
      </div>

      <div className="skills-hub-toolbar">
        <div className="plugins-search skills-hub-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={zh ? "搜索公开技能" : "Search public skills"}
            aria-label={zh ? "搜索公开技能" : "Search public skills"}
          />
          {query && (
            <button type="button" className="plugins-search-clear" onClick={() => setQuery("")} aria-label={zh ? "清除搜索" : "Clear search"}>
              ×
            </button>
          )}
        </div>
        <button
          className="set-iconbtn"
          onClick={() => setRefreshToken((value) => value + 1)}
          disabled={loading}
          title={zh ? "刷新 skills.sh 目录" : "Refresh skills.sh directory"}
        >
          {loading ? <span className="spinner" /> : <Refresh size={15} />}
        </button>
      </div>

      {error && <div className="skills-hub-error">{error}</div>}
      <div className="skills-hub-layout">
        <section className="skills-hub-results" aria-label={zh ? "技能搜索结果" : "Skill search results"}>
          <div className="skills-hub-section-head">
            <span>{query.trim() ? (zh ? "搜索结果" : "SEARCH RESULTS") : zh ? "按下载量排序" : "ALL-TIME DOWNLOADS"}</span>
            <span className="skills-hub-count">{loading ? "…" : results.length}</span>
          </div>
          {!loading && results.length === 0 && <div className="set-empty-mini">{zh ? "没有匹配的公开技能。" : "No public skills matched your search."}</div>}
          {results.map((skill) => {
            const installed = skillIsInstalled(skill, installedSkills, installedOverrides);
            const active = selected?.id === skill.id;
            const key = skillKey(skill);
            return (
              <div
                className={`skills-hub-card${active ? " active" : ""}`}
                key={skill.id}
                role="button"
                tabIndex={0}
                onClick={() => selectSkill(skill)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectSkill(skill);
                  }
                }}
              >
                <div className="skills-hub-card-main">
                  <div className="skills-hub-card-title">
                    <span className="skills-hub-card-name">{skill.name}</span>
                    {installed && <span className="skills-hub-installed-label">{zh ? "已安装" : "Installed"}</span>}
                  </div>
                  <div className="skills-hub-card-source" title={skill.source}>
                    {skill.source}
                  </div>
                  <div className="skills-hub-card-installs">{formatInstalls(skill.installs)} {zh ? "次下载" : "installs"}</div>
                </div>
                <button
                  type="button"
                  className={`skills-hub-install${installed ? " installed" : ""}`}
                  disabled={installed || installing === key}
                  onClick={(event) => {
                    event.stopPropagation();
                    install(skill);
                  }}
                  title={installed ? (zh ? "已安装" : "Installed") : zh ? "安装技能" : "Install skill"}
                  aria-label={installed ? (zh ? `已安装 ${skill.name}` : `${skill.name} installed`) : zh ? `安装 ${skill.name}` : `Install ${skill.name}`}
                >
                  {installing === key ? <span className="spinner" /> : installed ? <Check size={15} /> : <Plus size={15} />}
                </button>
              </div>
            );
          })}
        </section>

        <aside className="skills-hub-detail" aria-label={zh ? "技能详情" : "Skill details"}>
          {!selected && <div className="skills-hub-detail-empty">{zh ? "选择一个技能查看详情" : "Select a skill to view details"}</div>}
          {selected && (
            <>
              <div className="skills-hub-detail-head">
                <div>
                  <div className="skills-hub-detail-title">{selected.name}</div>
                  <div className="skills-hub-card-source">{selected.source}</div>
                </div>
                <button
                  type="button"
                  className={`skills-hub-detail-install${selectedInstalled ? " installed" : ""}`}
                  disabled={selectedInstalled || !!installing}
                  onClick={() => install(selected)}
                >
                  {installing === skillKey(selected) ? <span className="spinner" /> : selectedInstalled ? <Check size={14} /> : <Plus size={14} />}
                  {selectedInstalled ? (zh ? "已安装" : "Installed") : zh ? "安装" : "Install"}
                </button>
              </div>
              <div className="skills-hub-detail-meta">
                <span>{formatInstalls(selected.installs)} {zh ? "次下载" : "installs"}</span>
                <a href={selected.url} target="_blank" rel="noreferrer noopener">
                  {zh ? "查看 skills.sh" : "View on skills.sh"} ↗
                </a>
              </div>
              {detailLoading && <div className="skills-hub-detail-loading"><span className="spinner" /> {zh ? "加载详情…" : "Loading details…"}</div>}
              {detail && !detailLoading && (
                <div className="skills-hub-detail-scroll">
                  <p className="skills-hub-description">{detail.description}</p>
                  <div className="skills-hub-install-command">
                    <div className="skills-hub-mini-label">{zh ? "安装命令" : "INSTALL COMMAND"}</div>
                    <code>{detail.installCommand}</code>
                  </div>
                  {detail.files.length > 0 && (
                    <div className="skills-hub-files">
                      <div className="skills-hub-mini-label">{zh ? "文件" : "FILES"}</div>
                      {detail.files.map((file) => <div key={file.path} className="skills-hub-file">{file.path}</div>)}
                    </div>
                  )}
                  {detail.markdown && (
                    <div className="skills-hub-markdown">
                      <div className="skills-hub-mini-label">SKILL.md</div>
                      <Markdown text={detail.markdown} />
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

export function PluginsPanel() {
  const open = useStore((s) => s.pluginsOpen);
  const close = useStore((s) => s.closePlugins);
  const packages = useStore((s) => s.packages);
  const skills = useStore((s) => s.skills);
  const loading = useStore((s) => s.pluginsLoading);
  const togglePackage = useStore((s) => s.togglePackage);
  const installPackage = useStore((s) => s.installPackage);
  const removePackage = useStore((s) => s.removePackage);
  const updatePackages = useStore((s) => s.updatePackages);
  const loadPlugins = useStore((s) => s.loadPlugins);
  const toggleSkill = useStore((s) => s.toggleSkill);
  const language = useStore((s) => s.config?.language || "en");
  const zh = language === "zh";

  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [updatingAll, setUpdatingAll] = useState(false);
  const [updatingOne, setUpdatingOne] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hubOpen, setHubOpen] = useState(false);

  const dismiss = () => {
    setHubOpen(false);
    close();
  };

  const normalizedQuery = query.trim().toLowerCase();
  const filteredPackages = useMemo(
    () =>
      packages.filter((p) =>
        !normalizedQuery || [p.name, p.source, p.kind].some((value) => value.toLowerCase().includes(normalizedQuery)),
      ),
    [packages, normalizedQuery],
  );
  const filteredSkills = useMemo(
    () =>
      skills.filter((sk) =>
        !normalizedQuery || [sk.name, sk.path, sk.root].some((value) => value.toLowerCase().includes(normalizedQuery)),
      ),
    [skills, normalizedQuery],
  );

  if (!open) return null;

  const install = async () => {
    const s = source.trim();
    if (!s) return;
    setBusy(true);
    await installPackage(s);
    setBusy(false);
    setSource("");
  };

  const updating = updatingAll || updatingOne !== null;
  const updateAll = async () => {
    if (updating) return;
    setUpdatingAll(true);
    await updatePackages();
    setUpdatingAll(false);
  };
  const updateOne = async (src: string) => {
    if (updating) return;
    setUpdatingOne(src);
    await updatePackages(src);
    setUpdatingOne(null);
  };

  return (
    <div className="settings-backdrop" onMouseDown={dismiss}>
      <div className="plugins-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="plugins-head">
          <div className="plugins-head-title">
            <span className="set-brand-mark">
              {hubOpen ? <AppStore size={18} /> : <At size={18} />}
            </span>
            <div>
              <div className="set-brand-title">{hubOpen ? (zh ? "技能中心" : "Skills Hub") : zh ? "插件" : "Plugins"}</div>
              <div className="set-brand-sub">
                {hubOpen ? (zh ? "浏览并安装 skills.sh 公开技能" : "Browse and install public skills from skills.sh") : zh ? "管理 pi 的扩展包与技能" : "Manage Pi extension packages and skills"}
              </div>
            </div>
          </div>
          <div className="plugins-head-actions">
            {hubOpen ? (
              <button className="skills-hub-back" type="button" onClick={() => setHubOpen(false)}>
                ← {zh ? "插件" : "Plugins"}
              </button>
            ) : (
              <button className="skills-hub-entry" type="button" onClick={() => setHubOpen(true)}>
                <AppStore size={14} />
                {zh ? "技能中心" : "Skills Hub"}
              </button>
            )}
            <button className="set-iconbtn" title={zh ? "关闭" : "Close"} onClick={dismiss}>
              <Close size={16} />
            </button>
          </div>
        </header>

        {hubOpen ? <SkillsHubPanel installedSkills={skills} language={language} /> : <div className="plugins-body">
          <div className="muted plugins-note">
            {zh
              ? "开关写入 ~/.pi/agent/settings.json，与终端 pi 共享；显示 ~/.pi/agent/skills 和 ~/.agents/skills，Pi 目录同名技能优先。"
              : "Changes are written to ~/.pi/agent/settings.json and shared with terminal Pi. Pi Studio displays ~/.pi/agent/skills and ~/.agents/skills; Pi skills win duplicate names."}
          </div>

          <div className="plugins-toolbar">
            <div className="plugins-search">
              <Search size={15} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={zh ? "搜索插件或技能" : "Search plugins or skills"}
                aria-label={zh ? "搜索插件或技能" : "Search plugins or skills"}
              />
              {query && (
                <button type="button" className="plugins-search-clear" onClick={() => setQuery("")} aria-label={zh ? "清除搜索" : "Clear search"}>
                  ×
                </button>
              )}
            </div>
            <button className="set-iconbtn" onClick={() => loadPlugins()} disabled={loading} title={zh ? "刷新插件和技能" : "Refresh plugins and skills"}>
              {loading ? <span className="spinner" /> : <Refresh size={15} />}
            </button>
          </div>

          <section className="plugins-section">
            <div className="plugins-section-head plugins-section-head-row">
              <span>
                {zh ? "扩展包" : "Extensions"}（{filteredPackages.length}
                {normalizedQuery ? ` / ${packages.length}` : ""}）
              </span>
              <button className="set-btn" onClick={updateAll} disabled={updating || packages.length === 0} title={zh ? "检查并更新所有扩展（pi update --extensions）" : "Check and update all extensions (pi update --extensions)"}>
                {updatingAll ? <span className="spinner" /> : <Refresh size={13} />}
                {zh ? "更新全部" : "Update all"}
              </button>
            </div>

            <div className="plugins-install">
              <input
                className="set-input"
                placeholder={zh ? "安装来源，如 npm:@foo/bar、git:github.com/user/repo 或本地路径" : "Package source, such as npm:@foo/bar, git:github.com/user/repo, or a local path"}
                value={source}
                onChange={(e) => setSource(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && install()}
              />
              <button className="set-btn primary" onClick={install} disabled={busy || !source.trim()}>
                {busy ? <span className="spinner" /> : <Plus size={14} />} {zh ? "安装" : "Install"}
              </button>
            </div>

            {loading && packages.length === 0 && <div className="set-empty-mini">{zh ? "加载中…" : "Loading…"}</div>}
            {!loading && packages.length === 0 && <div className="set-empty-mini">{zh ? "尚未安装任何扩展包。" : "No extension packages installed."}</div>}
            {packages.length > 0 && filteredPackages.length === 0 && <div className="set-empty-mini">{zh ? "没有匹配的扩展包。" : "No matching extension packages."}</div>}
            {filteredPackages.map((p) => (
              <div className="plugins-row" key={p.source}>
                <div className="plugins-row-main">
                  <span className="plugins-row-name" title={p.source}>
                    {p.name}
                  </span>
                  <span className="plugins-kind">{p.kind === "local" ? (zh ? "本地" : KIND_LABEL[p.kind]) : KIND_LABEL[p.kind] || p.kind}</span>
                  {!p.enabled && <span className="plugins-off">{zh ? "已停用" : "Disabled"}</span>}
                </div>
                <div className="plugins-row-sub" title={p.source}>
                  {p.source}
                </div>
                <div className="plugins-row-actions">
                  <button
                    className="set-iconbtn"
                    title={zh ? "检查并更新此扩展" : "Check and update this extension"}
                    disabled={updating}
                    onClick={() => updateOne(p.source)}
                  >
                    {updatingOne === p.source ? <span className="spinner" /> : <Refresh size={13} />}
                  </button>
                  <Toggle checked={p.enabled} onChange={(v) => togglePackage(p.source, v)} />
                  <button
                    className="set-iconbtn danger"
                    title={zh ? "移除" : "Remove"}
                    onClick={() => {
                      const question = zh ? `移除包 “${p.name}”？` : `Remove package “${p.name}”?`;
                      if (window.confirm(question)) removePackage(p.source);
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </section>

          <section className="plugins-section">
            <div className="plugins-section-head">
              {zh ? "技能" : "Skills"} ({filteredSkills.length}
              {normalizedQuery ? ` / ${skills.length}` : ""})
            </div>
            {loading && skills.length === 0 && <div className="set-empty-mini">{zh ? "加载中…" : "Loading…"}</div>}
            {!loading && skills.length === 0 && <div className="set-empty-mini">{zh ? "未在 ~/.pi/agent/skills 或 ~/.agents/skills 目录发现独立技能。" : "No standalone skills found in ~/.pi/agent/skills or ~/.agents/skills."}</div>}
            {skills.length > 0 && filteredSkills.length === 0 && <div className="set-empty-mini">{zh ? "没有匹配的技能。" : "No matching skills."}</div>}
            {filteredSkills.map((sk) => (
              <div className="plugins-row" key={sk.path}>
                <div className="plugins-row-main">
                  <span className="plugins-row-name" title={sk.path}>
                    {sk.name}
                  </span>
                  {!sk.enabled && <span className="plugins-off">{zh ? "已停用" : "Disabled"}</span>}
                </div>
                <div className="plugins-row-sub" title={sk.path}>
                  {sk.path}
                </div>
                <div className="plugins-row-actions">
                  <Toggle checked={sk.enabled} onChange={(v) => toggleSkill(sk.path, v)} />
                </div>
              </div>
            ))}
            <div className="muted plugins-note">
              {zh
                ? "停用技能会将其入口文件重命名为 *.disabled（可逆）；新增文件后可点击右上角刷新。"
                : "Disabling a skill renames its entry file to *.disabled (reversible). Refresh after adding new files."}
            </div>
          </section>
        </div>}
      </div>
    </div>
  );
}
