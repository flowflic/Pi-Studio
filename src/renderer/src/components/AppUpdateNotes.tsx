import { Markdown } from "../lib/markdown";

/**
 * Release notes shown in Settings → Update once a newer app version is found.
 * The notes come from the GitHub release body, so they are rendered as
 * Markdown inside a bounded scroll area instead of being dumped as raw text.
 */
export function AppUpdateNotes({
  language,
  version,
  releaseName,
  releaseNotes,
  releaseDate,
  releaseUrl,
}: {
  language: "en" | "zh";
  version: string | null;
  releaseName?: string | null;
  releaseNotes?: string | null;
  releaseDate?: string | null;
  releaseUrl?: string | null;
}) {
  const zh = language === "zh";
  const parsedDate = releaseDate ? new Date(releaseDate) : null;
  const showDate = parsedDate && Number.isFinite(parsedDate.getTime());
  return (
    <div className="upd-notes" data-update-notes={version || ""}>
      <div className="upd-notes-head">
        <span className="upd-notes-title">
          {zh ? `v${version} 更新内容` : `What's new in v${version}`}
        </span>
        {showDate && (
          <span className="upd-notes-date">{parsedDate.toLocaleDateString(zh ? "zh-CN" : undefined)}</span>
        )}
      </div>
      {releaseName && releaseName !== `v${version}` && <div className="upd-notes-name">{releaseName}</div>}
      {releaseNotes ? (
        <div className="upd-notes-body">
          <Markdown text={releaseNotes} />
        </div>
      ) : (
        <div className="set-hint">
          {zh
            ? "该版本未附带更新说明，可打开 GitHub 发布页查看。"
            : "This release has no notes attached. Open the GitHub release to see the details."}
        </div>
      )}
      {releaseUrl && (
        <a className="upd-notes-link" href={releaseUrl} target="_blank" rel="noreferrer noopener">
          {zh ? "在 GitHub 查看完整发布说明 ↗" : "Read the full release notes on GitHub ↗"}
        </a>
      )}
    </div>
  );
}
