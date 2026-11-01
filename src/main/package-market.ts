/**
 * Read the public Pi package catalog (https://pi.dev/packages).
 *
 * pi.dev lists npm packages that carry the `pi-package` keyword and exposes no
 * JSON API, so the catalog is read from the registry that feeds it: the npm
 * search endpoint for listings and each package's `latest` document for
 * details. Every item keeps a link back to its pi.dev page.
 */

import type { PiMarketPackage, PiMarketPackageDetail, PiMarketPage, PiPackageType } from "../renderer/src/lib/types";

const REGISTRY = "https://registry.npmjs.org";
const KEYWORD = "pi-package";
const REQUEST_TIMEOUT_MS = 12_000;
const SEARCH_TTL_MS = 3 * 60_000;
const DETAIL_TTL_MS = 10 * 60_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 60;
const MAX_QUERY_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 400;

interface CacheEntry<T> {
  expires: number;
  value: T;
}

const searchCache = new Map<string, CacheEntry<PiMarketPage>>();
const detailCache = new Map<string, CacheEntry<PiMarketPackageDetail>>();

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function trimmedDescription(value: unknown): string {
  const description = text(value).replace(/\s+/g, " ");
  return description.length > MAX_DESCRIPTION_LENGTH ? `${description.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…` : description;
}

function readLicense(value: unknown): string | undefined {
  const direct = text(value);
  if (direct) return direct;
  return text(asRecord(value).type) || undefined;
}

export function normalizeRepositoryUrl(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value : text(asRecord(value).url);
  if (!raw) return undefined;
  const url = raw
    .replace(/^git\+/, "")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "");
  return /^https?:\/\/\S+$/i.test(url) ? url : undefined;
}

/** npm package names only: optional scope, no spaces, no URL syntax. */
export function isPiPackageName(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 214 && /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(value);
}

function assertPackageName(value: string): string {
  const name = text(value);
  if (!isPiPackageName(name)) throw new Error(`Invalid package name: ${value}`);
  return name;
}

export function piPackageUrl(name: string): string {
  return `https://pi.dev/packages/${name}`;
}

export function npmPackageUrl(name: string): string {
  return `https://www.npmjs.com/package/${name}`;
}

/** Types declared by the package's `pi` manifest. */
export function typesFromManifest(manifest: unknown): PiPackageType[] {
  const pi = asRecord(manifest);
  const declared: Array<[PiPackageType, unknown]> = [
    ["extension", pi.extensions],
    ["skill", pi.skills],
    ["prompt", pi.prompts],
    ["theme", pi.themes],
  ];
  const types: PiPackageType[] = [];
  for (const [type, value] of declared) {
    const present = Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value.trim().length > 0 : !!value;
    if (present) types.push(type);
  }
  return types;
}

function hasPiKeyword(pkg: Record<string, any>): boolean {
  const keywords = Array.isArray(pkg.keywords) ? pkg.keywords : [];
  return keywords.some((keyword) => text(keyword).toLowerCase() === KEYWORD);
}

function authorOf(pkg: Record<string, any>): string | undefined {
  const publisher = text(asRecord(pkg.publisher).username) || text(asRecord(pkg.publisher).name);
  if (publisher) return publisher;
  const author = pkg.author;
  const direct = text(author) || text(asRecord(author).name);
  if (direct) return direct;
  const maintainers = Array.isArray(pkg.maintainers) ? pkg.maintainers : [];
  return text(asRecord(maintainers[0]).username) || text(asRecord(maintainers[0]).name) || undefined;
}

export function normalizeSearchResult(raw: unknown): PiMarketPackage | null {
  const result = asRecord(raw);
  const pkg = asRecord(result.package);
  const name = text(pkg.name);
  const version = text(pkg.version);
  if (!isPiPackageName(name) || !version || !hasPiKeyword(pkg)) return null;
  const links = asRecord(pkg.links);
  const downloads = asRecord(result.downloads);
  return {
    name,
    version,
    description: trimmedDescription(pkg.description),
    author: authorOf(pkg),
    license: readLicense(pkg.license),
    updatedAt: text(pkg.date) || undefined,
    monthlyDownloads: count(downloads.monthly),
    weeklyDownloads: count(downloads.weekly),
    repositoryUrl: normalizeRepositoryUrl(links.repository) || normalizeRepositoryUrl(pkg.repository),
    npmUrl: npmPackageUrl(name),
    piUrl: piPackageUrl(name),
  };
}

export function normalizePackageDetail(name: string, raw: unknown): PiMarketPackageDetail {
  const latest = asRecord(raw);
  const dist = asRecord(latest.dist);
  return {
    name: text(latest.name) || name,
    version: text(latest.version),
    description: trimmedDescription(latest.description),
    license: readLicense(latest.license),
    homepage: /^https?:\/\//i.test(text(latest.homepage)) ? text(latest.homepage) : undefined,
    repositoryUrl: normalizeRepositoryUrl(latest.repository),
    types: typesFromManifest(latest.pi),
    unpackedSize: count(dist.unpackedSize) || undefined,
    dependencies: Object.keys(asRecord(latest.dependencies)),
    peerDependencies: Object.keys(asRecord(latest.peerDependencies)),
    deprecated: text(latest.deprecated) || undefined,
  };
}

function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttl: number): void {
  if (cache.size >= 200) cache.clear();
  cache.set(key, { value, expires: Date.now() + ttl });
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`npm registry request failed (${response.status}) for ${url}`);
  }
  const length = count(response.headers.get("content-length"));
  if (length > MAX_RESPONSE_BYTES) throw new Error("npm registry response is too large");
  const body = await response.text();
  if (body.length > MAX_RESPONSE_BYTES) throw new Error("npm registry response is too large");
  return JSON.parse(body);
}

/** Search the catalog. An empty query lists the most downloaded packages. */
export async function searchPiMarketPackages(options: { query?: string; from?: number; size?: number } = {}): Promise<PiMarketPage> {
  const query = text(options.query).slice(0, MAX_QUERY_LENGTH);
  const from = clamp(options.from ?? 0, 0, 5000);
  const size = clamp(options.size ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const cacheKey = `${query.toLowerCase()}|${from}|${size}`;
  const cached = readCache(searchCache, cacheKey);
  if (cached) return cached;

  const searchText = query ? `keywords:${KEYWORD} ${query}` : `keywords:${KEYWORD}`;
  const payload = asRecord(await fetchJson(`${REGISTRY}/-/v1/search?text=${encodeURIComponent(searchText)}&size=${size}&from=${from}`));
  const raw = Array.isArray(payload.objects) ? payload.objects : [];
  const items = raw
    .map(normalizeSearchResult)
    .filter((item): item is PiMarketPackage => !!item)
    .sort((a, b) => b.monthlyDownloads - a.monthlyDownloads);

  const page: PiMarketPage = { items, from, exhausted: raw.length < size };
  writeCache(searchCache, cacheKey, page, SEARCH_TTL_MS);
  return page;
}

/** Metadata for one package, taken from its `latest` document. */
export async function getPiMarketPackageDetail(name: string): Promise<PiMarketPackageDetail> {
  const packageName = assertPackageName(name);
  const cached = readCache(detailCache, packageName);
  if (cached) return cached;

  const payload = await fetchJson(`${REGISTRY}/${encodeURIComponent(packageName)}/latest`);
  const detail = normalizePackageDetail(packageName, payload);
  if (!detail.version) throw new Error(`npm registry returned no version for ${packageName}`);
  writeCache(detailCache, packageName, detail, DETAIL_TTL_MS);
  return detail;
}
