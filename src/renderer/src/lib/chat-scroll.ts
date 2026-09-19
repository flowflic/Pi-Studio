/** Follow growing content only while the reader remains at the bottom. */
export function attachChatScroll(
  viewport: HTMLElement,
  content: HTMLElement,
  threadId: string,
  positions: Map<string, number>,
): () => void {
  const nearBottom = () => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 140;
  const saved = positions.get(threadId);
  viewport.scrollTop = saved ?? viewport.scrollHeight;
  let following = nearBottom();
  let lastTop = viewport.scrollTop;
  let disposed = false;
  const remember = () => {
    lastTop = viewport.scrollTop;
    positions.set(threadId, lastTop);
  };
  remember();

  const onScroll = () => {
    // Delayed events from our own scroll writes must not turn following off
    // when another text delta has already increased the content height.
    // Allow subpixel rounding at non-integer Windows display scales.
    if (Math.abs(viewport.scrollTop - lastTop) > 1) following = nearBottom();
    remember();
  };
  const observer = new ResizeObserver(() => {
    if (disposed) return;
    // A user scroll can precede its queued scroll event in the same frame.
    if (Math.abs(viewport.scrollTop - lastTop) > 1) following = nearBottom();
    if (following) viewport.scrollTop = viewport.scrollHeight;
    remember();
  });
  viewport.addEventListener("scroll", onScroll, { passive: true });
  observer.observe(content);
  observer.observe(viewport);
  return () => {
    disposed = true;
    observer.disconnect();
    viewport.removeEventListener("scroll", onScroll);
    // Use the last observed position: React may already have replaced the DOM
    // with a different transcript and clamped scrollTop during this commit.
    positions.set(threadId, lastTop);
  };
}
