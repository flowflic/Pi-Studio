import { useState } from "react";
import { useStore } from "../store";
import { formatChoiceReply, type ChoiceQuestion } from "../lib/choices";
import { Check, Sparkle } from "./icons";

type Answer = { index: number | "other"; text?: string };

/**
 * Interactive replacement for the "question with options" blocks assistants
 * write in chat. The user clicks an option instead of typing it, and every
 * question offers an explicit "Other" choice so none of the proposals can be
 * accepted as-is and a custom plan can be typed in.
 */
export function ChoicePrompt({ threadId, questions }: { threadId: string; questions: ChoiceQuestion[] }) {
  const sendPrompt = useStore((s) => s.sendPrompt);
  const language = useStore((s) => s.config?.language || "en");
  const zh = language === "zh";
  const [answers, setAnswers] = useState<Record<number, Answer>>({});
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [sent, setSent] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);

  if (dismissed) return null;

  const choose = (questionIndex: number, answer: Answer) => {
    setAnswers((current) => ({ ...current, [questionIndex]: answer }));
  };

  const ready = questions.every((_, index) => {
    const answer = answers[index];
    if (!answer) return false;
    return answer.index !== "other" || Boolean((drafts[index] || "").trim());
  });

  const send = async () => {
    if (!ready || sending) return;
    const reply = formatChoiceReply(
      questions,
      Object.fromEntries(
        questions.map((_, index) => {
          const answer = answers[index];
          return [index, answer.index === "other" ? { index: "other" as const, text: drafts[index] || "" } : answer];
        }),
      ),
    );
    if (!reply.trim()) return;
    setSending(true);
    try {
      await sendPrompt(threadId, reply);
      setSent(true);
    } catch {
      // Keep the card and the selection so the user can retry.
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="choice-card" aria-label={zh ? "需要你确认的选项" : "Choices that need your input"}>
      <div className="choice-card-head">
        <Sparkle size={14} />
        <span>{zh ? "请选择" : "Choose"}</span>
        <span className="choice-card-count">
          {questions.length} {zh ? "个问题" : questions.length === 1 ? "question" : "questions"}
        </span>
      </div>

      {questions.map((question, questionIndex) => {
        const answer = answers[questionIndex];
        const customSelected = answer?.index === "other";
        return (
          <div className="choice-question" key={`${questionIndex}:${question.title}`}>
            <div className="choice-question-title">{question.title}</div>
            {question.details && <div className="choice-question-details">{question.details}</div>}

            <div className="choice-options" role="radiogroup" aria-label={question.title}>
              {question.options.map((option, optionIndex) => {
                const selected = answer?.index === optionIndex;
                return (
                  <button
                    key={`${optionIndex}:${option.label}`}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={sent || sending}
                    className={`choice-option ${selected ? "selected" : ""}`}
                    onClick={() => choose(questionIndex, { index: optionIndex })}
                  >
                    <span className="choice-option-mark" aria-hidden="true">{selected ? <Check size={12} /> : null}</span>
                    <span className="choice-option-body">
                      <span className="choice-option-label">
                        {option.label}
                        {option.recommended && !/(?:推荐|recommended)/i.test(option.label) && (
                          <small className="choice-option-tag">{zh ? "推荐" : "Recommended"}</small>
                        )}
                      </span>
                      {option.description && <span className="choice-option-desc">{option.description}</span>}
                    </span>
                  </button>
                );
              })}

              <button
                type="button"
                role="radio"
                aria-checked={customSelected}
                disabled={sent || sending}
                className={`choice-option choice-option-other ${customSelected ? "selected" : ""}`}
                onClick={() => choose(questionIndex, { index: "other", text: drafts[questionIndex] || "" })}
              >
                <span className="choice-option-mark" aria-hidden="true">{customSelected ? <Check size={12} /> : null}</span>
                <span className="choice-option-body">
                  <span className="choice-option-label">{zh ? "其他（自定义方案）" : "Other (custom plan)"}</span>
                  <span className="choice-option-desc">
                    {zh ? "以上方案都不合适，我来描述自己的做法。" : "None of these work — describe your own approach."}
                  </span>
                </span>
              </button>

              {customSelected && !sent && (
                <textarea
                  className="choice-custom-input"
                  autoFocus
                  rows={3}
                  disabled={sending}
                  aria-label={zh ? "自定义方案" : "Custom plan"}
                  placeholder={
                    zh ? "写下你希望采用的方案，发送后会作为你的选择告诉 Pi。" : "Describe the plan you want. It is sent as your answer to Pi."
                  }
                  value={drafts[questionIndex] || ""}
                  onChange={(event) => {
                    const text = event.target.value;
                    setDrafts((current) => ({ ...current, [questionIndex]: text }));
                    choose(questionIndex, { index: "other", text });
                  }}
                />
              )}
            </div>
          </div>
        );
      })}

      <div className="choice-card-actions">
        {sent ? (
          <span className="choice-sent" role="status">
            <Check size={13} /> {zh ? "已发送你的选择" : "Your choices were sent"}
          </span>
        ) : (
          <>
            <button type="button" className="btn primary" disabled={!ready || sending} onClick={send}>
              {sending ? <span className="spinner" /> : <Check size={13} />}
              {zh ? "发送选择" : "Send choices"}
            </button>
            <button type="button" className="btn choice-dismiss" onClick={() => setDismissed(true)}>
              {zh ? "我自己回复" : "I will reply myself"}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
