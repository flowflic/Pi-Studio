import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import WebSocket from "ws";

const root = resolve(import.meta.dirname, "..");
const port = 18787;
const server = spawn(process.execPath, [resolve(root, "signaling", "server.mjs")], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function waitHealth() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      /* server is still starting */
    }
    await delay(50);
  }
  throw new Error("signaling server did not start");
}

function open() {
  return new Promise((resolveOpen, rejectOpen) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once("open", () => resolveOpen(socket));
    socket.once("error", rejectOpen);
  });
}

function nextMessage(socket, predicate) {
  return new Promise((resolveMessage, rejectMessage) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      rejectMessage(new Error("signaling message timeout"));
    }, 3000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolveMessage(message);
    };
    socket.on("message", onMessage);
  });
}

try {
  await waitHealth();
  const host = await open();
  const client = await open();
  const connectionId = "test-connection";
  host.send(JSON.stringify({ type: "register-host", hostId: "test-host" }));
  await delay(20);
  host.send(JSON.stringify({ type: "ticket", hostId: "test-host", ticket: "test-ticket", expiresAt: Date.now() + 30_000 }));

  const joinedOnHost = nextMessage(host, (message) => message.type === "peer-joined");
  const joinedOnClient = nextMessage(client, (message) => message.type === "joined");
  client.send(JSON.stringify({ type: "join", hostId: "test-host", connectionId, ticket: "test-ticket" }));
  await joinedOnClient;
  assert.equal((await joinedOnHost).connectionId, connectionId);

  const signalOnHost = nextMessage(host, (message) => message.type === "signal");
  client.send(JSON.stringify({ type: "signal", connectionId, payload: { type: "offer", sdp: "opaque-sdp" } }));
  assert.deepEqual((await signalOnHost).payload, { type: "offer", sdp: "opaque-sdp" });

  const signalOnClient = nextMessage(client, (message) => message.type === "signal");
  host.send(JSON.stringify({ type: "signal", connectionId, payload: { type: "answer", sdp: "opaque-answer" } }));
  assert.deepEqual((await signalOnClient).payload, { type: "answer", sdp: "opaque-answer" });

  let detachedPeerClosed = false;
  const onDetachedPeerClosed = (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "peer-closed" && message.connectionId === connectionId) detachedPeerClosed = true;
  };
  host.on("message", onDetachedPeerClosed);
  client.send(JSON.stringify({ type: "detach" }));
  await delay(20);
  client.close();
  await delay(100);
  host.off("message", onDetachedPeerClosed);
  assert.equal(detachedPeerClosed, false, "detaching signaling must preserve the direct peer");

  const resumed = await open();
  const resumeConnectionId = "resume-connection";
  const resumedOnHost = nextMessage(host, (message) => message.type === "peer-joined" && message.connectionId === resumeConnectionId);
  const resumedOnClient = nextMessage(resumed, (message) => message.type === "joined" && message.connectionId === resumeConnectionId);
  resumed.send(JSON.stringify({
    type: "join",
    hostId: "test-host",
    connectionId: resumeConnectionId,
    ticket: "expired-ticket",
    resume: true,
    deviceId: "device-12345678",
  }));
  await resumedOnClient;
  assert.equal((await resumedOnHost).connectionId, resumeConnectionId);
  let detachedHostPeerClosed = false;
  const onDetachedHostPeerClosed = (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "peer-closed" && message.connectionId === resumeConnectionId) detachedHostPeerClosed = true;
  };
  resumed.on("message", onDetachedHostPeerClosed);
  host.send(JSON.stringify({ type: "detach" }));
  await delay(20);
  host.close();
  await delay(100);
  resumed.off("message", onDetachedHostPeerClosed);
  assert.equal(detachedHostPeerClosed, false, "detaching the host signaling socket must preserve the direct peer");

  const offline = await open();
  const offlineFailure = nextMessage(offline, (message) => message.type === "join-failed");
  offline.send(JSON.stringify({
    type: "join",
    hostId: "test-host",
    connectionId: "offline-connection",
    ticket: "expired-ticket",
    resume: true,
    deviceId: "device-12345678",
  }));
  assert.equal((await offlineFailure).code, "HOST_OFFLINE");
  offline.close();
  resumed.close();

  client.close();
  console.log("remote signaling checks passed");
} finally {
  server.kill();
}
