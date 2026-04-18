/**
 * TLS certificate management.
 *
 * On startup, checks for certs/server.key + certs/server.crt.
 * If missing, generates a self-signed certificate valid for 10 years.
 * The panel should either:
 *   a) Trust the self-signed cert (add to trusted store), or
 *   b) Replace certs/ with a real cert (Let's Encrypt, etc.)
 *
 * The daemon reads TLS config from config.json:
 *   tls.enabled  — boolean (default false for backward compat)
 *   tls.certPath — path to cert file (default ./certs/server.crt)
 *   tls.keyPath  — path to key file  (default ./certs/server.key)
 */

const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');
const CatLoggr = require('cat-loggr');

const log      = new CatLoggr();
const CERT_DIR = path.join(__dirname, '../certs');

function ensureCerts(config) {
    const certPath = config?.tls?.certPath || path.join(CERT_DIR, 'server.crt');
    const keyPath  = config?.tls?.keyPath  || path.join(CERT_DIR, 'server.key');

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        log.info('TLS: using existing certificates');
        return { certPath, keyPath };
    }

    log.info('TLS: generating self-signed certificate...');
    fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });

    try {
        execSync(
            `openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
             -keyout "${keyPath}" \
             -out "${certPath}" \
             -subj "/CN=lunarix-dm" \
             -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"`,
            { stdio: 'pipe' }
        );
        // Restrict key permissions
        fs.chmodSync(keyPath, 0o600);
        log.info('TLS: self-signed certificate generated');
    } catch (err) {
        log.error('TLS: openssl failed:', err.message);
        log.warn('TLS: falling back to plain HTTP');
        return null;
    }

    return { certPath, keyPath };
}

function loadTlsContext(config) {
    if (!config?.tls?.enabled) return null;

    const paths = ensureCerts(config);
    if (!paths) return null;

    try {
        return {
            key:  fs.readFileSync(paths.keyPath),
            cert: fs.readFileSync(paths.certPath),
            // Modern TLS only — drop SSLv3, TLS 1.0, TLS 1.1
            minVersion: 'TLSv1.2',
            ciphers: [
                'TLS_AES_256_GCM_SHA384',
                'TLS_CHACHA20_POLY1305_SHA256',
                'TLS_AES_128_GCM_SHA256',
                'ECDHE-RSA-AES256-GCM-SHA384',
                'ECDHE-RSA-CHACHA20-POLY1305',
            ].join(':'),
        };
    } catch (err) {
        log.error('TLS: failed to load certificates:', err.message);
        return null;
    }
}

module.exports = { loadTlsContext, ensureCerts };
