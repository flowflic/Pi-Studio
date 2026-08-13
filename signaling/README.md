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

## Nginx one-click configuration

The repository includes an interactive Nginx configuration script. It asks for
the domain, certificate path, private-key path, and the local signaling address,
then creates the HTTPS/WSS reverse proxy, enables it, validates the Nginx
configuration, and reloads Nginx:

```bash
bash scripts/configure-nginx-signaling.sh
```

The script can also be run non-interactively:

```bash
bash scripts/configure-nginx-signaling.sh \
  relay.example.com \
  /etc/letsencrypt/live/relay.example.com/fullchain.pem \
  /etc/letsencrypt/live/relay.example.com/privkey.pem \
  http://127.0.0.1:8787
```

The certificate and private-key files must already exist. The private key must
be unencrypted so Nginx can restart unattended. The script does not issue or
renew certificates and does not replace an existing unrelated Nginx site.
