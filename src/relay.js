'use strict';

const net = require('net');
const { JSONFramer } = require('./parser');

function createRelay({ config, logger, persistence, onShot }) {
  let connId = 0;

  const server = net.createServer((uneekor) => {
    const id = ++connId;
    const log = logger.child({ conn: id, peer: `${uneekor.remoteAddress}:${uneekor.remotePort}` });
    log.info('uneekor connected');

    const framer = new JSONFramer();
    const gspro = new net.Socket();
    let gsproReady = false;
    let pendingFromUneekor = [];

    const closeBoth = (reason) => {
      log.info({ reason }, 'tearing down connection pair');
      try { uneekor.destroy(); } catch (_) {}
      try { gspro.destroy(); } catch (_) {}
    };

    gspro.connect(config.gspro.port, config.gspro.host, () => {
      gsproReady = true;
      log.info({ gspro: `${config.gspro.host}:${config.gspro.port}` }, 'gspro connected');
      for (const buf of pendingFromUneekor) gspro.write(buf);
      pendingFromUneekor = [];
    });

    uneekor.on('data', (chunk) => {
      if (gsproReady) gspro.write(chunk);
      else pendingFromUneekor.push(chunk);

      try {
        const events = framer.push(chunk);
        for (const ev of events) {
          if (ev.ok) {
            log.info({ deviceId: ev.value?.DeviceID, shotNumber: ev.value?.ShotNumber }, 'shot captured');
            try {
              persistence.saveShot(ev.value);
            } catch (err) {
              log.error({ err: err.message }, 'persistence.saveShot threw');
            }
            if (onShot) {
              try { onShot(ev.value); } catch (err) {
                log.error({ err: err.message }, 'onShot hook threw');
              }
            }
          } else {
            log.warn({ error: ev.error, sample: (ev.raw || '').slice(0, 120) }, 'parser emitted invalid JSON');
          }
        }
      } catch (err) {
        log.error({ err: err.message }, 'parser failure (forward path unaffected)');
      }
    });

    gspro.on('data', (chunk) => {
      try { uneekor.write(chunk); } catch (err) {
        log.error({ err: err.message }, 'failed to forward gspro response to uneekor');
      }
    });

    uneekor.on('end', () => {
      log.info('uneekor ended');
      gspro.end();
    });
    gspro.on('end', () => {
      log.info('gspro ended');
      uneekor.end();
    });

    uneekor.on('error', (err) => {
      log.error({ err: err.message }, 'uneekor socket error');
      closeBoth('uneekor error');
    });
    gspro.on('error', (err) => {
      log.error({ err: err.message, code: err.code }, 'gspro socket error');
      closeBoth('gspro error');
    });

    uneekor.on('close', () => log.info('uneekor closed'));
    gspro.on('close', () => log.info('gspro closed'));
  });

  server.on('error', (err) => {
    logger.error({ err: err.message, code: err.code }, 'relay server error');
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.relay.listenPort, config.relay.listenHost, () => {
        server.off('error', reject);
        const addr = server.address();
        logger.info({ addr }, 'relay listening');
        resolve(addr);
      });
    });
  }

  function close() {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, listen, close };
}

module.exports = { createRelay };
