import path from 'node:path';
import { existsSync } from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';

const databaseDir = path.resolve(process.env.PALLETDOCK_DB_DIR ?? '.data/postgres');
const port = Number(process.env.PALLETDOCK_DB_PORT ?? 55432);
const user = process.env.PALLETDOCK_DB_USER ?? 'palletdock';
const password = process.env.PALLETDOCK_DB_PASSWORD ?? 'palletdock_dev_only';
const database = process.env.PALLETDOCK_DB_NAME ?? 'palletdock';

if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PALLETDOCK_DB_PORT must be an unprivileged TCP port');

const pg = new EmbeddedPostgres({
  databaseDir,
  port,
  user,
  password,
  authMethod: 'scram-sha-256',
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: (message) => console.log(`[postgres] ${String(message)}`),
  onError: (message) => console.error(`[postgres] ${String(message)}`),
});

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[postgres] received ${signal}; stopping`);
  await pg.stop().catch((error) => console.error(`[postgres] stop failed: ${(error as Error).message}`));
  process.exit(0);
}

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));

if (!existsSync(databaseDir)) console.log(`[postgres] initializing ${databaseDir}`);
await pg.initialise();
await pg.start();
try {
  await pg.createDatabase(database);
  console.log(`[postgres] created database ${database}`);
} catch (error) {
  const message = (error as Error).message;
  if (!/already exists/i.test(message)) throw error;
}
console.log(`[postgres] ready on postgresql://${user}:<redacted>@127.0.0.1:${port}/${database}`);
await new Promise(() => {});
