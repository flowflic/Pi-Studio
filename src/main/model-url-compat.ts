import type { ModelDef, ProviderDef } from "../renderer/src/lib/types";

const ANTHROPIC_API = "anthropic-messages";
const OPENAI_APIS = new Set(["openai-completions", "openai-responses"]);

/**
 * The settings UI deliberately presents one URL convention for OpenAI- and
 * Anthropic-compatible APIs: URLs end in `/v1`. Pi's Anthropic adapter is the
 * exception at runtime — its SDK appends `/v1/messages` itself, so its runtime
 * base URL must stop before `/v1`.
 */
function mapBaseUrl(baseUrl: string | undefined, api: ProviderDef["api"] | ModelDef["api"], runtime: boolean): string | undefined {
  if (typeof baseUrl !== "string") return baseUrl;
  const raw = baseUrl.trim();
  if (!raw || !/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) return raw || undefined;

  const needsV1 = api === ANTHROPIC_API || OPENAI_APIS.has(api || "");
  if (!needsV1) return raw;

  const match = raw.match(/^([^?#]*)([?#].*)?$/);
  if (!match) return raw;
  const path = match[1].replace(/\/+$/, "");
  const suffix = match[2] || "";
  const withoutV1 = path.replace(/\/v1$/i, "");
  const nextPath = api === ANTHROPIC_API && runtime ? withoutV1 : /\/v1$/i.test(path) ? path : `${path}/v1`;
  return `${nextPath || path}${suffix}`;
}

function mapModel(model: ModelDef, provider: ProviderDef, runtime: boolean): ModelDef {
  const providerApi = provider.api;
  const api = model.api ?? providerApi;
  const overridesProviderApi = model.api !== undefined && model.api !== providerApi;
  const inheritedBaseUrl = overridesProviderApi && typeof model.baseUrl !== "string" ? provider.baseUrl : undefined;
  const sourceBaseUrl = typeof model.baseUrl === "string" ? model.baseUrl : inheritedBaseUrl;
  if (typeof sourceBaseUrl !== "string") return model;
  const baseUrl = mapBaseUrl(sourceBaseUrl, api, runtime);
  if (baseUrl === model.baseUrl) return model;
  return { ...model, baseUrl };
}

function mapProvider(provider: ProviderDef, runtime: boolean): ProviderDef {
  const nextBaseUrl = mapBaseUrl(provider.baseUrl, provider.api, runtime);
  const nextModels = provider.models?.map((model) => mapModel(model, provider, runtime));
  const baseUrlChanged = nextBaseUrl !== provider.baseUrl;
  const modelsChanged = nextModels !== provider.models;
  if (!baseUrlChanged && !modelsChanged) return provider;
  return {
    ...provider,
    ...(baseUrlChanged ? { baseUrl: nextBaseUrl } : {}),
    ...(modelsChanged ? { models: nextModels } : {}),
  };
}

function mapProviders(providers: Record<string, ProviderDef> | undefined, runtime: boolean): Record<string, ProviderDef> {
  return Object.fromEntries(Object.entries(providers || {}).map(([id, provider]) => [id, mapProvider(provider, runtime)]));
}

/** Convert the settings/UI representation to the format consumed by Pi. */
export function toPiRuntimeProviders(providers: Record<string, ProviderDef> | undefined): Record<string, ProviderDef> {
  return mapProviders(providers, true);
}

/** Convert Pi's runtime representation to the URL convention shown in Settings. */
export function toSettingsProviders(providers: Record<string, ProviderDef> | undefined): Record<string, ProviderDef> {
  return mapProviders(providers, false);
}

/** Convert one unsaved provider before writing an isolated availability probe. */
export function toPiRuntimeProvider(provider: ProviderDef): ProviderDef {
  return mapProvider(provider, true);
}
