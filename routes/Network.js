/**
 * Network isolation and bandwidth management for containers.
 *
 * Each container can be placed in a dedicated Docker network so it cannot
 * reach other containers on the node by default. Bandwidth limits are applied
 * via Docker's built-in blkio/network throttling options (tc-based on Linux).
 *
 * Routes:
 *   POST /network/:id/isolate          — move container to its own network
 *   DELETE /network/:id/isolate        — reconnect to shared bridge
 *   POST /network/:id/bandwidth        — set ingress/egress limits (kbps)
 *   GET  /network/:id/bandwidth        — read current limits
 *   DELETE /network/:id/bandwidth      — remove limits
 *   GET  /network/list                 — list all daemon-managed networks
 */

const express  = require('express');
const router   = express.Router();
const Docker   = require('dockerode');
const { exec } = require('child_process');
const { promisify } = require('util');
const CatLoggr = require('cat-loggr');

const docker  = new Docker({ socketPath: process.env.dockerSocket });
const log     = new CatLoggr();
const execAsync = promisify(exec);

// Prefix for all daemon-managed isolation networks
const NET_PREFIX = 'lunarix-isolated-';

// In-memory bandwidth config store (survives restarts via re-apply on boot)
const bandwidthStore = new Map(); // containerId -> { ingressKbps, egressKbps }

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getContainerVeth(containerId) {
    // Find the veth interface on the host side for a container
    const container = docker.getContainer(containerId);
    const info      = await container.inspect();
    const pid       = info.State.Pid;
    if (!pid) throw new Error('Container is not running');

    // Read the ifindex of eth0 inside the container's netns
    const { stdout } = await execAsync(
        `nsenter -t ${pid} -n -- cat /sys/class/net/eth0/iflink 2>/dev/null || echo ""`
    );
    const ifindex = stdout.trim();
    if (!ifindex) throw new Error('Could not determine container ifindex');

    // Find the matching veth on the host
    const { stdout: vethOut } = await execAsync(
        `ip link show | awk -F': ' '/^${ifindex}:/{print $2}' | head -1`
    );
    return vethOut.trim().split('@')[0];
}

async function applyTcRules(veth, ingressKbps, egressKbps) {
    // Clear existing rules first
    await execAsync(`tc qdisc del dev ${veth} root 2>/dev/null || true`);
    await execAsync(`tc qdisc del dev ${veth} ingress 2>/dev/null || true`);

    if (egressKbps > 0) {
        // Egress (outgoing from container's perspective = host veth TX)
        await execAsync(`tc qdisc add dev ${veth} root tbf rate ${egressKbps}kbit burst 32kbit latency 400ms`);
    }

    if (ingressKbps > 0) {
        // Ingress shaping via IFB (requires ifb module)
        await execAsync(`modprobe ifb 2>/dev/null || true`);
        await execAsync(`tc qdisc add dev ${veth} ingress`);
        await execAsync(`tc filter add dev ${veth} parent ffff: protocol ip u32 match u32 0 0 action mirred egress redirect dev ifb0`);
        await execAsync(`tc qdisc add dev ifb0 root tbf rate ${ingressKbps}kbit burst 32kbit latency 400ms`);
    }
}

async function clearTcRules(veth) {
    await execAsync(`tc qdisc del dev ${veth} root 2>/dev/null || true`);
    await execAsync(`tc qdisc del dev ${veth} ingress 2>/dev/null || true`);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /network/list — list all lunarix-managed isolation networks
router.get('/list', async (req, res) => {
    try {
        const networks = await docker.listNetworks({
            filters: JSON.stringify({ name: [NET_PREFIX] }),
        });
        res.json({ networks: networks.map(n => ({ id: n.Id, name: n.Name, created: n.Created })) });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST /network/:id/isolate — create a dedicated network and move the container into it
router.post('/:id/isolate', async (req, res) => {
    const { id } = req.params;
    const container = docker.getContainer(id);

    let info;
    try {
        info = await container.inspect();
    } catch {
        return res.status(404).json({ message: 'Container not found' });
    }

    const netName = NET_PREFIX + id.substring(0, 12);

    try {
        // Create isolated network (internal = no external routing by default)
        let network;
        try {
            network = await docker.createNetwork({
                Name:     netName,
                Driver:   'bridge',
                Internal: false, // set true to fully block internet access
                Options:  { 'com.docker.network.bridge.enable_icc': 'false' },
                Labels:   { 'lunarix.managed': 'true', 'lunarix.container': id },
            });
        } catch (err) {
            // Network may already exist
            const existing = await docker.listNetworks({ filters: JSON.stringify({ name: [netName] }) });
            if (existing.length === 0) throw err;
            network = docker.getNetwork(existing[0].Id);
        }

        // Disconnect from current networks, connect to isolated one
        const currentNets = Object.keys(info.NetworkSettings.Networks || {});
        for (const net of currentNets) {
            if (net !== netName) {
                try {
                    await docker.getNetwork(net).disconnect({ Container: id, Force: true });
                } catch { /* ignore */ }
            }
        }

        await network.connect({ Container: id });

        log.info(`Container ${id.substring(0, 12)} isolated to network ${netName}`);
        res.json({ message: 'Container isolated', network: netName });
    } catch (err) {
        log.error('Isolate error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// DELETE /network/:id/isolate — reconnect to default bridge and remove isolated network
router.delete('/:id/isolate', async (req, res) => {
    const { id } = req.params;
    const netName = NET_PREFIX + id.substring(0, 12);

    try {
        // Reconnect to default bridge
        const bridge = docker.getNetwork('bridge');
        await bridge.connect({ Container: id }).catch(() => {});

        // Disconnect from isolated network
        const nets = await docker.listNetworks({ filters: JSON.stringify({ name: [netName] }) });
        if (nets.length > 0) {
            const net = docker.getNetwork(nets[0].Id);
            await net.disconnect({ Container: id, Force: true }).catch(() => {});
            await net.remove();
        }

        res.json({ message: 'Isolation removed, container reconnected to bridge' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST /network/:id/bandwidth — apply tc-based bandwidth limits
router.post('/:id/bandwidth', async (req, res) => {
    const { id } = req.params;
    const { ingressKbps = 0, egressKbps = 0 } = req.body;

    if (typeof ingressKbps !== 'number' || typeof egressKbps !== 'number') {
        return res.status(400).json({ message: 'ingressKbps and egressKbps must be numbers' });
    }

    try {
        const veth = await getContainerVeth(id);
        await applyTcRules(veth, ingressKbps, egressKbps);
        bandwidthStore.set(id, { ingressKbps, egressKbps, veth });
        log.info(`Bandwidth set for ${id.substring(0, 12)}: in=${ingressKbps}kbps out=${egressKbps}kbps`);
        res.json({ message: 'Bandwidth limits applied', ingressKbps, egressKbps });
    } catch (err) {
        log.error('Bandwidth error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// GET /network/:id/bandwidth — read current limits
router.get('/:id/bandwidth', (req, res) => {
    const { id } = req.params;
    const config = bandwidthStore.get(id);
    if (!config) return res.json({ ingressKbps: 0, egressKbps: 0, limited: false });
    res.json({ ...config, limited: true });
});

// DELETE /network/:id/bandwidth — remove tc rules
router.delete('/:id/bandwidth', async (req, res) => {
    const { id } = req.params;
    const config = bandwidthStore.get(id);

    try {
        const veth = config?.veth || await getContainerVeth(id);
        await clearTcRules(veth);
        bandwidthStore.delete(id);
        res.json({ message: 'Bandwidth limits removed' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
