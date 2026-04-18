/**
 * Xray sidecar management for game server traffic obfuscation.
 *
 * Each game server container can have a paired Xray container that tunnels
 * its traffic through VLESS+WS+TLS, making it indistinguishable from HTTPS
 * to DPI systems and bypassing whitelist-based port blocking.
 *
 * Architecture:
 *   [Game Client] → [Xray Client (player's machine)]
 *       ↓ VLESS+WS+TLS (looks like HTTPS to DPI)
 *   [Xray Server (VPS/CDN)] → [Xray Sidecar (this node)]
 *       ↓ plain TCP/UDP (localhost)
 *   [Game Server Container]
 *
 * Routes:
 *   POST   /xray/:id/sidecar         — deploy Xray sidecar for a container
 *   DELETE /xray/:id/sidecar         — remove sidecar
 *   GET    /xray/:id/sidecar         — get sidecar status + client config
 *   POST   /xray/:id/sidecar/restart — restart sidecar container
 *   GET    /xray/configs/client/:id  — download client-side Xray config
 */

const express  = require('express');
const router   = express.Router();
const Docker   = require('dockerode');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs').promises;
const CatLoggr = require('cat-loggr');
const { generateXrayConfig } = require('../handlers/obfuscation.js');

const docker = new Docker({ socketPath: process.env.dockerSocket });
const log    = new CatLoggr();

const DATA_DIR    = path.join(__dirname, '../data');
const XRAY_IMAGE  = 'ghcr.io/xtls/xray-core:latest';
const SIDECAR_PREFIX = 'lunarix-xray-';

// Persist sidecar configs so they survive daemon restarts
const sidecars = new Map(); // containerId -> sidecarConfig

async function saveSidecars() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(
        path.join(DATA_DIR, 'sidecars.json'),
        JSON.stringify([...sidecars.entries()], null, 2)
    );
}

async function loadSidecars() {
    try {
        const raw  = await fs.readFile(path.join(DATA_DIR, 'sidecars.json'), 'utf8');
        const list = JSON.parse(raw);
        for (const [id, cfg] of list) sidecars.set(id, cfg);
        log.info(`Xray: loaded ${list.length} sidecar config(s)`);
    } catch (err) {
        if (err.code !== 'ENOENT') log.error('Xray load error:', err.message);
    }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /xray/:id/sidecar — deploy Xray sidecar
router.post('/:id/sidecar', async (req, res) => {
    const { id } = req.params;
    const {
        serverAddr,
        serverPort = 443,
        wsPath     = '/cdn-cgi/game',
        sni,
        localPort,
        protocol   = 'tcp',
    } = req.body;

    if (!serverAddr || typeof serverAddr !== 'string') {
        return res.status(400).json({ message: 'serverAddr is required' });
    }
    if (!sni || typeof sni !== 'string') {
        return res.status(400).json({ message: 'sni (TLS SNI domain) is required' });
    }
    if (!localPort || typeof localPort !== 'number') {
        return res.status(400).json({ message: 'localPort is required' });
    }

    // Verify game container exists
    let containerInfo;
    try {
        containerInfo = await docker.getContainer(id).inspect();
    } catch {
        return res.status(404).json({ message: 'Container not found' });
    }

    const uuid        = crypto.randomUUID();
    const sidecarName = SIDECAR_PREFIX + id.substring(0, 12);
    const configDir   = path.join(DATA_DIR, 'xray', id.substring(0, 12));

    await fs.mkdir(configDir, { recursive: true });

    // Generate server-side Xray config (runs on this node as sidecar)
    const serverConfig = {
        log: { loglevel: 'warning' },
        inbounds: [{
            port:     localPort,
            listen:   '127.0.0.1',
            protocol: 'vless',
            settings: {
                clients:    [{ id: uuid, level: 0 }],
                decryption: 'none',
            },
            streamSettings: {
                network:    'ws',
                security:   'none', // TLS is terminated at the upstream (CDN/reverse proxy)
                wsSettings: { path: wsPath },
            },
            tag: 'vless-in',
        }],
        outbounds: [{
            protocol: 'freedom',
            settings: { domainStrategy: 'UseIP' },
            tag:      'direct',
        }],
        routing: {
            rules: [{
                type:        'field',
                inboundTag:  ['vless-in'],
                outboundTag: 'direct',
            }],
        },
    };

    const serverConfigPath = path.join(configDir, 'server.json');
    await fs.writeFile(serverConfigPath, JSON.stringify(serverConfig, null, 2));

    // Generate client-side config (for players / panel to distribute)
    const clientConfig = generateXrayConfig({
        uuid, serverAddr, serverPort, wsPath, sni, localPort, protocol,
    });

    const clientConfigPath = path.join(configDir, 'client.json');
    await fs.writeFile(clientConfigPath, JSON.stringify(clientConfig, null, 2));

    // Pull Xray image if needed and start sidecar container
    try {
        await new Promise((resolve, reject) => {
            docker.pull(XRAY_IMAGE, (err, stream) => {
                if (err) return reject(err);
                docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
            });
        });
    } catch (err) {
        log.warn('Xray: image pull failed (may already exist):', err.message);
    }

    // Remove existing sidecar if present
    try {
        await docker.getContainer(sidecarName).remove({ force: true });
    } catch { /* not running */ }

    const sidecarContainer = await docker.createContainer({
        name:  sidecarName,
        Image: XRAY_IMAGE,
        Cmd:   ['xray', 'run', '-c', '/etc/xray/config.json'],
        HostConfig: {
            Binds:       [`${configDir}:/etc/xray`],
            NetworkMode: 'host',
            RestartPolicy: { Name: 'unless-stopped' },
            SecurityOpt: ['no-new-privileges'],
        },
        Labels: {
            'lunarix.managed':   'true',
            'lunarix.sidecar':   'xray',
            'lunarix.container': id,
        },
    });

    await sidecarContainer.start();

    const sidecarConfig = {
        containerId:      id,
        sidecarId:        sidecarContainer.id,
        sidecarName,
        uuid,
        serverAddr,
        serverPort,
        wsPath,
        sni,
        localPort,
        protocol,
        createdAt:        new Date().toISOString(),
    };

    sidecars.set(id, sidecarConfig);
    await saveSidecars();

    log.info(`Xray sidecar deployed for container ${id.substring(0, 12)}`);
    res.status(201).json({
        message:      'Xray sidecar deployed',
        sidecarId:    sidecarContainer.id,
        uuid,
        clientConfig, // panel can distribute this to players
    });
});

// GET /xray/:id/sidecar — status
router.get('/:id/sidecar', async (req, res) => {
    const { id } = req.params;
    const cfg = sidecars.get(id);
    if (!cfg) return res.status(404).json({ message: 'No sidecar for this container' });

    let status = 'unknown';
    try {
        const info = await docker.getContainer(cfg.sidecarId).inspect();
        status = info.State.Status;
    } catch {
        status = 'removed';
    }

    res.json({ ...cfg, status });
});

// DELETE /xray/:id/sidecar — remove sidecar
router.delete('/:id/sidecar', async (req, res) => {
    const { id } = req.params;
    const cfg = sidecars.get(id);
    if (!cfg) return res.status(404).json({ message: 'No sidecar for this container' });

    try {
        await docker.getContainer(cfg.sidecarId).remove({ force: true });
    } catch { /* already removed */ }

    // Clean up config files
    const configDir = path.join(DATA_DIR, 'xray', id.substring(0, 12));
    await fs.rm(configDir, { recursive: true, force: true }).catch(() => {});

    sidecars.delete(id);
    await saveSidecars();

    res.json({ message: 'Xray sidecar removed' });
});

// POST /xray/:id/sidecar/restart
router.post('/:id/sidecar/restart', async (req, res) => {
    const { id } = req.params;
    const cfg = sidecars.get(id);
    if (!cfg) return res.status(404).json({ message: 'No sidecar for this container' });

    try {
        await docker.getContainer(cfg.sidecarId).restart();
        res.json({ message: 'Sidecar restarted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// GET /xray/configs/client/:id — download client Xray config JSON
router.get('/configs/client/:id', async (req, res) => {
    const { id } = req.params;
    const cfg = sidecars.get(id);
    if (!cfg) return res.status(404).json({ message: 'No sidecar for this container' });

    const clientConfigPath = path.join(DATA_DIR, 'xray', id.substring(0, 12), 'client.json');
    try {
        const content = await fs.readFile(clientConfigPath, 'utf8');
        res.setHeader('Content-Disposition', `attachment; filename="xray-client-${id.substring(0, 12)}.json"`);
        res.setHeader('Content-Type', 'application/json');
        res.send(content);
    } catch {
        res.status(404).json({ message: 'Client config not found' });
    }
});

loadSidecars();

module.exports = router;
