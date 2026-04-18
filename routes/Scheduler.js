/**
 * Task scheduler for containers.
 *
 * Supports two task types:
 *   - auto-backup: creates a ZIP archive of the container's volume on a cron schedule
 *   - auto-restart: restarts the container on a cron schedule
 *
 * Tasks are persisted to ./data/schedules.json so they survive daemon restarts.
 *
 * Routes:
 *   GET    /scheduler/tasks                  — list all scheduled tasks
 *   POST   /scheduler/tasks                  — create a task
 *   DELETE /scheduler/tasks/:taskId          — remove a task
 *   POST   /scheduler/tasks/:taskId/run      — trigger immediately
 *   GET    /scheduler/tasks/:taskId/history  — last 20 execution results
 */

const express  = require('express');
const router   = express.Router();
const cron     = require('node-cron');
const Docker   = require('dockerode');
const fs       = require('fs');
const fsP      = require('fs').promises;
const path     = require('path');
const archiver = require('archiver');
const crypto   = require('crypto');
const CatLoggr = require('cat-loggr');

const docker = new Docker({ socketPath: process.env.dockerSocket });
const log    = new CatLoggr();

const DATA_DIR      = path.join(__dirname, '../data');
const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json');
const ARCHIVES_DIR  = path.join(__dirname, '../archives');
const VOLUMES_DIR   = path.join(__dirname, '../volumes');

// In-memory state
const tasks    = new Map(); // taskId -> task config
const cronJobs = new Map(); // taskId -> cron.ScheduledTask
const history  = new Map(); // taskId -> [{ ts, success, message }]

const HISTORY_MAX = 20;

// ── Persistence ───────────────────────────────────────────────────────────────

async function saveTasks() {
    await fsP.mkdir(DATA_DIR, { recursive: true });
    const data = JSON.stringify([...tasks.values()], null, 2);
    await fsP.writeFile(SCHEDULES_FILE, data, 'utf8');
}

async function loadTasks() {
    try {
        const raw  = await fsP.readFile(SCHEDULES_FILE, 'utf8');
        const list = JSON.parse(raw);
        for (const task of list) {
            tasks.set(task.id, task);
            scheduleTask(task);
        }
        log.info(`Scheduler: loaded ${list.length} task(s)`);
    } catch (err) {
        if (err.code !== 'ENOENT') log.error('Scheduler load error:', err.message);
    }
}

// ── Task execution ────────────────────────────────────────────────────────────

function recordHistory(taskId, success, message) {
    if (!history.has(taskId)) history.set(taskId, []);
    const h = history.get(taskId);
    h.unshift({ ts: new Date().toISOString(), success, message });
    if (h.length > HISTORY_MAX) h.pop();
}

async function runBackup(task) {
    const { containerId, volumeId } = task;
    const volumePath  = path.join(VOLUMES_DIR, volumeId);
    const archiveDir  = path.join(ARCHIVES_DIR, containerId.substring(0, 12));

    await fsP.mkdir(archiveDir, { recursive: true });

    const timestamp   = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveName = `auto-${volumeId}-${timestamp}.zip`;
    const archivePath = path.join(archiveDir, archiveName);

    await new Promise((resolve, reject) => {
        const output  = fs.createWriteStream(archivePath);
        const archive = archiver('zip', { zlib: { level: 6 } });

        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(volumePath, false);
        archive.finalize();
    });

    log.info(`Scheduler: backup created ${archiveName}`);
    return archiveName;
}

async function runRestart(task) {
    const container = docker.getContainer(task.containerId);
    await container.restart();
    log.info(`Scheduler: restarted container ${task.containerId.substring(0, 12)}`);
}

async function executeTask(task) {
    try {
        let msg;
        if (task.type === 'auto-backup') {
            const name = await runBackup(task);
            msg = `Backup created: ${name}`;
        } else if (task.type === 'auto-restart') {
            await runRestart(task);
            msg = 'Container restarted';
        } else {
            msg = `Unknown task type: ${task.type}`;
        }
        recordHistory(task.id, true, msg);
    } catch (err) {
        log.error(`Scheduler task ${task.id} failed:`, err.message);
        recordHistory(task.id, false, err.message);
    }
}

// ── Cron scheduling ───────────────────────────────────────────────────────────

function scheduleTask(task) {
    if (!cron.validate(task.schedule)) {
        log.warn(`Scheduler: invalid cron expression for task ${task.id}: ${task.schedule}`);
        return;
    }

    const job = cron.schedule(task.schedule, () => executeTask(task), {
        timezone: task.timezone || 'UTC',
    });

    cronJobs.set(task.id, job);
    log.info(`Scheduler: task ${task.id} (${task.type}) scheduled: ${task.schedule}`);
}

function unscheduleTask(taskId) {
    const job = cronJobs.get(taskId);
    if (job) {
        job.stop();
        cronJobs.delete(taskId);
    }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /scheduler/tasks
router.get('/tasks', (req, res) => {
    const list = [...tasks.values()].map(t => ({
        ...t,
        nextRun: cronJobs.has(t.id) ? 'scheduled' : 'invalid',
    }));
    res.json({ tasks: list });
});

// POST /scheduler/tasks
router.post('/tasks', async (req, res) => {
    const { type, containerId, volumeId, schedule, timezone, label } = req.body;

    if (!['auto-backup', 'auto-restart'].includes(type)) {
        return res.status(400).json({ message: 'type must be auto-backup or auto-restart' });
    }
    if (!containerId || typeof containerId !== 'string') {
        return res.status(400).json({ message: 'containerId is required' });
    }
    if (type === 'auto-backup' && (!volumeId || typeof volumeId !== 'string')) {
        return res.status(400).json({ message: 'volumeId is required for auto-backup' });
    }
    if (!schedule || !cron.validate(schedule)) {
        return res.status(400).json({ message: 'Invalid cron expression. Example: "0 3 * * *" (daily at 03:00)' });
    }

    // Verify container exists
    try {
        await docker.getContainer(containerId).inspect();
    } catch {
        return res.status(404).json({ message: 'Container not found' });
    }

    const task = {
        id:          crypto.randomBytes(8).toString('hex'),
        type,
        containerId,
        volumeId:    volumeId || null,
        schedule,
        timezone:    timezone || 'UTC',
        label:       label || `${type} — ${containerId.substring(0, 12)}`,
        createdAt:   new Date().toISOString(),
    };

    tasks.set(task.id, task);
    scheduleTask(task);
    await saveTasks();

    res.status(201).json({ message: 'Task created', task });
});

// DELETE /scheduler/tasks/:taskId
router.delete('/tasks/:taskId', async (req, res) => {
    const { taskId } = req.params;
    if (!tasks.has(taskId)) return res.status(404).json({ message: 'Task not found' });

    unscheduleTask(taskId);
    tasks.delete(taskId);
    history.delete(taskId);
    await saveTasks();

    res.json({ message: 'Task removed' });
});

// POST /scheduler/tasks/:taskId/run — trigger immediately
router.post('/tasks/:taskId/run', async (req, res) => {
    const { taskId } = req.params;
    const task = tasks.get(taskId);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    // Run async, respond immediately
    executeTask(task);
    res.json({ message: 'Task triggered' });
});

// GET /scheduler/tasks/:taskId/history
router.get('/tasks/:taskId/history', (req, res) => {
    const { taskId } = req.params;
    if (!tasks.has(taskId)) return res.status(404).json({ message: 'Task not found' });
    res.json({ history: history.get(taskId) || [] });
});

// ── Init ──────────────────────────────────────────────────────────────────────

loadTasks();

module.exports = router;
