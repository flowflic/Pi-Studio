import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

type RiskLevel = "allow" | "approval" | "always";
type ShellDecision = {
  risk: RiskLevel;
  reason: string;
  reasonZh?: string;
  exactKey?: string;
  prefixKey?: string;
};

type HardRiskRule = {
  pattern: RegExp;
  reason: string;
  reasonZh: string;
};

const HARD_RISK_RULES: HardRiskRule[] = [
  {
    pattern: /\b(rm|rmdir|unlink|shred|remove-item|clear-item|clear-content)\b|(^|[\s&|;])(del|erase|rd)(?=\s|$)/i,
    reason: "A file or directory deletion command was detected. Deleted data may not be recoverable.",
    reasonZh: "检测到文件或目录删除命令，删除的数据可能无法恢复。",
  },
  {
    pattern: /\b(format|format-volume|mkfs(?:\.\w+)?|diskpart|dd|wipefs)\b/i,
    reason: "A disk formatting or raw disk-write command was detected. It can destroy an entire volume.",
    reasonZh: "检测到磁盘格式化或原始磁盘写入命令，可能破坏整个磁盘卷。",
  },
  {
    pattern: /\b(shutdown|reboot|halt|poweroff|restart-computer|stop-computer)\b/i,
    reason: "A system shutdown or restart command was detected.",
    reasonZh: "检测到关机或重启系统的命令。",
  },
  {
    pattern: /\b(stop-process|taskkill|kill)\b/i,
    reason: "A process termination command was detected. It may interrupt running work or services.",
    reasonZh: "检测到终止进程的命令，可能中断正在运行的任务或服务。",
  },
  {
    pattern: /\b(sudo|runas)\b/i,
    reason: "A privilege-elevation command was detected. It may run with administrator permissions.",
    reasonZh: "检测到提权命令，操作可能以管理员权限运行。",
  },
  {
    pattern: /\b(chmod|chown|takeown|icacls)\b/i,
    reason: "A file ownership or permission change was detected.",
    reasonZh: "检测到文件所有权或访问权限修改命令。",
  },
  {
    pattern: /\b(reg(?:\.exe)?\s+(add|delete)|sc(?:\.exe)?\s+(create|delete|config)|schtasks(?:\.exe)?\s+\/(create|delete)|net\s+(user|localgroup))\b/i,
    reason: "A Windows registry, service, scheduled-task, or user-account change was detected.",
    reasonZh: "检测到 Windows 注册表、服务、计划任务或用户账户修改。",
  },
  {
    pattern: /\bgit\s+(push|reset|clean|checkout|restore|rebase|merge|cherry-pick|commit|tag\s+-d|branch\s+-[dD])\b/i,
    reason: "A Git operation that can publish, rewrite, or discard repository state was detected.",
    reasonZh: "检测到可能发布、重写或丢弃仓库状态的 Git 操作。",
  },
  {
    pattern: /\b(npm|pnpm|yarn)\s+(publish|unpublish)\b/i,
    reason: "A package publishing operation was detected. It changes a public or remote registry.",
    reasonZh: "检测到包发布操作，它会修改公共或远程软件包仓库。",
  },
  {
    pattern: /-(encodedcommand|enc)\b/i,
    reason: "An encoded command was detected. Its actual operation is intentionally obscured.",
    reasonZh: "检测到编码命令，其真实操作内容被隐藏，无法可靠审查。",
  },
  {
    pattern: /\b(invoke-expression|iex)\b/i,
    reason: "Dynamic PowerShell expression execution was detected. The executed code cannot be classified reliably.",
    reasonZh: "检测到动态 PowerShell 表达式执行，无法可靠判断实际运行的代码。",
  },
  {
    pattern: /\b(cmd(?:\.exe)?\s+\/c|powershell(?:\.exe)?|pwsh(?:\.exe)?)\b/i,
    reason: "A nested command-shell invocation was detected. The child command may bypass normal inspection.",
    reasonZh: "检测到嵌套命令行解释器，子命令可能绕过常规风险检查。",
  },
  {
    pattern: /\b(?:bash|sh|zsh)\s+-c\b/i,
    reason: "An inline Unix shell script was detected. It can execute arbitrary shell operations.",
    reasonZh: "检测到内联 Unix Shell 脚本，它可以执行任意 Shell 操作。",
  },
  {
    pattern: /\bnode\s+-e\b/i,
    reason: "Inline Node.js code (`node -e`) was detected. It can execute arbitrary code and cannot be verified as read-only.",
    reasonZh: "检测到内联 Node.js（node -e），它可以执行任意代码，无法可靠确认仅执行只读操作。",
  },
  {
    pattern: /\bpython3?\s+-c\b/i,
    reason: "Inline Python code (`python -c`) was detected. It can execute arbitrary code and cannot be verified as read-only.",
    reasonZh: "检测到内联 Python（python -c），它可以执行任意代码，无法可靠确认仅执行只读操作。",
  },
  {
    pattern: /--(pre|ext-diff|textconv)\b/i,
    reason: "A Git external-command hook was detected. It can run code outside the apparent Git operation.",
    reasonZh: "检测到 Git 外部命令钩子，它可能执行表面 Git 操作之外的代码。",
  },
];

const FILE_MUTATION =
  /\b(set-content|out-file|add-content|new-item|copy-item|move-item|rename-item|mkdir|md|cp|mv|touch|tee)\b/i;
const NETWORK_COMMAND = /\b(curl|curl\.exe|wget|invoke-webrequest|irm|iwr)\b/i;
const NETWORK_WRITE = /(?:^|\s)(?:-x|--request)\s+(?:post|put|patch|delete)\b|(?:^|\s)(?:-d|--data(?:-\w+)?|-t|--upload-file)(?:\s|$)/i;

const READ_ONLY_SEGMENTS: RegExp[] = [
  /^(?:pwd|get-location|whoami|hostname)(?:\s+[^;&|<>]*)?$/i,
  /^(?:ls|dir|get-childitem|gci)(?:\s+[^;&|<>]*)?$/i,
  /^(?:cat|get-content|gc|type)(?:\s+[^;&|<>]*)?$/i,
  /^(?:rg|grep|findstr|select-string)(?:\s+[^;&|<>]*)?$/i,
  /^(?:where|where\.exe|which|get-command|test-path|resolve-path|get-item|get-process)(?:\s+[^;&|<>]*)?$/i,
  /^(?:select-object|sort-object|measure-object|format-table|format-list)(?:\s+[^;&|<>]*)?$/i,
  /^(?:head|tail|wc)(?:\s+[^;&|<>]*)?$/i,
  /^git\s+(?:status|diff|log|show|rev-parse|ls-files|grep|ls-tree|cat-file|describe|name-rev)(?:\s+[^;&|<>]*)?$/i,
  /^git\s+branch\s+--show-current(?:\s+[^;&|<>]*)?$/i,
  /^git\s+remote\s+(?:-v|get-url)(?:\s+[^;&|<>]*)?$/i,
  /^git\s+tag(?:\s+--list)?(?:\s+[^;&|<>]*)?$/i,
  /^git\s+config\s+(?:--get|--get-all|--list)(?:\s+[^;&|<>]*)?$/i,
  /^(?:node|npm|pnpm|yarn|python|python3|pi|git|rg)\s+(?:-v|--version|-h|--help)(?:\s+[^;&|<>]*)?$/i,
];

const SAFE_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "ask_question",
  "plan_question",
  "plan_complete",
  "plan_step_complete",
  "consult_advisor",
  "ask_llm",
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
]);
const SUBAGENT_TOOLS = new Set(["run_subagent", "resume_subagent", "convene_council"]);
const MUTATING_TOOL_NAME = /(?:^|[_-])(write|edit|create|update|delete|remove|send|upload|publish|execute|deploy)(?:[_-]|$)/i;

function cacheKey(command: string): string {
  return command.trim().replace(/[ \t]+/g, " ");
}

type ParsedShell = {
  segments: string[];
  separators: string[];
  hasRedirection: boolean;
  hasSubstitution: boolean;
  unterminatedQuote: boolean;
};

/**
 * Split shell control operators while preserving quoted text. This is not a
 * shell interpreter; ambiguous constructs remain approval-required. The key
 * safety property is that every segment must be classified in full.
 */
export function parseShellCommand(command: string): ParsedShell {
  const segments: string[] = [];
  const separators: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let hasRedirection = false;
  let hasSubstitution = false;

  const flush = (separator: string) => {
    if (current.trim()) segments.push(current.trim());
    current = "";
    separators.push(separator);
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const next = command[i + 1] || "";
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" || char === "`") {
      if (char === "`" && !quote) hasSubstitution = true;
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "$" && next === "(") {
      hasSubstitution = true;
      current += char;
      continue;
    }
    if (char === ">" || char === "<") {
      hasRedirection = true;
      current += char;
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && next === "\n") i++;
      flush("newline");
      continue;
    }
    if (char === ";" || char === "|" || char === "&") {
      const pair = char + next;
      if (pair === "||" || pair === "&&") i++;
      flush(pair === "||" || pair === "&&" ? pair : char);
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return { segments, separators, hasRedirection, hasSubstitution, unterminatedQuote: quote !== null };
}

function isReadOnlySegment(segment: string): boolean {
  const masked = maskQuotedLiterals(segment);
  if (HARD_RISK_RULES.some((rule) => rule.pattern.test(masked))) return false;
  return READ_ONLY_SEGMENTS.some((pattern) => pattern.test(masked));
}

function maskQuotedLiterals(value: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      out += quote ? " " : char;
      escaped = false;
      continue;
    }
    if (char === "\\" || char === "`") {
      escaped = true;
      out += quote ? " " : char;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      out += " ";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
}

function suggestedPrefix(command: string, parsed: ParsedShell): string | undefined {
  if (parsed.segments.length !== 1 || parsed.separators.length || parsed.hasRedirection || parsed.hasSubstitution) return undefined;
  const normalized = cacheKey(command);
  const npmRun = normalized.match(/^(npm|pnpm|yarn)\s+run\s+([^\s]+)/i);
  if (npmRun) return `${npmRun[1]} run ${npmRun[2]}`;
  const packageTask = normalized.match(/^(npm|pnpm|yarn)\s+(test|build|lint|typecheck)(?=\s|$)/i);
  if (packageTask) return `${packageTask[1]} ${packageTask[2]}`;
  const script = normalized.match(/^(python3?|node)\s+("[^"]+"|'[^']+'|[^\s]+\.(?:py|js|mjs|cjs|ts))(?=\s|$)/i);
  if (script) return `${script[1]} ${script[2]}`;
  return undefined;
}

export function classifyShellCommand(command: string): ShellDecision {
  const exactKey = cacheKey(command);
  if (!exactKey) return { risk: "allow", reason: "" };
  const parsed = parseShellCommand(command);
  const riskText = maskQuotedLiterals(command);

  if (parsed.unterminatedQuote) {
    return { risk: "always", reason: "The command contains an unterminated quote and cannot be classified safely." };
  }
  const hardRisk = HARD_RISK_RULES.find((rule) => rule.pattern.test(riskText));
  if (hardRisk) {
    return { risk: "always", reason: hardRisk.reason, reasonZh: hardRisk.reasonZh };
  }
  if (parsed.hasSubstitution) {
    return {
      risk: "always",
      reason: "Dynamic command substitution or backtick execution cannot be safely inspected.",
      reasonZh: "检测到动态命令替换或反引号执行，无法在运行前可靠判断实际命令。",
    };
  }
  if (parsed.segments.length > 0 && parsed.segments.every(isReadOnlySegment) && !parsed.hasRedirection) {
    return { risk: "allow", reason: "" };
  }
  if (NETWORK_COMMAND.test(riskText)) {
    return {
      risk: NETWORK_WRITE.test(riskText) ? "always" : "approval",
      reason: NETWORK_WRITE.test(riskText)
        ? "A network upload or state-changing HTTP request was detected."
        : "A network request will be made from the local machine.",
      reasonZh: NETWORK_WRITE.test(riskText)
        ? "检测到网络上传或会修改远程状态的 HTTP 请求。"
        : "该命令将从本机发起网络请求。",
      exactKey,
    };
  }
  if (parsed.hasRedirection || FILE_MUTATION.test(riskText)) {
    return {
      risk: "approval",
      reason: "The shell command may create, overwrite, copy, move, or redirect file content.",
      reasonZh: "该命令可能创建、覆盖、复制、移动文件，或将输出重定向到文件。",
      exactKey,
      prefixKey: suggestedPrefix(command, parsed),
    };
  }
  return {
    risk: "approval",
    reason: "This command is not fully classified as read-only.",
    reasonZh: "该命令无法被完整确认为只读操作。",
    exactKey,
    prefixKey: suggestedPrefix(command, parsed),
  };
}

function realPathWithMissingTail(path: string): string {
  let cursor = resolve(path);
  const tail: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    tail.unshift(cursor.slice(parent.length).replace(/^[\\/]+/, ""));
    cursor = parent;
  }
  let canonical = existsSync(cursor) ? realpathSync.native(cursor) : resolve(cursor);
  for (const part of tail) canonical = resolve(canonical, part);
  return canonical;
}

export function isOutsideProject(path: string, cwd: string): boolean {
  if (!path) return false;
  const root = realPathWithMissingTail(cwd);
  const target = realPathWithMissingTail(resolve(cwd, path));
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function redactInput(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (key, item) => (/token|secret|password|api[-_]?key|authorization/i.test(key) ? "[redacted]" : item),
      2,
    ).slice(0, 4000);
  } catch {
    return String(value).slice(0, 4000);
  }
}

export default function permissionGate(pi: any) {
  const modeFile = process.env.PI_STUDIO_GATE_MODE_FILE || "";
  const approvedExact = new Set<string>();
  const approvedPrefixes = new Set<string>();
  const approvedTools = new Set<string>();
  let previousFullMode = false;

  const isFullMode = (): boolean => {
    if (!modeFile) return false;
    try {
      return readFileSync(modeFile, "utf8").trim() === "full";
    } catch {
      return false;
    }
  };

  const language = (): "en" | "zh" => {
    if (!modeFile) return "en";
    try {
      const config = JSON.parse(readFileSync(resolve(dirname(modeFile), "..", "config.json"), "utf8"));
      return config?.language === "zh" ? "zh" : "en";
    } catch {
      return "en";
    }
  };

  const gatingDisabled = () => {
    const full = isFullMode();
    if (full !== previousFullMode) {
      approvedExact.clear();
      approvedPrefixes.clear();
      approvedTools.clear();
      previousFullMode = full;
    }
    return full;
  };

  const blocked = (reason: string) => ({ block: true, reason });

  const requestApproval = async (
    ctx: any,
    title: string,
    reason: string,
    detail: string,
    options: { exactKey?: string; prefixKey?: string; toolKey?: string; cacheable?: boolean } = {},
  ) => {
    const zh = language() === "zh";
    if (!ctx.hasUI) {
      return blocked(zh ? `${title}：无可用确认界面，已阻止` : `${title}: no approval UI is available; blocked`);
    }
    const allowOnce = zh ? "仅允许本次" : "Allow once";
    const allowExact = zh ? "本线程允许完全相同操作" : "Allow this exact operation for this thread";
    const allowPrefix = options.prefixKey
      ? zh
        ? `本线程允许前缀：${options.prefixKey}`
        : `Allow prefix for this thread: ${options.prefixKey}`
      : "";
    const allowTool = options.toolKey
      ? zh
        ? `本线程允许工具：${options.toolKey}`
        : `Allow tool for this thread: ${options.toolKey}`
      : "";
    const deny = zh ? "拒绝" : "Deny";
    const choices = [
      allowOnce,
      ...(options.cacheable && options.exactKey ? [allowExact] : []),
      ...(options.cacheable && allowPrefix ? [allowPrefix] : []),
      ...(options.cacheable && allowTool ? [allowTool] : []),
      deny,
    ];
    const heading = zh
      ? `沙盒请求授权：${title}\n${reason}\n\n${detail}`
      : `Sandbox authorization: ${title}\n${reason}\n\n${detail}`;
    const choice = await ctx.ui.select(heading, choices);
    if (!choice || choice === deny) {
      return blocked(zh ? "用户未授权，沙盒已阻止执行" : "The user denied this operation; Sandbox blocked it");
    }
    if (choice === allowExact && options.exactKey) approvedExact.add(options.exactKey);
    if (allowPrefix && choice === allowPrefix && options.prefixKey) approvedPrefixes.add(options.prefixKey);
    if (allowTool && choice === allowTool && options.toolKey) approvedTools.add(options.toolKey);
    return undefined;
  };

  const hasShellApproval = (decision: ShellDecision): boolean => {
    if (decision.exactKey && approvedExact.has(decision.exactKey)) return true;
    if (decision.exactKey) {
      for (const prefix of approvedPrefixes) {
        if (decision.exactKey === prefix || decision.exactKey.startsWith(`${prefix} `)) return true;
      }
    }
    return false;
  };

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (gatingDisabled()) return undefined;

    if (event.toolName === "bash") {
      const command = String(event.input?.command || "");
      const decision = classifyShellCommand(command);
      if (decision.risk === "allow" || (decision.risk === "approval" && hasShellApproval(decision))) return undefined;
      return requestApproval(ctx, "Shell", language() === "zh" ? decision.reasonZh || decision.reason : decision.reason, command, {
        exactKey: decision.exactKey,
        prefixKey: decision.prefixKey,
        cacheable: decision.risk === "approval",
      });
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const path = String(event.input?.path || "");
      if (!isOutsideProject(path, String(ctx.cwd || process.cwd()))) return undefined;
      return requestApproval(
        ctx,
        event.toolName,
        language() === "zh" ? "将修改当前项目真实路径之外的文件。" : "This will modify a file outside the real project path.",
        path,
        { cacheable: false },
      );
    }

    const toolName = String(event.toolName || "");
    if (SAFE_TOOLS.has(toolName)) return undefined;
    if (SUBAGENT_TOOLS.has(toolName)) {
      return requestApproval(
        ctx,
        toolName,
        language() === "zh"
          ? "子智能体进程目前无法获得逐工具沙盒拦截；允许即代表本次子智能体具有完整本机权限。"
          : "Child agents cannot currently receive per-tool Sandbox interception. Allowing this grants the child full local permissions for this run.",
        redactInput(event.input),
        { cacheable: false },
      );
    }
    if (approvedTools.has(toolName)) return undefined;
    const mutating = MUTATING_TOOL_NAME.test(toolName);
    return requestApproval(
      ctx,
      toolName || "Extension tool",
      mutating
        ? language() === "zh"
          ? "扩展工具名称表明它可能修改本地或外部状态。"
          : "The extension tool name indicates that it may mutate local or external state."
        : language() === "zh"
          ? "该扩展工具没有声明可验证的只读风险级别。"
          : "This extension tool has no verifiable read-only risk declaration.",
      redactInput(event.input),
      { toolKey: toolName, cacheable: !mutating },
    );
  });

  pi.registerCommand("pi-studio-branch-at", {
    description: "Internal Pi Studio branch operation",
    handler: async (args: string, ctx: any) => {
      const entryId = args.trim();
      if (!entryId || !/^[a-zA-Z0-9_-]+$/.test(entryId)) throw new Error("Invalid session entry id");
      const result = await ctx.fork(entryId, { position: "at" });
      if (result?.cancelled) throw new Error("Branch operation cancelled");
    },
  });

  pi.registerCommand("pi-studio-refresh-models", {
    description: "Internal Pi Studio model registry refresh",
    handler: async (_args: string, ctx: any) => {
      await ctx.modelRegistry.refresh();
    },
  });
}
