import { ModelDefinition } from '../types/model.types.ts';
import { getCustomSchema, modelsHavePostGISFields } from '../utils/field.utils.ts';

/**
 * Generates the database connection module, the bootstrap script and the drizzle-kit config.
 *
 * COG does not generate DDL: the Drizzle schema is the single source of truth and drizzle-kit
 * turns it into tables (`push` for development, `generate` + `migrate` for production). Only
 * what drizzle-kit cannot express - the PostGIS extension and non-default schemas - is emitted
 * here as a bootstrap step that has to run first.
 */
export class DatabaseInitGenerator {
  private models: ModelDefinition[];
  private dbType: 'postgresql' | 'cockroachdb';
  /** PostGIS support: spatial column types in the generated schema */
  private postgis: boolean;
  /** Where the generated code is written, as drizzle-kit resolves paths from the project root */
  private outputPath: string;

  constructor(
    models: ModelDefinition[],
    options: { dbType?: string; postgis?: boolean; outputPath?: string } = {},
  ) {
    this.models = models;
    this.dbType = options.dbType === 'cockroachdb' ? 'cockroachdb' : 'postgresql';
    this.postgis = options.postgis !== false;
    this.outputPath = (options.outputPath ?? './generated').replace(/\/+$/, '');
  }

  /**
   * Schemas the models use beyond Postgres' default one
   */
  private customSchemas(): string[] {
    return [
      ...new Set(this.models.map(getCustomSchema).filter((schema): schema is string => schema !== null)),
    ].sort();
  }

  /**
   * Whether the database needs the PostGIS extension installed.
   * CockroachDB has spatial support built in and does not implement CREATE EXTENSION.
   */
  private requiresPostGISExtension(): boolean {
    return this.dbType === 'postgresql' && this.postgis && modelsHavePostGISFields(this.models);
  }

  /**
   * Generate database utility file
   */
  generateDatabaseInit(): string {
    return `import { drizzle } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../schema/index.ts";

// Export transaction type for use in domain layer
export type DbTransaction = PgTransaction<
  PostgresJsQueryResultHKT,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

export interface DatabaseConfig {
  /**
   * Connection string in PostgreSQL format.
   * If provided, individual connection parameters (host, port, etc.) are ignored.
   * Example: 'postgresql://user:password@localhost:5432/dbname'
   */
  connectionString?: string;

  // Individual connection parameters (used if connectionString is not provided)
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;

  // See more info at: // See https://nodejs.org/api/tls.html#tlsconnectoptions-callback
  ssl?: boolean | 'require' | 'prefer' | 'allow' | 'verify-full' | {
    ca?: string;                  // CA certificate
    key?: string;                 // Client key
    cert?: string;                // Client certificate
    rejectUnauthorized?: boolean; // Whether to reject unauthorized connections
  };
  max?: number;
  idle_timeout?: number;
}

// Logger configuration with defaults
export interface Logger {
  trace?: (message: string, ...args: unknown[]) => void;
  debug?: (message: string, ...args: unknown[]) => void;
  info?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
}

let db: ReturnType<typeof drizzle> | null = null;
let sql: postgres.Sql<Record<string, never>> | null = null;
let logger: Logger = {
  trace: console.log,
  debug: console.log,
  info: console.log,
  warn: console.warn,
  error: console.error,
};

/**
 * Initialize database connection
 */
export async function connect(config: DatabaseConfig, logging?: Logger) {
  // Configure logger with provided functions or defaults
  if (logging) {
    logger = {
      trace: logging.trace || console.log,
      debug: logging.debug || console.log,
      info: logging.info || console.log,
      warn: logging.warn || console.warn,
      error: logging.error || console.error,
    };
  }
  if (db) {
    return { db, sql };
  }

  // Create postgres connection
  const options = {
    ssl: config.ssl,
    max: config.max || 10,
    idle_timeout: config.idle_timeout || 20,
  };

  if (config.connectionString) {
    sql = postgres(config.connectionString, options);
  } else {
    sql = postgres({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ...options,
    });
  };

  // Create drizzle instance
  db = drizzle(sql, { schema });

  // Test connection
  try {
    await sql\`SELECT 1\`;
    logger.info?.('Database connected successfully');
  } catch (error) {
    logger.error?.('Failed to connect to database:', error);
    throw error;
  }

  return { db, sql };
}

/**
 * Get database instance
 */
export function withoutTransaction() {
  if (!db) {
    throw new Error('Database not connected. Call connect(...) first.');
  }
  return db;
}

/**
 * Work an after* hook schedules, started once its transaction has committed
 */
export type AfterCommitTask = () => Promise<void>;

// The after-commit queue of every transaction COG opened. Keyed by the transaction object, so the
// queue travels wherever the transaction is passed and is released together with it.
const afterCommitQueues = new WeakMap<DbTransaction, AfterCommitTask[]>();

const UNKNOWN_TRANSACTION_MESSAGE =
  'The transaction was not opened by withTransaction() or withNestedTransaction(). ' +
  'after* hooks start once their transaction has committed, so COG has to open that transaction.';

/**
 * Start a task without awaiting it. It starts on a later tick, so the caller's own continuation
 * (building the HTTP response) is not held up; a failure is logged, never thrown.
 */
const startDetached = (task: AfterCommitTask): void => {
  setTimeout(async () => {
    try {
      await task();
    } catch (error: unknown) {
      logger.error?.('[afterCommit] After-commit task failed:', error);
    }
  }, 0);
};

/**
 * Schedule an after* hook.
 *
 * Inside a transaction the task starts once that transaction has committed (the outermost one,
 * for a nested transaction) and is dropped when it rolls back. Without a transaction there is
 * nothing to wait for, so it starts right away. It is never awaited.
 *
 * @throws when tx was not opened by withTransaction() or withNestedTransaction()
 */
export const runAfterCommit = (tx: DbTransaction | undefined, task: AfterCommitTask): void => {
  if (!tx) {
    startDetached(task);
    return;
  }
  const queue = afterCommitQueues.get(tx);
  if (!queue) {
    throw new Error(UNKNOWN_TRANSACTION_MESSAGE);
  }
  queue.push(task);
};

/**
 * Execute database operations within a transaction context
 *
 * Automatically retries transactions on serialization errors (error code 40001)
 * which commonly occur in CockroachDB and PostgreSQL under high concurrency.
 *
 * after* hooks scheduled inside the callback start once the transaction has committed, in the
 * order they were scheduled, and are not awaited. A rollback drops them, and so does a failed
 * attempt before a retry: every attempt is a transaction of its own.
 *
 * @param callback - Function to execute within the transaction
 * @param options - Transaction and retry configuration options
 * @returns Result of the transaction callback
 *
 * @example
 * \`\`\`typescript
 * // Default behavior with automatic retries
 * await withTransaction(async (tx) => {
 *   await userDomain.create(userData, tx);
 * });
 *
 * // Disable retries for specific transaction
 * await withTransaction(async (tx) => {
 *   // ... operations
 * }, { enableRetry: false });
 *
 * // Custom retry configuration
 * await withTransaction(async (tx) => {
 *   // ... operations
 * }, {
 *   maxRetries: 10,
 *   initialDelayMs: 100,
 *   maxDelayMs: 10000
 * });
 * \`\`\`
 */
export async function withTransaction<T>(
  callback: (tx: DbTransaction) => Promise<T>,
  options?: {
    isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
    accessMode?: 'read write' | 'read only';
    deferrable?: boolean;
    // Retry configuration for handling serialization errors (error code 40001)
    maxRetries?: number;      // Maximum retry attempts (default: 5)
    initialDelayMs?: number;  // Initial retry delay in milliseconds (default: 50)
    maxDelayMs?: number;      // Maximum retry delay in milliseconds (default: 5000)
    enableRetry?: boolean;    // Enable automatic retries (default: true)
  }
): Promise<T> {
  const database = withoutTransaction();
  const maxRetries = options?.maxRetries ?? 5;
  const initialDelay = options?.initialDelayMs ?? 50;
  const maxDelay = options?.maxDelayMs ?? 5000;
  const enableRetry = options?.enableRetry ?? true;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Only pass transaction options if they're defined
      // Passing undefined values causes Drizzle to generate invalid SQL
      const txOptions: Record<string, unknown> = {};
      if (options?.isolationLevel) txOptions.isolationLevel = options.isolationLevel;
      if (options?.accessMode) txOptions.accessMode = options.accessMode;
      if (options?.deferrable !== undefined) txOptions.deferrable = options.deferrable;

      const afterCommit: AfterCommitTask[] = [];
      const result = await database.transaction(
        async (tx) => {
          afterCommitQueues.set(tx, afterCommit);
          return await callback(tx);
        },
        Object.keys(txOptions).length > 0 ? txOptions : undefined
      );

      // The transaction promise resolves only once COMMIT has succeeded
      afterCommit.forEach(startDetached);
      return result;
    } catch (error: unknown) {
      lastError = error;

      // Check if this is a serialization error (error code 40001)
      // This occurs in both CockroachDB (WriteTooOldError) and PostgreSQL (serialization_failure)
      const errorCode = (error as { cause?: { code?: string }; code?: string } | undefined)?.cause?.code || (error as { code?: string } | undefined)?.code;
      const isSerializationError = errorCode === '40001';

      // Only retry on serialization errors if retries are enabled
      if (!enableRetry || !isSerializationError || attempt >= maxRetries) {
        throw error;
      }

      // Calculate exponential backoff with jitter
      const backoff = initialDelay * Math.pow(2, attempt);
      const jitter = backoff * 0.1 * (Math.random() - 0.5); // ±10% jitter
      const delay = Math.min(backoff + jitter, maxDelay);

      logger.warn?.(
        '[withTransaction] Retrying transaction (attempt ' + (attempt + 1) + '/' + maxRetries + ') ' +
        'after ' + Math.round(delay) + 'ms due to serialization error (code: ' + errorCode + ')'
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Execute database operations within a nested transaction (a savepoint) of an open one.
 *
 * A failure rolls back the nested transaction's work only; the caller may catch it and carry on
 * with the parent. A savepoint is not a commit, so the after* hooks scheduled inside it are handed
 * to the parent when it succeeds and dropped when it fails: they start once the outermost
 * transaction has committed.
 *
 * @param parent - An open transaction, opened by withTransaction() or withNestedTransaction()
 * @param callback - Function to execute within the nested transaction
 * @returns Result of the callback
 *
 * @example
 * \`\`\`typescript
 * await withTransaction(async (tx) => {
 *   await orderDomain.create(order, tx);
 *   try {
 *     await withNestedTransaction(tx, async (nested) => {
 *       await auditDomain.create(entry, nested);
 *     });
 *   } catch {
 *     // the audit entry and its after* hooks are gone, the order stays
 *   }
 * });
 * \`\`\`
 */
export const withNestedTransaction = async <T>(
  parent: DbTransaction,
  callback: (tx: DbTransaction) => Promise<T>,
): Promise<T> => {
  const parentQueue = afterCommitQueues.get(parent);
  if (!parentQueue) {
    throw new Error(UNKNOWN_TRANSACTION_MESSAGE);
  }

  const afterCommit: AfterCommitTask[] = [];
  const result = await parent.transaction(async (tx) => {
    afterCommitQueues.set(tx, afterCommit);
    return await callback(tx);
  });

  parentQueue.push(...afterCommit);
  return result;
};

/**
 * Get SQL instance
 */
export function getSQL(): postgres.Sql<Record<string, never>> {
  if (!sql) {
    throw new Error('Database not connected. Call connect(...) first.');
  }
  return sql;
}

/**
 * Get configured logger instance
 */
export function getLogger(): Logger {
  return logger;
}

/**
 * Close database connection
 */
export async function disconnect() {
  if (sql) {
    await sql.end();
    sql = null;
    db = null;
    return true;
  }
  return false;
}

/**
 * Health check
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const sqlInstance = getSQL();
    await sqlInstance\`SELECT 1\`;
    return true;
  } catch {
    return false;
  }
}`;
  }

  /**
   * Generate the bootstrap script.
   *
   * Runs the statements drizzle-kit does not emit, and has to run before `push` or `migrate`.
   */
  generateBootstrap(): string {
    // Schemas are drizzle-kit's job - it creates every exported pgSchema. The extension is not,
    // because it has to exist before the first spatial column is created.
    const body = this.requiresPostGISExtension()
      ? `    await sql\`CREATE EXTENSION IF NOT EXISTS postgis\`;\n` +
        `    logger.info?.('PostGIS extension ready');`
      : '    // Nothing to prepare: these models need no database extension';

    return `import { connect, DatabaseConfig, disconnect, getLogger, getSQL } from './database.ts';

/**
 * Prepares what drizzle-kit cannot create itself.
 *
 * drizzle-kit owns the tables and the schemas; the PostGIS extension has to be installed before
 * the first spatial column exists. Run this before \`drizzle-kit push\` or \`drizzle-kit migrate\`,
 * it is idempotent.
 */
export async function bootstrapDatabase(config: DatabaseConfig) {
  await connect(config);

  const sql = getSQL();
  const logger = getLogger();

  try {
${body}

    logger.info?.('Database bootstrap completed');
  } finally {
    await disconnect();
  }
}

// Runnable directly, so no wrapper script is needed:
//   deno run -A --env-file=.env <generated>/db/bootstrap.ts
if (import.meta.main) {
  const connectionString = Deno.env.get('DB_URL');
  if (!connectionString) {
    console.error('DB_URL is not set');
    Deno.exit(1);
  }

  const caFile = Deno.env.get('DB_SSL_CA_FILE');
  await bootstrapDatabase({
    connectionString,
    ssl: caFile ? { ca: Deno.readTextFileSync(caFile) } : undefined,
  });
}
`;
  }

  /**
   * Generate the drizzle-kit configuration.
   *
   * schemaFilter has to list every schema the models use, otherwise push would treat the tables
   * of a non-default schema as unknown. extensionsFilters keeps push away from the tables PostGIS
   * creates for itself (spatial_ref_sys), which it would otherwise offer to drop.
   */
  generateDrizzleConfig(): string {
    const schemas = ['public', ...this.customSchemas()].map((schema) => `'${schema}'`).join(', ');
    const extensionsFilter = this.requiresPostGISExtension() ? `\n  extensionsFilters: ['postgis'],` : '';

    return `import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit reads this file with its own loader, so it uses process.env rather than a Deno
 * specific dotenv import. Pass the connection string as DB_URL, for example with
 * \`deno run -A --env-file=.env npm:drizzle-kit push\`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: '${this.outputPath}/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DB_URL ?? '' },
  schemaFilter: [${schemas}],${extensionsFilter}
});
`;
  }
}
