const ftpd   = require('ftpd');
const fs     = require('fs').promises;
const path   = require('path');
const crypto = require('crypto');
const config = require('../config.json');
const logger = require('cat-loggr');

const log = new logger();

const options = {
    host: config.ftp.ip   || '127.0.0.1',
    port: config.ftp.port || 21,
    tls:  null,
};

const FTP_DIR     = path.join(process.cwd(), 'ftp');
const VOLUMES_DIR = path.join(process.cwd(), 'volumes');

// Generate a cryptographically secure random password
function generatePassword() {
    // 24 random bytes -> 32-char base64url string (URL-safe, no padding issues)
    return crypto.randomBytes(24).toString('base64url');
}

const getDirectories = async (srcPath) => {
    const files = await fs.readdir(srcPath);
    const results = await Promise.all(files.map(async (file) => {
        const stat = await fs.stat(path.join(srcPath, file));
        return stat.isDirectory() ? file : null;
    }));
    return results.filter(Boolean);
};

const createUserData = (username, password, dir) => ({
    username,
    password,
    host: options.host,
    port: options.port,
    root: path.join(VOLUMES_DIR, dir),
});

// In-memory user store: { username -> { password, root } }
const users = {};

const createNewVolume = async (dir) => {
    const username = 'user-' + dir;
    const userFile = path.join(FTP_DIR, username + '.json');

    try {
        await fs.access(userFile);
        // File exists — load it into memory if not already there
        if (!users[username]) {
            const data = JSON.parse(await fs.readFile(userFile, 'utf8'));
            users[username] = { password: data.password, root: data.root };
        }
    } catch {
        // File doesn't exist — create a new user
        const password = generatePassword();
        const userData = createUserData(username, password, dir);
        await fs.writeFile(userFile, JSON.stringify(userData, null, 2), { mode: 0o600 });
        users[username] = { password, root: userData.root };
        log.info('Created FTP user: ' + username);
    }
};

const watchVolumesDirectory = () => {
    setInterval(async () => {
        try {
            const dirs     = await getDirectories(VOLUMES_DIR);
            const newDirs  = dirs.filter(dir => !users['user-' + dir]);
            await Promise.all(newDirs.map(createNewVolume));
        } catch (err) {
            log.error('Volume watcher error: ' + err.message);
        }
    }, 5000);
};

const initializeUsers = async () => {
    await fs.mkdir(FTP_DIR, { recursive: true });

    let dirs = [];
    try {
        dirs = await getDirectories(VOLUMES_DIR);
    } catch {
        log.warn('Volumes directory not found, skipping FTP user init');
        return;
    }

    await Promise.all(dirs.map(createNewVolume));
    log.info('FTP users initialized (' + dirs.length + ' volumes)');
};

const createServer = () => {
    const server = new ftpd.FtpServer(options.host, {
        getInitialCwd: () => '/',
        getRoot: (connection, callback) => {
            const user = users[connection.username];
            user ? callback(null, user.root) : callback(new Error('No such user'));
        },
        pasvPortRangeStart: 1025,
        pasvPortRangeEnd:   1050,
        tlsOptions:         options.tls,
        allowUnauthorizedTls: true,
        useWriteFile:  false,
        useReadFile:   false,
        uploadMaxSlurpSize: 7000,
        allowedCommands: ['XMKD', 'AUTH', 'TLS', 'SSL', 'USER', 'PASS', 'PWD',
                          'OPTS', 'TYPE', 'PORT', 'PASV', 'LIST', 'CWD', 'MKD',
                          'SIZE', 'STOR', 'MDTM', 'DELE', 'QUIT', 'RMD'],
    });

    server.on('error', (error) => log.error('FTP Server error:', error));

    server.on('client:connected', (connection) => {
        let currentUser = null;

        connection.on('command:user', (user, success, failure) => {
            if (users[user]) {
                currentUser = user;
                success();
            } else {
                log.warn('FTP login: unknown user ' + user);
                failure();
            }
        });

        connection.on('command:pass', (pass, success, failure) => {
            if (!currentUser) {
                failure();
                return;
            }
            const user = users[currentUser];
            // Constant-time comparison to prevent timing attacks
            const expected = Buffer.from(user.password, 'utf8');
            const provided = Buffer.from(pass, 'utf8');
            const valid = expected.length === provided.length &&
                crypto.timingSafeEqual(expected, provided);

            if (valid) {
                success(currentUser);
            } else {
                log.warn('FTP login: wrong password for ' + currentUser);
                failure();
            }
        });
    });

    return server;
};

const start = async () => {
    await initializeUsers();
    watchVolumesDirectory();

    const server = createServer();
    server.debugging = 0; // disable verbose FTP debug output in production
    server.listen(options.port);
    log.info('FTP server started on port ' + options.port);
};

module.exports = { start, createNewVolume };
