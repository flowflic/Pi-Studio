import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
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
    pattern: /\bnode\s+(?:-e|--eval|-p|--print|-r|--require|--loader|--import|--experimental-loader)\b/i,
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
  /\b(set-content|out-file|add-content|clear-content|new-item|copy-item|move-item|rename-item|mkdir|md|cp|mv|touch|tee)\b/i;
const NETWORK_COMMAND = /\b(curl|curl\.exe|wget|invoke-webrequest|irm|iwr)\b/i;
const NETWORK_WRITE = /(?:^|\s)(?:-x|--request)\s+(?:post|put|patch|delete)\b|(?:^|\s)(?:-d|--data(?:-\w+)?|-t|--upload-file)(?:\s|$)/i;

// Sandbox intentionally has a useful middle ground: operations with an
// explicit, non-sensitive file target can run without interrupting the user,
// but the classifier remains fail-closed for destructive, sensitive, external
// code execution, or opaque operations. The model's selected tool call is the
// operation being judged; this extension never silently broadens full access.
const DELETION_COMMAND = /(?:^|[\s;&|])(?:rm|rmdir|unlink|shred|remove-item|clear-item|del|erase|rd)(?:\.exe)?(?=\s|$)/i;
const RECURSIVE_DELETE = /(?:\s|^)(?:-[^-\s]*r|--recursive|-recurse|\/s)(?:\s|$)|\*|\?|\[[^\]]+\]/i;
const SENSITIVE_FILE_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:[-_.].*)?|secrets?(?:[-_.].*)?|.*(?:^|[-_.])(secret|credential|password|passwd|token|api[-_]?key|access[-_]?key|private[-_]?key)(?:[-_.].*)?)$/i;
const SENSITIVE_FILE_EXT = /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/i;
const SENSITIVE_DIRECTORY = /^(?:\.aws|\.azure|\.git|\.gnupg|\.hg|\.ssh|\.svn|credentials?|secrets?)$/i;
const SENSITIVE_SYSTEM_LOCATION = /^(?:[a-z]:\/)?(?:windows|program files(?: \(x86\))?|programdata|recovery|system volume information)(?:\/|$)|^\/(?:etc|root|usr|var|system)(?:\/|$)|^\/\//i;
const DANGEROUS_SCRIPT_NAME = /(?:^|[-_./\\])(clean|delete|deploy|destroy|dangerous|erase|format|install|publish|release|remove|reset|uninstall|wipe|prune)(?:[-_.\\/]|$)/i;
const SAFE_PROJECT_NPM_TASK = /^(?:build|check|compile|dev|format|generate|lint|preview|test|typecheck|validate)$/i;
const SAFE_NON_MUTATING_SEGMENT = /^(?:echo|printf|true|false|clear|cls|date|time)(?:\s+[^;&|<>]*)?$/i;

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

function splitShellWords(segment: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const flush = () => {
    if (current) words.push(current);
    current = "";
  };

  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];
    const next = segment[i + 1] || "";
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "`" && quote !== "'") {
      escaped = true;
      continue;
    }
    // Keep backslashes intact: on Windows they are path separators, while a
    // POSIX escaped character is still conservatively treated as an opaque
    // token by the path checks below.
    if (char === "\\" && quote !== "'") {
      current += char;
      if (next) {
        current += next;
        i++;
      }
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    current += char;
  }
  if (quote || escaped) return null;
  flush();
  return words;
}

function commandName(value: string): string {
  return value.trim().split(/[\\/]/).pop()?.replace(/\.exe$/i, "").toLowerCase() || "";
}

function cleanPathToken(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "").replace(/[;,]+$/g, "");
}

function isSensitivePath(path: string): boolean {
  const normalized = cleanPathToken(path).replace(/\\/g, "/");
  if (!normalized) return false;
  const pieces = normalized.split("/").filter(Boolean);
  const name = pieces[pieces.length - 1] || "";
  return SENSITIVE_SYSTEM_LOCATION.test(normalized) || pieces.some((piece) => SENSITIVE_DIRECTORY.test(piece)) || SENSITIVE_FILE_NAME.test(name) || SENSITIVE_FILE_EXT.test(name);
}

function hasPathWildcard(path: string): boolean {
  return /[*?]|\[[^\]]*\]/.test(cleanPathToken(path));
}

type PathScope = "inside" | "outside" | "sensitive" | "ambiguous";

function pathScope(path: string, cwd: string): PathScope {
  const clean = cleanPathToken(path);
  if (!clean || hasPathWildcard(clean)) return "ambiguous";
  if (isSensitivePath(clean)) return "sensitive";
  // A leading ~ is resolved by the shell before Pi can run the operation and
  // is never project-relative.
  if (/^~(?:[\\/]|$)/.test(clean)) return "outside";
  if (!isOutsideProject(clean, cwd)) return "inside";
  try {
    return isSensitivePath(realPathWithMissingTail(resolve(cwd, clean))) ? "sensitive" : "outside";
  } catch {
    return "outside";
  }
}

function optionName(value: string): string {
  return value.replace(/^(?:--?|\/)/, "").split("=", 1)[0].toLowerCase();
}

function isOption(value: string): boolean {
  return /^--?[a-z][a-z-]*(?:=.*)?$/i.test(value);
}

function looksLikePathArgument(value: string): boolean {
  const clean = cleanPathToken(value);
  return Boolean(clean) && (/^(?:\.\.?[\\/]|~[\\/]|[a-z]:[\\/]|[\\/])/.test(clean) || /[\\/]/.test(clean) || /\.[a-z0-9]{1,8}$/i.test(clean));
}

function optionValues(words: string[], names: Set<string>): string[] {
  const values: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (!isOption(word)) continue;
    const [rawName, inlineValue] = word.split(/=(.*)/s, 2);
    if (!names.has(optionName(rawName))) continue;
    if (inlineValue !== undefined && inlineValue) values.push(inlineValue);
    else if (words[i + 1] && !isOption(words[i + 1])) values.push(words[++i]);
  }
  return values;
}

function positionalValues(words: string[], skipOptions = true): string[] {
  const values: string[] = [];
  let positionalOnly = false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "--") {
      positionalOnly = true;
      continue;
    }
    if (skipOptions && !positionalOnly && isOption(word)) {
      // Common options with a following value must not be mistaken for a
      // destination path (for example -Value text or -ItemType File).
      if (!word.includes("=") && words[i + 1] && !isOption(words[i + 1]) && /^(?:path|literalpath|destination|target|name|itemtype|value|encoding|filter|include|exclude|force|append|recurse|recursive|s|q|f|r|t)$/i.test(optionName(word))) {
        i++;
      }
      continue;
    }
    values.push(word);
  }
  return values;
}

function redirectionTargets(segment: string): string[] {
  const targets: string[] = [];
  const pattern = />{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/g;
  for (const match of segment.matchAll(pattern)) targets.push(match[1] || match[2] || match[3] || "");
  return targets;
}

function mutationTargets(segment: string): string[] {
  const words = splitShellWords(segment);
  if (!words?.length) return [];
  const name = commandName(words[0]);
  const paths = redirectionTargets(segment);
  const pathFlags = new Set(["path", "literalpath", "destination", "target", "outfile", "filepath", "file", "literaldestination"]);
  const flagged = optionValues(words, pathFlags);
  const positional = positionalValues(words);

  if (name === "set-content" || name === "add-content" || name === "clear-content" || name === "out-file" || name === "new-item" || name === "mkdir" || name === "md" || name === "touch" || name === "tee") {
    paths.push(...flagged, ...(flagged.length ? [] : positional.slice(0, 1)));
  } else if (name === "copy-item" || name === "move-item" || name === "rename-item") {
    paths.push(...flagged, ...(flagged.length ? [] : positional));
  } else if (name === "cp" || name === "mv") {
    paths.push(...flagged, ...(flagged.length ? [] : positional.slice(-2)));
  }
  return paths.map(cleanPathToken).filter(Boolean);
}

function deletionTargets(segment: string): string[] {
  const words = splitShellWords(segment);
  if (!words?.length) return [];
  const name = commandName(words[0]);
  const flagged = optionValues(words, new Set(["path", "literalpath"]));
  const positional = positionalValues(words);
  if (name === "remove-item" || name === "clear-item" || name === "clear-content") return flagged.length ? flagged : positional.slice(0, 1);
  return positional;
}

function isRecursiveDeletion(segment: string): boolean {
  const masked = maskQuotedLiterals(segment);
  return /(?:^|\s)-[a-z]*r[a-z]*(?:\s|$)/i.test(masked) || RECURSIVE_DELETE.test(masked) || /\b(?:remove-item|clear-item)\b[^;&|<>]*-(?:recurse|recursive)\b/i.test(masked);
}

function projectScriptDecision(segment: string, cwd: string): ShellDecision | null {
  const words = splitShellWords(segment);
  if (!words?.length) return null;
  const name = commandName(words[0]);

  if (name === "npm" || name === "pnpm" || name === "yarn") {
    const taskIndex = words[1]?.toLowerCase() === "run" ? 2 : 1;
    const task = words[taskIndex] || "";
    if (!task || task.startsWith("-")) return null;
    if ((words[1]?.toLowerCase() === "run" || /^(?:build|check|compile|dev|format|generate|lint|preview|test|typecheck|validate)$/i.test(task)) && DANGEROUS_SCRIPT_NAME.test(task)) {
      return {
        risk: "approval",
        reason: "The package task name suggests cleanup, deployment, installation, or another state-changing operation.",
        reasonZh: "该包任务名称疑似清理、部署、安装或其他状态变更操作。",
      };
    }
    if (words[1]?.toLowerCase() === "run" && SAFE_PROJECT_NPM_TASK.test(task)) return { risk: "allow", reason: "" };
    if (/^(?:build|check|compile|dev|format|generate|lint|preview|test|typecheck|validate)$/i.test(task)) return { risk: "allow", reason: "" };
    return null;
  }

  if (name !== "node" && name !== "python" && name !== "python3") return null;
  const scriptIndex = words[1] === "--" ? 2 : 1;
  const script = words[scriptIndex];
  if (!script || script === "-" || script.startsWith("-")) return null;
  const scope = pathScope(script, cwd);
  if (scope === "sensitive" || scope === "outside" || scope === "ambiguous") {
    return {
      risk: "always",
      reason: "The script path is outside the project or points to a sensitive/ambiguous location.",
      reasonZh: "脚本路径位于项目外，或指向敏感/无法确认的位置。",
    };
  }
  for (const argument of words.slice(scriptIndex + 1)) {
    const inlinePath = argument.match(/^--?(?:output|out|path|file|dir|destination|dest|input|config)=(.+)$/i)?.[1];
    const candidate = inlinePath || (!isOption(argument) && looksLikePathArgument(argument) ? argument : "");
    if (!candidate) continue;
    const argumentScope = pathScope(candidate, cwd);
    if (argumentScope === "sensitive" || argumentScope === "outside" || argumentScope === "ambiguous") {
      return {
        risk: "always",
        reason: "A script argument points to a sensitive, outside-project, or ambiguous path.",
        reasonZh: "脚本参数指向敏感位置、项目外路径，或无法可靠确认。",
      };
    }
  }
  if (DANGEROUS_SCRIPT_NAME.test(script)) {
    return {
      risk: "approval",
      reason: "The script name suggests a destructive or externally state-changing operation.",
      reasonZh: "脚本名称疑似破坏性或会修改外部状态的操作。",
    };
  }
  return { risk: "allow", reason: "" };
}

function projectMutationDecision(segment: string, cwd: string): ShellDecision | null {
  const paths = mutationTargets(segment);
  if (!paths.length) return null;
  const scopes = paths.map((path) => pathScope(path, cwd));
  if (scopes.some((scope) => scope === "sensitive")) {
    return {
      risk: "always",
      reason: "The command writes to a sensitive file or directory.",
      reasonZh: "该命令将写入敏感文件或目录。",
    };
  }
  if (scopes.some((scope) => scope === "ambiguous")) {
    return {
      risk: "always",
      reason: "The command writes to an ambiguous path that cannot be verified safely.",
      reasonZh: "该命令将写入无法可靠确认的路径。",
    };
  }
  return { risk: "allow", reason: "" };
}

function resolvesToProjectRoot(path: string, cwd: string): boolean {
  try {
    return realPathWithMissingTail(cwd) === realPathWithMissingTail(resolve(cwd, cleanPathToken(path)));
  } catch {
    return false;
  }
}

function isExistingDirectory(path: string, cwd: string): boolean {
  try {
    return statSync(resolve(cwd, cleanPathToken(path))).isDirectory();
  } catch {
    return false;
  }
}

function deletionDecision(segment: string, cwd: string): ShellDecision | null {
  if (!DELETION_COMMAND.test(segment)) return null;
  const targets = deletionTargets(segment);
  if (isRecursiveDeletion(segment) || !targets.length) {
    return {
      risk: "always",
      reason: "A recursive, bulk, or otherwise ambiguous deletion command was detected. Deleted data may not be recoverable.",
      reasonZh: "检测到递归、批量或无法确认目标的删除命令，删除的数据可能无法恢复。",
    };
  }
  const name = commandName(splitShellWords(segment)?.[0] || "");
  if (name === "rmdir" || name === "rd" || targets.some((target) => resolvesToProjectRoot(target, cwd) || isExistingDirectory(target, cwd))) {
    return {
      risk: "always",
      reason: "The command may delete a project directory or the project root and requires fallback user confirmation.",
      reasonZh: "该命令可能删除项目目录或项目根目录，必须由用户兜底确认。",
    };
  }
  const scopes = targets.map((target) => pathScope(target, cwd));
  if (scopes.some((scope) => scope !== "inside")) {
    return {
      risk: "always",
      reason: "The deletion targets a sensitive, outside-project, or ambiguous path.",
      reasonZh: "删除目标位于敏感位置、项目外，或无法可靠确认。",
    };
  }
  return { risk: "allow", reason: "A single, project-local deletion was classified as low risk." };
}

function lowRiskSegmentDecision(segment: string, cwd: string): ShellDecision | null {
  const deletion = deletionDecision(segment, cwd);
  if (deletion) return deletion;
  const script = projectScriptDecision(segment, cwd);
  const mutation = projectMutationDecision(segment, cwd);
  const decisions = [script, mutation].filter((decision): decision is ShellDecision => Boolean(decision));
  if (decisions.some((decision) => decision.risk === "always")) return decisions.find((decision) => decision.risk === "always")!;
  if (decisions.some((decision) => decision.risk === "approval")) return decisions.find((decision) => decision.risk === "approval")!;
  if (decisions.length) return { risk: "allow", reason: "" };
  if (isReadOnlySegment(segment)) return { risk: "allow", reason: "" };
  if (SAFE_NON_MUTATING_SEGMENT.test(maskQuotedLiterals(segment))) return { risk: "allow", reason: "" };
  return null;
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

export function classifyShellCommand(command: string, cwd = process.cwd()): ShellDecision {
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
  const lowRisk = parsed.segments.map((segment) => lowRiskSegmentDecision(segment, cwd));
  if (lowRisk.length > 0 && lowRisk.every((decision): decision is ShellDecision => Boolean(decision))) {
    const always = lowRisk.find((decision) => decision?.risk === "always");
    if (always) return { ...always, exactKey };
    const approval = lowRisk.find((decision) => decision?.risk === "approval");
    if (approval) return { ...approval, exactKey, prefixKey: suggestedPrefix(command, parsed) };
    return { risk: "allow", reason: "" };
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
      const decision = classifyShellCommand(command, String(ctx.cwd || process.cwd()));
      if (decision.risk === "allow" || (decision.risk === "approval" && hasShellApproval(decision))) return undefined;
      return requestApproval(ctx, "Shell", language() === "zh" ? decision.reasonZh || decision.reason : decision.reason, command, {
        exactKey: decision.exactKey,
        prefixKey: decision.prefixKey,
        cacheable: decision.risk === "approval",
      });
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const path = String(event.input?.path || "");
      const cwd = String(ctx.cwd || process.cwd());
      if (!path) {
        return requestApproval(
          ctx,
          event.toolName,
          language() === "zh" ? "缺少明确文件路径，无法判断写入范围。" : "No explicit file path was provided, so the write scope cannot be verified.",
          redactInput(event.input),
          { cacheable: false },
        );
      }
      if (hasPathWildcard(path)) {
        return requestApproval(
          ctx,
          event.toolName,
          language() === "zh" ? "文件路径包含通配符，无法确认实际修改范围。" : "The file path contains a wildcard, so the actual write scope cannot be verified.",
          path,
          { cacheable: false },
        );
      }
      let resolvedPath = path;
      try {
        resolvedPath = realPathWithMissingTail(resolve(cwd, path));
      } catch {
        /* fall back to the lexical path check */
      }
      if (isSensitivePath(path) || isSensitivePath(resolvedPath)) {
        return requestApproval(
          ctx,
          event.toolName,
          language() === "zh" ? "将修改敏感文件或目录，必须由用户兜底确认。" : "This will modify a sensitive file or directory and requires fallback user confirmation.",
          path,
          { cacheable: false },
        );
      }
      return undefined;
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
