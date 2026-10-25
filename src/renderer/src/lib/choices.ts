/**
 * Recognize the "question with options" blocks assistants write in chat:
 *
 *   **Q1: Which rendering path?**
 *
 *   **Details:** Both routes change the glyph antialiasing.
 *
 *   **Options:**
 *
 *   1. **O1-1: Ordered dithering (recommended)**. Keeps the current waveform.
 *   2. **O1-2: GRAY8 refresh**. Smoother edges, ~50% slower.
 *
 * Parsing is deliberately conservative: a block only counts when it has a
 * numbered question line, an explicit Options/选项 header, and at least two
 * options. Anything else stays plain Markdown, so ordinary prose is never
 * turned into a menu. The matched lines are removed from `remainder` so the
 * chat can render the same content once, as an interactive card.
 */

export interface ChoiceOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface ChoiceQuestion {
  title: string;
  details?: string;
  options: ChoiceOption[];
}

export interface ChoiceParseResult {
  questions: ChoiceQuestion[];
  /** The message with parsed question blocks removed. */
  remainder: string;
}

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 8;

const QUESTION_LINE =
  /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:Q(?:uestion)?\s*(\d+)|问题\s*(\d+)?)\s*[:：]\s*(.*?)\s*$/i;
const LIST_MARKER = /^(?:[-*+]\s+|\d+[.)]\s+)/;
const DETAILS_PREFIX = /^(?:\*\*)?\s*(?:Details?|详情|说明)\s*(?:\*\*)?\s*[:：]\s*/i;

function stripEmphasis(value: string): string {
  return value.trim().replace(/^\*{1,2}/, "").replace(/\*{1,2}$/, "").trim();
}

function matchQuestionLine(line: string): string | null {
  const match = QUESTION_LINE.exec(line);
  if (!match) return null;
  const title = stripEmphasis(match[3] || "");
  if (!title) return null;
  // "Q1" must be followed by a real title; a bare "Q1:" is not a question.
  return title;
}

function isOptionsHeader(line: string): boolean {
  const value = stripEmphasis(line.replace(/^#{1,6}\s*/, ""));
  return /^(?:options?|choices?|选项|可选方案)\s*[:：]?$/i.test(value);
}

function isRecommended(label: string): boolean {
  return /[（(]\s*(?:推荐|recommended)\s*[)）]|推荐|recommended/i.test(label);
}

/** Split "**label**。description" / "label — description" into its parts. */
function parseOption(line: string): ChoiceOption | null {
  let value = line.trim().replace(LIST_MARKER, "").trim();
  if (!value) return null;
  let label = value;
  let description = "";

  const bold = /^\*\*(.+?)\*\*\s*([\s\S]*)$/.exec(value);
  if (bold) {
    label = bold[1].trim();
    description = bold[2].trim().replace(/^[。．.:：—–-]\s*/, "").trim();
  } else {
    const separators = [
      /^(.{1,80}?)\s+[—–-]\s+([\s\S]+)$/,
      /^(.{1,24}?)\s*[:：]\s*([\s\S]+)$/,
      /^(.{1,80}?)[。．.]\s+([\s\S]+)$/,
    ];
    for (const separator of separators) {
      const match = separator.exec(value);
      if (match) {
        label = match[1].trim();
        description = match[2].trim();
        break;
      }
    }
  }

  label = stripEmphasis(label).replace(/[。．.]+$/, "").trim();
  if (!label) return null;
  return {
    label,
    ...(description ? { description } : {}),
    ...(isRecommended(label) ? { recommended: true } : {}),
  };
}

function parseBlock(title: string, body: string[]): ChoiceQuestion | null {
  const headerIndex = body.findIndex(isOptionsHeader);
  if (headerIndex === -1) return null;

  const details = body
    .slice(0, headerIndex)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // "**Details:**" wraps the label in bold, so the marker can sit on either
    // side of the colon. Details are rendered as plain text, so dropping the
    // emphasis markers avoids stray "**" in the card.
    .map((line) => line.replace(DETAILS_PREFIX, "").replace(/\*\*/g, "").trim())
    .filter(Boolean);

  const options: ChoiceOption[] = [];
  for (const rawLine of body.slice(headerIndex + 1)) {
    const line = rawLine.trim();
    if (!line) continue;
    // A new question/heading ends this block's option list.
    if (matchQuestionLine(line) || /^#{1,6}\s/.test(line)) break;
    if (LIST_MARKER.test(line)) {
      const option = parseOption(line);
      if (option) options.push(option);
      continue;
    }
    // Wrapped text continues the previous option's description.
    if (options.length > 0 && !isOptionsHeader(line)) {
      const previous = options[options.length - 1];
      previous.description = `${previous.description || ""}${previous.description ? " " : ""}${stripEmphasis(line)}`.trim();
      continue;
    }
    break;
  }

  if (options.length < 2) return null;
  return {
    title,
    ...(details.length ? { details: details.join("\n") } : {}),
    options: options.slice(0, MAX_OPTIONS),
  };
}

export function parseChoiceQuestions(text: string): ChoiceParseResult {
  const source = String(text || "").replace(/\r\n?/g, "\n");
  if (!source.trim()) return { questions: [], remainder: source };

  const lines = source.split("\n");
  const consumed = new Array(lines.length).fill(false);
  const questions: ChoiceQuestion[] = [];

  for (let i = 0; i < lines.length; i++) {
    const title = matchQuestionLine(lines[i]);
    if (!title) continue;
    let end = i + 1;
    while (end < lines.length && !matchQuestionLine(lines[end])) end++;
    const parsed = parseBlock(title, lines.slice(i + 1, end));
    if (parsed) {
      questions.push(parsed);
      for (let index = i; index < end; index++) consumed[index] = true;
    }
    i = end - 1;
  }

  if (!questions.length) return { questions: [], remainder: source };

  const remainder = lines
    .filter((_, index) => !consumed[index])
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { questions: questions.slice(0, MAX_QUESTIONS), remainder };
}

/** Compose the user message that answers the questions the user picked. */
export function formatChoiceReply(
  questions: ChoiceQuestion[],
  answers: Record<number, { index: number | "other"; text?: string }>,
): string {
  return questions
    .map((question, index) => {
      const answer = answers[index];
      if (!answer) return "";
      const value =
        answer.index === "other"
          ? String(answer.text || "").trim()
          : question.options[answer.index]?.label || "";
      if (!value) return "";
      return `Q${index + 1}. ${question.title} → ${value}`;
    })
    .filter(Boolean)
    .join("\n");
}
