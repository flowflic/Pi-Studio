import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * Keep every renderer on the same explicit grammar set. `rehype-highlight`
 * ships with a smaller common set by default, which notably excludes
 * PowerShell; Preview already needed these grammars for file rendering.
 */
export const CODE_LANGUAGES = {
  bash,
  cpp,
  csharp,
  css,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  markdown,
  php,
  powershell,
  python,
  ruby,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

/** Language names emitted by Markdown fences and inferred from file paths. */
export const CODE_LANGUAGE_ALIASES: Record<string, string[]> = {
  bash: ["shell", "sh", "zsh"],
  csharp: ["cs", "c#"],
  javascript: ["js", "jsx"],
  markdown: ["md"],
  powershell: ["ps", "ps1", "pwsh"],
  python: ["py"],
  typescript: ["ts", "tsx"],
  xml: ["html", "htm", "xhtml", "svg"],
  yaml: ["yml"],
};

export const CODE_LANGUAGE_NAMES = Object.keys(CODE_LANGUAGES);
