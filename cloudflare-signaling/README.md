# Pi Studio Cloudflare signaling

This Worker is the public signaling endpoint for the isolated Pi Studio remote
companion. It forwards only WebRTC signaling messages between a Windows host and
an Android client. Prompts, Pi events, project data and files stay on the direct
WebRTC DataChannel.

## Local commands

```powershell
npm install
npm run typecheck
npm run dev
npm run deploy
```

The deployed client URL is:

```text
wss://pi-studio-signaling.<account-subdomain>.workers.dev/ws
```

The local Windows and Android clients use `register-host`, `ticket`, `join`,
`signal`, and `detach`. The desktop opens signaling on demand for pairing or
reconnect, and both peers detach after direct WebRTC authentication so the
Durable Object does not keep an unnecessary signaling session alive. A resume
join may receive `HOST_OFFLINE` while the desktop is reopening its signaling
lease; clients retry that transient result with exponential backoff and a
bounded attempt count.

## Cloudflare settings

- Durable Object binding: `SIGNALING_HUB`
- Durable Object class: `SignalingHub`
- Storage: SQLite
- WebRTC transport policy: STUN/direct only; TURN is not configured here
- Do not enable Cloudflare Access for `/ws` unless both clients are changed to
  send an Access JWT
