/**
 * Runs a local PostgreSQL for development without Docker.
 * Data lives in server/.pgdata. Stop with Ctrl+C.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.pgdata');
const port = Number(process.env.EMBEDDED_PG_PORT ?? 5433);

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'puzzlelove',
  password: 'puzzlelove',
  port,
  persistent: true,
  onLog: () => {},
});

const firstRun = !existsSync(path.join(dataDir, 'PG_VERSION'));
if (firstRun) {
  console.log('[db] initialising data directory...');
  await pg.initialise();
}
await pg.start();
if (firstRun) await pg.createDatabase('puzzlelove');

console.log(`[db] PostgreSQL running: postgresql://puzzlelove:puzzlelove@localhost:${port}/puzzlelove`);
console.log('[db] Press Ctrl+C to stop.');

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
