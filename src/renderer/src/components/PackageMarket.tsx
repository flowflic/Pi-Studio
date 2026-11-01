import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import type { PiMarketPackage, PiMarketPackageDetail, PluginPackage } from "../lib/types";
import { formatBytes, formatTokens } from "../lib/format";
import { AppStore, Check, Plus, Refresh, Search } from "./icons";

const PAGE_SIZE = 30;

const TYPE_LABEL: Record<string, string> = {
  extension: "extension",
  skill: "skill",
  prompt: "prompt",
  theme: "theme",
};

/** Full npm name for a package source such as `npm:@scope/name@1.2.3`. */
function npmNameOf(source: string): string | null {
  if (!source.startsWith("npm:")) return null;
  const spec = source.slice("npm:".length).trim();
  if (!spec) return null;
  const versionAt = spec.indexOf("@", 1);
  return versionAt > 0 ? spec.slice(0, versionAt) : spec;
}

function formatDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

export function PackageMarket({ packages, language }: { packages: PluginPackage[]; language: "en" | "zh" }) {
  const installPackage = useStore((s) => s.installPackage);
  const updatePackages = useStore((s) => s.updatePackages);
  const zh = language === "zh";
  const [query, setQuery] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [items, setItems] = useState<PiMarketPackage[]>([]);
  const [exhausted, setExhausted] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<PiMarketPackage | null>(null);
  const [detail, setDetail] = useState<PiMarketPackageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const detailCache = useRef(new Map<string, PiMarketPackageDetail>());

  const installed = useMemo(() => {
    const map = new Map<string, PluginPackage>();
    for (const item of packages) {
      const name = npmNameOf(item.source);
      if (name) map.set(name, item);
    }
    return map;
  }, [packages]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const page = await window.pi.plugins.searchPackageMarket({ query: query.trim(), from: 0, size: PAGE_SIZE });
        if (cancelled) return;
        setItems(page.items);
        setExhausted(page.exhausted);
      } catch (e: any) {
        if (cancelled) return;
        setItems([]);
        setExhausted(true);
        setError(e?.message || (zh ? "无法加载插件市场" : "Unable to load the package catalog"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, query.trim() ? 300 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, refreshToken, zh]);

  useEffect(() => {
    if (!selected) return;
    const cached = detailCache.current.get(selected.name);
    if (cached) {
      setDetail(cached);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailLoading(true);
    window.pi.plugins
      .getPackageMarketDetail(selected.name)
      .then((payload) => {
        if (cancelled) return;
        detailCache.current.set(payload.name, payload);
        setDetail(payload);
      })
      .catch((e: any) => {
        if (!cancelled) setError(e?.message || (zh ? "详情加载失败" : "Unable to load package details"));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, zh]);

  const loadMore = async () => {
    if (loading || loadingMore || exhausted) return;
    setLoadingMore(true);
    try {
      const page = await window.pi.plugins.searchPackageMarket({ query: query.trim(), from: items.length, size: PAGE_SIZE });
      setItems((current) => {
        const seen = new Set(current.map((item) => item.name));
        return [...current, ...page.items.filter((item) => !seen.has(item.name))];
      });
      setExhausted(page.exhausted);
    } catch (e: any) {
      setError(e?.message || (zh ? "加载更多失败" : "Unable to load more packages"));
    } finally {
      setLoadingMore(false);
    }
  };

  const run = async (item: PiMarketPackage, action: "install" | "update") => {
    if (busy) return;
    setBusy(item.name);
    try {
      if (action === "install") await installPackage(`npm:${item.name}`);
      else await updatePackages(`npm:${item.name}`);
    } finally {
      setBusy(null);
    }
  };

  const installedPackage = (item: PiMarketPackage) => installed.get(item.name);
  const installedVersion = detail && installed.get(detail.name)?.version;

  return (
    <div className="skills-hub-body">
      <div className="skills-hub-intro">
        <div>
          <div className="skills-hub-kicker">{zh ? "官方插件市场" : "OFFICIAL PACKAGE CATALOG"}</div>
          <div className="skills-hub-copy">
            {zh
              ? "浏览 pi.dev/packages 收录的扩展、技能、提示词与主题，默认按下载量排序。"
              : "Browse extensions, skills, prompts, and themes listed on pi.dev/packages, ranked by downloads."}
          </div>
        </div>
        <a className="skills-hub-link" href="https://pi.dev/packages" target="_blank" rel="noreferrer noopener">
          pi.dev/packages ↗
        </a>
      </div>

      <div className="skills-hub-toolbar">
        <div className="plugins-search skills-hub-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={zh ? "搜索插件名称或描述" : "Search package name or description"}
            aria-label={zh ? "搜索插件市场" : "Search the package catalog"}
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
          title={zh ? "刷新插件市场" : "Refresh the package catalog"}
        >
          {loading ? <span className="spinner" /> : <Refresh size={15} />}
        </button>
      </div>

      {error && <div className="skills-hub-error">{error}</div>}
      <div className="skills-hub-layout">
        <section className="skills-hub-results" aria-label={zh ? "插件市场结果" : "Package catalog results"}>
          <div className="skills-hub-section-head">
            <span>{query.trim() ? (zh ? "搜索结果" : "SEARCH RESULTS") : zh ? "按下载量排序" : "MOST DOWNLOADED"}</span>
            <span className="skills-hub-count">{loading ? "…" : items.length}</span>
          </div>
          {!loading && items.length === 0 && (
            <div className="set-empty-mini">{zh ? "没有匹配的插件。" : "No packages matched your search."}</div>
          )}
          {items.map((item) => {
            const pkg = installedPackage(item);
            const active = selected?.name === item.name;
            return (
              <div
                className={`skills-hub-card${active ? " active" : ""}`}
                key={item.name}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(item)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelected(item);
                  }
                }}
              >
                <div className="skills-hub-card-main">
                  <div className="skills-hub-card-title">
                    <span className="skills-hub-card-name">{item.name}</span>
                    {pkg && (
                      <span className="skills-hub-installed-label">
                        {zh ? "已安装" : "Installed"}
                        {pkg.version ? ` v${pkg.version}` : ""}
                      </span>
                    )}
                  </div>
                  <div className="pkg-market-desc">{item.description || (zh ? "无描述" : "No description")}</div>
                  <div className="skills-hub-card-installs">
                    v{item.version}
                    {item.author ? ` · ${item.author}` : ""} · {formatTokens(item.monthlyDownloads)} {zh ? "次/月" : "downloads/mo"}
                  </div>
                </div>
                {pkg ? (
                  <button
                    type="button"
                    className="skills-hub-install installed pkg-market-update"
                    disabled={busy === item.name}
                    onClick={(event) => {
                      event.stopPropagation();
                      run(item, "update");
                    }}
                    title={zh ? "更新到此版本" : "Update this package"}
                    aria-label={zh ? `更新 ${item.name}` : `Update ${item.name}`}
                  >
                    {busy === item.name ? <span className="spinner" /> : <Refresh size={14} />}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="skills-hub-install"
                    disabled={busy === item.name}
                    onClick={(event) => {
                      event.stopPropagation();
                      run(item, "install");
                    }}
                    title={zh ? "安装插件" : "Install package"}
                    aria-label={zh ? `安装 ${item.name}` : `Install ${item.name}`}
                  >
                    {busy === item.name ? <span className="spinner" /> : <Plus size={15} />}
                  </button>
                )}
              </div>
            );
          })}
          {!loading && !exhausted && items.length > 0 && (
            <button className="set-btn pkg-market-more" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? <span className="spinner" /> : null}
              {zh ? "加载更多" : "Load more"}
            </button>
          )}
        </section>

        <aside className="skills-hub-detail" aria-label={zh ? "插件详情" : "Package details"}>
          {!selected && <div className="skills-hub-detail-empty">{zh ? "选择一个插件查看详情" : "Select a package to view details"}</div>}
          {selected && (
            <>
              <div className="skills-hub-detail-head">
                <div className="skills-hub-detail-title">{selected.name}</div>
                {installed.get(selected.name) ? (
                  <button type="button" className="skills-hub-detail-install installed pkg-market-update" disabled={busy === selected.name} onClick={() => run(selected, "update")}>
                    {busy === selected.name ? <span className="spinner" /> : <Refresh size={14} />}
                    {zh ? "更新" : "Update"}
                  </button>
                ) : (
                  <button type="button" className="skills-hub-detail-install" disabled={busy === selected.name} onClick={() => run(selected, "install")}>
                    {busy === selected.name ? <span className="spinner" /> : <Plus size={14} />}
                    {zh ? "安装" : "Install"}
                  </button>
                )}
              </div>
              <div className="skills-hub-detail-meta">
                <span>
                  v{selected.version} · {formatTokens(selected.monthlyDownloads)} {zh ? "次/月" : "downloads/mo"}
                  {formatDate(selected.updatedAt) ? ` · ${formatDate(selected.updatedAt)}` : ""}
                </span>
                <a href={selected.piUrl} target="_blank" rel="noreferrer noopener">
                  {zh ? "查看 pi.dev" : "View on pi.dev"} ↗
                </a>
              </div>
              {detailLoading && (
                <div className="skills-hub-detail-loading">
                  <span className="spinner" /> {zh ? "加载详情…" : "Loading details…"}
                </div>
              )}
              {!detailLoading && (
                <div className="skills-hub-detail-scroll">
                  {selected.description && <p className="skills-hub-description">{selected.description}</p>}
                  {detail && detail.types.length > 0 && (
                    <div className="pkg-market-types">
                      {detail.types.map((type) => (
                        <span className="pkg-market-type" key={type}>
                          {TYPE_LABEL[type] || type}
                        </span>
                      ))}
                    </div>
                  )}
                  {detail?.deprecated && <div className="skills-hub-error">{detail.deprecated}</div>}
                  <div className="skills-hub-install-command">
                    <div className="skills-hub-mini-label">{zh ? "安装命令" : "INSTALL COMMAND"}</div>
                    <code>pi install npm:{selected.name}</code>
                  </div>
                  <div className="pkg-market-meta">
                    {installed.get(selected.name) && (
                      <div>
                        <span className="skills-hub-mini-label">{zh ? "已安装版本" : "INSTALLED"}</span>
                        <div>{installedVersion ? `v${installedVersion}` : installed.get(selected.name)?.version || "—"}</div>
                      </div>
                    )}
                    {detail?.license && (
                      <div>
                        <span className="skills-hub-mini-label">{zh ? "许可证" : "LICENSE"}</span>
                        <div>{detail.license}</div>
                      </div>
                    )}
                    {detail?.unpackedSize ? (
                      <div>
                        <span className="skills-hub-mini-label">{zh ? "体积" : "SIZE"}</span>
                        <div>{formatBytes(detail.unpackedSize)}</div>
                      </div>
                    ) : null}
                    {detail && (
                      <div>
                        <span className="skills-hub-mini-label">{zh ? "依赖" : "DEPENDENCIES"}</span>
                        <div>
                          {zh
                            ? `运行时 ${detail.dependencies.length} 个`
                            : `${detail.dependencies.length} runtime`}
                          {detail.peerDependencies.length
                            ? zh
                              ? ` · 同伴 ${detail.peerDependencies.length} 个`
                              : ` · ${detail.peerDependencies.length} peer`
                            : ""}
                        </div>
                      </div>
                    )}
                  </div>
                  {(detail?.repositoryUrl || selected.repositoryUrl) && (
                    <div className="skills-hub-files">
                      <div className="skills-hub-mini-label">{zh ? "源码" : "REPOSITORY"}</div>
                      <a className="skills-hub-link" href={detail?.repositoryUrl || selected.repositoryUrl} target="_blank" rel="noreferrer noopener">
                        {detail?.repositoryUrl || selected.repositoryUrl} ↗
                      </a>
                    </div>
                  )}
                  {!(detail?.repositoryUrl || selected.repositoryUrl) && selected.npmUrl && (
                    <div className="skills-hub-files">
                      <div className="skills-hub-mini-label">npm</div>
                      <a className="skills-hub-link" href={selected.npmUrl} target="_blank" rel="noreferrer noopener">
                        {selected.npmUrl} ↗
                      </a>
                    </div>
                  )}
                  <div className="skills-hub-files">
                    <div className="skills-hub-mini-label">{zh ? "状态" : "STATUS"}</div>
                    <div className="pkg-market-status">
                      {installed.get(selected.name) ? <Check size={13} /> : <AppStore size={13} />}
                      {installed.get(selected.name)
                        ? zh
                          ? "已安装，可在插件列表中停用或移除。"
                          : "Installed. Disable or remove it from the plugins list."
                        : zh
                          ? "尚未安装。"
                          : "Not installed yet."}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
