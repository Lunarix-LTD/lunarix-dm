# Lunarix Daemon — API Reference

Complete reference for panel↔node integration. Covers HTTP, WebSocket, obfuscated transport, and all subsystems.

---

## Table of Contents

1. [Authentication](#authentication)
2. [TLS & Transport Security](#tls--transport-security)
3. [Traffic Obfuscation (DPI bypass)](#traffic-obfuscation-dpi-bypass)
4. [Base Endpoints](#base-endpoints)
5. [Instances](#instances)
6. [Deployment](#deployment)
7. [Power Actions](#power-actions)
8. [File System](#file-system)
9. [Archives](#archives)
10. [Database](#database)
11. [FTP](#ftp)
12. [Network Isolation & Bandwidth](#network-isolation--bandwidth)
13. [Scheduler](#scheduler)
14. [Xray Sidecar](#xray-sidecar-game-traffic-obfuscation)
15. [Metrics](#metrics)
16. [WebSocket — Standard](#websocket--standard)
17. [WebSocket — Obfuscated](#websocket--obfuscated)

---

## Authentication

All HTTP endpoints use **HTTP Basic Auth**.

| Field    | Value                    |
|----------|--------------------------|
| Username | `Lunarix`                |
| Password | `key` from `config.json` |

Both HTTP and WebSocket auth use `crypto.timingSafeEqual` — timing attacks are not effective.

```bash
curl -u Lunarix:<key> https://<node>:3002/
```

---

## TLS & Transport Security

### Enabling TLS

Add to `config.json`:

```json
{
  "tls": {
    "enabled":  true,
    "certPath": "./certs/server.crt",
    "keyPath":  "./certs/server.key"
  }
}
```

When `tls.enabled` is `true`:
- Daemon starts an **HTTPS** server; WebSocket uses **WSS**
- If cert files are missing, a self-signed RSA-4096 cert is generated at `./certs/`
- Only TLS 1.2+ is accepted; ciphers restricted to AEAD (AES-256-GCM, ChaCha20-Poly1305)

### Production certificate (Let's Encrypt)

```bash
certbot certonly --standalone -d node.yourdomain.com
cp /etc/letsencrypt/live/node.yourdomain.com/fullchain.pem ./certs/server.crt
cp /etc/letsencrypt/live/node.yourdomain.com/privkey.pem   ./certs/server.key
```

### Trusting the self-signed cert on the panel side

```js
const https = require('https');
const fs    = require('fs');

const agent = new https.Agent({ ca: fs.readFileSync('./node-cert.crt') });
axios.get('https://node:3002/', { httpsAgent: agent });
```

---

## Traffic Obfuscation (DPI bypass)

Two layers make daemon traffic undetectable by DPI and bypass whitelist-based filtering.

### Layer 1 — Fake CDN headers

Every HTTP response includes Cloudflare-style headers:

```
CF-Ray: a1b2c3d4e5f6a7b8-AMS
CF-Cache-Status: DYNAMIC
Server: cloudflare
Alt-Svc: h3=":443"; ma=86400
```

### Layer 2 — Obfuscated WebSocket channel

Standard paths (`/exec/`, `/stats/`) are recognisable daemon signatures. The obfuscated channel disguises them.

**Disguised URL:** `wss://node:3002/cdn-cgi/ws?p=<realPath>`

**Frame format:**

```
[1 byte: padding length N] [N random bytes] [XOR(payload, sessionKey)]
```

- `sessionKey` = HKDF-SHA256(daemonKey, randomNonce, `"lunarix-obfs-v1"`) — 256-bit
- Random padding (0–64 bytes) per frame defeats length-based traffic analysis
- The auth key never appears in plaintext — it travels inside the obfuscated channel

**Handshake:**

```
Client → Server:  WS upgrade to /cdn-cgi/ws?p=/exec/<id>
Server → Client:  {"event":"nonce","nonce":"<64-char hex>"}   ← plaintext, before obfuscation
Client derives:   sessionKey = HKDF(daemonKey, nonce)
Client → Server:  encodeFrame({"event":"auth","args":["<key>"]})
Server → Client:  encodeFrame("connected (obfuscated)!")
... all subsequent frames are XOR-encoded ...
```

### Panel-side client implementation

```js
const crypto    = require('crypto');
const WebSocket = require('ws');
const { EventEmitter } = require('events');

function deriveKey(daemonKey, nonceHex) {
    return crypto.hkdfSync('sha256',
        Buffer.from(daemonKey, 'utf8'),
        Buffer.from(nonceHex, 'hex'),
        Buffer.from('lunarix-obfs-v1'),
        32
    );
}

function encodeFrame(plain, key) {
    const n   = crypto.randomInt(0, 65);
    const pad = crypto.randomBytes(n);
    const xor = Buffer.alloc(plain.length);
    for (let i = 0; i < plain.length; i++) xor[i] = plain[i] ^ key[i % key.length];
    return Buffer.concat([Buffer.from([n]), pad, xor]);
}

function decodeFrame(frame, key) {
    const n    = frame[0];
    const xor  = frame.slice(1 + n);
    const plain = Buffer.alloc(xor.length);
    for (let i = 0; i < xor.length; i++) plain[i] = xor[i] ^ key[i % key.length];
    return plain;
}

class ObfuscatedWebSocket extends EventEmitter {
    constructor(nodeUrl, daemonKey, realPath) {
        super();
        this._key   = null;
        this._ready = false;
        this._queue = [];
        this._dk    = daemonKey;

        const url = `${nodeUrl}/cdn-cgi/ws?p=${encodeURIComponent(realPath)}`;
        this._ws  = new WebSocket(url);

        this._ws.on('message', (data) => {
            if (!this._ready) {
                const msg = JSON.parse(data.toString());
                if (msg.event === 'nonce') {
                    this._key   = deriveKey(this._dk, msg.nonce);
                    this._ready = true;
                    for (const m of this._queue) this._enc(m);
                    this._queue = [];
                }
                return;
            }
            const plain = decodeFrame(Buffer.isBuffer(data) ? data : Buffer.from(data), this._key);
            this.emit('message', plain.toString('utf8'));
        });

        this._ws.on('open',  ()     => this.emit('open'));
        this._ws.on('close', (c, r) => this.emit('close', c, r));
        this._ws.on('error', (e)    => this.emit('error', e));
    }

    send(data) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        if (!this._ready) { this._queue.push(buf); return; }
        this._enc(buf);
    }

    _enc(buf) { this._ws.send(encodeFrame(buf, this._key)); }
    close(c, r) { this._ws.close(c, r); }
}

// Usage:
const ws = new ObfuscatedWebSocket('wss://node:3002', '<daemonKey>', '/exec/<containerId>');
ws.on('open',    ()  => ws.send(JSON.stringify({ event: 'auth', args: ['<daemonKey>'] })));
ws.on('message', (m) => console.log(m));
```

---

## Base Endpoints

### `GET /`

```json
{
  "versionFamily":  2,
  "versionRelease": "lunarix-dm 0.2.1",
  "online":         true,
  "tls":            true,
  "obfuscation":    true,
  "docker":         { "status": "running", "systemInfo": { "..." : "..." } }
}
```

---

## Instances

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/instances` | List all containers |
| `GET` | `/instances/:id` | Inspect container |
| `GET` | `/instances/:id/ports` | List port bindings |
| `DELETE` | `/instances/:id` | Remove container + volume |
| `DELETE` | `/instances/purge/all` | Force-remove all containers |

---

## Deployment

### `POST /instances/create`

```json
{
  "Image":        "itzg/minecraft-server:latest",
  "Id":           "my-server-uuid",
  "Cmd":          ["java", "-jar", "server.jar"],
  "Env":          ["EULA=TRUE"],
  "Ports":        { "25565/tcp": {} },
  "PortBindings": { "25565/tcp": [{ "HostPort": "25565" }] },
  "Memory":       2048,
  "Cpu":          2,
  "Scripts": {
    "Install": [{ "Uri": "https://example.com/server.jar", "Path": "server.jar" }]
  },
  "variables": "{\"version\": \"1.20.1\"}"
}
```

| Field | Notes |
|-------|-------|
| `Memory` | MB, 0 = unlimited |
| `Cpu` | Core count (uses NanoCpus internally) |
| `Scripts.Install` | Downloaded after response; HTTPS only |

**Response `201`:** `{ "containerId": "...", "volumeId": "..." }`

### `POST /instances/redeploy/:id`
Recreate with new settings. Volume preserved.

### `PUT /instances/edit/:id`
Update image/memory/CPU. Stops, removes, recreates. Volume preserved.

---

## Power Actions

### `POST /instances/:id/:action`

Actions: `start` `stop` `restart` `pause` `unpause` `kill`

---

## File System

All routes prefixed `/fs`. Optional `?path=subdir`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/fs/:id/files` | List directory |
| `GET` | `/fs/:id/files/view/:filename` | Read file (≤5 MB) |
| `POST` | `/fs/:id/files/edit/:filename` | Write file (≤5 MB) |
| `POST` | `/fs/:id/files/create/:filename` | Create file |
| `POST` | `/fs/:id/files/rename/:filename/:newfilename` | Rename |
| `POST` | `/fs/:id/files/upload` | Upload (multipart, ≤100 MB/file) |
| `DELETE` | `/fs/:id/files/delete/:filename` | Delete file or directory |
| `POST` | `/fs/:id/folders/create/:foldername` | Create directory |

All paths validated against volume root — traversal returns `400`.

---

## Archives

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/archive/:id/archives` | List archives |
| `POST` | `/archive/:id/archives/:volumeId/create` | Create ZIP |
| `GET` | `/archive/:id/archives/download/:archiveName` | Download |
| `POST` | `/archive/:id/archives/delete/:archiveName` | Delete |
| `POST` | `/archive/:id/archives/rollback/:volumeId/:archiveName` | Restore (destructive) |

---

## Database

### `POST /database/create/:name`

Name: `^[a-zA-Z0-9_]+$`

```json
{ "credentials": { "dbName": "mydb", "userName": "user_mydb", "password": "...", "host": "localhost" } }
```

---

## FTP

### `GET /ftp/info/:id`

```json
{ "username": "user-<id>", "password": "...", "host": "127.0.0.1", "port": 3003 }
```

Passwords: `crypto.randomBytes(24)` (192-bit entropy).

---

## Network Isolation & Bandwidth

All routes prefixed `/network`.

### `POST /network/:id/isolate`

Moves container to a dedicated Docker bridge with ICC disabled. Container retains internet access but cannot reach other containers.

```json
{ "message": "Container isolated", "network": "lunarix-isolated-abc123456789" }
```

### `DELETE /network/:id/isolate`

Reconnect to default bridge, remove isolated network.

### `POST /network/:id/bandwidth`

Apply `tc`-based limits (Linux only, requires `tc` + optionally `ifb` for ingress).

```json
{ "ingressKbps": 10240, "egressKbps": 5120 }
```

### `GET /network/:id/bandwidth`

```json
{ "ingressKbps": 10240, "egressKbps": 5120, "limited": true }
```

### `DELETE /network/:id/bandwidth`

Remove `tc` rules.

### `GET /network/list`

List all daemon-managed isolation networks.

---

## Scheduler

Persistent cron scheduler. Tasks stored in `./data/schedules.json` and survive restarts.

All routes prefixed `/scheduler`.

### `POST /scheduler/tasks`

```json
{
  "type":        "auto-backup",
  "containerId": "abc123...",
  "volumeId":    "my-server-uuid",
  "schedule":    "0 3 * * *",
  "timezone":    "Europe/Moscow",
  "label":       "Nightly backup"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | ✅ | `auto-backup` or `auto-restart` |
| `containerId` | ✅ | Target container |
| `volumeId` | For backup | Volume directory name |
| `schedule` | ✅ | Cron expression (`"0 3 * * *"` = daily 03:00) |
| `timezone` | — | IANA timezone (default: `UTC`) |

### Other scheduler routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/scheduler/tasks` | List all tasks |
| `DELETE` | `/scheduler/tasks/:taskId` | Remove task |
| `POST` | `/scheduler/tasks/:taskId/run` | Trigger immediately |
| `GET` | `/scheduler/tasks/:taskId/history` | Last 20 execution results |

**History entry:**
```json
{ "ts": "2024-01-01T03:00:01.000Z", "success": true, "message": "Backup created: auto-uuid-2024-01-01.zip" }
```

---

## Xray Sidecar (Game Traffic Obfuscation)

Deploys an [Xray-core](https://github.com/XTLS/Xray-core) container alongside a game server to tunnel its traffic through **VLESS+WebSocket+TLS**, making it look like HTTPS to DPI.

### Architecture

```
[Player]
  ↓  VLESS+WS+TLS on port 443  (looks like HTTPS to ISP/DPI)
[Xray Server — VPS or CDN edge]
  ↓  forwards to node
[Xray Sidecar container]  ← managed by daemon
  ↓  plain TCP/UDP on localhost
[Game Server container]
```

All routes prefixed `/xray`.

### `POST /xray/:id/sidecar`

```json
{
  "serverAddr": "node.yourdomain.com",
  "serverPort": 443,
  "wsPath":     "/cdn-cgi/game",
  "sni":        "node.yourdomain.com",
  "localPort":  25565,
  "protocol":   "tcp"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `serverAddr` | ✅ | Xray server hostname |
| `sni` | ✅ | TLS SNI domain (must have valid cert) |
| `localPort` | ✅ | Game server port |
| `wsPath` | — | WS path (default: `/cdn-cgi/game`) |
| `protocol` | — | `tcp` or `udp` |

**Response `201`:**
```json
{
  "sidecarId":    "def456...",
  "uuid":         "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "clientConfig": { "...": "complete Xray client JSON" }
}
```

`clientConfig` is ready to import into any Xray-compatible client (v2rayN, Nekoray, Shadowrocket, etc.).

### Other Xray routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/xray/:id/sidecar` | Status + config |
| `DELETE` | `/xray/:id/sidecar` | Remove sidecar |
| `POST` | `/xray/:id/sidecar/restart` | Restart sidecar |
| `GET` | `/xray/configs/client/:id` | Download client config JSON |

---

## Metrics

### `GET /metrics`

Prometheus-compatible. Not behind Basic Auth — protect at network level.

**Prometheus scrape config:**
```yaml
scrape_configs:
  - job_name: lunarix-dm
    static_configs:
      - targets: ['node:3002']
    scheme: https
    tls_config:
      ca_file: /etc/prometheus/lunarix-node.crt
    metrics_path: /metrics
```

**Available metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `lunarix_container_cpu_percent` | Gauge | CPU % per container |
| `lunarix_container_memory_usage_bytes` | Gauge | RSS memory (cache excluded) |
| `lunarix_container_memory_limit_bytes` | Gauge | Memory limit |
| `lunarix_container_network_rx_bytes_total` | Gauge | Total bytes received |
| `lunarix_container_network_tx_bytes_total` | Gauge | Total bytes sent |
| `lunarix_ws_connections_active` | Gauge | Active WS connections |
| `lunarix_http_requests_total` | Counter | Requests by method/route/status |
| `lunarix_containers_total` | Gauge | Container count by state |
| `lunarix_process_*` | Various | Node.js GC, heap, event loop |

Collected every **15 seconds** in background — scrapes are always fast.

### `GET /metrics/history/:id`

In-memory load history (last 60 samples ≈ 15 min). `:id` = 12-char short container ID.

```json
{
  "cpu": [12.5, 13.1, 11.8],
  "mem": [536870912, 541065216],
  "ts":  [1704067200000, 1704067215000]
}
```

---

## WebSocket — Standard

### URLs

```
ws[s]://<node>:<port>/exec/<containerId>
ws[s]://<node>:<port>/stats/<containerId>[/<volumeId>]
```

### Auth (first message)

```json
{ "event": "auth", "args": ["<daemonKey>"] }
```

### `/exec` — Console

| Direction | Format | Description |
|-----------|--------|-------------|
| Server→Client | Raw text | Container stdout/stderr |
| Client→Server | `{"event":"cmd","command":"..."}` | Run command |
| Server→Client | `{"event":"cmd:done"}` | Command finished |
| Client→Server | `{"event":"power:start"}` | Power action |
| Server→Client | `{"event":"power:state","state":"start"}` | Power result |

### `/stats` — Real-time Stats

Pushed on every Docker event (~1/sec):

```json
{
  "event":      "stats",
  "cpu":        12.34,
  "memory":     { "usage": 536870912, "limit": 2147483648 },
  "network":    { "rx": 1024000, "tx": 512000 },
  "timestamp":  "2024-01-01T00:00:00.000Z",
  "volumeSize": "1.20 GB"
}
```

### Errors

```json
{ "event": "error", "message": "Description" }
```

---

## WebSocket — Obfuscated

### URL

```
ws[s]://<node>:<port>/cdn-cgi/ws?p=<urlEncodedRealPath>
```

### Differences from standard WS

1. Server sends `{"event":"nonce","nonce":"<64-char hex>"}` first (plaintext)
2. Client derives `sessionKey = HKDF-SHA256(daemonKey, nonce, "lunarix-obfs-v1")`
3. All subsequent frames encoded: `[paddingLen][randomPadding][XOR(payload, key)]`
4. Same JSON protocol inside — auth, commands, stats unchanged

See [Panel-side client implementation](#panel-side-client-implementation) above.

---

## Security Summary

| Mechanism | Applied to |
|-----------|-----------|
| TLS 1.2+ (AES-256-GCM, ChaCha20) | All HTTP and WS traffic |
| `timingSafeEqual` on auth key | HTTP Basic Auth + WS auth |
| Helmet security headers | All HTTP responses |
| Fake Cloudflare headers | All HTTP responses |
| XOR+HKDF frame obfuscation | Obfuscated WS channel |
| Rate limiting (200 req/min/IP) | All HTTP endpoints |
| Max 20 concurrent WS per IP | WS server |
| Path traversal protection | All filesystem routes |
| Regex validation on IDs/names | `/fs`, `/database`, `/ftp` |
| `no-new-privileges` secopt | All created containers |
| NanoCpus CPU limits | Container deployment |
| `crypto.randomBytes(24)` FTP passwords | FTP user creation |
| File size limits (5 MB r/w, 100 MB upload) | Filesystem routes |
| Depth-limited dir traversal (max 10) | Volume size calculation |
| HTTPS-only install script URLs | Deployment |
