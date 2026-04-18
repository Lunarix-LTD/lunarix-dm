/*
 *           __                          __      __
 *     _____/ /____  ______  ____  _____/ /_____/ /
 *    / ___/ //_/ / / / __ \/ __ \/ ___/ __/ __  / 
 *   (__  ) ,< / /_/ / /_/ / /_/ / /  / /_/ /_/ /  
 *  /____/_/|_|\__, / .___/\____/_/   \__/\__,_/   
 *            /____/_/                        
 * 
 *  Lunarix Daemon v2
 *  (c) 2024 Lunarix LTD
 * 
*/

process.env.dockerSocket = process.platform === 'win32'
    ? '//./pipe/docker_engine'
    : '/var/run/docker.sock';

const express    = require('express');
const Docker     = require('dockerode');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const basicAuth  = require('express-basic-auth');
const bodyParser = require('body-parser');
const CatLoggr   = require('cat-loggr');
const WebSocket  = require('ws');
const http       = require('http');
const https      = require('https');
const fs         = require('node:fs');
const path       = require('path');
const chalk      = require('chalk');
const crypto     = require('crypto');

const ascii = fs.readFileSync('./handlers/ascii.txt', 'utf8');
const { init, createVolumesFolder } = require('./handlers/init.js');
const { seed }                      = require('./handlers/seed.js');
const { start: startFtp }           = require('./routes/InstanceFTP.js');
const { createDatabaseAndUser }     = require('./routes/InstanceDB.js');
const { loadTlsContext }            = require('./handlers/tls.js');
const { fakeCdnHeaders, createObfuscatedWss } = require('./handlers/obfuscation.js');
const metrics                       = require('./handlers/metrics.js');
const config                        = require('./config.json');

const docker = new Docker({ socketPath: process.env.dockerSocket });
const log    = new CatLoggr();

// ── TLS context (HTTPS/WSS) ───────────────────────────────────────────────────

const tlsContext = loadTlsContext(config);
const app        = express();

// Create HTTPS or HTTP server depending on TLS config
const server = tlsContext
    ? https.createServer(tlsContext, app)
    : http.createServer(app);

const protocol = tlsContext ? 'https' : 'http';

// ── Security middleware ───────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));
app.use(fakeCdnHeaders); // Fake Cloudflare headers for DPI bypass

// 200 req/min per IP
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, slow down.' },
});
app.use(apiLimiter);

app.use(bodyParser.json({ limit: '10mb' }));

// Constant-time comparison to prevent timing attacks on the auth key
app.use(basicAuth({
    authorizer: (username, password) => {
        const userOk = basicAuth.safeCompare(username, 'Lunarix');
        const passOk = basicAuth.safeCompare(password, config.key);
        return userOk && passOk;
    },
    challenge: true,
}));

// ── HTTP request metrics ──────────────────────────────────────────────────────

app.use((req, res, next) => {
    res.on('finish', () => {
        metrics.httpRequests.labels(req.method, req.route?.path || req.path, String(res.statusCode)).inc();
    });
    next();
});

// ── Startup ───────────────────────────────────────────────────────────────────

console.log(chalk.gray(ascii) + chalk.white('version v' + config.version + '\n'));
init();
seed();
metrics.startCollector();

// ── Routes ────────────────────────────────────────────────────────────────────

const instanceRouter   = require('./routes/Instance.js');
const deploymentRouter = require('./routes/Deploy.js');
const filesystemRouter = require('./routes/Volume.js');
const archiveRouter    = require('./routes/ArchiveVolume.js');
const powerRouter      = require('./routes/PowerActions.js');
const networkRouter    = require('./routes/Network.js');
const schedulerRouter  = require('./routes/Scheduler.js');
const xrayRouter       = require('./routes/Xray.js');

app.use('/instances', instanceRouter);
app.use('/instances', deploymentRouter);
app.use('/instances', powerRouter);
app.use('/archive',   archiveRouter);
app.use('/fs',        filesystemRouter);
app.use('/network',   networkRouter);
app.use('/scheduler', schedulerRouter);
app.use('/xray',      xrayRouter);

// ── Prometheus metrics ────────────────────────────────────────────────────────

// Metrics endpoint is intentionally NOT behind basicAuth so Prometheus can scrape
// without credentials. Protect it at the network level (firewall/VPN).
// To add auth, wrap with basicAuth middleware here.
app.get('/metrics', async (req, res) => {
    try {
        res.set('Content-Type', metrics.registry.contentType);
        res.end(await metrics.registry.metrics());
    } catch (err) {
        res.status(500).end(err.message);
    }
});

// Container load history (last 60 samples, ~15 min)
app.get('/metrics/history/:id', (req, res) => {
    const { id } = req.params;
    if (!/^[a-f0-9]{12}$/.test(id)) {
        return res.status(400).json({ message: 'Invalid container ID (use 12-char short ID)' });
    }
    res.json(metrics.getHistory(id));
});

// ── FTP ───────────────────────────────────────────────────────────────────────

startFtp();

app.get('/ftp/info/:id', (req, res) => {
    const id = req.params.id;
    if (!/^[a-zA-Z0-9\-_]+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid ID format' });
    }
    const filePath = path.join(__dirname, 'ftp', 'user-' + id + '.json');
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') return res.status(404).json({ error: 'FTP user not found' });
            log.error('FTP info read error:', err);
            return res.status(500).json({ error: 'Internal error' });
        }
        try {
            res.json(JSON.parse(data));
        } catch {
            res.status(500).json({ error: 'Corrupt FTP user data' });
        }
    });
});

// ── Database ──────────────────────────────────────────────────────────────────

app.post('/database/create/:name', async (req, res) => {
    const dbName = req.params.name;
    if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
        return res.status(400).json({ error: 'Invalid database name. Use only letters, numbers, underscores.' });
    }
    try {
        const credentials = await createDatabaseAndUser(dbName);
        res.status(200).json({ message: 'Database ' + dbName + ' created', credentials });
    } catch (error) {
        log.error('DB create error:', error);
        res.status(500).json({ error: 'Failed to create database' });
    }
});

// ── Status endpoint ───────────────────────────────────────────────────────────

app.get('/', async (req, res) => {
    try {
        const [dockerInfo, isDockerRunning] = await Promise.all([
            docker.info(),
            docker.ping(),
        ]);
        res.json({
            versionFamily:  2,
            versionRelease: 'lunarix-dm ' + config.version,
            online:         true,
            remote:         config.remote,
            tls:            !!tlsContext,
            obfuscation:    true,
            docker: {
                status:     isDockerRunning ? 'running' : 'not running',
                systemInfo: dockerInfo,
            },
        });
    } catch (error) {
        log.error('Docker status error:', error);
        res.status(500).json({ error: 'Docker is not running — daemon will not function properly.' });
    }
});

// ── Global error handler ──────────────────────────────────────────────────────

app.use((err, req, res, next) => {
    log.error('Unhandled error:', err.stack);
    res.status(500).json({ error: 'Internal server error' });
});

// ── WebSocket servers ─────────────────────────────────────────────────────────

// Track active WS connections for metrics
let activeWsCount = 0;

/**
 * Standard WS server (plain path, for backward compat):
 *   ws[s]://<node>/exec/<containerId>
 *   ws[s]://<node>/stats/<containerId>[/<volumeId>]
 *
 * Obfuscated WS server (disguised path, DPI-resistant):
 *   ws[s]://<node>/cdn-cgi/ws?p=/exec/<containerId>
 *   ws[s]://<node>/cdn-cgi/ws?p=/stats/<containerId>[/<volumeId>]
 */
function initializeWebSocketServer(server) {
    const wss = new WebSocket.Server({ server });

    // Per-IP connection limit
    const ipConnections = new Map();

    wss.on('connection', (ws, req) => {
        const ip    = req.socket.remoteAddress;
        const count = (ipConnections.get(ip) || 0) + 1;
        if (count > 20) {
            ws.close(1008, 'Too many connections from this IP');
            return;
        }
        ipConnections.set(ip, count);
        activeWsCount++;
        metrics.wsConnections.set(activeWsCount);

        ws.on('close', () => {
            const c = (ipConnections.get(ip) || 1) - 1;
            if (c <= 0) ipConnections.delete(ip);
            else ipConnections.set(ip, c);
            activeWsCount = Math.max(0, activeWsCount - 1);
            metrics.wsConnections.set(activeWsCount);
        });

        let isAuthenticated = false;

        ws.on('message', async (message) => {
            let msg;
            try {
                msg = JSON.parse(message);
            } catch {
                ws.send(JSON.stringify({ event: 'error', message: 'Invalid JSON' }));
                return;
            }

            if (msg.event === 'auth' && Array.isArray(msg.args)) {
                const provided    = String(msg.args[0] || '');
                const keyBuf      = Buffer.from(config.key, 'utf8');
                const providedBuf = Buffer.from(provided, 'utf8');
                const valid = keyBuf.length === providedBuf.length &&
                    crypto.timingSafeEqual(keyBuf, providedBuf);

                if (valid) {
                    isAuthenticated = true;
                    log.info('WS auth success from ' + ip);
                    ws.send('\r\n\x1b[33m[lunarix-dm] \x1b[0mconnected!\r\n');
                    handleWebSocketConnection(ws, req);
                } else {
                    log.warn('WS auth failure from ' + ip);
                    ws.send(JSON.stringify({ event: 'error', message: 'Authentication failed' }));
                    ws.close(1008, 'Authentication failed');
                }
                return;
            }

            if (!isAuthenticated) {
                ws.send(JSON.stringify({ event: 'error', message: 'Unauthorized' }));
                ws.close(1008, 'Unauthorized');
                return;
            }

            const urlParts    = req.url.split('/');
            const containerId = urlParts[2];
            if (!containerId) { ws.close(1008, 'Container ID not specified'); return; }

            const container = docker.getContainer(containerId);
            switch (msg.event) {
                case 'power:start':   performPowerAction(ws, container, 'start');   break;
                case 'power:stop':    performPowerAction(ws, container, 'stop');    break;
                case 'power:restart': performPowerAction(ws, container, 'restart'); break;
                default:
                    ws.send(JSON.stringify({ event: 'error', message: 'Unknown event: ' + msg.event }));
            }
        });
    });

    // Obfuscated WS — same logic but frames are XOR-encoded
    createObfuscatedWss(server, config.key, (transparentWs, req, realPath) => {
        // Patch req.url so handleWebSocketConnection sees the real path
        const patchedReq = Object.assign(Object.create(req), { url: realPath });

        activeWsCount++;
        metrics.wsConnections.set(activeWsCount);

        transparentWs.on('close', () => {
            activeWsCount = Math.max(0, activeWsCount - 1);
            metrics.wsConnections.set(activeWsCount);
        });

        let isAuthenticated = false;

        transparentWs.on('message', async (message) => {
            let msg;
            try { msg = JSON.parse(message); } catch {
                transparentWs.send(JSON.stringify({ event: 'error', message: 'Invalid JSON' }));
                return;
            }

            if (msg.event === 'auth' && Array.isArray(msg.args)) {
                const provided    = String(msg.args[0] || '');
                const keyBuf      = Buffer.from(config.key, 'utf8');
                const providedBuf = Buffer.from(provided, 'utf8');
                const valid = keyBuf.length === providedBuf.length &&
                    crypto.timingSafeEqual(keyBuf, providedBuf);

                if (valid) {
                    isAuthenticated = true;
                    log.info('Obfs WS auth success from ' + req.socket.remoteAddress);
                    transparentWs.send('\r\n\x1b[33m[lunarix-dm] \x1b[0mconnected (obfuscated)!\r\n');
                    handleWebSocketConnection(transparentWs, patchedReq);
                } else {
                    log.warn('Obfs WS auth failure from ' + req.socket.remoteAddress);
                    transparentWs.send(JSON.stringify({ event: 'error', message: 'Authentication failed' }));
                    transparentWs.close(1008, 'Authentication failed');
                }
                return;
            }

            if (!isAuthenticated) {
                transparentWs.send(JSON.stringify({ event: 'error', message: 'Unauthorized' }));
                transparentWs.close(1008, 'Unauthorized');
                return;
            }

            const urlParts    = realPath.split('/');
            const containerId = urlParts[2];
            if (!containerId) { transparentWs.close(1008, 'Container ID not specified'); return; }

            const container = docker.getContainer(containerId);
            switch (msg.event) {
                case 'power:start':   performPowerAction(transparentWs, container, 'start');   break;
                case 'power:stop':    performPowerAction(transparentWs, container, 'stop');    break;
                case 'power:restart': performPowerAction(transparentWs, container, 'restart'); break;
                default:
                    transparentWs.send(JSON.stringify({ event: 'error', message: 'Unknown event: ' + msg.event }));
            }
        });
    });

    function handleWebSocketConnection(ws, req) {
        const urlParts    = req.url.split('/');
        const mode        = urlParts[1];
        const containerId = urlParts[2];

        if (!containerId) { ws.close(1008, 'Container ID not specified'); return; }

        const container = docker.getContainer(containerId);
        container.inspect((err) => {
            if (err) {
                ws.send(JSON.stringify({ event: 'error', message: 'Container not found' }));
                ws.close(1011, 'Container not found');
                return;
            }
            if (mode === 'exec') {
                setupExecSession(ws, container);
            } else if (mode === 'stats') {
                setupStatsStreaming(ws, container, urlParts[3] || null);
            } else {
                ws.close(1002, 'URL must start with /exec/ or /stats/');
            }
        });
    }

    async function setupExecSession(ws, container) {
        let logStream;
        try {
            logStream = await container.logs({ follow: true, stdout: true, stderr: true, tail: 50 });
        } catch (err) {
            ws.send(JSON.stringify({ event: 'error', message: 'Failed to attach log stream' }));
            return;
        }

        logStream.on('data', (chunk) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(chunk.slice(8).toString('utf8'));
        });
        logStream.on('error', (err) => log.error('Log stream error:', err));

        ws.on('message', async (msg) => {
            let parsed;
            try { parsed = JSON.parse(msg); } catch { return; }
            if (parsed.event === 'cmd' && typeof parsed.command === 'string') {
                await executeCommand(ws, container, parsed.command);
            }
        });

        ws.on('close', () => { logStream.destroy(); log.info('Exec WS disconnected'); });
    }

    function setupStatsStreaming(ws, container, volumeId) {
        let statsStream;
        container.stats({ stream: true }, (err, stream) => {
            if (err) {
                ws.send(JSON.stringify({ event: 'error', message: 'Failed to fetch stats' }));
                return;
            }
            statsStream = stream;
            let buffer  = '';
            stream.on('data', (chunk) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const stats   = JSON.parse(line);
                        const payload = buildStatsPayload(stats, volumeId);
                        ws.send(JSON.stringify(payload));
                    } catch { /* skip malformed chunk */ }
                }
            });
            stream.on('error', (err) => log.error('Stats stream error:', err));
        });
        ws.on('close', () => { if (statsStream) statsStream.destroy(); log.info('Stats WS disconnected'); });
    }

    function buildStatsPayload(stats, volumeId) {
        const cpuDelta    = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
        const numCpus     = stats.cpu_stats.online_cpus || 1;
        const cpuPercent  = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;
        const memUsage    = stats.memory_stats.usage - (stats.memory_stats.stats?.cache || 0);
        const memLimit    = stats.memory_stats.limit;
        const networks    = stats.networks || {};
        let rxBytes = 0, txBytes = 0;
        for (const iface of Object.values(networks)) {
            rxBytes += iface.rx_bytes || 0;
            txBytes += iface.tx_bytes || 0;
        }
        const payload = {
            event:     'stats',
            cpu:       parseFloat(cpuPercent.toFixed(2)),
            memory:    { usage: memUsage, limit: memLimit },
            network:   { rx: rxBytes, tx: txBytes },
            timestamp: stats.read,
        };
        if (volumeId) payload.volumeSize = getVolumeSize(volumeId);
        return payload;
    }

    async function executeCommand(ws, container, command) {
        if (typeof command !== 'string' || command.length > 4096) {
            ws.send(JSON.stringify({ event: 'error', message: 'Invalid command' }));
            return;
        }
        try {
            const exec   = await container.exec({ Cmd: ['/bin/sh', '-c', command], AttachStdout: true, AttachStderr: true });
            const stream = await exec.start({ hijack: true, stdin: false });
            stream.on('data', (chunk) => { if (ws.readyState === WebSocket.OPEN) ws.send(chunk.slice(8).toString('utf8')); });
            stream.on('end',  ()      => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'cmd:done' })); });
            stream.on('error', (err)  => log.error('Exec stream error:', err));
        } catch (err) {
            log.error('Failed to exec command:', err);
            ws.send(JSON.stringify({ event: 'error', message: 'Exec failed: ' + err.message }));
        }
    }

    function performPowerAction(ws, container, action) {
        ws.send('[1m[33m[daemon] [0mworking on it...');
        const actionMap = {
            start:   container.start.bind(container),
            stop:    container.kill.bind(container),
            restart: container.restart.bind(container),
        };
        actionMap[action]((err) => {
            if (err) {
                log.error('Power action ' + action + ' failed:', err);
                ws.send(JSON.stringify({ event: 'error', message: 'Power action failed: ' + err.message }));
                return;
            }
            ws.send(JSON.stringify({ event: 'power:state', state: action }));
        });
    }

    function getVolumeSize(volumeId) {
        if (!/^[a-zA-Z0-9\-_]+$/.test(volumeId)) return 'Unknown';
        const volumePath = path.join(__dirname, 'volumes', volumeId);
        try { return formatBytes(calculateDirectorySize(volumePath, 0)); }
        catch (err) { log.error('Volume size error for ' + volumeId + ':', err); return 'Unknown'; }
    }

    function calculateDirectorySize(dirPath, depth) {
        if (depth > 10) return 0;
        let totalSize = 0, files;
        try { files = fs.readdirSync(dirPath); } catch { return 0; }
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            try {
                const stats = fs.statSync(filePath);
                if (stats.isDirectory()) totalSize += calculateDirectorySize(filePath, depth + 1);
                else totalSize += stats.size;
            } catch { /* skip */ }
        }
        return totalSize;
    }

    function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}

initializeWebSocketServer(server);

// ── Start ─────────────────────────────────────────────────────────────────────

const port = config.port;
setTimeout(() => {
    server.listen(port, () => {
        log.info('lunarix-dm listening on port ' + port + ' (' + protocol.toUpperCase() + ')');
        if (tlsContext) log.info('TLS enabled — WSS and HTTPS active');
        log.info('Obfuscated WS endpoint: ' + protocol + '://node:' + port + '/cdn-cgi/ws?p=/exec/<id>');
    });
}, 2000);
