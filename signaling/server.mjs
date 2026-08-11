import http from "node:http";
import { WebSocketServer } from "ws";

const port = Number(process.env.PORT || 8787);
const hostTickets = new Map();
const hosts = new Map();
const peers = new Map();

function now() {
  return Date.now();
}

function send(ws, message) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
}

function prune() {
  const t = now();
  for (const [key, value] of hostTickets) if (value.expiresAt <= t) hostTickets.delete(key);
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, hosts: hosts.size, peers: peers.size }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
wss.on("connection", (ws) => {
  let role = "unknown";
  let hostId = "";
  let connectionId = "";

  ws.on("message", (raw) => {
    prune();
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", code: "INVALID_JSON" });
      return;
    }

    if (message.type === "register-host") {
      role = "host";
      hostId = String(message.hostId || "");
      if (!hostId) return send(ws, { type: "error", code: "INVALID_HOST" });
      const existing = hosts.get(hostId);
      if (existing && existing !== ws) {
        for (const [id, peer] of peers) {
          if (peer.host !== existing) continue;
          send(peer.client, { type: "peer-closed", connectionId: id });
          peers.delete(id);
        }
        hosts.delete(hostId);
        try {
          existing.close(1012, "host connection replaced");
        } catch {
          /* ignore a close race; the new host can still be registered */
        }
      }
      hosts.set(hostId, ws);
      send(ws, { type: "registered", hostId });
      return;
    }

    if (message.type === "ticket" && role === "host") {
      const ticket = String(message.ticket || "");
      const expiresAt = Number(message.expiresAt || 0);
      if (ticket && expiresAt > now()) hostTickets.set(`${hostId}:${ticket}`, { hostId, expiresAt, host: ws });
      return;
    }

    if (message.type === "join") {
      role = "client";
      hostId = String(message.hostId || "");
      connectionId = String(message.connectionId || "");
      const ticket = String(message.ticket || "");
      const record = hostTickets.get(`${hostId}:${ticket}`);
      const host = hosts.get(hostId);
      // After the first approval, the desktop authenticates the device over
      // the WebRTC data channel using its persisted Ed25519 key. The signaling
      // service does not know the trusted-device list, so it may only let an
      // expired-ticket resume attempt reach the host; the host remains the
      // authority and rejects unknown device identities.
      const resume = message.resume === true && /^device-[A-Za-z0-9_-]{8,80}$/.test(String(message.deviceId || ""));
      if (!connectionId) {
        send(ws, { type: "join-failed", code: "INVALID_CONNECTION" });
        return;
      }
      if ((!record || record.expiresAt <= now()) && !resume) {
        send(ws, { type: "join-failed", code: "PAIRING_EXPIRED" });
        return;
      }
      if (!host) {
        send(ws, { type: "join-failed", code: "HOST_OFFLINE" });
        return;
      }
      peers.set(connectionId, { host, client: ws, hostId });
      send(ws, { type: "joined", connectionId, hostId });
      send(host, { type: "peer-joined", connectionId });
      return;
    }

    if (message.type === "signal") {
      const signalConnectionId = String(message.connectionId || connectionId || "");
      if (!signalConnectionId) return send(ws, { type: "error", code: "INVALID_CONNECTION" });
      const peer = peers.get(signalConnectionId);
      if (!peer) return send(ws, { type: "error", code: "PEER_NOT_FOUND" });
      const target = role === "host" ? peer.client : peer.host;
      send(target, { type: "signal", connectionId: signalConnectionId, payload: message.payload });
      return;
    }

    if (message.type === "detach") {
      if (role === "host" && hosts.get(hostId) === ws) hosts.delete(hostId);
      for (const [id, peer] of peers) {
        if (peer.host === ws || peer.client === ws) peers.delete(id);
      }
      role = "unknown";
      hostId = "";
      connectionId = "";
    }
  });

  ws.on("close", () => {
    if (role === "host" && hosts.get(hostId) === ws) hosts.delete(hostId);
    for (const [id, peer] of peers) {
      if (peer.host === ws || peer.client === ws) {
        const target = peer.host === ws ? peer.client : peer.host;
        send(target, { type: "peer-closed", connectionId: id });
        peers.delete(id);
      }
    }
    for (const [key, ticket] of hostTickets) if (ticket.host === ws) hostTickets.delete(key);
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[pi-studio-signaling] listening on :${port}`);
});
