import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const schema = JSON.parse(readFileSync(resolve(root, "protocol", "remote-v1.schema.json"), "utf8"));

assert.equal(schema.$id, "https://pi-studio.dev/protocol/remote-v1.schema.json");
assert.equal(schema.properties.v.const, 1);
assert.deepEqual(schema.required, ["v", "type", "sessionId", "sentAt"]);
assert.ok(schema.properties.type.maxLength <= 80);
assert.ok(schema["x-request-types"].includes("thread.setModel"));
assert.match(JSON.stringify(schema.$defs.remoteSkill), /skill:/);

const protocol = readFileSync(resolve(root, "src", "main", "remote", "protocol.ts"), "utf8");
assert.match(protocol, /"thread\.setModel"/);
assert.match(protocol, /interface RemoteModelOption/);
assert.match(protocol, /interface RemoteSkill/);
assert.match(protocol, /interface RemoteFileArtifact/);

const desktopIpc = readFileSync(resolve(root, "src", "main", "ipc.ts"), "utf8");
assert.match(desktopIpc, /availableModels: remoteModelOptions/);
assert.match(desktopIpc, /skills: remoteSkills/);
assert.match(desktopIpc, /MODEL_UNAVAILABLE/);
assert.match(desktopIpc, /lastReplyIndex/);
assert.match(desktopIpc, /remotePathFromArgs\(block\.arguments\)/);

const androidProtocol = readFileSync(resolve(root, "android", "app", "src", "main", "java", "com", "pistudio", "remote", "RemoteProtocol.kt"), "utf8");
assert.match(androidProtocol, /data class RemoteModelOption/);
assert.match(androidProtocol, /data class RemoteSkill/);
assert.match(androidProtocol, /data class RemoteFileArtifact/);

const androidMain = readFileSync(resolve(root, "android", "app", "src", "main", "java", "com", "pistudio", "remote", "MainActivity.kt"), "utf8");
assert.match(androidMain, /isAllowedHtmlPreviewUri/);
assert.match(androidMain, /requestDisallowInterceptTouchEvent/);
assert.match(androidMain, /return !isAllowedHtmlPreviewUri/);

const source = readFileSync(resolve(root, "src", "main", "remote", "host.ts"), "utf8");
assert.match(source, /directOnly:\s*true/);
assert.match(source, /relay-candidate-rejected/);
assert.doesNotMatch(source, /turns?:/i);

const config = readFileSync(resolve(root, "src", "main", "config.ts"), "utf8");
assert.match(config, /wss:\/\/pi-studio-remote\.scholarcn\.com\/ws/);
for (const stunUrl of [
  "stun:stun.miwifi.com:3478",
  "stun:stun.chat.bilibili.com:3478",
  "stun:stun.cloudflare.com:3478",
]) {
  assert.match(config, new RegExp(stunUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

const remotePanel = readFileSync(resolve(root, "src", "renderer", "src", "components", "RemotePanel.tsx"), "utf8");
assert.match(remotePanel, /Signal connection/);
assert.doesNotMatch(remotePanel, />Host ID<|>Transport<|>Last error<|STUN URLs|stunText/);

const transport = readFileSync(resolve(root, "src", "renderer", "src", "remote", "transport.ts"), "utf8");
assert.match(transport, /typ\\s\+relay/);
assert.match(transport, /iceServers/);
assert.match(transport, /transportStatus/);
assert.match(transport, /pi-remote-heartbeat-v1:ping/);
assert.match(transport, /heartbeat-timeout/);

const android = readFileSync(resolve(root, "android", "app", "src", "main", "java", "com", "pistudio", "remote", "WebRtcClient.kt"), "utf8");
assert.match(android, /startsWith\("stun:/i);
assert.match(android, /direct-connection-rejected-relay/);
assert.doesNotMatch(android, /turn:/i);
assert.match(android, /private var connectionId/);
assert.match(android, /HEARTBEAT_PING/);

console.log("remote protocol checks passed");
