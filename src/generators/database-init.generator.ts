import { FieldDefinition, ModelDefinition } from '../types/model.types.ts';
import { getCustomSchema, getSoftDeleteColumn, modelsHavePostGISFields } from '../utils/field.utils.ts';
import { toSnakeCase } from '../utils/string.utils.ts';

/**
 * Generates database initialization code
 */
export class DatabaseInitGenerator {
  private models: ModelDefinition[];
  private dbType: 'postgresql' | 'cockroachdb';
  /** PostGIS support: drives spatial column types and GIST index methods */
  private postgis: boolean;
  /** Whether the initialization script has to create the PostGIS extension */
  private requiresPostGISExtension: boolean;

  constructor(
    models: ModelDefinition[],
    options: { dbType?: string; postgis?: boolean } = {},
  ) {
    this.models = models;
    this.dbType = options.dbType === 'cockroachdb' ? 'cockroachdb' : 'postgresql';
    this.postgis = options.postgis !== false;
    // The extension is only required when a model actually declares a spatial field,
    // otherwise CREATE EXTENSION fails on a plain PostgreSQL without PostGIS installed
    this.requiresPostGISExtension = this.postgis && modelsHavePostGISFields(models);
  }

  /**
   * Generate database initialization script
   */
  generateDatabaseInitialization(): string {
    const createSchemas = this.generateSchemaCreationSQL();
    const createPostgis = this.requiresPostGISExtension
      ? "\n    // Create PostGIS extension\n    await sql`CREATE EXTENSION IF NOT EXISTS postgis`;\n    logger.info?.('PostGIS extension created');"
      : '';

    // Remove extra indentation and fix template
    return `import { connect, DatabaseConfig, disconnect, getSQL, getLogger } from './database.ts';

// Handle interruption signals
Deno.addSignalListener("SIGINT", async () => {
  const logger = getLogger();
  logger.info?.('\\nReceived interrupt signal');
  await disconnect();
  logger.info?.('Database connection closed');
  Deno.exit(0);
});

export async function initializeDatabase(config: DatabaseConfig) {
  try {
    // Initialize database with the existing configuration
    await connect(config);

    const sql = getSQL();
    const logger = getLogger();
${createPostgis}
${createSchemas}

    // Drop existing tables (in reverse dependency order)
${this.generateTableDropSQL()}

    // Create tables (without foreign key constraints)
${this.generateTableCreationSQL()}

    // Create junction tables for many-to-many relationships (without foreign key constraints)
${this.generateJunctionTableCreationSQL()}

    // Add foreign key constraints (after all tables exist)
${this.generateForeignKeyConstraintsSQL()}

    // Create indexes
${this.generateIndexCreationSQL()}

    logger.info?.('Database initialization completed successfully');
  } catch (error) {
    const logger = getLogger();
    logger.error?.('Error during database initialization:', error);
    throw error;
  } finally {
    const logger = getLogger();
    await disconnect();
    logger.info?.('Database connection closed');
  }
}
`;
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
 * Execute database operations within a transaction context
 *
 * Automatically retries transactions on serialization errors (error code 40001)
 * which commonly occur in CockroachDB and PostgreSQL under high concurrency.
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

      return await database.transaction(
        callback,
        Object.keys(txOptions).length > 0 ? txOptions : undefined
      );
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
   * Table reference for DDL, schema-qualified unless the model lives in Postgres' default
   * schema. Mirrors the pgTable()/pgSchema() choice of the Drizzle schema generator - the two
   * must agree or the ORM queries a table the DDL never created.
   */
  private tableRef(model: ModelDefinition): string {
    const tableName = model.tableName || model.name.toLowerCase();
    const schema = getCustomSchema(model);
    return schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
  }

  /**
   * Table reference of a referenced model, looked up by model name.
   * Falls back to the snake_cased model name when the target is unknown.
   */
  private referencedTableRef(modelName: string): string {
    const model = this.models.find((m) => m.name === modelName);
    return model ? this.tableRef(model) : `"${toSnakeCase(modelName)}"`;
  }

  /**
   * Generate CREATE SCHEMA statements for every non-default schema the models use
   */
  private generateSchemaCreationSQL(): string {
    const schemas = [
      ...new Set(this.models.map(getCustomSchema).filter((schema): schema is string => schema !== null)),
    ].sort();

    if (schemas.length === 0) return '';

    const statements = schemas.map((schema) =>
      `    await sql\`CREATE SCHEMA IF NOT EXISTS "${schema}"\`;\n` +
      `    logger.info?.('Created schema if not exists: ${schema}');`
    );

    return `\n    // Create non-default schemas\n${statements.join('\n')}`;
  }

  /**
   * Generate SQL statements for dropping tables
   */
  private generateTableDropSQL(): string {
    const drops: string[] = [];

    // First, drop junction tables (they depend on main tables)
    const processedJunctions = new Set<string>();
    for (const model of this.models) {
      if (!model.relationships) continue;
      for (const rel of model.relationships) {
        if (rel.type === 'manyToMany' && rel.through) {
          if (!processedJunctions.has(rel.through)) {
            processedJunctions.add(rel.through);
            const junctionTableName = rel.through.toLowerCase();
            drops.push(
              `    await sql\`DROP TABLE IF EXISTS "${junctionTableName}" CASCADE\`;\n    logger.info?.('Dropped table if exists: ${junctionTableName}');`,
            );
          }
        }
      }
    }

    // Then drop main tables in reverse dependency order
    const sortedModels = this.sortModelsByDependencies().reverse();
    for (const model of sortedModels) {
      const tableName = model.tableName;
      drops.push(
        `    await sql\`DROP TABLE IF EXISTS ${this.tableRef(model)} CASCADE\`;\n` +
          `    logger.info?.('Dropped table if exists: ${tableName}');`,
      );
    }

    return drops.join('\n');
  }

  /**
   * Sort models by their dependencies
   */
  private sortModelsByDependencies(): ModelDefinition[] {
    const graph = new Map<string, Set<string>>();
    const temp = new Set<string>();
    const visited = new Set<string>();
    const ordered: string[] = [];

    // Build dependency graph: model -> set(dependencies it references)
    for (const model of this.models) {
      const modelName = model.name.toLowerCase();
      if (!graph.has(modelName)) graph.set(modelName, new Set());
      for (const field of model.fields) {
        if (field.references) {
          const ref = field.references.model.toLowerCase();
          // ignore self-references
          if (ref !== modelName) graph.get(modelName)!.add(ref);
        }
      }
    }

    // DFS visit ensures deps are added before the model
    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (temp.has(name)) {
        // cycle detected; break it by returning (self/circular deps handled)
        return;
      }
      temp.add(name);
      const deps = graph.get(name) || new Set();
      for (const d of deps) visit(d);
      temp.delete(name);
      visited.add(name);
      ordered.push(name); // push after deps so deps come first
    };

    for (const model of this.models) visit(model.name.toLowerCase());

    // Map back to ModelDefinition in correct order
    const modelByName = new Map(this.models.map((m) => [m.name.toLowerCase(), m] as const));
    return ordered.map((n) => modelByName.get(n)!).filter(Boolean);
  }

  /**
   * Generate SQL statements for junction table creation
   */
  private generateJunctionTableCreationSQL(): string {
    const junctionTables: string[] = [];
    const processedJunctions = new Set<string>();

    for (const model of this.models) {
      if (!model.relationships) continue;

      for (const rel of model.relationships) {
        if (rel.type === 'manyToMany' && rel.through) {
          // Avoid generating the same junction table twice
          if (processedJunctions.has(rel.through)) continue;
          processedJunctions.add(rel.through);

          // Find the target model
          const targetModel = this.models.find((m) => m.name === rel.target);
          if (!targetModel) continue;

          // Get primary key types
          const sourcePK = model.fields.find((f) => f.primaryKey);
          const targetPK = targetModel.fields.find((f) => f.primaryKey);

          if (!sourcePK || !targetPK) continue;

          // Get the SQL types for the foreign key columns
          const sourceFKType = this.getColumnType(sourcePK).replace(' PRIMARY KEY', '').replace(' NOT NULL', '');
          const targetFKType = this.getColumnType(targetPK).replace(' PRIMARY KEY', '').replace(' NOT NULL', '');

          // Generate the junction table name and columns
          const tableName = rel.through.toLowerCase();
          const sourceFKColumn = rel.foreignKey || toSnakeCase(model.name) + '_id';
          const targetFKColumn = rel.targetForeignKey || toSnakeCase(rel.target) + '_id';

          let tableSQL = `    await sql\`
      CREATE TABLE IF NOT EXISTS "${tableName}" (
        ${sourceFKColumn} ${sourceFKType} NOT NULL,
        ${targetFKColumn} ${targetFKType} NOT NULL`;

          // Add timestamps if enabled (stored as EPOCH milliseconds - bigint)
          const hasTimestamps = model.timestamps || targetModel.timestamps;
          if (hasTimestamps) {
            tableSQL += `,
        created_at INT8 DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL`;
          }

          tableSQL += `,
        PRIMARY KEY (${sourceFKColumn}, ${targetFKColumn})
      );\`;
    logger.info?.('Created junction table: ${tableName}');`;

          junctionTables.push(tableSQL);

          // Add indexes for the foreign keys
          const indexSQL = `    // Create indexes for ${tableName}
    await sql\`CREATE INDEX IF NOT EXISTS idx_${tableName}_${sourceFKColumn} ON "${tableName}"(${sourceFKColumn});\`;
    await sql\`CREATE INDEX IF NOT EXISTS idx_${tableName}_${targetFKColumn} ON "${tableName}"(${targetFKColumn});\`;
    logger.info?.('Created indexes for junction table: ${tableName}');`;

          junctionTables.push(indexSQL);
        }
      }
    }

    return junctionTables.join('\n\n');
  }

  /**
   * Generate SQL statements for table creation
   */
  private generateTableCreationSQL(): string {
    const sortedModels = this.sortModelsByDependencies();
    return sortedModels.map((model) => {
      const tableName = model.tableName;
      const columns = this.generateColumnsSQL(model);
      const constraints = this.generateConstraintsSQL(model);

      return `    await sql\`
      CREATE TABLE IF NOT EXISTS ${this.tableRef(model)} (
        ${columns}${constraints ? ',\n        ' + constraints : ''}
      );\`;
    logger.info?.('Created table: ${tableName}');`;
    }).join('\n\n');
  }

  /**
   * Generate column definitions for a table
   */
  private generateColumnsSQL(model: ModelDefinition): string {
    const columns = [];

    // Model-specific columns
    for (const field of model.fields) {
      if (field.primaryKey) {
        // Primary key field
        if (field.type === 'uuid') {
          columns.push(
            `${field.name} UUID PRIMARY KEY${field.defaultValue ? ` DEFAULT ${field.defaultValue}` : ''} NOT NULL`,
          );
        } else {
          columns.push(`${field.name} ${this.getColumnType(field)} PRIMARY KEY NOT NULL`);
        }
        continue;
      }

      const columnName = toSnakeCase(field.name);
      const columnType = this.getColumnType(field);
      const constraints = this.getColumnConstraints(field);
      columns.push(`"${columnName}" ${columnType}${constraints}`);
    }

    // Common columns (timestamps stored as EPOCH milliseconds - bigint)
    if (model.timestamps !== false) {
      const timestampType = 'INT8'; // bigint for EPOCH milliseconds
      const defaultValue = '(extract(epoch from now()) * 1000)::bigint';
      columns.push(`created_at ${timestampType} DEFAULT ${defaultValue} NOT NULL`);
      columns.push(`updated_at ${timestampType} DEFAULT ${defaultValue} NOT NULL`);
    }

    // Soft-delete column (nullable, no default)
    const softDeleteColumn = getSoftDeleteColumn(model);
    if (softDeleteColumn) {
      columns.push(`${softDeleteColumn} INT8`);
    }

    return columns.join(',\n        ');
  }

  /**
   * Generate constraints for a table (excluding foreign key constraints)
   */
  private generateConstraintsSQL(model: ModelDefinition): string {
    const constraints = [];

    // Unique constraints (suppressed for soft-delete models; they use partial unique indexes instead)
    const sdCol = getSoftDeleteColumn(model);
    for (const field of model.fields) {
      if (field.unique && !sdCol) {
        const columnName = toSnakeCase(field.name);
        constraints.push(`CONSTRAINT "${model.name.toLowerCase()}_${columnName}_unique" UNIQUE("${columnName}")`);
      }
    }

    // Foreign key constraints are now added separately after all tables are created
    // This avoids circular dependency issues

    return constraints.join(',\n        ');
  }

  /**
   * Generate SQL statements for foreign key constraint creation
   */
  private generateForeignKeyConstraintsSQL(): string {
    const constraints: string[] = [];

    // Add FK constraints for main tables
    for (const model of this.models) {
      for (const field of model.fields) {
        if (field.references) {
          const columnName = toSnakeCase(field.name);
          const refTable = this.referencedTableRef(field.references.model);
          const refColumn = field.references.field || 'id';
          const onDelete = field.references.onDelete || 'NO ACTION';
          const onUpdate = field.references.onUpdate || 'NO ACTION';
          const constraintName = `${model.name.toLowerCase()}_${columnName}_fk`;

          constraints.push(
            `    await sql\`ALTER TABLE ${this.tableRef(model)} ` +
              `ADD CONSTRAINT "${constraintName}" ` +
              `FOREIGN KEY ("${columnName}") REFERENCES ${refTable}("${refColumn}") ` +
              `ON DELETE ${onDelete} ON UPDATE ${onUpdate};\`;\n` +
              `    logger.info?.('Added FK constraint: ${constraintName}');`,
          );
        }
      }
    }

    // Add FK constraints for junction tables
    const processedJunctions = new Set<string>();
    for (const model of this.models) {
      if (!model.relationships) continue;

      for (const rel of model.relationships) {
        if (rel.type === 'manyToMany' && rel.through) {
          if (processedJunctions.has(rel.through)) continue;
          processedJunctions.add(rel.through);

          const targetModel = this.models.find((m) => m.name === rel.target);
          if (!targetModel) continue;

          const sourcePK = model.fields.find((f) => f.primaryKey);
          const targetPK = targetModel.fields.find((f) => f.primaryKey);
          if (!sourcePK || !targetPK) continue;

          const tableName = rel.through.toLowerCase();
          const sourceFKColumn = rel.foreignKey || toSnakeCase(model.name) + '_id';
          const targetFKColumn = rel.targetForeignKey || toSnakeCase(rel.target) + '_id';

          // Add FK constraint for source table
          constraints.push(
            `    await sql\`ALTER TABLE "${tableName}" ` +
              `ADD CONSTRAINT "${tableName}_${sourceFKColumn}_fk" ` +
              `FOREIGN KEY (${sourceFKColumn}) REFERENCES ${this.tableRef(model)}(${sourcePK.name}) ` +
              `ON DELETE CASCADE;\`;\n` +
              `    logger.info?.('Added FK constraint: ${tableName}_${sourceFKColumn}_fk');`,
          );

          // Add FK constraint for target table
          constraints.push(
            `    await sql\`ALTER TABLE "${tableName}" ` +
              `ADD CONSTRAINT "${tableName}_${targetFKColumn}_fk" ` +
              `FOREIGN KEY (${targetFKColumn}) REFERENCES ${this.tableRef(targetModel)}(${targetPK.name}) ` +
              `ON DELETE CASCADE;\`;\n` +
              `    logger.info?.('Added FK constraint: ${tableName}_${targetFKColumn}_fk');`,
          );
        }
      }
    }

    return constraints.join('\n\n');
  }

  /**
   * Generate SQL statements for index creation
   */
  private generateIndexCreationSQL(): string {
    // Index names only have to be unique within a schema, so the key includes the table
    const processedIndexes = new Set<string>();
    return this.models.map((model) => {
      const indexes = this.generateIndexes(model);

      if (!indexes.length) return '';

      return indexes.map(({ sql, name }) => {
        const key = `${this.tableRef(model)}:${name}`;
        if (processedIndexes.has(key)) return '';
        processedIndexes.add(key);
        return `    await sql\`${sql}\`;
    logger.info?.('Created index: ${name}');`;
      }).filter(Boolean).join('\n');
    }).filter(Boolean).join('\n\n');
  }

  /**
   * Generate indexes for a table
   */
  private generateIndexes(model: ModelDefinition): Array<{ sql: string; name: string }> {
    const indexes = [];
    const tableName = model.tableName;
    const tableRef = this.tableRef(model);
    const sdCol = getSoftDeleteColumn(model);

    // Field-level indexes
    for (const field of model.fields) {
      if (field.index) {
        const columnName = toSnakeCase(field.name);
        const method = this.getIndexMethod(field);
        const methodClause = method ? `USING ${method}` : '';
        const indexName = `idx_${tableName}_${columnName}`;

        // For soft-delete models suppress the UNIQUE keyword here: the dedicated partial-unique-index
        // loop below already emits a correct `WHERE deleted_at IS NULL` unique index for this column.
        // A plain non-partial UNIQUE INDEX would let soft-deleted rows reserve the value — defeating the fix.
        const createType = field.unique && !sdCol ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX';
        indexes.push({
          name: indexName,
          sql: `${createType} IF NOT EXISTS "${indexName}" ON ${tableRef} ` +
            `${methodClause} ("${columnName}")`,
        });
      }
    }

    // Soft-delete: field-level unique becomes a partial unique index over live rows
    if (sdCol) {
      for (const field of model.fields) {
        if (field.unique) {
          const columnName = toSnakeCase(field.name);
          const indexName = `uq_${tableName}_${columnName}`;
          indexes.push({
            name: indexName,
            sql: `CREATE UNIQUE INDEX IF NOT EXISTS "${indexName}" ON ${tableRef} ` +
              `("${columnName}") WHERE ${sdCol} IS NULL`,
          });
        }
      }
    }

    // Model-level indexes
    if (model.indexes) {
      for (const idx of model.indexes) {
        const columns = idx.fields.map((f) => `"${toSnakeCase(f)}"`).join(', ');
        const indexName = idx.name || `idx_${tableName}_${idx.fields.map((f) => toSnakeCase(f)).join('_')}`;

        // Determine index method, respecting postgis setting
        let method = idx.type || this.getDefaultIndexMethod();

        // If PostGIS is disabled and index type is GIST, fall back to GIN for JSONB
        if (!this.postgis && method.toUpperCase() === 'GIST') {
          method = 'GIN';
        }

        const methodClause = method ? `USING ${method}` : '';

        const createType = idx.unique ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX';
        const partialClause = idx.unique && sdCol ? ` WHERE ${sdCol} IS NULL` : '';
        indexes.push({
          name: indexName,
          sql: `${createType} IF NOT EXISTS "${indexName}" ON ${tableRef} ` +
            `${methodClause} (${columns})${partialClause}`,
        });
      }
    }

    return indexes;
  }

  /**
   * Get SQL type for a field
   */
  private getColumnType(field: FieldDefinition): string {
    // Handle array types first
    if (field.array) {
      if (field.type === 'text') return 'TEXT[]';
      const baseType = this.getColumnType({ ...field, array: false });
      return `${baseType}[]`;
    }

    // Basic types that are the same in both PostgreSQL and CockroachDB
    const commonTypes: Record<string, string> = {
      'uuid': 'UUID',
      'string': field.maxLength ? `VARCHAR(${field.maxLength})` : 'TEXT',
      'text': 'TEXT',
      'boolean': 'BOOLEAN',
      'date': 'INT8', // Store dates as EPOCH milliseconds (bigint)
      'jsonb': 'JSONB',
      'timestamp': 'INT8', // Store timestamps as EPOCH milliseconds (bigint)
    };

    if (field.type in commonTypes) {
      return commonTypes[field.type];
    }

    // Database-specific types
    if (this.dbType === 'cockroachdb') {
      switch (field.type) {
        case 'integer':
          return 'INT4';
        case 'bigint':
          return 'INT8';
        case 'decimal':
          return `DECIMAL(${field.precision || 10}, ${field.scale || 2})`;
        case 'point':
        case 'linestring':
        case 'polygon':
        case 'multipoint':
        case 'multilinestring':
        case 'multipolygon':
        case 'geometry':
        case 'geography': {
          if (!this.postgis) {
            return 'JSONB';
          }
          // CockroachDB doesn't support GEOGRAPHY type - convert to GEOMETRY
          // For generic geometry/geography fields without specific geometryType, use GEOMETRY without subtype
          if (field.geometryType) {
            const srid = field.srid || 4326;
            return `GEOMETRY(${field.geometryType}, ${srid})`;
          } else if (field.type === 'geometry' || field.type === 'geography') {
            // Generic geometry - use GEOMETRY without subtype specification
            return 'GEOMETRY';
          } else {
            // Specific type (point, polygon, etc.)
            const geometryType = field.type.toUpperCase();
            const srid = field.srid || 4326;
            return `GEOMETRY(${geometryType}, ${srid})`;
          }
        }
        default:
          return 'TEXT';
      }
    } else {
      // PostgreSQL types
      switch (field.type) {
        case 'integer':
          return 'INTEGER';
        case 'bigint':
          return 'BIGINT';
        case 'decimal':
          return `DECIMAL(${field.precision || 10}, ${field.scale || 2})`;
        case 'point':
        case 'linestring':
        case 'polygon':
        case 'multipoint':
        case 'multilinestring':
        case 'multipolygon':
        case 'geometry':
        case 'geography': {
          if (!this.postgis) {
            return 'JSONB';
          }
          // For generic geometry/geography fields without specific geometryType, use column type without subtype
          if (field.geometryType) {
            const srid = field.srid || 4326;
            const isGeography = field.type === 'geography';
            const columnType = isGeography ? 'GEOGRAPHY' : 'GEOMETRY';
            return `${columnType}(${field.geometryType}, ${srid})`;
          } else if (field.type === 'geometry') {
            // Generic geometry - use GEOMETRY without subtype specification
            return 'GEOMETRY';
          } else if (field.type === 'geography') {
            // Generic geography - use GEOGRAPHY without subtype specification
            return 'GEOGRAPHY';
          } else {
            // Specific type (point, polygon, etc.)
            const geometryType = field.type.toUpperCase();
            const srid = field.srid || 4326;
            return `GEOMETRY(${geometryType}, ${srid})`;
          }
        }
        default:
          return 'TEXT';
      }
    }
  }

  /**
   * Get SQL constraints for a field
   */
  private getColumnConstraints(field: FieldDefinition): string {
    const constraints = [];

    if (field.required) {
      constraints.push('NOT NULL');
    }

    if (field.defaultValue !== undefined) {
      if (field.type === 'uuid' && field.defaultValue === 'gen_random_uuid()') {
        constraints.push(`DEFAULT gen_random_uuid()`);
      } else if (typeof field.defaultValue === 'string' && !field.defaultValue.includes('(')) {
        constraints.push(`DEFAULT '${field.defaultValue}'`);
      } else if (typeof field.defaultValue === 'boolean') {
        constraints.push(`DEFAULT ${field.defaultValue}`);
      } else if (typeof field.defaultValue === 'number') {
        constraints.push(`DEFAULT ${field.defaultValue}`);
      } else if (field.defaultValue === null) {
        constraints.push('DEFAULT NULL');
      } else {
        constraints.push(`DEFAULT ${field.defaultValue}`);
      }
    }

    return constraints.length ? ' ' + constraints.join(' ') : '';
  }

  /**
   * Get index method based on field type
   */
  private getIndexMethod(field: FieldDefinition): string {
    // CockroachDB only supports BTREE and INVERTED indexes
    if (this.dbType === 'cockroachdb') {
      if (field.type === 'json' || field.type === 'jsonb') {
        return 'INVERTED';
      }
      return this.postgis && ['point', 'polygon', 'multipolygon', 'linestring'].includes(field.type) ? 'GIST' : 'BTREE';
    }

    // PostgreSQL index types
    if (this.postgis && ['point', 'polygon', 'multipolygon', 'linestring'].includes(field.type)) {
      return 'GIST';
    }

    if (field.type === 'json' || field.type === 'jsonb') {
      return 'GIN';
    }

    return 'BTREE';
  }

  /**
   * Get default index method for the database
   */
  private getDefaultIndexMethod(): string {
    return this.dbType === 'cockroachdb' ? 'BTREE' : 'BTREE';
  }

  /**
   * Format default value for SQL
   */
  private formatDefaultValue(field: FieldDefinition): string {
    if (field.type === 'uuid' && field.defaultValue === 'gen_random_uuid()') {
      return 'gen_random_uuid()';
    } else if (typeof field.defaultValue === 'string' && !field.defaultValue.includes('(')) {
      return `'${field.defaultValue}'`;
    } else if (typeof field.defaultValue === 'boolean') {
      return field.defaultValue.toString().toUpperCase();
    } else if (typeof field.defaultValue === 'number') {
      return field.defaultValue.toString();
    } else if (field.defaultValue === null) {
      return 'NULL';
    } else {
      return field.defaultValue?.toString() || '';
    }
  }
}
