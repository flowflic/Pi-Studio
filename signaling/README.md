# Pi Studio signaling service

This service only exchanges short-lived pairing tickets, SDP and ICE
candidates. It never receives Pi messages or application data. After a device
has been approved once, the client may send an expired-ticket resume marker so
the host can authenticate its persisted device key over the data channel; the
signaling service does not decide whether that device is trusted.

```powershell
npm install
$env:PORT = "8787"
node signaling/server.mjs
```

For production, put the service behind a TLS reverse proxy and configure the
desktop and Android clients with a `wss://` URL. TURN is deliberately not part
of this project: the clients use STUN for candidate discovery and reject relay
candidates.
