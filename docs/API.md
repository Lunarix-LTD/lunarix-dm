# Lunarix Daemon — API Reference

This document describes every HTTP and WebSocket endpoint exposed by `lunarix-dm`.  
It is intended for panel developers integrating with a daemon node.

---

## Authentication

All HTTP endpoints use **HTTP Basic Auth**.

| Field    | Value                          |
|----------|--------------------------------|
| Username | `Lunarix`                      |
| Password | The `key` value from `config.json` |

The comparison is constant-time on the daemon side, so brute-force timing attacks are not effective.

**Example (curl):**
```bash
curl -u Lunarix:<key> http://<node>:3002/
```

WebSocket authentication is described separately in the [WebSocket](#websocket) section.

---

## Base URL

```
http://<node-host>:<port>
```

Default port: `3002` (configurable in `config.json`).

---

## HTTP Endpoints

### Status

#### `GET /`

Returns daemon and Docker status. Does **not** expose database credentials.

**Response `200`:**
```json
{
  "versionFamily": 2,
  "versionRelease": "lunarix-dm 0.2.1",
  "online": true,
  "remote": "http://panel:3001",
  "docker": {
    "status": "running",
    "systemInfo": { ... }
  }
}
```

---

### Instances

#### `GET /instances`

List all Docker containers (running and stopped).

**Response `200`:** Array of Docker container objects.

---

#### `GET /instances/:id`

Inspect a single container.

| Param | Type   | Description       |
|-------|--------|-------------------|
| `id`  | string | Docker container ID |

**Response `200`:** Full Docker inspect object.  
**Response `404`:** Container not found.

---

#### `GET /instances/:id/ports`

List port bindings for a container.

**Response `200`:**
```json
[
  { "port": "25565/tcp", "bindings": [{ "HostIp": "0.0.0.0", "HostPort": "25565" }] }
]
```

---

#### `DELETE /instances/:id`

Remove a container and its volume directory.

**Response `200`:**
```json
{ "message": "Container and volume removed" }
```

---

#### `DELETE /instances/purge/all`

Force-remove **all** containers on the node. Use with caution.

**Response `200`:**
```json
{ "message": "Removed 3 containers" }
```

**Response `207`** (partial failure):
```json
{ "message": "Some containers could not be removed", "errors": ["..."] }
```

---

### Deployment

#### `POST /instances/create`

Create and start a new container.

**Request body:**
```json
{
  "Image":        "itzg/minecraft-server:latest",
  "Id":           "my-server-uuid",
  "Cmd":          ["java", "-jar", "server.jar"],
  "Env":          ["EULA=TRUE", "MEMORY=2G"],
  "Ports":        { "25565/tcp": {} },
  "PortBindings": { "25565/tcp": [{ "HostPort": "25565" }] },
  "Memory":       2048,
  "Cpu":          2,
  "Scripts": {
    "Install": [
      { "Uri": "https://example.com/server.jar", "Path": "server.jar" }
    ]
  },
  "variables": "{\"version\": \"1.20.1\"}"
}
```

| Field          | Type    | Required | Description                                      |
|----------------|---------|----------|--------------------------------------------------|
| `Image`        | string  | ✅       | Docker image name                                |
| `Id`           | string  | ✅       | Unique ID used as container name and volume dir  |
| `Cmd`          | array   | —        | Override container entrypoint command            |
| `Env`          | array   | —        | Environment variables (`KEY=VALUE`)              |
| `Ports`        | object  | —        | Exposed ports map (Docker format)                |
| `PortBindings` | object  | —        | Host port bindings (Docker format)               |
| `Memory`       | number  | —        | RAM limit in **MB** (0 = unlimited)              |
| `Cpu`          | number  | —        | CPU core count (0 = unlimited, uses NanoCpus)    |
| `Scripts`      | object  | —        | Install scripts to download after container start|
| `variables`    | string  | —        | JSON string of variables for script URL templating|

**Response `201`:**
```json
{
  "message": "Container created successfully",
  "containerId": "abc123...",
  "volumeId": "my-server-uuid"
}
```

> Install scripts are downloaded **after** the response is sent, so the panel is not blocked.

---

#### `POST /instances/redeploy/:id`

Stop, remove, and recreate a container with new settings. The volume is preserved.

| Param | Type   | Description              |
|-------|--------|--------------------------|
| `id`  | string | Existing container ID    |

**Request body:** Same fields as `/instances/create` (except `Scripts`).

**Response `200`:**
```json
{ "message": "Container redeployed", "containerId": "def456..." }
```

---

#### `PUT /instances/edit/:id`

Update a container's image, memory, or CPU. Stops and recreates the container; volume is preserved.

| Param | Type   | Description           |
|-------|--------|-----------------------|
| `id`  | string | Existing container ID |

**Request body:**
```json
{
  "Image":    "itzg/minecraft-server:1.20",
  "Memory":   4096,
  "Cpu":      4,
  "VolumeId": "my-server-uuid"
}
```

**Response `200`:**
```json
{
  "message":        "Container updated",
  "oldContainerId": "abc123...",
  "newContainerId": "ghi789..."
}
```

---

### Power Actions

#### `POST /instances/:id/:action`

Control container power state.

| Param    | Type   | Values                                      |
|----------|--------|---------------------------------------------|
| `id`     | string | Container ID                                |
| `action` | string | `start` `stop` `restart` `pause` `unpause` `kill` |

**Response `200`:**
```json
{ "message": "Container started successfully" }
```

---

### File System

All filesystem routes are prefixed with `/fs`.  
The `path` query parameter specifies a subdirectory within the volume (optional).

#### `GET /fs/:id/files[?path=subdir]`

List files and directories in a volume.

**Response `200`:**
```json
{
  "files": [
    {
      "name":        "server.jar",
      "isDirectory": false,
      "isEditable":  false,
      "size":        "42.00 MB",
      "lastUpdated": "2024-01-01T00:00:00.000Z",
      "purpose":     "other",
      "extension":   ".jar",
      "permissions": "644"
    }
  ]
}
```

---

#### `GET /fs/:id/files/view/:filename[?path=subdir]`

Read a text file's content. Limited to editable file types and files ≤ 5 MB.

**Response `200`:**
```json
{ "content": "# server.properties\n..." }
```

**Response `413`:** File exceeds 5 MB limit.  
**Response `400`:** File type not supported for viewing.

---

#### `POST /fs/:id/files/edit/:filename[?path=subdir]`

Overwrite a file's content. Limited to editable types and ≤ 5 MB.

**Request body:**
```json
{ "content": "# updated content" }
```

**Response `200`:** `{ "message": "File updated" }`

---

#### `POST /fs/:id/files/create/:filename[?path=subdir]`

Create a new file.

**Request body:**
```json
{ "content": "" }
```

**Response `200`:** `{ "message": "File created" }`

---

#### `POST /fs/:id/files/rename/:filename/:newfilename[?path=subdir]`

Rename a file or directory.

**Response `200`:** `{ "message": "File renamed" }`  
**Response `400`:** Target name already exists.

---

#### `POST /fs/:id/files/upload[?path=subdir]`

Upload one or more files via `multipart/form-data`. Max 100 MB per file.

**Form field:** `files` (multiple allowed)

**Response `200`:** `{ "message": "Files uploaded" }`

---

#### `DELETE /fs/:id/files/delete/:filename[?path=subdir]`

Delete a file or directory (recursive for directories).

**Response `200`:** `{ "message": "Deleted" }`

---

#### `POST /fs/:id/folders/create/:foldername[?path=subdir]`

Create a new directory.

**Response `200`:** `{ "message": "Folder created" }`

---

### Archives

All archive routes are prefixed with `/archive`.

#### `GET /archive/:id/archives`

List all archives for a volume.

**Response `200`:**
```json
{
  "archives": [
    { "name": "my-server-2024-01-01.zip", "size": "120.00 MB", "lastUpdated": "..." }
  ]
}
```

---

#### `POST /archive/:id/archives/:volumeId/create`

Create a ZIP archive of a volume.

**Response `200`:**
```json
{ "message": "Archive created successfully", "archiveName": "my-server-2024-01-01T00-00-00.zip" }
```

---

#### `GET /archive/:id/archives/download/:archiveName`

Download an archive file.

**Response `200`:** Binary ZIP stream with `Content-Disposition: attachment`.

---

#### `POST /archive/:id/archives/delete/:archiveName`

Delete an archive.

**Response `200`:** `{ "message": "Archive deleted successfully" }`

---

#### `POST /archive/:id/archives/rollback/:volumeId/:archiveName`

Restore a volume from an archive. **Destructive** — current volume contents are deleted first.

**Response `200`:** `{ "message": "Volume rolled back successfully" }`

---

### Database

#### `POST /database/create/:name`

Create a MySQL database and a dedicated user with full privileges on it.  
Database name must match `^[a-zA-Z0-9_]+$`.

**Response `200`:**
```json
{
  "message": "Database mydb created",
  "credentials": {
    "dbName":   "mydb",
    "userName": "user_mydb",
    "password": "...",
    "host":     "localhost"
  }
}
```

---

### FTP

#### `GET /ftp/info/:id`

Retrieve FTP credentials for a volume.

**Response `200`:**
```json
{
  "username": "user-my-server-uuid",
  "password": "...",
  "host":     "127.0.0.1",
  "port":     3003,
  "root":     "/path/to/volumes/my-server-uuid"
}
```

---

## WebSocket

### Connection

```
ws://<node-host>:<port>/exec/<containerId>
ws://<node-host>:<port>/stats/<containerId>[/<volumeId>]
```

### Authentication

Send as the **first message** after connecting:

```json
{ "event": "auth", "args": ["<daemon-key>"] }
```

On success the daemon responds with a plain-text welcome string.  
On failure the connection is closed with code `1008`.

---

### `/exec/<containerId>` — Console

Streams container stdout/stderr and accepts commands.

**Receiving output:**  
The daemon sends raw text chunks (Docker log stream with 8-byte header stripped).

**Sending a command:**
```json
{ "event": "cmd", "command": "ls -la /app/data" }
```

**Command completion:**
```json
{ "event": "cmd:done" }
```

**Power actions** (also available on exec connections):
```json
{ "event": "power:start" }
{ "event": "power:stop" }
{ "event": "power:restart" }
```

Power action result:
```json
{ "event": "power:state", "state": "start" }
```

---

### `/stats/<containerId>[/<volumeId>]` — Real-time Stats

The daemon pushes a stats object every time Docker emits a new measurement (roughly every 1 second). No polling — the Docker native stream is used.

**Stats payload:**
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

| Field              | Unit         | Description                          |
|--------------------|--------------|--------------------------------------|
| `cpu`              | percent      | CPU usage across all cores           |
| `memory.usage`     | bytes        | RSS memory (cache excluded)          |
| `memory.limit`     | bytes        | Container memory limit               |
| `network.rx`       | bytes        | Total received since container start |
| `network.tx`       | bytes        | Total sent since container start     |
| `volumeSize`       | human string | Volume directory size (if volumeId provided) |

---

### Error events

Any error from the daemon is sent as:
```json
{ "event": "error", "message": "Description of the problem" }
```

---

## Security Notes

- All paths are validated against the volume root — directory traversal attempts return `400`.
- Volume IDs and database names are validated with strict regex before use in filesystem paths or SQL.
- FTP passwords are generated with `crypto.randomBytes(24)` (192 bits of entropy).
- The daemon key is compared with `crypto.timingSafeEqual` on both HTTP and WebSocket auth.
- Containers are created with `SecurityOpt: ['no-new-privileges']` to prevent privilege escalation.
- CPU limits use `NanoCpus` (not the deprecated `CpuCount`) for accurate enforcement.
- File reads and writes are capped at 5 MB; uploads at 100 MB per file.
- The status endpoint (`GET /`) never exposes database credentials.
