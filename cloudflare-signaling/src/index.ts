import { DurableObject } from "cloudflare:workers";

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_HOST_ID_LENGTH = 160;
const MAX_CONNECTION_ID_LENGTH = 160;
const MAX_TICKET_LENGTH = 512;
const MAX_TICKET_TTL_MS = 5 * 60 * 1000;
const TICKET_PREFIX = "ticket:";
const GLOBAL_HUB_NAME = "global-v1";

interface Env {
  SIGNALING_HUB: DurableObjectNamespace<SignalingHub>;
}

type SocketRole = "unknown" | "host" | "client";

interface SocketAttachment {
  role: SocketRole;
  hostId: string;
  connectionId: string;
}

interface TicketRecord {
  hostId: string;
  expiresAt: number;
}

interface SignalingMessage {
  type?: unknown;
  hostId?: unknown;
  connectionId?: unknown;
  ticket?: unknown;
  expiresAt?: unknown;
  resume?: unknown;
  deviceId?: unknown;
  payload?: unknown;
}

const textEncoder = new TextEncoder();

function stringValue(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function isOpen(socket: WebSocket): boolean {
  return socket.readyState === 1;
}

function send(socket: WebSocket | undefined, message: Record<string, unknown>): void {
  if (!socket || !isOpen(socket)) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // A peer can disappear between the readyState check and send().
  }
}

function ticketKey(hostId: string, ticket: string): string {
  return `${TICKET_PREFIX}${hostId}:${ticket}`;
}

function validResume(message: SignalingMessage): boolean {
  return message.resume === true && /^device-[A-Za-z0-9_-]{8,80}$/.test(String(message.deviceId || ""));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }

    if (url.pathname !== "/ws") {
      return new Response("not found", { status: 404 });
    }

    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Upgrade Required", { status: 426 });
    }

    // v1 uses one small global hub so the existing Windows and Android clients
    // can use the deployed URL without adding host-sharding parameters.
    const id = env.SIGNALING_HUB.idFromName(GLOBAL_HUB_NAME);
    return env.SIGNALING_HUB.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class SignalingHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Upgrade Required", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = {
      role: "unknown",
      hostId: "",
      connectionId: "",
    };

    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") {
      send(socket, { type: "error", code: "BINARY_MESSAGE_REJECTED" });
      return;
    }

    if (textEncoder.encode(raw).byteLength > MAX_FRAME_BYTES) {
      send(socket, { type: "error", code: "FRAME_TOO_LARGE" });
      try {
        socket.close(1009, "frame too large");
      } catch {
        // Ignore close races.
      }
      return;
    }

    let message: SignalingMessage;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") throw new Error("message must be an object");
      message = parsed as SignalingMessage;
    } catch {
      send(socket, { type: "error", code: "INVALID_JSON" });
      return;
    }

    const type = typeof message.type === "string" ? message.type : "";
    const attachment = this.attachmentOf(socket);

    switch (type) {
      case "register-host":
        await this.registerHost(socket, attachment, message);
        return;
      case "ticket":
        await this.storeTicket(socket, attachment, message);
        return;
      case "join":
        await this.join(socket, attachment, message);
        return;
      case "signal":
        this.forwardSignal(socket, attachment, message);
        return;
      case "detach":
        this.detach(socket);
        return;
      default:
        send(socket, { type: "error", code: "UNKNOWN_MESSAGE_TYPE" });
    }
  }

  webSocketClose(socket: WebSocket): void {
    const attachment = this.attachmentOf(socket);
    if (!attachment.hostId) return;

    if (attachment.role === "host") {
      for (const peerSocket of this.sockets()) {
        if (peerSocket === socket) continue;
        const peer = this.attachmentOf(peerSocket);
        if (peer.role === "client" && peer.hostId === attachment.hostId) {
          send(peerSocket, { type: "peer-closed", connectionId: peer.connectionId });
        }
      }
      return;
    }

    if (attachment.role === "client" && attachment.connectionId) {
      const host = this.findHost(attachment.hostId);
      send(host, { type: "peer-closed", connectionId: attachment.connectionId });
    }
  }

  webSocketError(socket: WebSocket): void {
    this.webSocketClose(socket);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<TicketRecord>({ prefix: TICKET_PREFIX });
    let nextExpiry = Number.POSITIVE_INFINITY;

    for (const [key, record] of entries) {
      if (!record || record.expiresAt <= now) {
        await this.ctx.storage.delete(key);
      } else {
        nextExpiry = Math.min(nextExpiry, record.expiresAt);
      }
    }

    if (Number.isFinite(nextExpiry)) {
      await this.ctx.storage.setAlarm(nextExpiry);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private async registerHost(socket: WebSocket, attachment: SocketAttachment, message: SignalingMessage): Promise<void> {
    const hostId = stringValue(message.hostId, MAX_HOST_ID_LENGTH);
    if (!hostId) {
      send(socket, { type: "error", code: "INVALID_HOST" });
      return;
    }

    const existing = this.findHost(hostId);
    if (existing && existing !== socket) {
      // A half-open socket can survive a client network change long enough
      // to block the replacement host. Notify its clients, detach it from
      // host lookup immediately, and let the newest socket take ownership.
      for (const peerSocket of this.sockets()) {
        if (peerSocket === existing) continue;
        const peer = this.attachmentOf(peerSocket);
        if (peer.role === "client" && peer.hostId === hostId) {
          send(peerSocket, { type: "peer-closed", connectionId: peer.connectionId });
        }
      }
      existing.serializeAttachment({ role: "unknown", hostId: "", connectionId: "" } satisfies SocketAttachment);
      try {
        existing.close(1012, "host connection replaced");
      } catch {
        // Ignore a close race; the new host can still be registered.
      }
    }

    const next: SocketAttachment = {
      role: "host",
      hostId,
      connectionId: "",
    };
    socket.serializeAttachment(next);
    send(socket, { type: "registered", hostId });
  }

  private async storeTicket(socket: WebSocket, attachment: SocketAttachment, message: SignalingMessage): Promise<void> {
    if (attachment.role !== "host" || !attachment.hostId) return;

    const ticket = stringValue(message.ticket, MAX_TICKET_LENGTH);
    const requestedExpiresAt = Number(message.expiresAt || 0);
    const now = Date.now();
    if (!ticket || !Number.isFinite(requestedExpiresAt) || requestedExpiresAt <= now) return;

    // The desktop creates the ticket using its own clock. Do not reject a
    // valid ticket merely because the Worker clock is slightly different.
    // The Worker remains authoritative for the maximum lifetime.
    const expiresAt = Math.min(requestedExpiresAt, now + MAX_TICKET_TTL_MS);

    await this.ctx.storage.put<TicketRecord>(ticketKey(attachment.hostId, ticket), {
      hostId: attachment.hostId,
      expiresAt,
    });
    await this.ctx.storage.setAlarm(expiresAt);
  }

  private async join(socket: WebSocket, attachment: SocketAttachment, message: SignalingMessage): Promise<void> {
    const hostId = stringValue(message.hostId, MAX_HOST_ID_LENGTH);
    const connectionId = stringValue(message.connectionId, MAX_CONNECTION_ID_LENGTH);
    const ticket = stringValue(message.ticket, MAX_TICKET_LENGTH);
    const host = this.findHost(hostId);

    const record = ticket ? await this.ctx.storage.get<TicketRecord>(ticketKey(hostId, ticket)) : null;
    const freshTicket = !!record && record.hostId === hostId && record.expiresAt > Date.now();
    const resume = validResume(message);

    if (!connectionId) {
      send(socket, { type: "join-failed", code: "INVALID_CONNECTION" });
      return;
    }

    if (!freshTicket && !resume) {
      send(socket, { type: "join-failed", code: "PAIRING_EXPIRED" });
      return;
    }

    if (!host) {
      send(socket, { type: "join-failed", code: "HOST_OFFLINE" });
      return;
    }

    if (freshTicket && ticket) {
      await this.ctx.storage.delete(ticketKey(hostId, ticket));
    }

    const next: SocketAttachment = {
      role: "client",
      hostId,
      connectionId,
    };
    socket.serializeAttachment(next);
    send(socket, { type: "joined", connectionId, hostId });
    send(host, { type: "peer-joined", connectionId });
  }

  private forwardSignal(socket: WebSocket, attachment: SocketAttachment, message: SignalingMessage): void {
    const connectionId = stringValue(message.connectionId, MAX_CONNECTION_ID_LENGTH) || attachment.connectionId;
    if (!connectionId) {
      send(socket, { type: "error", code: "INVALID_CONNECTION" });
      return;
    }

    const peer = this.findPeer(attachment.hostId, connectionId);
    if (!peer) {
      send(socket, { type: "error", code: "PEER_NOT_FOUND" });
      return;
    }

    const target = attachment.role === "host" ? peer.client : peer.host;
    send(target, { type: "signal", connectionId, payload: message.payload });
  }

  private detach(socket: WebSocket): void {
    // A direct WebRTC session can outlive its signaling socket. Clearing the
    // attachment prevents webSocketClose() from reporting a false peer-closed
    // event to the other side when the signaling socket is intentionally shut.
    socket.serializeAttachment({ role: "unknown", hostId: "", connectionId: "" } satisfies SocketAttachment);
  }

  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets();
  }

  private attachmentOf(socket: WebSocket): SocketAttachment {
    const value = socket.deserializeAttachment() as Partial<SocketAttachment> | null;
    if (!value || typeof value !== "object") {
      return { role: "unknown", hostId: "", connectionId: "" };
    }
    return {
      role: value.role === "host" || value.role === "client" ? value.role : "unknown",
      hostId: typeof value.hostId === "string" ? value.hostId : "",
      connectionId: typeof value.connectionId === "string" ? value.connectionId : "",
    };
  }

  private findHost(hostId: string): WebSocket | undefined {
    return this.sockets().find((socket) => {
      const attachment = this.attachmentOf(socket);
      return attachment.role === "host" && attachment.hostId === hostId && isOpen(socket);
    });
  }

  private findPeer(hostId: string, connectionId: string): { host: WebSocket; client: WebSocket } | undefined {
    const host = this.findHost(hostId);
    const client = this.sockets().find((socket) => {
      const attachment = this.attachmentOf(socket);
      return attachment.role === "client" && attachment.hostId === hostId && attachment.connectionId === connectionId && isOpen(socket);
    });
    if (!host || !client) return undefined;
    return { host, client };
  }
}
