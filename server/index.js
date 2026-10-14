import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDesignStore } from './db.js';
import { createApp } from './app.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = process.env.RENO_DB ?? path.join(ROOT, 'data', 'reno-toolbox.db');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

const store = openDesignStore(dbFile);
const server = createApp(store).listen(port, host, () => {
  console.log(`Reno Toolbox running at http://${host}:${port}  (db: ${dbFile})`);
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
