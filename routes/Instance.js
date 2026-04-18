const express = require('express');
const router  = express.Router();
const Docker  = require('dockerode');
const fs      = require('fs');
const path    = require('path');
const CatLoggr = require('cat-loggr');

const docker = new Docker({ socketPath: process.env.dockerSocket });
const log    = new CatLoggr();

// GET /instances — list all containers
router.get('/', (req, res) => {
    docker.listContainers({ all: true }, (err, containers) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json(containers);
    });
});

// GET /instances/:id — inspect a single container
router.get('/:id', (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ message: 'Container ID is required' });
    const container = docker.getContainer(id);
    container.inspect((err, data) => {
        if (err) return res.status(404).json({ message: 'Container not found' });
        res.json(data);
    });
});

// GET /instances/:id/ports — list exposed ports
router.get('/:id/ports', (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ message: 'Container ID is required' });
    const container = docker.getContainer(id);
    container.inspect((err, data) => {
        if (err) return res.status(404).json({ message: 'Container not found' });
        const ports    = data.NetworkSettings.Ports || {};
        const portList = Object.entries(ports).map(([port, bindings]) => ({
            port,
            bindings: bindings || [],
        }));
        res.json(portList);
    });
});

// DELETE /instances/:id — remove container and its volume
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ message: 'Container ID is required' });
    const container = docker.getContainer(id);
    let name;
    try {
        const info = await container.inspect();
        name = info.Name.startsWith('/') ? info.Name.slice(1) : info.Name;
    } catch (err) {
        return res.status(404).json({ message: 'Container not found' });
    }
    try {
        await container.remove({ force: true });
    } catch (err) {
        return res.status(500).json({ message: 'Failed to remove container: ' + err.message });
    }
    const volumeDir = path.join(__dirname, '../volumes', name);
    try {
        fs.rmSync(volumeDir, { force: true, recursive: true });
    } catch (err) {
        log.warn('Could not remove volume dir ' + volumeDir + ': ' + err.message);
    }
    res.json({ message: 'Container and volume removed' });
});

// DELETE /instances/purge/all — force-remove every container
router.delete('/purge/all', async (req, res) => {
    let containers;
    try {
        containers = await docker.listContainers({ all: true });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
    const results = await Promise.allSettled(
        containers.map(c => docker.getContainer(c.Id).remove({ force: true }))
    );
    const failed = results.filter(r => r.status === 'rejected').map(r => r.reason?.message);
    if (failed.length > 0) {
        return res.status(207).json({ message: 'Some containers could not be removed', errors: failed });
    }
    res.json({ message: 'Removed ' + containers.length + ' containers' });
});

module.exports = router;
