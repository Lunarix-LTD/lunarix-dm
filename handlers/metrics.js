/**
 * Prometheus-compatible metrics collector.
 *
 * Exposes:
 *   - Default Node.js process metrics (GC, event loop, heap)
 *   - Per-container CPU %, memory usage, network I/O
 *   - Daemon-level counters (WS connections, API requests)
 *
 * The collector runs a background Docker stats poll every 15 s so the
 * /metrics scrape is always fast (no blocking Docker calls on scrape).
 */

const client = require('prom-client');
const Docker = require('dockerode');
const CatLoggr = require('cat-loggr');

const log    = new CatLoggr();
const docker = new Docker({ socketPath: process.env.dockerSocket });

// ── Registry ──────────────────────────────────────────────────────────────────

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'lunarix_' });

// ── Per-container gauges ──────────────────────────────────────────────────────

const containerCpu = new client.Gauge({
    name: 'lunarix_container_cpu_percent',
    help: 'CPU usage percent per container',
    labelNames: ['id', 'name'],
    registers: [registry],
});

const containerMemUsage = new client.Gauge({
    name: 'lunarix_container_memory_usage_bytes',
    help: 'Memory usage (RSS, cache excluded) per container',
    labelNames: ['id', 'name'],
    registers: [registry],
});

const containerMemLimit = new client.Gauge({
    name: 'lunarix_container_memory_limit_bytes',
    help: 'Memory limit per container',
    labelNames: ['id', 'name'],
    registers: [registry],
});

const containerNetRx = new client.Gauge({
    name: 'lunarix_container_network_rx_bytes_total',
    help: 'Total bytes received per container since start',
    labelNames: ['id', 'name'],
    registers: [registry],
});

const containerNetTx = new client.Gauge({
    name: 'lunarix_container_network_tx_bytes_total',
    help: 'Total bytes sent per container since start',
    labelNames: ['id', 'name'],
    registers: [registry],
});

// ── Daemon-level counters ─────────────────────────────────────────────────────

const wsConnections = new client.Gauge({
    name: 'lunarix_ws_connections_active',
    help: 'Number of active WebSocket connections',
    registers: [registry],
});

const httpRequests = new client.Counter({
    name: 'lunarix_http_requests_total',
    help: 'Total HTTP requests handled',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
});

const containerCount = new client.Gauge({
    name: 'lunarix_containers_total',
    help: 'Total number of Docker containers (all states)',
    labelNames: ['state'],
    registers: [registry],
});

// ── In-memory history (last 60 samples per container, ~15 min at 15s interval) ─

const HISTORY_MAX = 60;
const history = new Map(); // containerId -> { cpu: [], mem: [], ts: [] }

function recordHistory(id, cpu, mem) {
    if (!history.has(id)) history.set(id, { cpu: [], mem: [], ts: [] });
    const h = history.get(id);
    h.cpu.push(cpu);
    h.mem.push(mem);
    h.ts.push(Date.now());
    if (h.cpu.length > HISTORY_MAX) {
        h.cpu.shift(); h.mem.shift(); h.ts.shift();
    }
}

function getHistory(id) {
    return history.get(id) || { cpu: [], mem: [], ts: [] };
}

// ── Background stats collector ────────────────────────────────────────────────

async function collectStats() {
    let containers;
    try {
        containers = await docker.listContainers({ all: true });
    } catch (err) {
        log.error('Metrics: failed to list containers:', err.message);
        return;
    }

    // Count by state
    const stateCounts = {};
    for (const c of containers) {
        stateCounts[c.State] = (stateCounts[c.State] || 0) + 1;
    }
    containerCount.reset();
    for (const [state, count] of Object.entries(stateCounts)) {
        containerCount.labels(state).set(count);
    }

    // Collect stats for running containers only
    const running = containers.filter(c => c.State === 'running');
    await Promise.allSettled(running.map(async (c) => {
        const id   = c.Id.substring(0, 12);
        const name = (c.Names[0] || id).replace(/^\//, '');
        try {
            const stats = await new Promise((resolve, reject) => {
                docker.getContainer(c.Id).stats({ stream: false }, (err, s) => {
                    if (err) reject(err); else resolve(s);
                });
            });

            const cpuDelta    = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
            const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
            const numCpus     = stats.cpu_stats.online_cpus || 1;
            const cpu         = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;
            const mem         = stats.memory_stats.usage - (stats.memory_stats.stats?.cache || 0);
            const memLimit    = stats.memory_stats.limit || 0;

            let rxBytes = 0, txBytes = 0;
            for (const iface of Object.values(stats.networks || {})) {
                rxBytes += iface.rx_bytes || 0;
                txBytes += iface.tx_bytes || 0;
            }

            containerCpu.labels(id, name).set(parseFloat(cpu.toFixed(2)));
            containerMemUsage.labels(id, name).set(mem);
            containerMemLimit.labels(id, name).set(memLimit);
            containerNetRx.labels(id, name).set(rxBytes);
            containerNetTx.labels(id, name).set(txBytes);

            recordHistory(id, parseFloat(cpu.toFixed(2)), mem);
        } catch { /* container may have stopped between list and stats */ }
    }));
}

// Poll every 15 seconds
let collectorInterval = null;

function startCollector() {
    collectStats();
    collectorInterval = setInterval(collectStats, 15_000);
}

function stopCollector() {
    if (collectorInterval) clearInterval(collectorInterval);
}

module.exports = {
    registry,
    wsConnections,
    httpRequests,
    getHistory,
    startCollector,
    stopCollector,
};
