import { useEffect, useState } from "react";

export function formatReplyDuration(ms: number, language: string): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = seconds % 60;
  if (language === "zh") return `${h ? `${h} 小时 ` : ""}${h || m ? `${m} 分 ` : ""}${s} 秒`;
  return `${h ? `${h}h ` : ""}${h || m ? `${m}m ` : ""}${s}s`;
}

/** Only this small footer ticks; the transcript and Markdown stay untouched. */
export function ReplyDuration({ startedAt, endedAt, running, language }: {
  startedAt: number; endedAt?: number; running: boolean; language: string;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);
  if (!running && endedAt === undefined) return null;
  return <span className="reply-duration" data-running={running || undefined}>
    {language === "zh" ? "用时 " : "Elapsed "}{formatReplyDuration((running ? now : endedAt!) - startedAt, language)}
  </span>;
}
