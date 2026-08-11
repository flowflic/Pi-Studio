import {
  errorFor,
  makeEnvelope,
  type RemoteEnvelope,
  type RemoteImageInput,
  RemoteProtocolError,
  responseFor,
  type RemotePermission,
  type RemoteThreadEventPayload,
  type RemoteThreadSnapshot,
  type RemoteUiRequest,
} from "./protocol";

export interface RemoteBackend {
  listProjects(): Promise<unknown>;
  listThreads(projectId: string): Promise<unknown>;
  getThread(threadId: string, options?: { live?: boolean }): Promise<RemoteThreadSnapshot>;
  createThread(projectId: string, name?: string, permission?: RemotePermission): Promise<RemoteThreadSnapshot>;
  setPermission(threadId: string, permission: RemotePermission): Promise<RemoteThreadSnapshot>;
  setModel(threadId: string, provider: string, modelId: string): Promise<RemoteThreadSnapshot>;
  prompt(threadId: string, text: string, images?: RemoteImageInput[]): Promise<unknown>;
  steer(threadId: string, text: string, images?: RemoteImageInput[]): Promise<unknown>;
  followUp(threadId: string, text: string, images?: RemoteImageInput[]): Promise<unknown>;
  abort(threadId: string): Promise<unknown>;
  fileTree(projectId: string, relativePath?: string): Promise<unknown>;
  filePreview(projectId: string, relativePath: string): Promise<unknown>;
  respondUi(threadId: string, requestId: string, payload: Record<string, unknown>): Promise<unknown>;
  subscribeThread(threadId: string, listener: (event: RemoteThreadEventPayload) => void): () => void;
}
export interface RemoteClientContext {
  connectionId: string;
  deviceId: string;
  send: (message: RemoteEnvelope) => void;
}

function safeErrorMessage(message: string): string {
  return message
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private|var|tmp|workspace)\/)[^\s"'<>`]*/gi, "[path]")
    .slice(0, 2_000);
}

interface Claim {
  connectionId: string;
  deviceId: string;
  expiresAt: number;
}

const REMOTE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_REMOTE_IMAGES = 3;
const MAX_REMOTE_IMAGE_DATA = 1_200_000;
const MAX_REMOTE_IMAGE_DATA_TOTAL = 1_500_000;

export class RemoteService {
  private readonly subscriptions = new Map<string, Map<string, () => void>>();
  private readonly claims = new Map<string, Claim>();
  private readonly requests = new Map<string, RemoteEnvelope>();
  private readonly sequences = new Map<string, number>();

  constructor(private readonly backend: RemoteBackend) {}

  disconnect(connectionId: string): void {
    if (connectionId === "__all__") {
      for (const id of [...this.subscriptions.keys()]) this.disconnect(id);
      this.claims.clear();
      return;
    }
    const entries = this.subscriptions.get(connectionId);
    entries?.forEach((unsubscribe) => unsubscribe());
    this.subscriptions.delete(connectionId);
    for (const [threadId, claim] of this.claims) {
      if (claim.connectionId === connectionId) this.claims.delete(threadId);
    }
  }

  async handle(request: RemoteEnvelope, context: RemoteClientContext): Promise<void> {
    const cacheKey = request.requestId ? `${context.deviceId}:${request.requestId}` : "";
    if (cacheKey && this.requests.has(cacheKey)) {
      context.send(this.requests.get(cacheKey)!);
      return;
    }

    try {
      const result = await this.dispatch(request, context);
      if (!result) return;
      if (cacheKey) this.requests.set(cacheKey, result);
      context.send(result);
      this.trimRequestCache();
    } catch (error) {
      const e = error instanceof RemoteProtocolError
        ? error
        : new RemoteProtocolError("INTERNAL_ERROR", safeErrorMessage(error instanceof Error ? error.message : String(error)));
      const result = errorFor(request, e.code, safeErrorMessage(e.message));
      if (cacheKey) this.requests.set(cacheKey, result);
      context.send(result);
    }
  }

  private async dispatch(request: RemoteEnvelope, context: RemoteClientContext): Promise<RemoteEnvelope | null> {
    const payload = (request.payload || {}) as Record<string, unknown>;
    switch (request.type) {
      case "projects.list":
        return responseFor(request, { projects: await this.backend.listProjects() });
      case "threads.list":
        return responseFor(request, { threads: await this.backend.listThreads(this.requiredString(payload, "projectId")) });
      case "thread.get":
        return responseFor(request, { snapshot: await this.backend.getThread(this.requiredThread(request)) });
      case "thread.resync":
        return responseFor(request, { snapshot: await this.backend.getThread(this.requiredThread(request), { live: true }) });
      case "thread.create":
        return responseFor(request, {
          snapshot: await this.backend.createThread(
            this.requiredString(payload, "projectId"),
            this.optionalString(payload, "name"),
            this.optionalPermission(payload, "permission") || "sandbox",
          ),
        });
      case "thread.claimWrite": {
        const threadId = this.requiredThread(request);
        const existing = this.claims.get(threadId);
        if (existing && existing.expiresAt > Date.now() && existing.connectionId !== context.connectionId) {
          throw new RemoteProtocolError("THREAD_BUSY", "Thread is being edited by another device");
        }
        const expiresAt = Date.now() + 30_000;
        this.claims.set(threadId, { connectionId: context.connectionId, deviceId: context.deviceId, expiresAt });
        return responseFor(request, { threadId, expiresAt, deviceId: context.deviceId });
      }
      case "thread.setPermission": {
        const threadId = this.requiredThread(request);
        this.assertWriter(threadId, context);
        return responseFor(request, {
          snapshot: await this.backend.setPermission(threadId, this.requiredPermission(payload, "permission")),
        });
      }
      case "thread.setModel": {
        const threadId = this.requiredThread(request);
        this.assertWriter(threadId, context);
        const provider = this.requiredShortString(payload, "provider");
        const modelId = this.requiredShortString(payload, "modelId");
        return responseFor(request, {
          snapshot: await this.backend.setModel(threadId, provider, modelId),
        });
      }
      case "thread.subscribe": {
        const threadId = this.requiredThread(request);
        const existing = this.subscriptions.get(context.connectionId) || new Map<string, () => void>();
        existing.get(threadId)?.();
        const unsubscribe = this.backend.subscribeThread(threadId, (event) => {
          const seq = (this.sequences.get(threadId) || 0) + 1;
          this.sequences.set(threadId, seq);
          context.send(makeEnvelope("thread.event", request.sessionId, event, { threadId, seq }));
        });
        existing.set(threadId, unsubscribe);
        this.subscriptions.set(context.connectionId, existing);
        // Opening a thread is deliberately history-first. Starting a cold Pi
        // bridge here can take several seconds and can exceed the mobile
        // request timeout. A later resync uses the live bridge when needed.
        return responseFor(request, { snapshot: await this.backend.getThread(threadId) });
      }
      case "thread.prompt":
      case "thread.steer":
      case "thread.followUp": {
        const threadId = this.requiredThread(request);
        this.assertWriter(threadId, context);
        const text = this.requiredString(payload, "text");
        const images = this.optionalImages(payload);
        const result = request.type === "thread.prompt"
          ? await this.backend.prompt(threadId, text, images)
          : request.type === "thread.steer"
            ? await this.backend.steer(threadId, text, images)
            : await this.backend.followUp(threadId, text, images);
        return responseFor(request, result);
      }
      case "thread.abort": {
        const threadId = this.requiredThread(request);
        this.assertWriter(threadId, context);
        return responseFor(request, await this.backend.abort(threadId));
      }
      case "file.tree":
        return responseFor(request, await this.backend.fileTree(this.requiredString(payload, "projectId"), this.optionalString(payload, "relativePath")));
      case "file.preview":
        return responseFor(request, await this.backend.filePreview(this.requiredString(payload, "projectId"), this.requiredString(payload, "relativePath")));
      case "ui.respond": {
        const threadId = this.requiredThread(request);
        this.assertWriter(threadId, context);
        const uiRequestId = this.requiredString(payload, "requestId");
        const response = payload.response;
        if (!response || typeof response !== "object" || Array.isArray(response)) throw new RemoteProtocolError("INVALID_REQUEST", "UI response must be an object");
        return responseFor(request, await this.backend.respondUi(threadId, uiRequestId, response as Record<string, unknown>));
      }
      default:
        throw new RemoteProtocolError("UNSUPPORTED", `Unsupported remote command: ${request.type}`);
    }
  }

  private assertWriter(threadId: string, context: RemoteClientContext): void {
    const claim = this.claims.get(threadId);
    if (!claim || claim.expiresAt <= Date.now()) {
      this.claims.delete(threadId);
      throw new RemoteProtocolError("WRITE_CLAIM_REQUIRED", "Claim the thread before writing");
    }
    if (claim.connectionId !== context.connectionId) throw new RemoteProtocolError("THREAD_BUSY", "Thread is being edited by another device");
    claim.expiresAt = Date.now() + 30_000;
  }

  private requiredThread(request: RemoteEnvelope): string {
    if (!request.threadId) throw new RemoteProtocolError("INVALID_REQUEST", "threadId is required");
    return request.threadId;
  }

  private requiredString(payload: Record<string, unknown>, key: string): string {
    const value = payload[key];
    if (typeof value !== "string" || !value.trim()) throw new RemoteProtocolError("INVALID_REQUEST", `${key} is required`);
    return value.trim();
  }

  private requiredShortString(payload: Record<string, unknown>, key: string): string {
    const value = this.requiredString(payload, key);
    if (value.length > 256) throw new RemoteProtocolError("INVALID_REQUEST", `${key} is too long`);
    return value;
  }

  private optionalString(payload: Record<string, unknown>, key: string): string | undefined {
    const value = payload[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private optionalPermission(payload: Record<string, unknown>, key: string): RemotePermission | undefined {
    const value = payload[key];
    return value === "sandbox" || value === "full" ? value : undefined;
  }

  private requiredPermission(payload: Record<string, unknown>, key: string): RemotePermission {
    const value = this.optionalPermission(payload, key);
    if (!value) throw new RemoteProtocolError("INVALID_REQUEST", `${key} must be sandbox or full`);
    return value;
  }

  private optionalImages(payload: Record<string, unknown>): RemoteImageInput[] | undefined {
    const value = payload.images;
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > MAX_REMOTE_IMAGES) {
      throw new RemoteProtocolError("INVALID_REQUEST", `images must contain at most ${MAX_REMOTE_IMAGES} items`);
    }
    let total = 0;
    return value.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new RemoteProtocolError("INVALID_REQUEST", `images[${index}] is invalid`);
      }
      const image = item as Record<string, unknown>;
      if (image.type !== "image") throw new RemoteProtocolError("INVALID_REQUEST", `images[${index}].type must be image`);
      const data = image.data;
      const mimeType = image.mimeType;
      if (typeof data !== "string" || data.length === 0 || data.length > MAX_REMOTE_IMAGE_DATA || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        throw new RemoteProtocolError("PAYLOAD_TOO_LARGE", `images[${index}] has invalid or oversized base64 data`);
      }
      if (typeof mimeType !== "string" || !REMOTE_IMAGE_MIME_TYPES.has(mimeType)) {
        throw new RemoteProtocolError("INVALID_REQUEST", `images[${index}] has an unsupported MIME type`);
      }
      total += data.length;
      if (total > MAX_REMOTE_IMAGE_DATA_TOTAL) throw new RemoteProtocolError("PAYLOAD_TOO_LARGE", "Image attachments are too large");
      return { type: "image", data, mimeType };
    });
  }

  private trimRequestCache(): void {
    if (this.requests.size <= 500) return;
    const first = this.requests.keys().next().value;
    if (first) this.requests.delete(first);
  }
}
