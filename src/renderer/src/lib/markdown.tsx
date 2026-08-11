import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CODE_LANGUAGE_ALIASES, CODE_LANGUAGE_NAMES, CODE_LANGUAGES } from "./code-languages";

function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in (node as any)) return extractText((node as any).props?.children);
  return "";
}

function CodeBlock({ className, children }: { className?: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const lang = (className || "").match(/language-([\w-]+)/)?.[1] || "";
  const text = extractText(children);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-block-lang">{lang || "code"}</span>
        <button className="code-copy" onClick={copy} title="Copy">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

// Module-level constants: markdown parsing + highlight.js is the single most
// expensive thing the renderer does. ReactMarkdown re-initializes its plugin
// pipeline when the plugin array identity changes, and re-parses the text on
// every render — so everything here must be stable, and the component itself
// is memoized on `text`. Unchanged messages then cost nothing to re-render.
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [
  [
    rehypeHighlight,
    {
      aliases: CODE_LANGUAGE_ALIASES,
      // Detect unlabeled fenced blocks after checking explicit languages. This
      // makes copied shell/code snippets useful while keeping the subset small.
      detect: true,
      languages: CODE_LANGUAGES,
      subset: CODE_LANGUAGE_NAMES,
    },
  ],
] as any;
const MD_COMPONENTS = {
  pre: ({ children }: any) => <>{children}</>,
  code: ({ className, children, ...rest }: any) => {
    const isBlock = /hljs|language-/.test(className || "") || extractText(children).includes("\n");
    if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>;
    return (
      <code className="inline-code" {...rest}>
        {children}
      </code>
    );
  },
  a: ({ href, children, ...rest }: any) => (
    <a
      href={href}
      {...rest}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => {
        if (href && /^https?:/i.test(href)) {
          e.preventDefault();
          window.open(href, "_blank");
        }
      }}
    >
      {children}
    </a>
  ),
  table: ({ children }: any) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
  img: ({ src, alt }: any) => <img className="md-img" src={src} alt={alt || ""} />,
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MD_COMPONENTS}>
        {text || ""}
      </ReactMarkdown>
    </div>
  );
});
