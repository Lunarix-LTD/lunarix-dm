const express  = require('express');
const router   = express.Router();
const Docker   = require('dockerode');
const fs       = require('fs').promises;
const fsSync   = require('fs');
const path     = require('path');
const CatLoggr = require('cat-loggr');
const https    = require('https');
const { pipeline } = require('stream/promises');

const docker = new Docker({ socketPath: process.env.dockerSocket });
const log    = new CatLoggr();

// Volumes base directory — all paths are resolved relative to this
const VOLUMES_BASE = path.resolve(__dirname, '../volumes');

function safeVolumePath(volumeId) {
    // Only allow alphanumeric + hyphens/underscores in volume IDs
    if (!/^[a-zA-Z0-9\-_]+$/.test(volumeId)) {
        throw new Error('Invalid volume ID');
    }
    return path.join(VOLUMES_BASE, volumeId);
}

const downloadFile = (url, dir, filename) => {
    return new Promise((resolve, reject) => {
        // Only allow HTTPS downloads
        if (!url.startsWith('https://')) {
            return reject(new Error('Only HTTPS download URLs are allowed'));
        }
        const filePath = path.join(dir, path.basename(filename)); // basename prevents path traversal
        https.get(url, async (response) => {
            if (response.statusCode !== 200) {
                return reject(new Error('HTTP ' + response.statusCode + ' downloading ' + filename));
            }
            const writeStream = fsSync.createWriteStream(filePath);
            try {
                await pipeline(response, writeStream);
                resolve();
            } catch (err) {
                fsSync.unlink(filePath, () => {});
                reject(err);
            }
        }).on('error', (err) => {
            fsSync.unlink(filePath, () => {});
            reject(err);
        });
    });
};

const downloadInstallScripts = async (installScripts, dir, variables) => {
    let parsedVariables = {};
    if (variables) {
        try {
            parsedVariables = typeof variables === 'string' ? JSON.parse(variables) : variables;
        } catch {
            log.warn('Could not parse install script variables');
        }
    }

    for (const script of installScripts) {
        if (!script.Uri || !script.Path) continue;
        try {
            let updatedUri = script.Uri;
            for (const [key, value] of Object.entries(parsedVariables)) {
                updatedUri = updatedUri.replace('{{' + key + '}}', encodeURIComponent(value));
            }
            await downloadFile(updatedUri, dir, script.Path);
            log.info('Downloaded ' + script.Path);
        } catch (err) {
            log.error('Failed to download ' + script.Path + ': ' + err.message);
        }
    }
};

const replaceVariables = async (dir, variables) => {
    const files = await fs.readdir(dir);
    for (const file of files) {
        const filePath = path.join(dir, file);
        const stats    = await fs.stat(filePath);
        if (!stats.isFile() || file.endsWith('.jar')) continue;
        // Skip large files to avoid OOM
        if (stats.size > 10 * 1024 * 1024) continue;
        let content = await fs.readFile(filePath, 'utf8');
        for (const [key, value] of Object.entries(variables)) {
            content = content.replace(new RegExp('{{' + key + '}}', 'g'), value);
        }
        await fs.writeFile(filePath, content, 'utf8');
    }
};

// POST /instances/create
router.post('/create', async (req, res) => {
    const { Image, Id, Cmd, Env, Ports, Scripts, Memory, Cpu, PortBindings } = req.body;
    const variables2 = req.body.variables;

    // Input validation
    if (!Image || typeof Image !== 'string') {
        return res.status(400).json({ message: 'Image is required' });
    }
    if (!Id || typeof Id !== 'string') {
        return res.status(400).json({ message: 'Id is required' });
    }
    if (Memory && (typeof Memory !== 'number' || Memory < 0 || Memory > 65536)) {
        return res.status(400).json({ message: 'Memory must be a number between 0 and 65536 MB' });
    }
    if (Cpu && (typeof Cpu !== 'number' || Cpu < 0 || Cpu > 256)) {
        return res.status(400).json({ message: 'Cpu must be a number between 0 and 256' });
    }

    let volumePath;
    try {
        volumePath = safeVolumePath(Id);
    } catch (err) {
        return res.status(400).json({ message: err.message });
    }

    log.info('Deploying container: ' + Id);

    try {
        await fs.mkdir(volumePath, { recursive: true });

        const containerOptions = {
            name: Id,
            Image,
            ExposedPorts: Ports || {},
            AttachStdout: true,
            AttachStderr: true,
            AttachStdin: true,
            Tty: true,
            OpenStdin: true,
            HostConfig: {
                PortBindings: PortBindings || {},
                Binds: [volumePath + ':/app/data'],
                Memory: Memory ? Memory * 1024 * 1024 : 0,
                // Use NanoCpus for precise CPU limiting (1 CPU = 1e9 NanoCpus)
                NanoCpus: Cpu ? Math.round(Cpu * 1e9) : 0,
                NetworkMode: 'host',
                // Security: prevent privilege escalation inside containers
                SecurityOpt: ['no-new-privileges'],
            },
        };

        if (Cmd) containerOptions.Cmd = Cmd;
        if (Env && Array.isArray(Env)) containerOptions.Env = Env;

        const container = await docker.createContainer(containerOptions);
        await container.start();

        log.info('Deployed container: ' + container.id);
        res.status(201).json({
            message: 'Container created successfully',
            containerId: container.id,
            volumeId: Id,
        });

        // Run install scripts after responding so the panel isn't blocked
        if (Scripts && Scripts.Install && Array.isArray(Scripts.Install)) {
            await downloadInstallScripts(Scripts.Install, volumePath, variables2);

            const primaryPort = PortBindings && Object.values(PortBindings)[0]?.[0]?.HostPort;
            const variables = {
                primaryPort:   primaryPort || '',
                containerName: container.id.substring(0, 12),
                timestamp:     new Date().toISOString(),
                randomString:  require('crypto').randomBytes(4).toString('hex'),
            };
            await replaceVariables(volumePath, variables);
        }
    } catch (err) {
        log.error('Deployment failed: ' + err.message);
        // Only send error if headers not already sent
        if (!res.headersSent) {
            res.status(500).json({ message: err.message });
        }
    }
});

// DELETE /instances/:id
router.delete('/:id', async (req, res) => {
    const container = docker.getContainer(req.params.id);
    try {
        await container.remove({ force: true });
        res.status(200).json({ message: 'Container removed' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST /instances/redeploy/:id
router.post('/redeploy/:id', async (req, res) => {
    const { id } = req.params;
    const { Image, Id, Ports, Memory, Cpu, PortBindings, Env } = req.body;

    if (!Id || typeof Id !== 'string') {
        return res.status(400).json({ message: 'Id is required' });
    }

    let volumePath;
    try {
        volumePath = safeVolumePath(Id);
    } catch (err) {
        return res.status(400).json({ message: err.message });
    }

    const container = docker.getContainer(id);
    try {
        await container.remove({ force: true });

        const containerOptions = {
            Image,
            ExposedPorts: Ports || {},
            AttachStdout: true,
            AttachStderr: true,
            AttachStdin: true,
            Tty: true,
            OpenStdin: true,
            HostConfig: {
                PortBindings: PortBindings || {},
                Binds: [volumePath + ':/app/data'],
                Memory: Memory ? Memory * 1024 * 1024 : 0,
                NanoCpus: Cpu ? Math.round(Cpu * 1e9) : 0,
                NetworkMode: 'host',
                SecurityOpt: ['no-new-privileges'],
            },
        };

        if (Env && Array.isArray(Env)) containerOptions.Env = Env;

        const newContainer = await docker.createContainer(containerOptions);
        await newContainer.start();
        res.status(200).json({ message: 'Container redeployed', containerId: newContainer.id });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// PUT /instances/edit/:id
router.put('/edit/:id', async (req, res) => {
    const { id } = req.params;
    const { Image, Memory, Cpu, VolumeId } = req.body;

    if (!VolumeId || typeof VolumeId !== 'string') {
        return res.status(400).json({ message: 'VolumeId is required' });
    }

    let volumePath;
    try {
        volumePath = safeVolumePath(VolumeId);
    } catch (err) {
        return res.status(400).json({ message: err.message });
    }

    try {
        const container     = docker.getContainer(id);
        const containerInfo = await container.inspect();
        const existing      = containerInfo.Config;
        const existingHost  = containerInfo.HostConfig;

        const newOptions = {
            Image:        Image || existing.Image,
            ExposedPorts: existing.ExposedPorts,
            Cmd:          existing.Cmd,
            Env:          existing.Env,
            AttachStdout: true,
            AttachStderr: true,
            AttachStdin:  true,
            Tty:          true,
            OpenStdin:    true,
            HostConfig: {
                PortBindings: existingHost.PortBindings,
                Binds:        [volumePath + ':/app/data'],
                Memory:       Memory ? Memory * 1024 * 1024 : existingHost.Memory,
                NanoCpus:     Cpu ? Math.round(Cpu * 1e9) : existingHost.NanoCpus,
                NetworkMode:  'host',
                SecurityOpt:  ['no-new-privileges'],
            },
        };

        await container.stop().catch(() => {}); // ignore if already stopped
        await container.remove();

        const newContainer = await docker.createContainer(newOptions);
        await newContainer.start();

        log.info('Edited container ' + id + ' -> ' + newContainer.id);
        res.status(200).json({
            message:        'Container updated',
            oldContainerId: id,
            newContainerId: newContainer.id,
        });
    } catch (err) {
        log.error('Edit failed: ' + err.message);
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
