import type { RemoteImageInput, RemotePermission, RemoteThreadEventPayload, RemoteThreadSnapshot } from "./protocol";

export class RemoteEventHub {
  private readonly listeners = new Map<string, Set<(event: RemoteThreadEventPayload) => void>>();

  subscribe(threadId: string, listener: (event: RemoteThreadEventPayload) => void): () => void {
    const entries = this.listeners.get(threadId) || new Set<(event: RemoteThreadEventPayload) => void>();
    entries.add(listener);
    this.listeners.set(threadId, entries);
    return () => {
      entries.delete(listener);
      if (entries.size === 0) this.listeners.delete(threadId);
    };
  }

  publish(threadId: string, event: RemoteThreadEventPayload): void {
    for (const listener of this.listeners.get(threadId) || []) listener(event);
  }

  clear(): void {
    this.listeners.clear();
  }
}
export class ProjectService {
  constructor(
    private readonly listFn: () => Promise<unknown>,
    private readonly getFn: (projectId: string) => Promise<unknown>,
    private readonly threadsFn: (projectId: string) => Promise<unknown>,
  ) {}

  list(): Promise<unknown> { return this.listFn(); }
  get(projectId: string): Promise<unknown> { return this.getFn(projectId); }
  listThreads(projectId: string): Promise<unknown> { return this.threadsFn(projectId); }
}

export class ThreadService {
  constructor(
    private readonly getFn: (threadId: string) => Promise<RemoteThreadSnapshot>,
    private readonly createFn: (projectId: string, name?: string, permission?: RemotePermission) => Promise<RemoteThreadSnapshot>,
    private readonly promptFn: (threadId: string, text: string, images?: RemoteImageInput[]) => Promise<unknown>,
    private readonly steerFn: (threadId: string, text: string, images?: RemoteImageInput[]) => Promise<unknown>,
    private readonly followUpFn: (threadId: string, text: string, images?: RemoteImageInput[]) => Promise<unknown>,
    private readonly abortFn: (threadId: string) => Promise<unknown>,
  ) {}

  get(threadId: string): Promise<RemoteThreadSnapshot> { return this.getFn(threadId); }
  create(projectId: string, name?: string, permission?: RemotePermission): Promise<RemoteThreadSnapshot> { return this.createFn(projectId, name, permission); }
  prompt(threadId: string, text: string, images?: RemoteImageInput[]): Promise<unknown> { return this.promptFn(threadId, text, images); }
  steer(threadId: string, text: string, images?: RemoteImageInput[]): Promise<unknown> { return this.steerFn(threadId, text, images); }
  followUp(threadId: string, text: string, images?: RemoteImageInput[]): Promise<unknown> { return this.followUpFn(threadId, text, images); }
  abort(threadId: string): Promise<unknown> { return this.abortFn(threadId); }
}

export class FilePreviewService {
  constructor(
    private readonly treeFn: (projectId: string, relativePath?: string) => Promise<unknown>,
    private readonly previewFn: (projectId: string, relativePath: string) => Promise<unknown>,
  ) {}

  tree(projectId: string, relativePath?: string): Promise<unknown> { return this.treeFn(projectId, relativePath); }
  preview(projectId: string, relativePath: string): Promise<unknown> { return this.previewFn(projectId, relativePath); }
}
