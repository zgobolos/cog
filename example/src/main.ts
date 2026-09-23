import { type Context, Hono } from '@hono/hono';
import { HTTPException } from '@hono/hono/http-exception';
import { Scalar } from '@scalar/hono-api-reference';
import { load } from '@std/dotenv';
import { crypto } from '@std/crypto';
import { and, isNotNull, type SQL } from 'drizzle-orm';
import { type DbTransaction, extractRoutes, initializeGenerated, type QueryOptions } from '../generated/index.ts';
import type { DomainHookContext } from '../generated/domain/hooks.types.ts';
import type { Employee, NewEmployee } from '../generated/schema/index.ts';
import { employeeTable } from '../generated/schema/employee.schema.ts';
import { buildOpenAPISpec } from '../generated/rest/openapi.ts';
import type { ExampleEnv } from './context.ts';
import { recordHook } from './hook-probe.ts';

export interface ServerConfig {
  port?: number;
  hostname?: string;
  databaseUrl?: string;
  sslCaFile?: string;
}

export interface ServerHandle {
  server: Deno.HttpServer;
  shutdown: () => Promise<void>;
}

/**
 * Start the example server
 * @param config Optional configuration overrides
 * @returns Server handle with shutdown function
 */
export async function startServer(config: ServerConfig = {}): Promise<ServerHandle> {
  const app = new Hono<ExampleEnv>();

  // Load environment variables
  const env = await load();

  // Middleware: Set custom Env context variables
  app.use('*', async (c, next) => {
    c.set('someString', crypto.randomUUID());
    c.set('someDeepStructure', { someOtherString: new Date() });
    await next();
  });

  // Database configuration - use config overrides or env defaults
  const databaseUrl = config.databaseUrl || env.DB_URL;
  const sslCaFile = config.sslCaFile || env.DB_SSL_CA_FILE;

  // Initialize generated code with full hook signature demonstrations
  await initializeGenerated({
    database: {
      connectionString: databaseUrl,
      ssl: sslCaFile
        ? {
          ca: Deno.readTextFileSync(sslCaFile),
        }
        : undefined,
    },
    app,
    api: {
      basePath: '/api',
    },

    // DOMAIN HOOKS - Run within database transaction
    domainHooks: {
      employee: {
        // BEFORE hooks - Run OUTSIDE transaction, BEFORE validation
        beforeCreate: (
          rawInput: unknown,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<unknown> => {
          console.log('Employee.beforeCreate - outside transaction, before validation');
          // Can transform input, do auth checks, or throw to prevent operation
          return Promise.resolve(rawInput);
        },

        // CREATE hooks with full signatures
        preCreate: (
          input: NewEmployee,
          _rawInput: unknown,
          _tx: DbTransaction,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<NewEmployee> => {
          console.log('Employee.preCreate');
          return Promise.resolve(input);
        },

        postCreate: (
          _input: NewEmployee,
          result: Employee,
          _rawInput: unknown,
          _tx: DbTransaction,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<Employee> => {
          console.log('Employee.postCreate');
          return Promise.resolve(result);
        },

        afterCreate: (
          _result: Employee,
          _rawInput: unknown,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<void> => {
          console.log('Employee.afterCreate - async side effect');
          return Promise.resolve();
        },

        // UPDATE hooks with full signatures
        beforeUpdate: (
          _id: string,
          rawInput: unknown,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<unknown> => {
          console.log('Employee.beforeUpdate - outside transaction, before validation');
          return Promise.resolve(rawInput);
        },

        preUpdate: (
          _id: string,
          input: Partial<NewEmployee>,
          _rawInput: unknown,
          _tx: DbTransaction,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<Partial<NewEmployee>> => {
          console.log('Employee.preUpdate');
          return Promise.resolve(input);
        },

        postUpdate: (
          _id: string,
          _input: Partial<NewEmployee>,
          result: Employee,
          _rawInput: unknown,
          _tx: DbTransaction,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<Employee> => {
          console.log('Employee.postUpdate');
          return Promise.resolve(result);
        },

        afterUpdate: (
          _result: Employee,
          _rawInput: unknown,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<void> => {
          console.log('Employee.afterUpdate - async side effect');
          return Promise.resolve();
        },

        // DELETE hooks with full signatures
        beforeDelete: (
          _id: string,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<void> => {
          console.log('Employee.beforeDelete - outside transaction, before validation');
          return Promise.resolve();
        },

        preDelete: (
          _id: string,
          _tx: DbTransaction,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<{ id: string }> => {
          console.log('Employee.preDelete');
          return Promise.resolve({ id: _id });
        },

        postDelete: (
          _id: string,
          result: Employee,
          _tx: DbTransaction,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<Employee> => {
          console.log('Employee.postDelete');
          return Promise.resolve(result);
        },

        afterDelete: (
          _result: Employee,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<void> => {
          console.log('Employee.afterDelete - async side effect');
          return Promise.resolve();
        },

        // FIND hooks with full signatures
        beforeFindById: (
          id: string,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<string> => {
          console.log('Employee.beforeFindById - outside transaction');
          return Promise.resolve(id);
        },

        preFindById: (
          _id: string,
          _tx?: DbTransaction,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<{ id: string }> => {
          console.log('Employee.preFindById');
          return Promise.resolve({ id: _id });
        },

        postFindById: (
          _id: string,
          result: Employee | null,
          _tx?: DbTransaction,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<Employee | null> => {
          console.log('Employee.postFindById');
          return Promise.resolve(result);
        },

        beforeFindMany: (
          options: QueryOptions,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<QueryOptions> => {
          console.log('Employee.beforeFindMany - outside transaction');
          // Test combining existing filter with additional SQL condition using and()
          // This validates that options.where is already SQL (not raw WhereFilter)
          const additionalCondition = isNotNull(employeeTable.departmentId);
          if (options.where) {
            // Combine existing filter with our condition
            return Promise.resolve({
              ...options,
              where: and(options.where as SQL, additionalCondition),
            });
          }
          // No existing filter, just add our condition
          return Promise.resolve({
            ...options,
            where: additionalCondition,
          });
        },

        preFindMany: (
          _tx?: DbTransaction,
          options?: QueryOptions,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<QueryOptions> => {
          console.log('Employee.preFindMany');
          return Promise.resolve(options || {});
        },

        postFindMany: (
          _options: QueryOptions,
          results: Employee[],
          _tx?: DbTransaction,
          _context?: DomainHookContext<ExampleEnv['Variables']>,
        ): Promise<Employee[]> => {
          console.log('Employee.postFindMany');
          return Promise.resolve(results);
        },

        // JUNCTION HOOKS - Full signatures for many-to-many relationships
        skillListJunctionHooks: {
          beforeAddJunction: (
            ids: Record<string, string>,
            _rawInput: unknown,
            context?: DomainHookContext<ExampleEnv['Variables']>,
          ): Promise<Record<string, string>> => {
            console.log('Employee.skillList.beforeAddJunction - outside transaction');
            recordHook('skillList.beforeAddJunction', context);
            return Promise.resolve(ids);
          },

          preAddJunction: (
            ids: Record<string, string>,
            _rawInput: unknown,
            _tx: DbTransaction,
            context?: DomainHookContext<ExampleEnv['Variables']>,
          ): Promise<{ ids: Record<string, string> }> => {
            console.log('Employee.skillList.preAddJunction');
            recordHook('skillList.preAddJunction', context);
            return Promise.resolve({ ids });
          },

          postAddJunction: (
            _ids: Record<string, string>,
            _rawInput: unknown,
            _tx: DbTransaction,
            context?: DomainHookContext<ExampleEnv['Variables']>,
          ): Promise<void> => {
            console.log('Employee.skillList.postAddJunction');
            recordHook('skillList.postAddJunction', context);
            return Promise.resolve();
          },

          afterAddJunction: (
            _ids: Record<string, string>,
            _rawInput: unknown,
            context?: DomainHookContext<ExampleEnv['Variables']>,
          ): Promise<void> => {
            console.log('Employee.skillList.afterAddJunction - async side effect');
            recordHook('skillList.afterAddJunction', context);
            return Promise.resolve();
          },

          beforeRemoveJunction: (
            ids: Record<string, string>,
            _rawInput: unknown,
            context?: DomainHookContext<ExampleEnv['Variables']>,
          ): Promise<Record<string, string>> => {
            console.log('Employee.skillList.beforeRemoveJunction - outside transaction');
            recordHook('skillList.beforeRemoveJunction', context);
            return Promise.resolve(ids);
          },

          preRemoveJunction: (
            ids: Record<string, string>,
            _rawInput: unknown,
            _tx: DbTransaction,
            context?: DomainHookContext<ExampleEnv['Variables']>,
          ): Promise<{ ids: Record<string, string> }> => {
            console.log('Employee.skillList.preRemoveJunction');
            recordHook('skillList.preRemoveJunction', context);
            return Promise.resolve({ ids });
          },

          postRemoveJunction: (
            _ids: Record<string, string>,
            _rawInput: unknown,
            _tx: DbTransaction,
            context?: DomainHookContext<ExampleEnv['Variables']>,
          ): Promise<void> => {
            console.log('Employee.skillList.postRemoveJunction');
            recordHook('skillList.postRemoveJunction', context);
            return Promise.resolve();
          },

          afterRemoveJunction: (
            _ids: Record<string, string>,
            _rawInput: unknown,
            context?: DomainHookContext<ExampleEnv['Variables']>,
          ): Promise<void> => {
            console.log('Employee.skillList.afterRemoveJunction - async side effect');
            recordHook('skillList.afterRemoveJunction', context);
            return Promise.resolve();
          },
        },
      },
    },
  });

  // Build OpenAPI specification with basePath
  const openAPISpec = buildOpenAPISpec('/api');

  // Documentation endpoints
  app.get('/docs/openapi.json', (c) => c.json(openAPISpec));
  app.get('/docs/reference', Scalar({ url: '/docs/openapi.json' }) as unknown as (c: Context<ExampleEnv>) => Response);

  // Error handling
  app.onError((err: Error, c: Context<ExampleEnv>) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    console.error('Unhandled error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  // Start server
  const port = config.port || 3000;
  const hostname = config.hostname || '0.0.0.0';

  const server = Deno.serve(
    {
      port,
      hostname,
      onListen(addr) {
        console.log(`\nServer started at ${addr.hostname}:${addr.port}`);
        console.log(`\nDocumentation:`);
        console.log(`  OpenAPI Spec: http://localhost:${port}/docs/openapi.json`);
        console.log(`  Interactive Docs: http://localhost:${port}/docs/reference\n`);

        const routes = extractRoutes(app);
        console.table(routes);
      },
    },
    app.fetch,
  );

  return {
    server,
    shutdown: async () => {
      await server.shutdown();
    },
  };
}

// Run server when executed directly
if (import.meta.main) {
  startServer();
}
