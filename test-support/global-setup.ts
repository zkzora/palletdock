import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

/**
 * Starts a throwaway PostgreSQL for integration tests unless TEST_DATABASE_URL
 * points at an existing server (CI uses a service container). Each test file
 * then creates and migrates its own database via createTestDatabase().
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export default async function setup(project: TestProject) {
  if (process.env.TEST_DATABASE_URL) {
    project.provide('adminDatabaseUrl', process.env.TEST_DATABASE_URL);
    return;
  }
  if (process.platform === 'win32') {
    // Embedded PostgreSQL cannot read its extension files past Windows MAX_PATH (260).
    const deepest = path.join(process.cwd(), 'node_modules', '.pnpm', '@embedded-postgres+windows-x64@18.4.0-beta.17', 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'share', 'extension', 'plpgsql--1.0.sql');
    if (deepest.length >= 260) {
      throw new Error(`The repository path is too long for embedded PostgreSQL on Windows (${deepest.length} ≥ 260 chars). Clone to a shorter path (for example C:\\src\\palletdock) or set TEST_DATABASE_URL to an existing PostgreSQL.`);
    }
  }
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = mkdtempSync(path.join(tmpdir(), 'palletdock-test-pg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(dir, 'data'),
    port,
    user: 'pdtest',
    password: 'pdtest',
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  project.provide('adminDatabaseUrl', `postgresql://pdtest:pdtest@127.0.0.1:${port}/postgres`);
  return async () => {
    await pg.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
  }
}
