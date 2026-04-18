const axios  = require('axios');
const Docker = require('dockerode');
const config = require('../config.json');
const CatLoggr = require('cat-loggr');
const { createVolumesFolder } = require('./init.js');

const log    = new CatLoggr();
const docker = new Docker({ socketPath: process.env.dockerSocket });

async function seed() {
    await createVolumesFolder();

    let images;
    try {
        log.init('Fetching image list from panel...');
        const response = await axios.get(config.remote + '/images/list', { timeout: 10000 });
        images = response.data;
    } catch (error) {
        // Panel may be temporarily unavailable — log and continue rather than killing the process.
        // The daemon can still serve existing containers without the image list.
        log.warn('Could not fetch image list from panel: ' + error.message);
        log.warn('Daemon will start without pre-pulling images. Retry on next restart.');
        return;
    }

    if (!Array.isArray(images) || images.length === 0) {
        log.info('No images to pull.');
        return;
    }

    log.init('Pulling ' + images.length + ' image(s)...');

    for (const image of images) {
        if (!image.Image || typeof image.Image !== 'string') continue;
        try {
            log.info('Pulling ' + image.Image + '...');
            await new Promise((resolve, reject) => {
                docker.pull(image.Image, (err, stream) => {
                    if (err) return reject(err);
                    docker.modem.followProgress(stream,
                        (err) => err ? reject(err) : resolve(),
                        (event) => { if (event.status) log.info(image.Image + ': ' + event.status); }
                    );
                });
            });
            log.info('Pulled ' + image.Image);
        } catch (err) {
            // A single failed pull should not abort the rest
            log.error('Failed to pull ' + image.Image + ': ' + err.message);
        }
    }

    log.info('Image pre-pull complete.');
}

module.exports = { seed };
