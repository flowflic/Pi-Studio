/** Timing entries are display metadata and never enter the model context. */
export function replyTimings(entries: any[]): Map<string, { replyStartedAt: number; replyEndedAt: number }> {
  const result = new Map<string, { replyStartedAt: number; replyEndedAt: number }>();
  for (const entry of entries) {
    const data = entry?.data;
    if (entry?.type !== "custom" || entry.customType !== "pi-studio-reply-timing" ||
      !Number.isFinite(data?.startedAt) || !Number.isFinite(data?.endedAt) ||
      data.startedAt <= 0 || data.endedAt < data.startedAt || !Array.isArray(data.entryIds)) continue;
    for (const id of data.entryIds) if (typeof id === "string") {
      result.set(id, { replyStartedAt: data.startedAt, replyEndedAt: data.endedAt });
    }
  }
  return result;
}
