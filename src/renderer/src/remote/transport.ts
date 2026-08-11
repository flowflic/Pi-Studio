/**
 * Desktop-side WebRTC host transport.
 *
 * The public signaling service only delivers the messages handled here. Pi
 * protocol frames remain inside the SCTP data channel. This class intentionally
 * creates STUN-only peer connections and closes a connection if the selected
 * candidate pair ever reports a relay candidate.
 */

type SignalMessage = {
  type?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit | string | null;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
};

type Peer = {
  connectionId: string;
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  opened: boolean;
  queue: string[];
  incomingChunks: Map<string, IncomingChunk>;
  pendingCandidates: RTCIceCandidateInit[];
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null;
  heartbeatAwaitingPong: boolean;
  closed: boolean;
};

type TransportConfig = { stunUrls: string[]; directOnly: boolean };

type IncomingChunk = {
  total: number;
  parts: Array<string | undefined>;
  received: number;
  encodedLength: number;
};

const REMOTE_CHUNK_PREFIX = "pi-remote-chunk-v1:";
const MAX_DATA_CHANNEL_MESSAGE_BYTES = 16_000;
const MAX_CHUNK_DATA_CHARS = 10_000;
const MAX_REASSEMBLED_FRAME_BYTES = 2_000_000;
const MAX_INCOMING_CHUNKS = 512;
const ICE_DISCONNECTED_GRACE_MS = 10_000;
const HEARTBEAT_PING = "pi-remote-heartbeat-v1:ping";
const HEARTBEAT_PONG = "pi-remote-heartbeat-v1:pong";
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isRelayCandidate(candidate: RTCIceCandidateInit | string | null | undefined): boolean {
  const text = typeof candidate === "string" ? candidate : candidate?.candidate;
  return typeof text === "string" && /\btyp\s+relay\b/i.test(text);
}

export class RemoteWebRtcTransport {
  private started = false;
  private config: TransportConfig = { stunUrls: [], directOnly: true };
  private peers = new Map<string, Peer>();
  private offSignal: (() => void) | null = null;
  private offOutbound: (() => void) | null = null;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.config = (await window.pi.remote.getTransportConfig()) as TransportConfig;
    this.offSignal = window.pi.remote.onSignal((payload) => void this.handleSignal(payload.connectionId, payload.message));
    this.offOutbound = window.pi.remote.onOutbound((payload) => this.handleOutbound(payload.connectionId, payload.frame));
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.offSignal?.();
    this.offOutbound?.();
    this.offSignal = null;
    this.offOutbound = null;
    for (const peer of this.peers.values()) this.closePeer(peer, false);
    this.peers.clear();
  }

  private async handleSignal(connectionId: string, message: SignalMessage): Promise<void> {
    if (message?.type === "peer-closed") {
      const peer = this.peers.get(connectionId);
      if (peer) this.closePeer(peer, false);
      this.peers.delete(connectionId);
      return;
    }

    const peer = this.ensurePeer(connectionId);
    if (message?.type === "offer" && typeof message.sdp === "string") {
      await peer.pc.setRemoteDescription({ type: "offer", sdp: message.sdp });
      await this.flushCandidates(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      await window.pi.remote.sendSignal({
        connectionId,
        payload: { type: "answer", sdp: answer.sdp || "" },
      });
      return;
    }

    if (message?.type === "answer" && typeof message.sdp === "string") {
      await peer.pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
      await this.flushCandidates(peer);
      return;
    }

    if (message?.type === "candidate" && message.candidate) {
      if (isRelayCandidate(message.candidate)) {
        this.rejectRelay(peer);
        return;
      }
      const candidate = typeof message.candidate === "string"
        ? { candidate: message.candidate, sdpMid: message.sdpMid ?? null, sdpMLineIndex: message.sdpMLineIndex ?? null }
        : message.candidate;
      if (peer.pc.remoteDescription) {
        await peer.pc.addIceCandidate(candidate);
      } else {
        peer.pendingCandidates.push(candidate);
      }
    }
  }

  private ensurePeer(connectionId: string): Peer {
    const existing = this.peers.get(connectionId);
    if (existing) return existing;

    const iceServers = (this.config.stunUrls || [])
      .filter((url) => /^stun:/i.test(url.trim()))
      .map((url) => ({ urls: url.trim() }));
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: "all" });
    const peer: Peer = {
      connectionId,
      pc,
      channel: null,
      opened: false,
      queue: [],
      incomingChunks: new Map(),
      pendingCandidates: [],
      disconnectTimer: null,
      heartbeatTimer: null,
      heartbeatTimeoutTimer: null,
      heartbeatAwaitingPong: false,
      closed: false,
    };
    this.peers.set(connectionId, peer);

    pc.onicecandidate = (event) => {
      const candidate = event.candidate?.toJSON?.() || event.candidate;
      if (!candidate) return;
      if (isRelayCandidate(candidate)) {
        this.rejectRelay(peer);
        return;
      }
      void window.pi.remote.sendSignal({ connectionId, payload: { type: "candidate", ...candidate } });
    };
    pc.ondatachannel = (event) => this.attachChannel(peer, event.channel);
    pc.oniceconnectionstatechange = () => {
      void this.reportSelectedCandidate(peer);
      if (pc.iceConnectionState === "failed") this.closePeer(peer, true, "ice-failed");
      else if (pc.iceConnectionState === "closed") this.closePeer(peer, true, "connection-closed");
      else this.updateDisconnectedRecovery(peer);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") this.closePeer(peer, true, "connection-failed");
      else if (pc.connectionState === "closed") this.closePeer(peer, true, "connection-closed");
      else this.updateDisconnectedRecovery(peer);
    };
    return peer;
  }

  private attachChannel(peer: Peer, channel: RTCDataChannel): void {
    if (peer.closed) {
      channel.close();
      return;
    }
    peer.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      peer.opened = true;
      void window.pi.remote.transportOpen({ connectionId: peer.connectionId });
      this.startHeartbeat(peer);
      this.flushQueue(peer);
      void this.reportSelectedCandidate(peer);
    };
    channel.onmessage = (event) => {
      const frame = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      this.handleInboundFrame(peer, frame);
    };
    channel.onerror = () => this.closePeer(peer, true, "datachannel-error");
    channel.onclose = () => this.closePeer(peer, true, "datachannel-closed");
  }

  private handleOutbound(connectionId: string, frame: string): void {
    const peer = this.peers.get(connectionId);
    if (!peer || peer.closed) return;
    if (peer.channel?.readyState === "open") {
      this.sendFrame(peer, frame);
    } else {
      peer.queue.push(frame);
      if (peer.queue.length > 50) peer.queue.shift();
    }
  }

  private flushQueue(peer: Peer): void {
    if (peer.channel?.readyState !== "open") return;
    for (const frame of peer.queue.splice(0)) {
      if (!this.sendFrame(peer, frame)) break;
    }
  }

  private sendFrame(peer: Peer, frame: string): boolean {
    const channel = peer.channel;
    if (!channel || channel.readyState !== "open") return false;
    const bytes = new TextEncoder().encode(frame);
    try {
      if (bytes.byteLength <= MAX_DATA_CHANNEL_MESSAGE_BYTES) {
        channel.send(frame);
        return true;
      }
      const encoded = bytesToBase64(bytes);
      const total = Math.ceil(encoded.length / MAX_CHUNK_DATA_CHARS);
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      for (let index = 0; index < total; index++) {
        const chunk = `${REMOTE_CHUNK_PREFIX}${JSON.stringify({
          id,
          index,
          total,
          data: encoded.slice(index * MAX_CHUNK_DATA_CHARS, (index + 1) * MAX_CHUNK_DATA_CHARS),
        })}`;
        channel.send(chunk);
      }
      return true;
    } catch {
      this.closePeer(peer, true, "send-failed");
      return false;
    }
  }

  private handleInboundFrame(peer: Peer, frame: string): void {
    if (frame === HEARTBEAT_PONG) {
      this.ackHeartbeat(peer);
      return;
    }
    if (frame === HEARTBEAT_PING) {
      try {
        peer.channel?.send(HEARTBEAT_PONG);
      } catch {
        this.closePeer(peer, true, "heartbeat-send-failed");
      }
      return;
    }
    if (!frame.startsWith(REMOTE_CHUNK_PREFIX)) {
      void window.pi.remote.transportFrame({ connectionId: peer.connectionId, frame });
      return;
    }
    try {
      const chunk = JSON.parse(frame.slice(REMOTE_CHUNK_PREFIX.length)) as {
        id?: unknown;
        index?: unknown;
        total?: unknown;
        data?: unknown;
      };
      const id = typeof chunk.id === "string" ? chunk.id : "";
      const index = typeof chunk.index === "number" ? chunk.index : -1;
      const total = typeof chunk.total === "number" ? chunk.total : 0;
      const data = typeof chunk.data === "string" ? chunk.data : "";
      if (!id || id.length > 100 || total < 1 || total > MAX_INCOMING_CHUNKS || index < 0 || index >= total || !data) return;
      let assembly = peer.incomingChunks.get(id);
      if (!assembly) {
        assembly = { total, parts: Array(total), received: 0, encodedLength: 0 };
        peer.incomingChunks.set(id, assembly);
      }
      if (assembly.total !== total || assembly.parts[index] !== undefined) return;
      assembly.parts[index] = data;
      assembly.received++;
      assembly.encodedLength += data.length;
      if (assembly.encodedLength > MAX_REASSEMBLED_FRAME_BYTES * 2) {
        peer.incomingChunks.delete(id);
        return;
      }
      if (assembly.received !== assembly.total) return;
      peer.incomingChunks.delete(id);
      const decoded = new TextDecoder().decode(base64ToBytes(assembly.parts.join("")));
      if (new TextEncoder().encode(decoded).byteLength > MAX_REASSEMBLED_FRAME_BYTES) return;
      void window.pi.remote.transportFrame({ connectionId: peer.connectionId, frame: decoded });
    } catch {
      // Ignore malformed fragments; the authenticated protocol frame will
      // still be rejected if a complete message cannot be reconstructed.
    }
  }

  private async flushCandidates(peer: Peer): Promise<void> {
    if (!peer.pc.remoteDescription) return;
    for (const candidate of peer.pendingCandidates.splice(0)) await peer.pc.addIceCandidate(candidate);
  }

  private async reportSelectedCandidate(peer: Peer): Promise<void> {
    if (peer.closed) return;
    try {
      const stats = await peer.pc.getStats();
      let pair: any;
      const candidates = new Map<string, any>();
      stats.forEach((report: any) => {
        if (report.type === "candidate-pair" && (report.selected || report.nominated || report.state === "succeeded")) pair = report;
        if (report.type === "local-candidate" || report.type === "remote-candidate") candidates.set(report.id, report);
      });
      if (!pair) return;
      const local = candidates.get(pair.localCandidateId);
      const remote = candidates.get(pair.remoteCandidateId);
      const localType = typeof local?.candidateType === "string" ? local.candidateType : undefined;
      const remoteType = typeof remote?.candidateType === "string" ? remote.candidateType : undefined;
      if (localType === "relay" || remoteType === "relay") {
        this.rejectRelay(peer);
        return;
      }
      void window.pi.remote.transportStatus({
        connectionId: peer.connectionId,
        state: pair.state,
        localCandidateType: localType,
        remoteCandidateType: remoteType,
      });
    } catch {
      /* ICE stats are best-effort; candidate strings are still filtered. */
    }
  }

  private rejectRelay(peer: Peer): void {
    if (peer.closed) return;
    void window.pi.remote.transportStatus({ connectionId: peer.connectionId, state: "relay" });
    this.closePeer(peer, true, "relay-rejected");
  }

  private updateDisconnectedRecovery(peer: Peer): void {
    if (peer.closed) return;
    const disconnected = peer.pc.iceConnectionState === "disconnected" || peer.pc.connectionState === "disconnected";
    if (!disconnected) {
      this.clearDisconnectedRecovery(peer);
      return;
    }
    if (peer.disconnectTimer) return;
    peer.disconnectTimer = setTimeout(() => {
      peer.disconnectTimer = null;
      if (peer.closed) return;
      const stillDisconnected = peer.pc.iceConnectionState === "disconnected" || peer.pc.connectionState === "disconnected";
      if (stillDisconnected) this.closePeer(peer, true, "ice-disconnected");
    }, ICE_DISCONNECTED_GRACE_MS);
  }

  private clearDisconnectedRecovery(peer: Peer): void {
    if (!peer.disconnectTimer) return;
    clearTimeout(peer.disconnectTimer);
    peer.disconnectTimer = null;
  }

  private startHeartbeat(peer: Peer): void {
    this.stopHeartbeat(peer);
    const ping = () => {
      if (peer.closed || peer.channel?.readyState !== "open" || peer.heartbeatAwaitingPong) return;
      try {
        peer.channel.send(HEARTBEAT_PING);
        peer.heartbeatAwaitingPong = true;
        peer.heartbeatTimeoutTimer = setTimeout(() => {
          peer.heartbeatTimeoutTimer = null;
          if (!peer.closed) this.closePeer(peer, true, "heartbeat-timeout");
        }, HEARTBEAT_TIMEOUT_MS);
      } catch {
        this.closePeer(peer, true, "heartbeat-send-failed");
      }
    };
    ping();
    peer.heartbeatTimer = setInterval(ping, HEARTBEAT_INTERVAL_MS);
  }

  private ackHeartbeat(peer: Peer): void {
    peer.heartbeatAwaitingPong = false;
    if (!peer.heartbeatTimeoutTimer) return;
    clearTimeout(peer.heartbeatTimeoutTimer);
    peer.heartbeatTimeoutTimer = null;
  }

  private stopHeartbeat(peer: Peer): void {
    if (peer.heartbeatTimer) clearInterval(peer.heartbeatTimer);
    if (peer.heartbeatTimeoutTimer) clearTimeout(peer.heartbeatTimeoutTimer);
    peer.heartbeatTimer = null;
    peer.heartbeatTimeoutTimer = null;
    peer.heartbeatAwaitingPong = false;
  }

  private closePeer(peer: Peer, notifyMain: boolean, reason = "transport-closed"): void {
    if (peer.closed) return;
    peer.closed = true;
    peer.opened = false;
    this.clearDisconnectedRecovery(peer);
    this.stopHeartbeat(peer);
    if (this.peers.get(peer.connectionId) === peer) this.peers.delete(peer.connectionId);
    peer.incomingChunks.clear();
    try {
      peer.channel?.close();
      peer.pc.close();
    } catch {
      /* ignore already-closed WebRTC objects */
    }
    if (notifyMain) void window.pi.remote.transportClose({ connectionId: peer.connectionId, reason });
  }
}

export const remoteWebRtcTransport = new RemoteWebRtcTransport();
