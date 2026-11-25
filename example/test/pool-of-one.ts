/**
 * Started by the integration test in a process of its own, with a pool of ONE connection: the pool is
 * module state of the generated code, so it cannot be resized inside the test process.
 *
 * A REST update whose beforeUpdate reads the row through meta.tx has to complete. Reading through
 * withoutTransaction() instead needs a second connection while the request holds the only one, and waits
 * for ever - with as many concurrent writes as the pool has connections, that is a deadlock.
 *
 * Exits 0 on success, 1 on a failure or after a timeout.
 */
import { Hono } from '@hono/hono';
import { load } from '@std/dotenv';
import { eq } from 'drizzle-orm';
import { initializeGenerated, keyednoteTable } from '../generated/index.ts';

type PoolEnv = { Variables: Record<string, unknown> };

const TIMEOUT_MS = 10_000;

const env = await load();
const app = new Hono<PoolEnv>();
const rowsSeen: number[] = [];

await initializeGenerated<PoolEnv>({
  database: {
    connectionString: env.DB_URL,
    max: 1,
    ssl: env.DB_SSL_CA_FILE ? { ca: Deno.readTextFileSync(env.DB_SSL_CA_FILE) } : undefined,
  },
  app,
  api: { basePath: '/api' },
  domainHooks: {
    keyednote: {
      beforeUpdate: async (id, rawInput, _context, meta) => {
        const rows = await meta.tx.select().from(keyednoteTable).where(eq(keyednoteTable.slug, id));
        rowsSeen.push(rows.length);
        return rawInput as Record<string, unknown>;
      },
    },
  },
});

const request = async (method: string, path: string, body?: unknown): Promise<void> => {
  const response = await app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  }
};

const run = async (): Promise<void> => {
  const slug = `pool-of-one-${crypto.randomUUID()}`;
  await request('POST', '/api/keyednote', { slug, tenant: 'pool' });
  await request('PUT', `/api/keyednote/${slug}`, { body: 'updated through a pool of one' });
  await request('DELETE', `/api/keyednote/${slug}`);
  if (rowsSeen[0] !== 1) {
    throw new Error(`beforeUpdate saw ${rowsSeen[0]} rows through meta.tx, expected 1`);
  }
};

const timeout = new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error(`no answer within ${TIMEOUT_MS} ms: waiting for a second connection?`)), TIMEOUT_MS)
);

try {
  await Promise.race([run(), timeout]);
  console.log('pool of one: the update completed');
  Deno.exit(0);
} catch (error) {
  console.error('pool of one:', error);
  Deno.exit(1);
}
