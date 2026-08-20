import { useEffect, useState } from "react";
import QRCode from "qrcode";

const DEFAULT_SIGNALING_URL = "wss://pi-studio-remote.scholarcn.com/ws";

type Pairing = {
  hostId: string;
  fingerprint: string;
  hostPublicKeyPem: string;
  signalingUrl: string;
  stunUrls: string[];
  ticket: string;
  expiresAt: number;
  protocol: number;
};

type RemoteStatus = {
  signalingEnabled: boolean;
  signalingUrl: string;
  signalingState: string;
  devices: Array<{ deviceId: string; name: string; connectedAt: number; authenticated: boolean }>;
  pendingPairings: Array<{ connectionId: string; deviceId: string; name: string }>;
};

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pairingUri(pairing: Pairing): string {
  return `pi-studio://pair?payload=${base64Url(JSON.stringify(pairing))}`;
}

function statusClass(state: string): string {
  return ["connected", "connecting", "error", "disabled"].includes(state) ? state : "disabled";
}

function statusLabel(state: string, zh: boolean): string {
  if (zh) {
    if (state === "connected") return "已连接";
    if (state === "connecting") return "连接中";
    if (state === "error") return "连接错误";
    return "未连接";
  }
  if (state === "connected") return "Connected";
  if (state === "connecting") return "Connecting";
  if (state === "error") return "Connection error";
  return "Not connected";
}

export function RemotePanel({ language }: { language: "en" | "zh" }) {
  const zh = language === "zh";
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [signalingUrl, setSignalingUrl] = useState(DEFAULT_SIGNALING_URL);
  const [busy, setBusy] = useState(false);

  const refresh = async (syncSignalUrl = true) => {
    try {
      const next = (await window.pi.remote.getStatus()) as RemoteStatus;
      setStatus(next);
      if (syncSignalUrl) setSignalingUrl(next.signalingUrl || DEFAULT_SIGNALING_URL);
    } catch {
      // The panel can briefly outlive the Electron IPC bridge during reload.
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(false), 1500);
    const off = window.pi.remote.onPairingRequest(() => void refresh(false));
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, []);

  const saveTransport = async () => {
    setBusy(true);
    try {
      await window.pi.remote.setConfig({ signalingUrl: signalingUrl.trim() });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const createPairing = async () => {
    setBusy(true);
    try {
      const next = (await window.pi.remote.createPairing()) as Pairing;
      setPairing(next);
      setQr(await QRCode.toDataURL(pairingUri(next), { width: 260, margin: 1, errorCorrectionLevel: "M" }));
    } finally {
      setBusy(false);
    }
  };

  const enableRemote = async () => {
    setBusy(true);
    try {
      await window.pi.remote.enableSignaling(true);
      await refresh(false);
    } finally {
      setBusy(false);
    }
  };

  const disableRemote = async () => {
    setBusy(true);
    try {
      await window.pi.remote.disableSignaling();
      await refresh(false);
    } finally {
      setBusy(false);
    }
  };

  const toggleRemote = async () => {
    if (status?.signalingEnabled) await disableRemote();
    else await enableRemote();
  };

  const state = status?.signalingState || "disabled";

  return (
    <div className="set-remote-stack">
      <div className="set-card">
        <div className="set-card-title">{zh ? "Android 手机远程控制" : "Android remote companion"}</div>
        <div className="set-hint">
          {zh
             ? "使用 WSS 信令和 STUN 直连 WebRTC。信令服务不会接收提示词、代码、对话或文件；TURN/relay 候选会被拒绝。"
            : "Uses WSS signaling and direct STUN WebRTC only. Signaling never receives prompts, code, conversations, or files; TURN/relay candidates are rejected."}
        </div>
        <div className="set-remote-status" aria-live="polite">
          <span className="set-diag-k">{zh ? "信令连接状态" : "Signal connection"}</span>
          <span className={`set-remote-status-value ${statusClass(state)}`}>
            <span className="set-remote-status-dot" aria-hidden="true" />
            {statusLabel(state, zh)}
          </span>
        </div>
      </div>

      <div className="set-card">
        <div className="set-card-title">{zh ? "信令配置" : "Signal settings"}</div>
        <label className="set-addprov-field wide">
           <span>{zh ? "信令地址（WSS）" : "Signal URL (WSS)"}</span>
          <input
            className="set-input"
            value={signalingUrl}
            onChange={(event) => setSignalingUrl(event.target.value)}
            placeholder={DEFAULT_SIGNALING_URL}
            spellCheck={false}
          />
        </label>
        <button className="set-btn primary" style={{ marginTop: 10 }} onClick={saveTransport} disabled={busy || !signalingUrl.trim()}>
          {zh ? "保存并重连" : "Save and reconnect"}
        </button>
        <div className="set-hint" style={{ marginTop: 10 }}>
          {zh
             ? "手动开启后信令会保持连接；配对或重连流程临时开启的信令会在直连认证完成后自动关闭。"
            : "Signal stays connected when enabled manually; pairing or reconnect flows close it after direct authentication."}
        </div>
        <div className="set-remote-toggle-row">
          <div className="set-remote-toggle-copy">
            <span className="set-remote-toggle-label">{zh ? "启用信令" : "Enable Signal"}</span>
            <span className="set-remote-toggle-state">
              {status?.signalingEnabled ? (zh ? "已启用" : "On") : (zh ? "已关闭" : "Off")}
            </span>
          </div>
          <button
            type="button"
            className={`set-toggle ${status?.signalingEnabled ? "on" : ""}`}
            role="switch"
            aria-checked={!!status?.signalingEnabled}
             aria-label={zh ? "切换信令" : "Toggle Signal"}
            onClick={() => void toggleRemote()}
            disabled={busy || !signalingUrl.trim()}
          >
            <span className="set-toggle-knob" />
          </button>
        </div>
      </div>

      <div className="set-card">
        <div className="set-card-title">{zh ? "配对手机" : "Pair a phone"}</div>
        <div className="set-hint">
          {zh
            ? "二维码包含短期票据、主机指纹、协议版本和连接地址，五分钟后失效。"
            : "The QR contains a short-lived ticket, host fingerprint, protocol, and endpoints. It expires after five minutes."}
        </div>
        <button className="set-btn primary" style={{ marginTop: 12 }} onClick={createPairing} disabled={busy || !signalingUrl.trim()}>
          {zh ? "生成配对二维码" : "Generate pairing QR"}
        </button>
        {pairing && (
          <div className="set-remote-pairing">
            {qr && <img src={qr} alt={zh ? "手机配对二维码" : "Phone pairing QR code"} width={260} height={260} />}
            <div className="set-hint">
            {zh ? "无法扫码时，可将下面的链接粘贴到 Android 应用。" : "If scanning is unavailable, paste this link into the Android app."}
            </div>
            <textarea className="set-input" rows={4} readOnly value={pairingUri(pairing)} />
            <div className="set-hint">{zh ? `指纹：${pairing.fingerprint}` : `Fingerprint: ${pairing.fingerprint}`}</div>
          </div>
        )}
      </div>

      {!!status?.pendingPairings.length && (
        <div className="set-card">
          <div className="set-card-title">{zh ? "待批准设备" : "Pending devices"}</div>
          {status.pendingPairings.map((device) => (
            <div className="set-diag-btns" key={device.connectionId}>
              <span>{device.name} · {device.deviceId}</span>
              <button className="set-btn primary" onClick={async () => { await window.pi.remote.approvePairing(device.connectionId); await refresh(); }}>
                {zh ? "允许" : "Approve"}
              </button>
              <button className="set-btn ghost" onClick={async () => { await window.pi.remote.rejectPairing(device.connectionId); await refresh(); }}>
                {zh ? "拒绝" : "Reject"}
              </button>
            </div>
          ))}
        </div>
      )}

      {!!status?.devices.length && (
        <div className="set-card">
          <div className="set-card-title">{zh ? "已信任设备" : "Trusted devices"}</div>
          {status.devices.map((device) => (
            <div className="set-diag-btns" key={device.deviceId}>
              <span>{device.name} · {device.authenticated ? (zh ? "已连接" : "connected") : (zh ? "离线" : "offline")}</span>
              <button className="set-btn ghost" onClick={async () => { await window.pi.remote.revokeDevice(device.deviceId); await refresh(); }}>
                {zh ? "撤销" : "Revoke"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
