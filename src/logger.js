const fs = require('fs');
const path = require('path');
const pino = require('pino');

function createLogger(config) {
  const level = config?.logging?.level || 'info';
  const filePath = config?.logging?.file;

  const streams = [{ level, stream: process.stdout }];

  if (filePath) {
    const resolved = path.resolve(__dirname, '..', filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    streams.push({
      level,
      stream: fs.createWriteStream(resolved, { flags: 'a' })
    });
  }

  return pino(
    { level, base: { app: 'clubhouse-relay' } },
    pino.multistream(streams)
  );
}

module.exports = { createLogger };
