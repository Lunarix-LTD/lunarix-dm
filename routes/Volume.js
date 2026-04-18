const express = require('express');
const router  = express.Router();
const fs      = require('fs').promises;
const multer  = require('multer');
const path    = require('path');

// Temp uploads go to a dedicated tmp dir, not the OS temp, to keep them local
const upload = multer({
    dest: 'tmp/',
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB per file
});

const VOLUMES_BASE = path.resolve(__dirname, '../volumes');

// Resolve and validate that target stays inside the volume root
function safePath(volumeId, subPath, filename) {
    if (!/^[a-zA-Z0-9\-_]+$/.test(volumeId)) {
        throw new Error('Invalid volume ID');
    }
    const base     = path.join(VOLUMES_BASE, volumeId);
    const combined = filename ? path.join(base, subPath || '', filename) : path.join(base, subPath || '');
    const resolved = path.resolve(combined);
    if (!resolved.startsWith(base)) {
        throw new Error('Path traversal attempt detected');
    }
    return resolved;
}

function getFilePurpose(file) {
    const ext = path.extname(file).toLowerCase();
    const map = {
        programming:    ['.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rb', '.php', '.swift', '.kt', '.rs', '.scala', '.groovy'],
        webDevelopment: ['.html', '.htm', '.css', '.scss', '.sass', '.less', '.js', '.ts', '.jsx', '.tsx', '.json', '.xml', '.svg'],
        textDocument:   ['.txt', '.md', '.rtf', '.log'],
        configuration:  ['.ini', '.yaml', '.yml', '.toml', '.cfg', '.conf', '.properties'],
        database:       ['.sql'],
        script:         ['.sh', '.bash', '.ps1', '.bat', '.cmd'],
    };
    for (const [purpose, exts] of Object.entries(map)) {
        if (exts.includes(ext)) return purpose;
    }
    return 'other';
}

const EDITABLE_EXTENSIONS = new Set([
    '.txt', '.md', '.rtf', '.log', '.ini', '.csv',
    '.html', '.htm', '.css', '.scss', '.sass', '.less',
    '.js', '.ts', '.jsx', '.tsx', '.json', '.xml', '.svg',
    '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go',
    '.rb', '.php', '.swift', '.kt', '.rs', '.scala', '.groovy',
    '.sh', '.bash', '.ps1', '.bat', '.cmd',
    '.yaml', '.yml', '.toml', '.cfg', '.conf', '.properties',
    '.tex', '.bib', '.markdown', '.sql',
    '.gitignore', '.env', '.htaccess',
]);

function isEditable(filename) {
    return EDITABLE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function formatFileSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes, i = 0;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return size.toFixed(2) + ' ' + units[i];
}

// GET /fs/:id/files[?path=subdir]
router.get('/:id/files', async (req, res) => {
    const { id } = req.params;
    const subPath = req.query.path || '';
    if (!id) return res.status(400).json({ message: 'No volume ID' });

    try {
        const fullPath = safePath(id, subPath);
        const entries  = await fs.readdir(fullPath, { withFileTypes: true });

        const files = await Promise.all(entries.map(async (entry) => {
            const filePath = path.join(fullPath, entry.name);
            const stats    = await fs.stat(filePath);
            return {
                name:        entry.name,
                isDirectory: entry.isDirectory(),
                isEditable:  isEditable(entry.name),
                size:        formatFileSize(stats.size),
                lastUpdated: stats.mtime.toISOString(),
                purpose:     entry.isDirectory() ? 'folder' : getFilePurpose(entry.name),
                extension:   path.extname(entry.name).toLowerCase(),
                permissions: stats.mode.toString(8).slice(-3),
            };
        }));

        res.json({ files });
    } catch (err) {
        if (err.message.includes('traversal') || err.message.includes('Invalid')) {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ message: err.message });
    }
});

// POST /fs/:id/files/rename/:filename/:newfilename[?path=subdir]
router.post('/:id/files/rename/:filename/:newfilename', async (req, res) => {
    const { id, filename, newfilename } = req.params;
    const subPath = req.query.path || '';

    try {
        const oldPath = safePath(id, subPath, filename);
        const newPath = safePath(id, subPath, newfilename);

        try {
            await fs.access(newPath);
            return res.status(400).json({ message: 'A file with that name already exists' });
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }

        await fs.rename(oldPath, newPath);
        res.json({ message: 'File renamed' });
    } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ message: 'File not found' });
        if (err.message.includes('traversal') || err.message.includes('Invalid')) {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ message: err.message });
    }
});

// GET /fs/:id/files/view/:filename[?path=subdir]
router.get('/:id/files/view/:filename', async (req, res) => {
    const { id, filename } = req.params;
    const subPath = req.query.path || '';

    if (!id || !filename) return res.status(400).json({ message: 'Missing parameters' });

    try {
        const filePath = safePath(id, subPath, filename);

        if (!isEditable(filename)) {
            return res.status(400).json({ message: 'File type not supported for viewing' });
        }

        const stats = await fs.stat(filePath);
        // Refuse to read files larger than 5 MB into memory
        if (stats.size > 5 * 1024 * 1024) {
            return res.status(413).json({ message: 'File too large to view (max 5 MB)' });
        }

        const content = await fs.readFile(filePath, 'utf8');
        res.json({ content });
    } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ message: 'File not found' });
        if (err.message.includes('traversal') || err.message.includes('Invalid')) {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ message: err.message });
    }
});

// POST /fs/:id/files/upload[?path=subdir]
router.post('/:id/files/upload', upload.array('files'), async (req, res) => {
    const { id } = req.params;
    const subPath = req.query.path || '';

    try {
        const fullPath = safePath(id, subPath);

        await Promise.all(req.files.map(async (file) => {
            const destPath = path.join(fullPath, path.basename(file.originalname));
            // Ensure dest is still inside volume after basename resolution
            if (!destPath.startsWith(path.join(VOLUMES_BASE, id))) {
                await fs.unlink(file.path).catch(() => {});
                throw new Error('Invalid upload destination');
            }
            return fs.rename(file.path, destPath);
        }));

        res.json({ message: 'Files uploaded' });
    } catch (err) {
        // Clean up any temp files on failure
        if (req.files) {
            await Promise.allSettled(req.files.map(f => fs.unlink(f.path)));
        }
        if (err.message.includes('traversal') || err.message.includes('Invalid')) {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ message: err.message });
    }
});

// POST /fs/:id/files/edit/:filename[?path=subdir]
router.post('/:id/files/edit/:filename', async (req, res) => {
    const { id, filename } = req.params;
    const { content }      = req.body;
    const subPath          = req.query.path || '';

    try {
        const filePath = safePath(id, subPath, filename);

        if (!isEditable(filename)) {
            return res.status(400).json({ message: 'File type not supported for editing' });
        }
        if (typeof content !== 'string') {
            return res.status(400).json({ message: 'Content must be a string' });
        }
        // Limit write size to 5 MB
        if (Buffer.byteLength(content, 'utf8') > 5 * 1024 * 1024) {
            return res.status(413).json({ message: 'Content too large (max 5 MB)' });
        }

        await fs.writeFile(filePath, content, 'utf8');
        res.json({ message: 'File updated' });
    } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ message: 'File not found' });
        if (err.message.includes('traversal') || err.message.includes('Invalid')) {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ message: err.message });
    }
});

// POST /fs/:id/files/create/:filename[?path=subdir]
router.post('/:id/files/create/:filename', async (req, res) => {
    const { id, filename } = req.params;
    const { content }      = req.body;
    const subPath          = req.query.path || '';

    try {
        const filePath = safePath(id, subPath, filename);
        await fs.writeFile(filePath, content || '', 'utf8');
        res.json({ message: 'File created' });
    } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ message: 'Path not found' });
        if (err.message.includes('traversal') || err.message.includes('Invalid')) {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ message: err.message });
    }
});

// POST /fs/:id/folders/create/:foldername[?path=subdir]
router.post('/:id/folders/create/:foldername', async (req, res) => {
    const { id, foldername } = req.params;
    const subPath            = req.query.path || '';

    try {
        const folderPath = safePath(id, subPath, foldername);
        await fs.mkdir(folderPath, { recursive: false });
        res.json({ message: 'Folder created' });
    } catch (err) {
        if (err.code === 'EEXIST') return res.status(400).json({ message: 'Folder already exists' });
        if (err.message.includes('traversal') || err.message.includes('Invalid')) {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ message: err.message });
    }
});

// DELETE /fs/:id/files/delete/:filename[?path=subdir]
router.delete('/:id/files/delete/:filename', async (req, res) => {
    const { id, filename } = req.params;
    const subPath          = req.query.path || '';

    try {
        const filePath = safePath(id, subPath, filename);
        const stats    = await fs.lstat(filePath);

        if (stats.isDirectory()) {
            await fs.rm(filePath, { recursive: true, force: true });
        } else {
            await fs.unlink(filePath);
        }

        res.json({ message: 'Deleted' });
    } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ message: 'Not found' });
        if (err.message.includes('traversal') || err.message.includes('Invalid')) {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
