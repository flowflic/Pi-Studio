import { readFileSync } from "node:fs";

/** Pi merges custom models into its built-in catalog. In Studio an explicit
 * models array is the user's selection, including when that array is empty.
 * Providers configured only for auth/URL overrides retain their full catalog.
 * Keep runtime metadata and availability; never invent unauthenticated models.
 */
export function visibleConfiguredModels<T extends { provider: string; id: string }>(models: T[], modelsPath: string): T[] {
  let providers: Record<string, { models?: { id: string }[] }>;
  try {
    providers = JSON.parse(readFileSync(modelsPath, "utf8")).providers;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) return models;
  } catch {
    return models;
  }

  const selections = new Map<string, Set<string>>();
  for (const [provider, definition] of Object.entries(providers)) {
    if (!Array.isArray(definition?.models)) continue;
    selections.set(provider, new Set(definition.models.map((model) => model?.id).filter((id) => typeof id === "string" && id.length > 0)));
  }
  return models.filter((model) => {
    const selected = selections.get(model.provider);
    return !selected || selected.has(model.id);
  });
}
