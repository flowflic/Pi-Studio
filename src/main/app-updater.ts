import { app } from "electron";
import { autoUpdater, type ProgressInfo, type UpdateCheckResult, type UpdateInfo } from "electron-updater";

const REPOSITORY = "flowflic/Pi-Studio";
const RELEASES_LATEST_URL = "https://github.com/" + REPOSITORY + "/releases/latest";

export type AppUpdateStage = "checking" | "downloading" | "ready" | "installing" | "error";

export interface AppUpdateProgress {
  stage: AppUpdateStage;
  message: string;
  /** 0..100 while electron-updater reports download progress. */
  pct?: number;
}

export interface AppUpdateStatus {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  source: "github" | null;
  releaseUrl: string | null;
  assetName: string | null;
  /** Whether this platform has a supported installer asset. */
  supported: boolean;
  /** Whether the current process can install and restart the packaged app. */
  installable: boolean;
  downloaded: boolean;
  error?: string;
}

export interface AppUpdateResult {
  ok: boolean;
  downloaded: boolean;
  version?: string | null;
  message: string;
}

let configured = false;
let latestUpdateInfo: UpdateInfo | null = null;
let downloadedVersion: string | null = null;
let lastUpdaterError: string | null = null;
let checkPromise: Promise<UpdateCheckResult | null> | null = null;
let downloadPromise: Promise<Array<string>> | null = null;
let progressSink: ((progress: AppUpdateProgress) => void) | null = null;

function normalizeVersion(raw: string): string {
  const value = String(raw || "").trim().replace(/^v/i, "");
  const match = /^(\d+(?:\.\d+){0,2})(?:[-+].*)?$/.exec(value);
  return match?.[1] || value;
}

function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = normalizeVersion(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const delta = (pa[i] || 0) - (pb[i] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function isWindowsInstallerSupported(): boolean {
  return process.platform === "win32";
}

function isPackagedInstallable(): boolean {
  return isWindowsInstallerSupported() && app.isPackaged;
}

function emitProgress(progress: AppUpdateProgress): void {
  try {
    progressSink?.(progress);
  } catch {
    // A renderer can disappear while the updater is still downloading.
    progressSink = null;
  }
}

function updateAssetName(info: UpdateInfo): string | null {
  const exeFile = info.files?.find((file) => /\.exe(?:$|\?)/i.test(file.url) && !/\.blockmap/i.test(file.url));
  const raw = info.path || exeFile?.url || "";
  if (!raw) return null;
  const withoutQuery = raw.split(/[?#]/, 1)[0];
  return decodeURIComponent(withoutQuery.split(/[\\/]/).pop() || withoutQuery);
}

function releaseUrl(version: string): string {
  return "https://github.com/" + REPOSITORY + "/releases/tag/v" + encodeURIComponent(version);
}

function isWindowsUpdateInfo(info: UpdateInfo): boolean {
  return Boolean(updateAssetName(info) && /\.exe$/i.test(updateAssetName(info) || ""));
}

function statusFromInfo(current: string, info: UpdateInfo): AppUpdateStatus {
  const latest = normalizeVersion(info.version);
  const supported = isWindowsInstallerSupported() && isWindowsUpdateInfo(info);
  const installable = supported && app.isPackaged;
  const hasUpdate = compareVersions(latest, current) > 0;

  return {
    current,
    latest,
    hasUpdate,
    source: "github",
    releaseUrl: releaseUrl(latest),
    assetName: updateAssetName(info),
    supported,
    installable,
    downloaded: downloadedVersion === latest,
    ...(lastUpdaterError ? { error: lastUpdaterError } : {}),
  };
}

function emptyStatus(current: string, error?: string): AppUpdateStatus {
  return {
    current,
    latest: null,
    hasUpdate: false,
    source: null,
    releaseUrl: RELEASES_LATEST_URL,
    assetName: null,
    supported: isWindowsInstallerSupported(),
    installable: isPackagedInstallable(),
    downloaded: false,
    ...(error ? { error } : {}),
  };
}

function configureUpdater(): void {
  if (configured) return;
  configured = true;

  // The settings page explicitly controls when to download/install.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = {
    info: (message?: unknown) => console.info("[electron-updater]", message),
    warn: (message?: unknown) => console.warn("[electron-updater]", message),
    error: (message?: unknown) => console.error("[electron-updater]", message),
  };

  autoUpdater.on("checking-for-update", () => {
    emitProgress({ stage: "checking", message: "正在检查 GitHub 发布页最新版本…" });
  });

  autoUpdater.on("update-available", (info) => {
    latestUpdateInfo = info;
    lastUpdaterError = null;
    const version = normalizeVersion(info.version);
    if (downloadedVersion && downloadedVersion !== version) downloadedVersion = null;
  });

  autoUpdater.on("update-not-available", (info) => {
    latestUpdateInfo = info;
    lastUpdaterError = null;
  });

  autoUpdater.on("download-progress", (info: ProgressInfo) => {
    const pct = Number.isFinite(info.percent) ? Math.max(0, Math.min(100, Math.round(info.percent))) : undefined;
    emitProgress({
      stage: "downloading",
      message: "正在下载 Pi Studio v" + normalizeVersion(latestUpdateInfo?.version || "") + "…",
      ...(pct === undefined ? {} : { pct }),
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    latestUpdateInfo = info;
    downloadedVersion = normalizeVersion(info.version);
    emitProgress({
      stage: "ready",
      message: "Pi Studio v" + downloadedVersion + " 已下载，可以安装并重启",
      pct: 100,
    });
  });

  autoUpdater.on("error", (error, message) => {
    lastUpdaterError = message || error?.message || String(error);
    emitProgress({ stage: "error", message: lastUpdaterError });
  });
}

async function checkWithUpdater(): Promise<UpdateCheckResult | null> {
  configureUpdater();
  if (checkPromise) return checkPromise;
  checkPromise = autoUpdater.checkForUpdates().finally(() => {
    checkPromise = null;
  });
  return checkPromise;
}

export async function checkForAppUpdate(): Promise<AppUpdateStatus> {
  configureUpdater();
  const current = normalizeVersion(app.getVersion());
  lastUpdaterError = null;
  latestUpdateInfo = null;

  if (!isPackagedInstallable()) {
    return emptyStatus(current);
  }

  try {
    const result = await checkWithUpdater();
    const info = result?.updateInfo || latestUpdateInfo;
    return info ? statusFromInfo(current, info) : emptyStatus(current, lastUpdaterError || undefined);
  } catch (error: any) {
    const message = error?.message || String(error);
    lastUpdaterError = message;
    return emptyStatus(current, message);
  }
}

export async function downloadAppUpdate(onProgress?: (progress: AppUpdateProgress) => void): Promise<AppUpdateResult> {
  configureUpdater();
  const previousSink = progressSink;
  progressSink = onProgress || null;
  lastUpdaterError = null;

  try {
    if (!isPackagedInstallable()) {
      throw new Error("当前环境不能自动安装应用更新，请使用已安装的 Pi Studio");
    }

    const result = await checkWithUpdater();
    const info = result?.updateInfo || latestUpdateInfo;
    if (!info) throw new Error("更新服务没有返回版本信息");

    latestUpdateInfo = info;
    const current = normalizeVersion(app.getVersion());
    const status = statusFromInfo(current, info);
    if (!status.hasUpdate) {
      return {
        ok: true,
        downloaded: false,
        version: status.current,
        message: "Pi Studio 已经是最新版本（v" + status.current + "）",
      };
    }
    if (!status.supported) throw new Error("更新服务没有返回 Windows 安装包");

    const version = normalizeVersion(info.version);
    if (downloadedVersion === version) {
      emitProgress({ stage: "ready", message: "Pi Studio v" + version + " 已下载，可以安装并重启", pct: 100 });
      return {
        ok: true,
        downloaded: true,
        version,
        message: "Pi Studio v" + version + " 已下载，可以安装并重启",
      };
    }

    emitProgress({ stage: "downloading", message: "正在下载 Pi Studio v" + version + "…", pct: 0 });
    if (!downloadPromise) {
      downloadPromise = autoUpdater.downloadUpdate().finally(() => {
        downloadPromise = null;
      });
    }
    await downloadPromise;

    if (downloadedVersion !== version) {
      throw new Error("更新下载完成但没有收到 update-downloaded 事件");
    }
    return {
      ok: true,
      downloaded: true,
      version,
      message: "Pi Studio v" + version + " 已下载，可以安装并重启",
    };
  } catch (error: any) {
    const message = error?.message || String(error);
    lastUpdaterError = message;
    emitProgress({ stage: "error", message });
    return { ok: false, downloaded: false, message: "Pi Studio 更新失败：" + message };
  } finally {
    if (progressSink === onProgress) progressSink = previousSink;
  }
}

export function installAppUpdate(): AppUpdateResult {
  configureUpdater();
  if (!downloadedVersion) {
    return { ok: false, downloaded: false, message: "请先下载应用更新" };
  }
  if (!isPackagedInstallable()) {
    return {
      ok: false,
      downloaded: true,
      version: downloadedVersion,
      message: "当前环境不能自动安装应用更新",
    };
  }

  const version = downloadedVersion;
  lastUpdaterError = null;
  emitProgress({ stage: "installing", message: "正在安装 Pi Studio v" + version + "，应用将自动重启" });
  try {
    // electron-updater invokes the NSIS updater, waits for this process to
    // exit, installs the downloaded package, and relaunches the app.
    autoUpdater.quitAndInstall(true, true);
    if (lastUpdaterError) {
      return { ok: false, downloaded: true, version, message: "启动安装程序失败：" + lastUpdaterError };
    }
    return {
      ok: true,
      downloaded: true,
      version,
      message: "正在安装 Pi Studio v" + version + "，应用将自动重启",
    };
  } catch (error: any) {
    const message = error?.message || String(error);
    lastUpdaterError = message;
    emitProgress({ stage: "error", message });
    return { ok: false, downloaded: true, version, message: "启动安装程序失败：" + message };
  }
}
