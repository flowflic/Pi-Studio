/**
 * One-paste setup for providers that Pi already ships a built-in model catalog
 * for (`docs/providers.md` in the Pi runtime). Selecting a preset only stores an
 * API key under the provider id in `models.json`; it never writes `baseUrl`,
 * `api` or a `models` list, so Pi keeps resolving the canonical endpoint and
 * its full catalog — including providers whose models use several wire
 * protocols and endpoints at once (OpenCode Zen/Go).
 *
 * Keep this file free of Node and DOM APIs: the main process, the preload
 * script and the renderer all import it.
 */

export type PresetApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

export type PresetRegion = "cn" | "global";

export interface LocalizedText {
  zh: string;
  en: string;
}

/** A provider Pi Studio can configure from an API key alone. */
export interface ProviderPreset {
  /** Stable preset id; also the data attribute used by the UI and tests. */
  id: string;
  /** Provider id recognised by the Pi runtime (`--provider <id>`). */
  provider: string;
  region: PresetRegion;
  label: LocalizedText;
  /** One line about the plan and the models it unlocks. */
  summary: LocalizedText;
  /** Canonical endpoint Pi uses; shown read-only, never written to models.json. */
  baseUrl: string;
  /** Wire protocol of the built-in catalog; omitted when a provider mixes APIs. */
  api?: PresetApi;
  /** Environment variable Pi reads when no stored key exists. */
  envVar: string;
  /** Console where the user creates a token, when known. */
  consoleUrl?: string;
  /** Representative built-in model ids, shown before the first save. */
  samples: string[];
  /** Model used by the connectivity probe (must exist in the built-in catalog). */
  testModel: string;
}

export const PRESET_REGIONS: { id: PresetRegion; label: LocalizedText }[] = [
  { id: "cn", label: { zh: "国内直连", en: "China mainland" } },
  { id: "global", label: { zh: "国际站", en: "International" } },
];

/**
 * Ordered by how often the plan is used for coding in Studio. Samples and
 * `testModel` mirror the catalog shipped with Pi 1.1.0; a newer runtime keeps
 * working because saving only writes the API key.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "zai-cn",
    provider: "zai-coding-cn",
    region: "cn",
    label: { zh: "智谱 GLM Coding Plan · 中国站", en: "Z.ai GLM Coding Plan · China" },
    summary: { zh: "open.bigmodel.cn 直连，使用 GLM Coding Plan 订阅令牌", en: "Direct open.bigmodel.cn access with a GLM Coding Plan token" },
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    api: "openai-completions",
    envVar: "ZAI_CODING_CN_API_KEY",
    consoleUrl: "https://bigmodel.cn",
    samples: ["glm-5.3", "glm-5.3-flash", "glm-5.3-highspeed", "glm-4.6v"],
    testModel: "glm-5.3",
  },
  {
    id: "qwen-token-plan-cn",
    provider: "qwen-token-plan-cn",
    region: "cn",
    label: { zh: "通义千问 Token 套餐 · 中国站", en: "Qwen Token Plan · China" },
    summary: { zh: "阿里云百炼 Token 套餐，含千问与第三方模型", en: "Alibaba Cloud Model Studio token plan with Qwen and third-party models" },
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    envVar: "QWEN_TOKEN_PLAN_CN_API_KEY",
    consoleUrl: "https://bailian.console.aliyun.com",
    samples: ["qwen3.8-max", "qwen3.7-max", "glm-5.3", "kimi-k2.6"],
    testModel: "qwen3.7-max",
  },
  {
    id: "minimax-cn",
    provider: "minimax-cn",
    region: "cn",
    label: { zh: "MiniMax Token Plan · 中国站", en: "MiniMax Token Plan · China" },
    summary: { zh: "api.minimaxi.com 直连，Chat 走 Anthropic 协议", en: "Direct api.minimaxi.com access over the Anthropic protocol" },
    baseUrl: "https://api.minimaxi.com/anthropic",
    api: "anthropic-messages",
    envVar: "MINIMAX_CN_API_KEY",
    consoleUrl: "https://platform.minimaxi.com",
    samples: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
    testModel: "MiniMax-M2.7",
  },
  {
    id: "deepseek",
    provider: "deepseek",
    region: "cn",
    label: { zh: "DeepSeek 开放平台", en: "DeepSeek Platform" },
    summary: { zh: "DeepSeek 官方 API，OpenAI 兼容协议", en: "Official DeepSeek API over the OpenAI-compatible protocol" },
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    envVar: "DEEPSEEK_API_KEY",
    consoleUrl: "https://platform.deepseek.com",
    samples: ["deepseek-v4-pro", "deepseek-flash"],
    testModel: "deepseek-v4-pro",
  },
  {
    id: "kimi-coding",
    provider: "kimi-coding",
    region: "cn",
    label: { zh: "Kimi For Coding", en: "Kimi For Coding" },
    summary: { zh: "Kimi 编码套餐，Anthropic 协议直连", en: "Kimi coding plan served over the Anthropic protocol" },
    baseUrl: "https://api.kimi.com/coding",
    api: "anthropic-messages",
    envVar: "KIMI_API_KEY",
    consoleUrl: "https://www.kimi.com/coding",
    samples: ["kimi-for-coding", "k3", "k3-256k", "kimi-for-coding-highspeed"],
    testModel: "kimi-for-coding",
  },
  {
    id: "moonshotai-cn",
    provider: "moonshotai-cn",
    region: "cn",
    label: { zh: "Moonshot / Kimi API · 中国站", en: "Moonshot / Kimi API · China" },
    summary: { zh: "按量计费 API，与 Kimi 编码套餐互补", en: "Pay-as-you-go API that complements the Kimi coding plan" },
    baseUrl: "https://api.moonshot.cn/v1",
    api: "openai-completions",
    envVar: "MOONSHOT_API_KEY",
    consoleUrl: "https://platform.moonshot.cn",
    samples: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6"],
    testModel: "kimi-k2.6",
  },
  {
    id: "xiaomi-token-plan-cn",
    provider: "xiaomi-token-plan-cn",
    region: "cn",
    label: { zh: "小米 MiMo Token 套餐 · 中国站", en: "Xiaomi MiMo Token Plan · China" },
    summary: { zh: "token-plan-cn.xiaomimimo.com，MiMo 系列模型", en: "token-plan-cn.xiaomimimo.com with the MiMo model family" },
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    api: "openai-completions",
    envVar: "XIAOMI_TOKEN_PLAN_CN_API_KEY",
    samples: ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro"],
    testModel: "mimo-v2.6-pro",
  },
  {
    id: "opencode-go",
    provider: "opencode-go",
    region: "global",
    label: { zh: "OpenCode Go", en: "OpenCode Go" },
    summary: { zh: "OpenCode 订阅网关，混合 Anthropic / OpenAI / Gemini 模型", en: "OpenCode subscription gateway with mixed Anthropic, OpenAI and Gemini models" },
    baseUrl: "https://opencode.ai/zen/go",
    envVar: "OPENCODE_API_KEY",
    consoleUrl: "https://opencode.ai",
    samples: ["kimi-k3", "glm-5.3", "deepseek-v4-pro", "qwen3.8-max"],
    testModel: "glm-5.3",
  },
  {
    id: "opencode-zen",
    provider: "opencode",
    region: "global",
    label: { zh: "OpenCode Zen", en: "OpenCode Zen" },
    summary: { zh: "OpenCode 模型市场，含 Claude、GPT、Grok 等", en: "OpenCode model marketplace including Claude, GPT and Grok" },
    baseUrl: "https://opencode.ai/zen",
    envVar: "OPENCODE_API_KEY",
    consoleUrl: "https://opencode.ai",
    samples: ["claude-sonnet-5", "gpt-5.5", "grok-4.7", "glm-5.3"],
    testModel: "glm-5.3",
  },
  {
    id: "zai-global",
    provider: "zai",
    region: "global",
    label: { zh: "智谱 GLM Coding Plan · 国际站", en: "Z.ai GLM Coding Plan · Global" },
    summary: { zh: "api.z.ai 直连，使用 GLM Coding Plan 订阅令牌", en: "Direct api.z.ai access with a GLM Coding Plan token" },
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    api: "openai-completions",
    envVar: "ZAI_API_KEY",
    consoleUrl: "https://z.ai",
    samples: ["glm-5.3", "glm-5.2", "glm-5.3-flash", "glm-4.7"],
    testModel: "glm-5.3",
  },
  {
    id: "qwen-token-plan",
    provider: "qwen-token-plan",
    region: "global",
    label: { zh: "通义千问 Token 套餐 · 国际站", en: "Qwen Token Plan · Global" },
    summary: { zh: "Model Studio 国际站 Token 套餐", en: "Model Studio international token plan" },
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    envVar: "QWEN_TOKEN_PLAN_API_KEY",
    samples: ["qwen3.8-max", "qwen3.7-max", "glm-5.3", "kimi-k2.6"],
    testModel: "qwen3.7-max",
  },
  {
    id: "qwen-token-plan-individual",
    provider: "qwen-token-plan-individual",
    region: "global",
    label: { zh: "通义千问 Token 套餐 · 个人版", en: "Qwen Token Plan · Individual" },
    summary: { zh: "个人订阅令牌，模型范围略窄于标准套餐", en: "Individual subscription token with a narrower model set" },
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    envVar: "QWEN_TOKEN_PLAN_API_KEY",
    samples: ["qwen3.8-max", "qwen3.7-max", "glm-5.2", "deepseek-v4-pro"],
    testModel: "qwen3.7-max",
  },
  {
    id: "minimax",
    provider: "minimax",
    region: "global",
    label: { zh: "MiniMax Token Plan · 国际站", en: "MiniMax Token Plan · Global" },
    summary: { zh: "api.minimax.io 直连，Chat 走 Anthropic 协议", en: "Direct api.minimax.io access over the Anthropic protocol" },
    baseUrl: "https://api.minimax.io/anthropic",
    api: "anthropic-messages",
    envVar: "MINIMAX_API_KEY",
    consoleUrl: "https://platform.minimax.io",
    samples: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
    testModel: "MiniMax-M2.7",
  },
  {
    id: "moonshotai",
    provider: "moonshotai",
    region: "global",
    label: { zh: "Moonshot / Kimi API · 国际站", en: "Moonshot / Kimi API · Global" },
    summary: { zh: "moonshot.ai 按量计费 API", en: "Pay-as-you-go API on moonshot.ai" },
    baseUrl: "https://api.moonshot.ai/v1",
    api: "openai-completions",
    envVar: "MOONSHOT_API_KEY",
    consoleUrl: "https://platform.moonshot.ai",
    samples: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6"],
    testModel: "kimi-k2.6",
  },
];

export function presetsForRegion(region: PresetRegion): ProviderPreset[] {
  return PROVIDER_PRESETS.filter((preset) => preset.region === region);
}

export function findProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** Provider ids a saved key can target; used by the main process to validate writes. */
export function presetProviderIds(): string[] {
  return [...new Set(PROVIDER_PRESETS.map((preset) => preset.provider))];
}
