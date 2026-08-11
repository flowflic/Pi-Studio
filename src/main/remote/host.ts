import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import {
  errorFor,
  makeEnvelope,
  parseEnvelope,
  RemoteProtocolError,
  type RemoteDeviceInfo,
  type RemoteEnvelope,
} from "./protocol";
import { deviceIdFor, fingerprintFor, loadOrCreateIdentity, saveIdentity, signText, verifyText, type HostIdentity, type TrustedRemoteDevice } from "./identity";
import { RemoteService } from "./service";

export interface RemoteHostOptions {
  userDataDir: string;
  signalingUrl: string;
  stunUrls: string[];
  sendToRenderer: (channel: string, payload: unknown) => void;
  service: RemoteService;
}

interface PairingTicket {
  ticket: string;
  expiresAt: number;
}

interface ConnectionState {
  connectionId: string;
  sessionId: string;
  challenge: string;
  deviceId?: string;
  deviceName?: string;
  publicKeyPem?: string;
  authenticated: boolean;
}

const MAX_SIGNALING_RETRIES = 10;
const SIGNALING_RETRY_BASE_MS = 1_000;
const SIGNALING_RETRY_MAX_MS = 30_000;
const SIGNALING_HEARTBEAT_INTERVAL_MS = 20_000;

export class RemoteHost {
  private readonly identity: HostIdentity;
  private readonly connections = new Map<string, ConnectionState>();
  private readonly pairingTickets = new Map<string, PairingTicket>();
  private ws: WebSocket | null = null;
  private started = false;
  private signalingEnabled = false;
  private manualSignalingEnabled = false;
  private signalingState: "disabled" | "connecting" | "connected" | "error" = "disabled";
  private lastError: string | null = null;
  private signalingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private signalingCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private ticketCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private signalingLeaseTimer: ReturnType<typeof setTimeout> | null = null;
  private signalingHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private signalingHeartbeatAlive = true;
  private signalingRetryCount = 0;

  constructor(private readonly options: RemoteHostOptions) {
    this.identity = loadOrCreateIdentity(options.userDataDir);
    if (!options.signalingUrl) this.signalingState = "disabled";
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.signalingEnabled = false;
    this.manualSignalingEnabled = false;
    this.signalingState = "disabled";
    this.signalingRetryCount = 0;
    this.scheduleTicketCleanup();
  }

  configure(signalingUrl: string, stunUrls: string[]): void {
    const wasStarted = this.started;
    const wasSignalingEnabled = this.signalingEnabled;
    const wasManualSignalingEnabled = this.manualSignalingEnabled;
    if (wasStarted) this.stop();
    this.options.signalingUrl = signalingUrl;
    this.options.stunUrls = [...stunUrls];
    this.signalingState = "disabled";
    if (wasStarted) {
      this.start();
      if (wasSignalingEnabled && signalingUrl) this.enableSignaling(wasManualSignalingEnabled);
    }
  }

  /** Open signaling; manual enables stay open until the user turns them off. */
  enableSignaling(manual = false): boolean {
    if (!this.started || !this.options.signalingUrl) {
      this.signalingEnabled = false;
      this.manualSignalingEnabled = false;
      this.signalingState = "disabled";
      return false;
    }
    const wasEnabled = this.signalingEnabled;
    this.signalingEnabled = true;
    if (manual) this.manualSignalingEnabled = true;
    if (!wasEnabled) this.signalingRetryCount = 0;
    this.clearSignalingRetry();
    this.clearSignalingLease();
    this.clearSignalingCleanup();
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return true;
    this.connectSignaling();
    return true;
  }

  /** Close only WSS; active WebRTC data channels and remote sessions stay alive. */
  disableSignaling(): void {
    this.signalingEnabled = false;
    this.manualSignalingEnabled = false;
    this.signalingRetryCount = 0;
    this.clearSignalingRetry();
    this.clearSignalingLease();
    this.closePendingConnections();
    this.closeSignaling();
  }

  stop(): void {
    this.started = false;
    this.signalingEnabled = false;
    this.manualSignalingEnabled = false;
    this.signalingRetryCount = 0;
    this.clearSignalingRetry();
    this.clearSignalingCleanup();
    this.clearTicketCleanup();
    this.clearSignalingLease();
    for (const connection of this.connections.values()) {
      this.options.sendToRenderer("remote:signal", { connectionId: connection.connectionId, message: { type: "peer-closed" } });
    }
    this.connections.clear();
    this.options.service.disconnect("__all__");
    this.closeSignaling();
  }

  getStatus(): {
    enabled: boolean;
    signalingEnabled: boolean;
    hostId: string;
    signalingUrl: string;
    signalingState: string;
    directOnly: true;
    stunUrls: string[];
    devices: RemoteDeviceInfo[];
    pendingPairings: Array<{ connectionId: string; deviceId: string; name: string }>;
    lastError: string | null;
  } {
    return {
      enabled: this.started,
      signalingEnabled: this.signalingEnabled,
      hostId: this.identity.hostId,
      signalingUrl: this.options.signalingUrl,
      signalingState: this.signalingState,
      directOnly: true,
      stunUrls: [...this.options.stunUrls],
      devices: this.identity.trustedDevices.map((device) => ({
        deviceId: device.deviceId,
        name: device.name,
        connectedAt: this.connectionsForDevice(device.deviceId)[0]?.connectedAt || 0,
        authenticated: !!this.connectionsForDevice(device.deviceId).length,
      })),
      pendingPairings: [...this.connections.values()]
        .filter((c) => !!c.deviceId && !c.authenticated)
        .map((c) => ({ connectionId: c.connectionId, deviceId: c.deviceId!, name: c.deviceName || c.deviceId! })),
      lastError: this.lastError,
    };
  }

  createPairingTicket(): {
    hostId: string;
    fingerprint: string;
    hostPublicKeyPem: string;
    signalingUrl: string;
    stunUrls: string[];
    ticket: string;
    expiresAt: number;
    protocol: 1;
  } {
    this.pruneTickets();
    const ticket = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + 5 * 60_000;
    this.pairingTickets.set(ticket, { ticket, expiresAt });
    this.scheduleTicketCleanup();
    this.enableSignaling();
    this.pruneTickets();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "ticket", hostId: this.identity.hostId, ticket, expiresAt }));
    }
    return {
      hostId: this.identity.hostId,
      fingerprint: fingerprintFor(this.identity.publicKeyPem),
      hostPublicKeyPem: this.identity.publicKeyPem,
      signalingUrl: this.options.signalingUrl,
      stunUrls: [...this.options.stunUrls],
      ticket,
      expiresAt,
      protocol: 1,
    };
  }

  revokeDevice(deviceId: string): boolean {
    const before = this.identity.trustedDevices.length;
    this.identity.trustedDevices = this.identity.trustedDevices.filter((device) => device.deviceId !== deviceId);
    if (before === this.identity.trustedDevices.length) return false;
    saveIdentity(this.options.userDataDir, this.identity);
    for (const connection of this.connections.values()) {
      if (connection.deviceId === deviceId) {
        this.options.sendToRenderer("remote:signal", { connectionId: connection.connectionId, message: { type: "peer-closed" } });
        this.options.service.disconnect(connection.connectionId);
        this.connections.delete(connection.connectionId);
      }
    }
    this.maybeCloseSignaling();
    return true;
  }

  /** Renderer-side WebRTC transport calls this when a data channel opens. */
  transportOpened(connectionId: string, sessionId?: string): void {
    const connection = this.getOrCreateConnection(connectionId, sessionId);
    this.sendFrame(connection, makeEnvelope("pair.challenge", connection.sessionId, {
      hostId: this.identity.hostId,
      challenge: connection.challenge,
      hostPublicKeyPem: this.identity.publicKeyPem,
      signature: signText(this.identity.privateKeyPem, `pi-studio-remote-v1|${this.identity.hostId}|${connection.connectionId}|${connection.challenge}`),
      directOnly: true,
    }));
  }

  /** Renderer-side WebRTC transport forwards a data-channel frame here. */
  async handleTransportFrame(connectionId: string, raw: string): Promise<void> {
    const connection = this.getOrCreateConnection(connectionId);
    let request: RemoteEnvelope;
    try {
      request = parseEnvelope(raw);
    } catch (error) {
      const e = error instanceof RemoteProtocolError ? error : new RemoteProtocolError("INVALID_REQUEST", String(error));
      this.sendFrame(connection, makeEnvelope("error", connection.sessionId, undefined, { error: { code: e.code, message: e.message } }));
      return;
    }

    if (!connection.authenticated) {
      if (request.type !== "pair.hello") {
        this.sendFrame(connection, errorFor(request, "AUTH_REQUIRED", "Pairing is required before remote commands"));
        return;
      }
      this.handleHello(connection, request);
      return;
    }

    await this.options.service.handle(request, {
      connectionId: connection.connectionId,
      deviceId: connection.deviceId!,
      send: (message) => this.sendFrame(connection, message),
    });
  }

  transportClosed(connectionId: string, reason = "transport-closed"): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    const shouldReopenForReconnect = connection.authenticated && this.isReconnectFailure(reason);
    this.options.service.disconnect(connectionId);
    this.connections.delete(connectionId);
    if (shouldReopenForReconnect) {
      this.enableSignaling();
      this.scheduleSignalingLease();
    } else {
      this.maybeCloseSignaling();
    }
  }

  /**
   * Renderer-side ICE diagnostics are treated as a security boundary. A
   * selected relay candidate is never accepted, even if a future renderer
   * regression accidentally adds a TURN server to the peer connection.
   */
  transportStatus(connectionId: string, status: { state?: string; candidateType?: string; localCandidateType?: string; remoteCandidateType?: string }): void {
    const candidateTypes = [status.candidateType, status.localCandidateType, status.remoteCandidateType]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toLowerCase());
    if (candidateTypes.includes("relay") || status.state === "relay") {
      this.options.sendToRenderer("remote:signal", { connectionId, message: { type: "peer-closed", reason: "relay-candidate-rejected" } });
      this.transportClosed(connectionId);
    }
  }

  approvePairing(connectionId: string): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection?.deviceId || !connection.publicKeyPem) return false;
    const existing = this.identity.trustedDevices.find((device) => device.deviceId === connection.deviceId);
    const device: TrustedRemoteDevice = existing || {
      deviceId: connection.deviceId,
      name: connection.deviceName || connection.deviceId,
      publicKeyPem: connection.publicKeyPem,
      addedAt: Date.now(),
    };
    device.name = connection.deviceName || device.name;
    device.lastSeenAt = Date.now();
    if (!existing) this.identity.trustedDevices.push(device);
    saveIdentity(this.options.userDataDir, this.identity);
    connection.authenticated = true;
    this.sendFrame(connection, makeEnvelope("pair.accepted", connection.sessionId, {
      hostId: this.identity.hostId,
      deviceId: connection.deviceId,
      directOnly: true,
    }));
    this.scheduleSignalingCleanup();
    return true;
  }

  rejectPairing(connectionId: string): boolean {
    if (!this.connections.has(connectionId)) return false;
    this.options.sendToRenderer("remote:signal", { connectionId, message: { type: "peer-closed" } });
    this.transportClosed(connectionId);
    return true;
  }

  /** Forward a signal message from the renderer to the public signaling service. */
  sendSignal(connectionId: string, payload: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: "signal", hostId: this.identity.hostId, connectionId, payload }));
    return true;
  }

  private connectSignaling(): void {
    if (!this.started || !this.signalingEnabled || !this.options.signalingUrl) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.signalingState = "connecting";
    this.lastError = null;
    try {
      const ws = new WebSocket(this.options.signalingUrl);
      this.ws = ws;
      ws.on("open", () => {
        this.signalingState = "connected";
        // Retry limits apply to consecutive failures. A stable connection
        // must give the next network interruption a fresh retry budget.
        this.signalingRetryCount = 0;
        this.startSignalingHeartbeat(ws);
        ws.send(JSON.stringify({ type: "register-host", hostId: this.identity.hostId }));
        for (const value of this.pairingTickets.values()) {
          if (value.expiresAt > Date.now()) ws.send(JSON.stringify({ type: "ticket", hostId: this.identity.hostId, ticket: value.ticket, expiresAt: value.expiresAt }));
        }
      });
      ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString()) as { type?: string; connectionId?: string; payload?: unknown };
          if (message.type === "error" && this.ws === ws) {
            this.lastError = typeof (message as any).code === "string" ? String((message as any).code) : "signaling error";
            if ((message as any).code === "HOST_ALREADY_REGISTERED") {
              try {
                ws.close(1012, "host registration replaced");
              } catch {
                /* ignore close races; the close handler schedules the retry */
              }
            }
            return;
          }
          if (message.type === "peer-joined" && message.connectionId) {
            this.getOrCreateConnection(message.connectionId);
            this.options.sendToRenderer("remote:signal", { connectionId: message.connectionId, message: { type: "peer-joined" } });
          }
          if (message.type === "signal" && message.connectionId && message.payload) {
            this.getOrCreateConnection(message.connectionId);
            this.options.sendToRenderer("remote:signal", { connectionId: message.connectionId, message: message.payload });
          }
          if (message.type === "peer-closed" && message.connectionId) {
            // Once the data channel is authenticated, the signaling socket is
            // intentionally disposable. A relay-side close must not tear down
            // the still-healthy direct WebRTC session.
            if (this.connections.get(message.connectionId)?.authenticated) return;
            this.options.sendToRenderer("remote:signal", { connectionId: message.connectionId, message: { type: "peer-closed" } });
            this.transportClosed(message.connectionId);
          }
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
        }
      });
      ws.on("error", (error) => {
        this.signalingState = "error";
        this.lastError = error.message;
      });
      ws.on("close", () => {
        const isCurrent = this.ws === ws;
        if (isCurrent) {
          this.ws = null;
          this.clearSignalingHeartbeat();
        }
        if (isCurrent && this.started && this.signalingEnabled) {
          this.signalingState = "connecting";
          this.scheduleSignalingRetry();
        } else if (isCurrent && !this.signalingEnabled) {
          this.signalingState = "disabled";
        }
      });
    } catch (error) {
      this.signalingState = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      this.scheduleSignalingRetry();
    }
  }

  private closeSignaling(): void {
    const ws = this.ws;
    this.ws = null;
    this.clearSignalingHeartbeat();
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "detach", hostId: this.identity.hostId }));
        } catch {
          /* ignore shutdown races */
        }
      }
      try {
        ws.close(1000, "signaling not needed");
      } catch {
        /* ignore shutdown races */
      }
    }
    this.signalingState = "disabled";
  }

  private closePendingConnections(): void {
    for (const connection of [...this.connections.values()]) {
      if (connection.authenticated) continue;
      this.options.sendToRenderer("remote:signal", { connectionId: connection.connectionId, message: { type: "peer-closed" } });
      this.options.service.disconnect(connection.connectionId);
      this.connections.delete(connection.connectionId);
    }
  }

  private maybeCloseSignaling(): void {
    if (!this.signalingEnabled || this.manualSignalingEnabled) return;
    this.pruneTickets();
    const hasActiveTicket = [...this.pairingTickets.values()].some((value) => value.expiresAt > Date.now());
    const hasPendingConnection = [...this.connections.values()].some((connection) => !connection.authenticated);
    if (hasActiveTicket || hasPendingConnection) return;
    this.disableSignaling();
  }

  private scheduleSignalingCleanup(): void {
    this.clearSignalingCleanup();
    this.signalingCleanupTimer = setTimeout(() => {
      this.signalingCleanupTimer = null;
      this.maybeCloseSignaling();
    }, 1_000);
  }

  private scheduleTicketCleanup(): void {
    this.clearTicketCleanup();
    const nextExpiry = [...this.pairingTickets.values()]
      .map((value) => value.expiresAt)
      .filter((value) => value > Date.now())
      .sort((a, b) => a - b)[0];
    if (!nextExpiry) return;
    this.ticketCleanupTimer = setTimeout(() => {
      this.ticketCleanupTimer = null;
      this.pruneTickets();
      this.maybeCloseSignaling();
      this.scheduleTicketCleanup();
    }, Math.max(25, nextExpiry - Date.now() + 25));
  }

  private scheduleSignalingRetry(): void {
    this.clearSignalingRetry();
    if (this.signalingRetryCount >= MAX_SIGNALING_RETRIES) {
      this.exhaustSignalingRetries();
      return;
    }
    const retryIndex = this.signalingRetryCount++;
    const delay = Math.min(SIGNALING_RETRY_BASE_MS * (2 ** retryIndex), SIGNALING_RETRY_MAX_MS);
    this.signalingRetryTimer = setTimeout(() => {
      this.signalingRetryTimer = null;
      if (this.started && this.signalingEnabled) this.connectSignaling();
    }, delay);
  }

  private exhaustSignalingRetries(): void {
    this.clearSignalingRetry();
    this.clearSignalingLease();
    this.signalingEnabled = false;
    this.manualSignalingEnabled = false;
    this.closePendingConnections();
    this.closeSignaling();
    this.signalingRetryCount = 0;
    this.signalingState = "error";
    this.lastError = `Signaling retry limit reached (${MAX_SIGNALING_RETRIES})`;
  }

  private scheduleSignalingLease(): void {
    this.clearSignalingLease();
    this.signalingLeaseTimer = setTimeout(() => {
      this.signalingLeaseTimer = null;
      this.maybeCloseSignaling();
    }, 60_000);
  }

  private clearSignalingRetry(): void {
    if (!this.signalingRetryTimer) return;
    clearTimeout(this.signalingRetryTimer);
    this.signalingRetryTimer = null;
  }

  private clearSignalingCleanup(): void {
    if (!this.signalingCleanupTimer) return;
    clearTimeout(this.signalingCleanupTimer);
    this.signalingCleanupTimer = null;
  }

  private startSignalingHeartbeat(ws: WebSocket): void {
    this.clearSignalingHeartbeat();
    this.signalingHeartbeatAlive = true;
    ws.on("pong", () => {
      if (this.ws === ws) this.signalingHeartbeatAlive = true;
    });
    this.signalingHeartbeatTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        this.clearSignalingHeartbeat();
        return;
      }
      if (!this.signalingHeartbeatAlive) {
        try {
          ws.terminate();
        } catch {
          /* ignore close races; the close handler schedules the retry */
        }
        return;
      }
      this.signalingHeartbeatAlive = false;
      try {
        ws.ping();
      } catch {
        try {
          ws.close(1001, "signaling heartbeat failed");
        } catch {
          /* ignore close races; the close handler schedules the retry */
        }
      }
    }, SIGNALING_HEARTBEAT_INTERVAL_MS);
  }

  private clearSignalingHeartbeat(): void {
    if (!this.signalingHeartbeatTimer) return;
    clearInterval(this.signalingHeartbeatTimer);
    this.signalingHeartbeatTimer = null;
    this.signalingHeartbeatAlive = true;
  }

  private clearTicketCleanup(): void {
    if (!this.ticketCleanupTimer) return;
    clearTimeout(this.ticketCleanupTimer);
    this.ticketCleanupTimer = null;
  }

  private clearSignalingLease(): void {
    if (!this.signalingLeaseTimer) return;
    clearTimeout(this.signalingLeaseTimer);
    this.signalingLeaseTimer = null;
  }

  private isReconnectFailure(reason: string): boolean {
    return reason === "heartbeat-timeout" || reason === "heartbeat-send-failed" || reason === "ice-disconnected" || reason === "ice-failed" || reason === "connection-failed" || reason === "connection-closed" ||
      reason === "datachannel-error" || reason === "datachannel-closed" || reason === "send-failed";
  }

  private handleHello(connection: ConnectionState, request: RemoteEnvelope): void {
    const payload = (request.payload || {}) as Record<string, unknown>;
    const deviceId = typeof payload.deviceId === "string" ? payload.deviceId : "";
    const deviceName = typeof payload.deviceName === "string" ? payload.deviceName.slice(0, 80) : deviceId;
    const publicKeyPem = typeof payload.publicKeyPem === "string" ? payload.publicKeyPem : "";
    const signature = typeof payload.signature === "string" ? payload.signature : "";
    const ticket = typeof payload.ticket === "string" ? payload.ticket : "";
    if (!deviceId || !publicKeyPem || !signature || deviceIdFor(publicKeyPem) !== deviceId) {
      this.sendFrame(connection, errorFor(request, "AUTH_REQUIRED", "Invalid device identity"));
      return;
    }
    const signed = `pi-studio-remote-v1|${this.identity.hostId}|${connection.connectionId}|${connection.challenge}|${deviceId}`;
    if (!verifyText(publicKeyPem, signed, signature)) {
      this.sendFrame(connection, errorFor(request, "AUTH_REQUIRED", "Device signature is invalid"));
      return;
    }
    connection.deviceId = deviceId;
    connection.deviceName = deviceName;
    connection.publicKeyPem = publicKeyPem;
    const trusted = this.identity.trustedDevices.find((device) => device.deviceId === deviceId);
    if (trusted && trusted.publicKeyPem === publicKeyPem) {
      trusted.lastSeenAt = Date.now();
      saveIdentity(this.options.userDataDir, this.identity);
      connection.authenticated = true;
      this.sendFrame(connection, makeEnvelope("pair.accepted", connection.sessionId, { hostId: this.identity.hostId, deviceId, directOnly: true }));
      this.scheduleSignalingCleanup();
      return;
    }
    const pair = this.pairingTickets.get(ticket);
    if (!pair || pair.expiresAt <= Date.now()) {
      this.sendFrame(connection, errorFor(request, "PAIRING_EXPIRED", "Scan a fresh pairing QR code"));
      return;
    }
    this.pairingTickets.delete(ticket);
    this.scheduleTicketCleanup();
    this.sendFrame(connection, makeEnvelope("pair.pending", connection.sessionId, { hostId: this.identity.hostId, deviceId, deviceName }));
    this.options.sendToRenderer("remote:pairing-request", { connectionId: connection.connectionId, deviceId, deviceName });
  }

  private getOrCreateConnection(connectionId: string, sessionId?: string): ConnectionState {
    const existing = this.connections.get(connectionId);
    if (existing) return existing;
    const connection: ConnectionState = {
      connectionId,
      sessionId: sessionId || `remote-${randomBytes(10).toString("base64url")}`,
      challenge: randomBytes(32).toString("base64url"),
      authenticated: false,
    };
    this.connections.set(connectionId, connection);
    return connection;
  }

  private sendFrame(connection: ConnectionState, message: RemoteEnvelope): void {
    this.options.sendToRenderer("remote:outbound", { connectionId: connection.connectionId, frame: JSON.stringify(message) });
  }

  private connectionsForDevice(deviceId: string): Array<{ connectedAt: number }> {
    return [...this.connections.values()]
      .filter((connection) => connection.deviceId === deviceId && connection.authenticated)
      .map(() => ({ connectedAt: Date.now() }));
  }

  private pruneTickets(): void {
    const now = Date.now();
    for (const [ticket, value] of this.pairingTickets) if (value.expiresAt <= now) this.pairingTickets.delete(ticket);
  }
}
