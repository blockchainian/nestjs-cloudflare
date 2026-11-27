import { execFile } from 'node:child_process';
import { existsSync, globSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

async function postgresControlPath() {
  const configured = await run('pg_config', ['--bindir']).then(
    ({ stdout }) => [join(stdout.trim(), 'pg_ctl')],
    () => [],
  );

  const onPath = (process.env.PATH ?? '')
    .split(delimiter)
    .map(directory => join(directory, 'pg_ctl'));

  const control = [
    ...configured,
    ...onPath,
    ...globSync('/opt/homebrew/opt/postgresql*/bin/pg_ctl'),
    ...globSync('/usr/lib/postgresql/*/bin/pg_ctl'),
  ].find(path => existsSync(path) && existsSync(join(dirname(path), 'initdb')));

  if (!control) {
    throw new Error('Install PostgreSQL with the pg_ctl and initdb binaries');
  }

  return control;
}

async function availablePort() {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });

  if (!address || typeof address === 'string') {
    throw new Error('Cannot allocate a TCP port for the test Postgres server');
  }

  return address.port;
}

describe('TypeORM in a Wrangler-bundled Worker', () => {
  let directory: string;
  let pgCtl: string;
  let miniflare: Miniflare | undefined;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nestjs-cloudflare-typeorm-'));

    const bundleDirectory = join(directory, 'bundle');

    await run(process.execPath, [
      join(
        dirname(require.resolve('wrangler/package.json')),
        'bin/wrangler.js',
      ),
      'deploy',
      '--dry-run',
      '--config',
      resolve('test/typeorm/wrangler.toml'),
      '--outdir',
      bundleDirectory,
    ]);

    const data = join(directory, 'data');
    const port = await availablePort();

    pgCtl = await postgresControlPath();

    await run(join(dirname(pgCtl), 'initdb'), [
      '-D',
      data,
      '-U',
      'worker_test',
      '--auth=trust',
      '--no-locale',
      '--no-sync',
    ]);

    await run(pgCtl, [
      '-D',
      data,
      '-l',
      join(directory, 'postgres.log'),
      '-w',
      '-t',
      '10',
      '-o',
      `-h 127.0.0.1 -p ${port} -c unix_socket_directories=''`,
      'start',
    ]);

    const connectionString = `postgresql://worker_test:test@127.0.0.1:${port}/postgres`;
    const owner = new Client({ connectionString });

    await owner.connect();

    try {
      await owner.query('CREATE TABLE entries (id text PRIMARY KEY)');
    } finally {
      await owner.end();
    }

    miniflare = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: await readFile(join(bundleDirectory, 'worker.js'), 'utf8'),
        compatibilityDate: '2026-08-22',
        compatibilityFlags: ['nodejs_compat'],
        hyperdrives: { DATABASE: connectionString },
      }),
    );

    await miniflare.ready;
  }, 30_000);

  afterAll(async () => {
    try {
      await miniflare?.dispose();
    } finally {
      if (directory) {
        const data = join(directory, 'data');

        if (pgCtl && existsSync(join(data, 'postmaster.pid'))) {
          await run(pgCtl, ['-D', data, '-w', '-m', 'immediate', 'stop']);
        }

        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  async function query(action: string, id: string) {
    const response = await miniflare!.dispatchFetch(
      `https://worker.test/${action}/${id}`,
    );

    const body = await response.text();

    expect(response.status, body).toBe(200);

    expect(
      Number(response.headers.get('x-opened-connections')),
    ).toBeGreaterThan(0);

    expect(response.headers.get('x-checked-out-connections')).toBe('0');
    expect(response.headers.get('x-open-connections')).toBe('0');

    return JSON.parse(body) as { id: string } | null;
  }

  it('boots the decorated root and resolves its feature repository outside a pool scope', async () => {
    const response = await miniflare!.dispatchFetch(
      'https://worker.test/ready',
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ready');
  });

  it('writes and reads serial requests', async () => {
    await expect(query('insert', 'serial')).resolves.toEqual({ id: 'serial' });
    await expect(query('read', 'serial')).resolves.toEqual({ id: 'serial' });
  });

  it('isolates the pools of ten concurrent requests', async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `concurrent-${index}`);

    expect(await Promise.all(ids.map(id => query('insert', id)))).toEqual(
      ids.map(id => ({ id })),
    );

    expect(await Promise.all(ids.map(id => query('read', id)))).toEqual(
      ids.map(id => ({ id })),
    );
  });

  it('commits and rolls back a transaction', async () => {
    await expect(query('commit', 'committed')).resolves.toEqual({
      id: 'committed',
    });

    await expect(query('rollback', 'rolled-back')).resolves.toBeNull();

    await expect(query('read', 'committed')).resolves.toEqual({
      id: 'committed',
    });

    await expect(query('read', 'rolled-back')).resolves.toBeNull();
  });
});
