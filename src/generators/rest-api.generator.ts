import { ModelDefinition } from '../types/model.types.ts';
import { capitalize } from '../utils/string.utils.ts';

/**
 * Generates REST API endpoints for Hono
 */
export class RestAPIGenerator {
  private models: ModelDefinition[];

  constructor(models: ModelDefinition[]) {
    this.models = models;
  }

  /**
   * Generate REST API files
   */
  generateRestAPIs(): Map<string, string> {
    const files = new Map<string, string>();

    // Generate shared types
    files.set('rest/types.ts', this.generateSharedTypes());

    // Generate shared helper functions
    files.set('rest/helpers.ts', this.generateRestHelpers());

    // Generate individual REST endpoints
    for (const model of this.models) {
      const restAPI = this.generateModelRestAPI(model);
      files.set(`rest/${model.name.toLowerCase()}.rest.ts`, restAPI);
    }

    // Generate REST registration file
    files.set('rest/index.ts', this.generateRestIndex());

    return files;
  }

  /**
   * Generate REST API for a model
   */
  private generateModelRestAPI(model: ModelDefinition): string {
    const modelName = model.name;
    const modelNameLower = model.name.toLowerCase();
    const hasRelationshipEndpoints = this.hasRelationshipEndpoints(model);

    // Build imports
    let imports = `import { Hono } from '@hono/hono';
import { ${modelNameLower}Domain } from '../domain/${modelNameLower}.domain.ts';
import { type ${modelName}, type New${modelName}, ${modelNameLower}FieldMeta } from '../schema/${modelNameLower}.schema.ts';
import { registerCrudRoutes, type CrudConfig } from './crud.factory.ts';`;

    // Add imports needed for relationship endpoints
    if (hasRelationshipEndpoints) {
      imports += `
import { withTransaction } from '../db/database.ts';
import { convertBigIntToNumber, handleDomainException, parseJsonBody } from './helpers.ts';`;
    }

    return `${imports}

/**
 * ${modelName} REST Routes
 * Handles HTTP endpoints (thin routing layer)
 */
class ${modelName}RestRoutes<RestEnvVars extends Record<string, unknown> = Record<string, unknown>> {
  public routes: Hono<{ Variables: RestEnvVars }>;

  constructor() {
    this.routes = new Hono<{ Variables: RestEnvVars }>();
    this.registerRoutes();
  }

  private registerRoutes() {
    // CRUD configuration
    const config: CrudConfig<${modelName}, New${modelName}> = {
      domain: ${modelNameLower}Domain,
      fieldMeta: ${modelNameLower}FieldMeta,
      modelName: '${modelName}',
      endpoints: {
        readMany: ${model.endpoints?.readMany !== false},
        readOne: ${model.endpoints?.readOne !== false},
        create: ${model.endpoints?.create !== false},
        update: ${model.endpoints?.update !== false},
        delete: ${model.endpoints?.delete !== false},
      },
    };

    // Register standard CRUD routes
    registerCrudRoutes<${modelName}, New${modelName}, RestEnvVars>(this.routes, config);
${this.generateRelationshipEndpointsWithHooks(model)}
  }
}

// Export singleton instance
export let ${modelNameLower}Routes = new ${modelName}RestRoutes().routes;

// Export function to initialize routes
export function initialize${modelName}RestRoutes<RestEnvVars extends Record<string, unknown> = Record<string, unknown>>() {
  const instance = new ${modelName}RestRoutes();
  ${modelNameLower}Routes = instance.routes as unknown as Hono<{ Variables: Record<string, unknown> }>;
  return instance.routes;
}
`;
  }

  /**
   * Check if model has any relationship endpoints
   */
  private hasRelationshipEndpoints(model: ModelDefinition): boolean {
    if (!model.relationships || model.relationships.length === 0) {
      return false;
    }
    return model.relationships.some((rel) => rel.type === 'manyToMany' && rel.through);
  }

  /**
   * Generate shared types file
   */
  private generateSharedTypes(): string {
    return `/**
 * Shared types for REST API
 *
 * Note: The Env type should be defined in your application code.
 * This allows you to customize the Variables available in your Hono context.
 *
 * Example:
 * export type Env = {
 *   Variables: {
 *     requestId?: string;
 *     userId?: string;
 *     // Add your custom variables here
 *   }
 * }
 */

// Default minimal Env type for generated routes
// You should override this in your application
export type DefaultEnv = {
  Variables: {
    [key: string]: unknown;
  }
}
`;
  }

  /**
   * Generate shared helper functions for REST API
   */
  private generateRestHelpers(): string {
    return `import { HTTPException } from '@hono/hono/http-exception';
import type { Context } from '@hono/hono';
import { NotFoundException, DomainException } from '../domain/exceptions.ts';

// Re-export filter utilities for use in REST handlers
export {
  parseWhereParam,
  validateFilter,
  type WhereFilter,
  type FilterCondition,
  type FilterGroup,
  type FieldMeta,
  type FilterValidationResult,
} from '../utils/filter.utils.ts';

/**
 * Converts BigInt values to numbers for JSON serialization
 * Dates are stored as EPOCH milliseconds (bigint) and need conversion for JSON
 */
export function convertBigIntToNumber<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'bigint') {
    return Number(obj) as unknown as T;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => convertBigIntToNumber(item)) as unknown as T;
  }

  if (typeof obj === 'object') {
    const converted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      converted[key] = convertBigIntToNumber(value);
    }
    return converted as T;
  }

  return obj;
}

/**
 * Detects Zod validation failures structurally instead of with instanceof.
 * drizzle-zod builds the schemas with the 'zod/v4' namespace, which is a different
 * class than the root 'zod' export on zod 3.25.x, so an identity check silently fails
 * depending on how the consuming project resolves zod - and the validation error
 * would surface as a 500 instead of a 400.
 */
const isZodError = (error: unknown): error is { issues: unknown[] } => {
  return typeof error === 'object' && error !== null &&
    (error as { name?: string }).name === 'ZodError' &&
    Array.isArray((error as { issues?: unknown }).issues);
};

/**
 * Reads and parses the JSON request body.
 * A malformed body is a client error, so it must not surface as a 500.
 */
export const parseJsonBody = async <T = Record<string, unknown>>(c: Context): Promise<T> => {
  try {
    return await c.req.json() as T;
  } catch {
    throw new HTTPException(400, { message: 'Invalid JSON in request body' });
  }
};

/**
 * Database errors that the request caused rather than the server.
 * Anything not listed here stays a 500: it is a bug or an outage, not a client mistake.
 */
const CLIENT_ERROR_STATUS_BY_SQLSTATE: Record<string, 400 | 409> = {
  '23001': 409, // restrict_violation - the row is still referenced
  '23505': 409, // unique_violation
  '23502': 400, // not_null_violation
  '23503': 400, // foreign_key_violation
  '23514': 400, // check_violation
  '22001': 400, // string_data_right_truncation
  '22007': 400, // invalid_datetime_format
  '22P02': 400, // invalid_text_representation
};

/**
 * Reads the SQLSTATE of a database error. Drizzle wraps driver errors in a DrizzleQueryError,
 * so the code sits on the cause rather than on the error itself.
 */
const databaseErrorStatus = (error: unknown): { status: 400 | 409; constraint?: string } | null => {
  const driverError = (error as { cause?: unknown }).cause ?? error;
  const { code, constraint_name } = (driverError ?? {}) as { code?: string; constraint_name?: string };
  const status = code ? CLIENT_ERROR_STATUS_BY_SQLSTATE[code] : undefined;

  return status ? { status, constraint: constraint_name } : null;
};

/**
 * Converts domain exceptions to HTTP exceptions
 * Handles centralized error conversion from domain layer
 */
export function handleDomainException(error: unknown): never {
  if (error instanceof NotFoundException) {
    throw new HTTPException(404, { message: error.message });
  }
  if (error instanceof DomainException) {
    throw new HTTPException(500, { message: error.message });
  }
  // Zod validation failures (e.g. minLength/maxLength, required, enum) are client errors
  if (isZodError(error)) {
    throw new HTTPException(400, { message: JSON.stringify(error.issues) });
  }
  // Constraint violations are caused by the request, so they are 4xx rather than 500
  const databaseError = databaseErrorStatus(error);
  if (databaseError) {
    const detail = databaseError.constraint ? \`: \${databaseError.constraint}\` : '';
    throw new HTTPException(databaseError.status, {
      message: \`\${databaseError.status === 409 ? 'Conflict' : 'Constraint violation'}\${detail}\`,
    });
  }
  throw error; // Re-throw unknown errors
}
`;
  }

  /**
   * Generate many-to-many relationship endpoints
   */
  private generateRelationshipEndpointsWithHooks(model: ModelDefinition): string {
    if (!model.relationships || model.relationships.length === 0) {
      return '';
    }

    const endpoints: string[] = [];
    const modelNameLower = model.name.toLowerCase();

    for (const rel of model.relationships) {
      if (rel.type === 'manyToMany' && rel.through) {
        const relName = rel.name;
        const RelName = capitalize(relName);
        // const targetNameLower = rel.target.toLowerCase();
        // const targetName = rel.target;

        // Derive singular form by removing "List" suffix if present
        const singularRelName = relName.endsWith('List') ? relName.slice(0, -4) : relName;
        const SingularRelName = capitalize(singularRelName);

        // GET relationship list
        if (rel.endpoints?.get !== false) {
          endpoints.push(`
    /**
     * GET /${modelNameLower}/:id/${relName}
     * Get ${relName} for a ${model.name}
     */
    this.routes.get('/:id/${relName}', async (c) => {
      try {
        const id = c.req.param('id');

        const result = await ${modelNameLower}Domain.get${RelName}(id);

        return c.json({ data: convertBigIntToNumber(result) });
      } catch (error) {
        handleDomainException(error);
      }
    });`);
        }

        // POST bulk add
        if (rel.endpoints?.add !== false) {
          endpoints.push(`
    /**
     * POST /${modelNameLower}/:id/${relName}
     * Add multiple ${relName} to a ${model.name}
     */
    this.routes.post('/:id/${relName}', async (c) => {
      try {
        const id = c.req.param('id');
        const body = await parseJsonBody<{ ids?: string[] }>(c);
        const ids = body.ids || [];

        await withTransaction(async (tx) => {
          await ${modelNameLower}Domain.add${RelName}(id, ids, body, tx);
        });

        return c.json({ data: { message: '${relName} added successfully' } }, 201);
      } catch (error) {
        handleDomainException(error);
      }
    });`);

          // POST single add
          endpoints.push(`
    /**
     * POST /${modelNameLower}/:id/${singularRelName}
     * Add a specific ${singularRelName} to a ${model.name}
     */
    this.routes.post('/:id/${singularRelName}', async (c) => {
      try {
        const id = c.req.param('id');
        const body = await parseJsonBody<{ id: string }>(c);
        const relatedId = body.id;

        await withTransaction(async (tx) => {
          await ${modelNameLower}Domain.add${SingularRelName}(id, relatedId, body, tx);
        });

        return c.json({ data: { message: '${singularRelName} added successfully' } }, 201);
      } catch (error) {
        handleDomainException(error);
      }
    });`);
        }

        // PUT replace all
        if (rel.endpoints?.replace !== false) {
          endpoints.push(`
    /**
     * PUT /${modelNameLower}/:id/${relName}
     * Replace all ${relName} for a ${model.name}
     */
    this.routes.put('/:id/${relName}', async (c) => {
      try {
        const id = c.req.param('id');
        const body = await parseJsonBody<{ ids?: string[] }>(c);
        const ids = body.ids || [];

        await withTransaction(async (tx) => {
          await ${modelNameLower}Domain.set${RelName}(id, ids, body, tx);
        });

        return c.json({ data: { message: '${relName} updated successfully' } });
      } catch (error) {
        handleDomainException(error);
      }
    });`);
        }

        // DELETE remove
        if (rel.endpoints?.remove !== false) {
          endpoints.push(`
    /**
     * DELETE /${modelNameLower}/:id/${singularRelName}
     * Remove a specific ${singularRelName} from a ${model.name}
     */
    this.routes.delete('/:id/${singularRelName}', async (c) => {
      try {
        const id = c.req.param('id');
        const body = await parseJsonBody<{ id: string }>(c);
        const relatedId = body.id;

        await withTransaction(async (tx) => {
          await ${modelNameLower}Domain.remove${SingularRelName}(id, relatedId, body, tx);
        });

        return c.json({ data: { message: '${singularRelName} removed successfully' } });
      } catch (error) {
        handleDomainException(error);
      }
    });`);

          // DELETE bulk remove
          endpoints.push(`
    /**
     * DELETE /${modelNameLower}/:id/${relName}
     * Remove multiple ${relName} from a ${model.name}
     */
    this.routes.delete('/:id/${relName}', async (c) => {
      try {
        const id = c.req.param('id');
        const body = await parseJsonBody<{ ids?: string[] }>(c);
        const ids = body.ids || [];

        await withTransaction(async (tx) => {
          await ${modelNameLower}Domain.remove${RelName}(id, ids, body, tx);
        });

        return c.json({ data: { message: '${relName} removed successfully' } });
      } catch (error) {
        handleDomainException(error);
      }
    });`);
        }
      }
    }

    return endpoints.join('\n');
  }

  /**
   * Generate REST index file
   */
  private generateRestIndex(): string {
    let code = `import { Hono, type Env } from '@hono/hono';
`;

    // Import all route files
    for (const model of this.models) {
      code += `import { ${model.name.toLowerCase()}Routes } from './${model.name.toLowerCase()}.rest.ts';\n`;
    }

    code += `

/**
 * Register all REST routes
 * Note: Global middlewares should be registered before calling this function
 * @param app - The Hono app instance
 * @param basePath - Optional base path prefix for API routes (defaults to '/api')
 */
export function registerRestRoutes<E extends Env = Env>(app: Hono<E>, basePath?: string) {
  const apiPrefix = basePath || '/api';
  
  // Register model routes
`;

    for (const model of this.models) {
      const modelNameLower = model.name.toLowerCase();
      code += `  app.route(\`\${apiPrefix}/${modelNameLower}\`, ${modelNameLower}Routes);\n`;
    }

    code += `
  // API documentation endpoint
  app.get(\`\${apiPrefix}\`, (c) => {
    return c.json({
      version: '1.0.0',
      basePath: apiPrefix,
      endpoints: [
${
      this.models.map((m) => {
        const modelNameLower = m.name.toLowerCase();
        return `        '${modelNameLower}'`;
      }).join(',\n')
    }
      ]
    });
  });
}

/**
 * Extracted route information
 */
export interface ExtractedRoute {
  method: string;  // HTTP method (GET, POST, PUT, PATCH, DELETE, etc.)
  path: string;    // Full route path including basePath
}

/**
 * Extract all registered HTTP routes from a Hono app instance
 *
 * This utility inspects Hono's internal route registry to return a clean list
 * of all registered HTTP endpoints. Middleware routes (method: 'ALL' with wildcards)
 * are automatically filtered out.
 *
 * @param app - The Hono app instance to inspect
 * @returns Array of route objects with method and path
 *
 * @example
 * \`\`\`typescript
 * import { extractRoutes } from './generated/rest/index.ts';
 *
 * const app = new Hono();
 * // ... register routes via initializeGenerated()
 *
 * const routes = extractRoutes(app);
 * console.log(routes);
 * // [
 * //   { method: 'GET', path: '/api/users' },
 * //   { method: 'POST', path: '/api/users' },
 * //   { method: 'GET', path: '/api/users/:id' },
 * //   ...
 * // ]
 * \`\`\`
 */
export function extractRoutes<E extends Env = Env>(app: Hono<E>): ExtractedRoute[] {
  return app.routes
    .filter(route => {
      // Filter out middleware routes (method: 'ALL' with wildcards like /* or /api/*)
      const isMiddleware = route.method === 'ALL' && route.path.includes('*');
      return !isMiddleware;
    })
    .map(route => {
      // Hono sometimes includes the full path in 'path' property
      // Check if path already contains basePath to avoid duplication
      let fullPath = route.path;

      if (route.basePath && route.basePath !== '/') {
        // If path already starts with basePath, use it as-is
        if (!route.path.startsWith(route.basePath)) {
          // Otherwise, concatenate basePath + path
          fullPath = \`\${route.basePath}\${route.path}\`;
        }
      }

      return {
        method: route.method,
        path: fullPath
      };
    })
    .sort((a, b) => {
      // Sort by path first, then by method
      const pathCompare = a.path.localeCompare(b.path);
      return pathCompare !== 0 ? pathCompare : a.method.localeCompare(b.method);
    });
}

// Export all routes for individual use
`;

    for (const model of this.models) {
      code +=
        `export { ${model.name.toLowerCase()}Routes, initialize${model.name}RestRoutes } from './${model.name.toLowerCase()}.rest.ts';\n`;
    }

    code += `\n// Re-export shared types\n`;
    code += `export type { DefaultEnv } from './types.ts';\n`;

    return code;
  }

  /**
   * Find model by name
   */
  private findModelByName(name: string): ModelDefinition | undefined {
    return this.models.find((m) => m.name === name);
  }
}
