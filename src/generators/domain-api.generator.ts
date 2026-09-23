import { FieldDefinition, ModelDefinition } from '../types/model.types.ts';
import { capitalize, toCamelCase, toSnakeCase } from '../utils/string.utils.ts';

/**
 * Generates domain API layer with CRUD operations and hooks
 */
export class DomainAPIGenerator {
  private models: ModelDefinition[];

  constructor(models: ModelDefinition[]) {
    this.models = models;
  }

  /**
   * Generate domain API files
   */
  generateDomainAPIs(): Map<string, string> {
    const files = new Map<string, string>();

    // Generate hooks types
    files.set('domain/hooks.types.ts', this.generateHooksTypes());

    // Generate individual domain APIs
    for (const model of this.models) {
      const domainAPI = this.generateModelDomainAPI(model);
      files.set(`domain/${model.name.toLowerCase()}.domain.ts`, domainAPI);
    }

    // Generate index file
    files.set('domain/index.ts', this.generateDomainIndex());

    return files;
  }

  /**
   * Generate hooks types
   */
  private generateHooksTypes(): string {
    return `import { SQL } from 'drizzle-orm';
import { type DbTransaction } from '../db/database.ts';
import { type WhereFilter } from '../utils/filter.utils.ts';

/**
 * Domain hook context that receives all variables from the Hono context.
 * The generic DomainEnvVars type will contain all custom variables defined
 * in your application's Env type.
 *
 * Example:
 * If your Env type has Variables: { requestId?: string; userId?: string; tenantId?: string }
 * Then in hooks you can access: context.requestId, context.userId, context.tenantId
 */
export type DomainHookContext<DomainEnvVars extends Record<string, unknown> = Record<string, unknown>> = DomainEnvVars;

/**
 * Query options for domain operations
 * - where: Can be a WhereFilter object (from REST) or raw SQL (from hooks) - findMany only
 * - include: Array of relationship names to eagerly load - find* methods
 * - limit/offset/orderBy/orderDirection: Pagination - findMany only
 * - skipSanitization: Skip field exposure filtering (default: false) - all methods
 */
export interface QueryOptions {
  // Filtering (findMany only)
  where?: WhereFilter | SQL;

  // Pagination (findMany only)
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDirection?: 'asc' | 'desc';

  // Relationship loading (find* methods)
  include?: string[];

  // Sanitization control (all methods, default: false)
  skipSanitization?: boolean;

  // Soft-delete control (find* methods, default: false): include soft-deleted rows
  withSoftDeleted?: boolean;
}


/**
 * Domain layer hooks with input validation.
 *
 * These hooks run at the domain layer within database transactions.
 *
 * Input Validation Flow:
 * 1. Input is validated with Zod schema BEFORE pre-hook is called
 * 2. Pre-hook receives validated input and can modify it
 * 3. Pre-hook output is validated with Zod schema BEFORE main operation
 * 4. This ensures pre-hooks cannot emit malformed data to operations
 *
 * All validation uses Zod schemas generated from Drizzle table definitions.
 * Validation errors will throw ZodError with detailed error information.
 *
 * The generic DomainEnvVars type allows you to specify your Env Variables type for type-safe
 * access to context variables in hooks.
 *
 * Hooks return the data directly (not wrapped in an object).
 * Context is passed as a parameter for read access.
 */
export interface DomainHooks<T, CreateInput, UpdateInput, DomainEnvVars extends Record<string, unknown> = Record<string, unknown>> {
  // Before-operation hooks (outside transaction, before validation)
  // Note: These run BEFORE any validation, receive raw input
  // Note: Can transform input, perform auth checks, or reject requests
  // Note: Throwing an exception aborts the operation before anything is written
  // Note: NO transaction parameter - runs outside transaction like after hooks
  beforeCreate?: (rawInput: unknown, context?: DomainHookContext<DomainEnvVars>) => Promise<unknown>;
  beforeUpdate?: (id: string, rawInput: unknown, context?: DomainHookContext<DomainEnvVars>) => Promise<unknown>;
  beforeDelete?: (id: string, context?: DomainHookContext<DomainEnvVars>) => Promise<void>;
  beforeFindById?: (id: string, context?: DomainHookContext<DomainEnvVars>) => Promise<string>;
  beforeFindMany?: (options: QueryOptions, context?: DomainHookContext<DomainEnvVars>) => Promise<QueryOptions>;

  // Pre-operation hooks (within transaction)
  // Note: Input is already validated before this hook is called
  // Note: Output will be validated before the main operation
  // Note: context contains all variables from your Env type
  // Note: rawInput contains the original unvalidated request body (use with caution)
  preCreate?: (input: CreateInput, rawInput: unknown, tx: DbTransaction, context?: DomainHookContext<DomainEnvVars>) => Promise<CreateInput>;
  preUpdate?: (id: string, input: UpdateInput, rawInput: unknown, tx: DbTransaction, context?: DomainHookContext<DomainEnvVars>) => Promise<UpdateInput>;
  preDelete?: (id: string, tx: DbTransaction, context?: DomainHookContext<DomainEnvVars>) => Promise<{ id: string }>;
  preFindById?: (id: string, tx?: DbTransaction, context?: DomainHookContext<DomainEnvVars>) => Promise<{ id: string }>;
  preFindMany?: (tx?: DbTransaction, options?: QueryOptions, context?: DomainHookContext<DomainEnvVars>) => Promise<QueryOptions>;

  // Post-operation hooks (within transaction)
  postCreate?: (input: CreateInput, result: T, rawInput: unknown, tx: DbTransaction, context?: DomainHookContext<DomainEnvVars>) => Promise<T>;
  postUpdate?: (id: string, input: UpdateInput, result: T, rawInput: unknown, tx: DbTransaction, context?: DomainHookContext<DomainEnvVars>) => Promise<T>;
  postDelete?: (id: string, result: T, tx: DbTransaction, context?: DomainHookContext<DomainEnvVars>) => Promise<T>;
  postFindById?: (id: string, result: T | null, tx?: DbTransaction, context?: DomainHookContext<DomainEnvVars>) => Promise<T | null>;
  postFindMany?: (options: QueryOptions, results: T[], tx?: DbTransaction, context?: DomainHookContext<DomainEnvVars>) => Promise<T[]>;

  // After-operation hooks (outside transaction, not awaited)
  // Note: Start once the transaction has committed - the outermost one, for a nested transaction
  // Note: A rollback drops them; a read without a transaction starts them right away
  // Note: Receive the same result the caller gets (sanitized unless skipSanitization is set)
  afterCreate?: (result: T, rawInput: unknown, context?: DomainHookContext<DomainEnvVars>) => Promise<void>;
  afterUpdate?: (result: T, rawInput: unknown, context?: DomainHookContext<DomainEnvVars>) => Promise<void>;
  afterDelete?: (result: T, context?: DomainHookContext<DomainEnvVars>) => Promise<void>;
  afterFindById?: (result: T | null, context?: DomainHookContext<DomainEnvVars>) => Promise<void>;
  afterFindMany?: (results: T[], context?: DomainHookContext<DomainEnvVars>) => Promise<void>;
}

/**
 * Junction table hooks for many-to-many relationship operations.
 * These hooks run at the domain layer within database transactions.
 * For batch operations (addMultiple, removeMultiple), the singular hooks are called for each item.
 *
 * The hook functions receive an object keyed by the junction table's foreign keys in camelCase.
 * For example, for a user_role table with user_id and role_id columns:
 * preAddJunction({ userId: '123', roleId: '456' }, rawInput, tx, context)
 *
 * The generic DomainEnvVars type allows you to specify your Env Variables type for type-safe
 * access to context variables in hooks.
 *
 * Hooks return the data directly (not wrapped in an object).
 * Context is passed as a parameter for read access.
 */
export interface JunctionTableHooks<DomainEnvVars extends Record<string, unknown> = Record<string, unknown>> {
  // Before-operation hooks (outside transaction, before validation)
  // Note: These run BEFORE any validation, receive raw input
  // Note: Throwing an exception aborts the operation before anything is written
  // Note: NO transaction parameter - runs outside transaction
  beforeAddJunction?: (ids: Record<string, string>, rawInput: unknown, context?: DomainHookContext<DomainEnvVars>) => Promise<Record<string, string>>;
  beforeRemoveJunction?: (ids: Record<string, string>, rawInput: unknown, context?: DomainHookContext<DomainEnvVars>) => Promise<Record<string, string>>;

  // Pre-operation hooks (within transaction)
  // Note: rawInput contains the original unvalidated request body (e.g., { ids: [...], metadata: {...} })
  preAddJunction?: (ids: Record<string, string>, rawInput: unknown, tx: DbTransaction, context?: DomainHookContext<DomainEnvVars>) => Promise<{ ids: Record<string, string> }>;
  preRemoveJunction?: (ids: Record<string, string>, rawInput: unknown, tx: DbTransaction, context?: DomainHookContext<DomainEnvVars>) => Promise<{ ids: Record<string, string> }>;

  // Post-operation hooks (within transaction)
  postAddJunction?: (ids: Record<string, string>, rawInput: unknown, tx: DbTransaction, context?: DomainHookContext<DomainEnvVars>) => Promise<void>;
  postRemoveJunction?: (ids: Record<string, string>, rawInput: unknown, tx: DbTransaction, context?: DomainHookContext<DomainEnvVars>) => Promise<void>;

  // After-operation hooks (outside transaction, not awaited)
  // Note: Start once the transaction has committed - the outermost one, for a nested transaction
  // Note: A rollback drops them
  afterAddJunction?: (ids: Record<string, string>, rawInput: unknown, context?: DomainHookContext<DomainEnvVars>) => Promise<void>;
  afterRemoveJunction?: (ids: Record<string, string>, rawInput: unknown, context?: DomainHookContext<DomainEnvVars>) => Promise<void>;
}
`;
  }

  /**
   * Generate domain API for a model
   */
  private generateModelDomainAPI(model: ModelDefinition): string {
    const modelName = model.name;
    const modelNameLower = model.name.toLowerCase();
    const primaryKeyField = model.fields.find((f) => f.primaryKey)?.name ||
      'id';

    // Check if we need additional imports for relationships
    const hasRelationships = model.relationships && model.relationships.length > 0;
    const hasManyToMany = model.relationships?.some((rel) => rel.type === 'manyToMany');

    // We need inArray for batch fetching in findMany when there are relationships
    // We need AnyColumn for orderBy type casting
    let drizzleImports = 'import { eq, desc, asc, sql, type AnyColumn';
    const needsAnd = hasManyToMany || !!model.softDelete;
    if (needsAnd) {
      drizzleImports += ', and';
    }
    if (hasManyToMany || hasRelationships) {
      drizzleImports += ', inArray';
    }
    if (model.softDelete) {
      drizzleImports += ', isNull';
    }
    drizzleImports += " } from 'drizzle-orm';";

    // Junction utility imports for many-to-many relationships
    const junctionUtilImports = hasManyToMany
      ? `import { addJunctionWithHooks, removeJunctionWithHooks, addManyJunctions, removeManyJunctions, setJunctions, hasJunction } from './junction.utils.ts';`
      : '';

    return `${drizzleImports}
import { InvalidFilterException, NotFoundException } from './exceptions.ts';
import { withoutTransaction, runAfterCommit, type DbTransaction } from '../db/database.ts';
import { ${modelNameLower}Table, type ${modelName}, type New${modelName}, ${modelNameLower}InsertSchema, ${modelNameLower}UpdateSchema, ${modelNameLower}FieldMeta } from '../schema/${modelNameLower}.schema.ts';
${this.generateRelationImports(model)}
${this.generateJunctionTableImports(model)}
import { DomainHooks, JunctionTableHooks, DomainHookContext, QueryOptions } from './hooks.types.ts';
import { buildWhereSQL, isWhereFilter, stripUnexposedFields, stripUnacceptedFields, validateFilter, type SQL } from '../utils/filter.utils.ts';
import { getExposedFields, getCreateUnexposedFields, getReadUnexposedFields, getCreateUnacceptedFields, getUpdateUnacceptedFields } from '../utils/field-meta.utils.ts';
${junctionUtilImports}

// Derive field arrays from metadata at module load
const ${modelNameLower}ExposedFields = getExposedFields(${modelNameLower}FieldMeta);
const ${modelNameLower}CreateUnexposedFields = getCreateUnexposedFields(${modelNameLower}FieldMeta);
const ${modelNameLower}ReadUnexposedFields = getReadUnexposedFields(${modelNameLower}FieldMeta);
const ${modelNameLower}CreateUnacceptedFields = getCreateUnacceptedFields(${modelNameLower}FieldMeta);
const ${modelNameLower}UpdateUnacceptedFields = getUpdateUnacceptedFields(${modelNameLower}FieldMeta);

export class ${modelName}Domain<DomainEnvVars extends Record<string, unknown> = Record<string, unknown>> {
  private hooks: DomainHooks<${modelName}, New${modelName}, Partial<New${modelName}>, DomainEnvVars>;
  ${this.generateJunctionHooksFields(model)}

  constructor(
    hooks?: DomainHooks<${modelName}, New${modelName}, Partial<New${modelName}>, DomainEnvVars>,
    ${this.generateJunctionHooksParams(model)}
  ) {
    this.hooks = hooks || {};
    ${this.generateJunctionHooksAssignments(model)}
  }

  /**
   * Create a new ${modelName}
   */
  async create(input: New${modelName}, tx: DbTransaction, options?: QueryOptions, context?: DomainHookContext<DomainEnvVars>): Promise<${modelName}> {
    // Strip unaccepted fields from input (before any hooks)
    const strippedInput = stripUnacceptedFields(input as unknown as Record<string, unknown>, ${modelNameLower}CreateUnacceptedFields);

    // Before-create hook (outside transaction, before validation)
    // Hook can inject server-managed fields that were stripped
    let transformedInput: unknown = strippedInput;
    if (this.hooks.beforeCreate) {
      transformedInput = await this.hooks.beforeCreate(strippedInput, context);
    }

    // Validate input before pre-hook
    const validatedInput = ${modelNameLower}InsertSchema.parse(transformedInput) as New${modelName};

    // Pre-create hook (within transaction)
    let processedInput = validatedInput;
    if (this.hooks.preCreate) {
      processedInput = await this.hooks.preCreate(validatedInput, input, tx, context);
      // Validate pre-hook output to ensure it didn't emit malformed data
      processedInput = ${modelNameLower}InsertSchema.parse(processedInput) as New${modelName};
    }

    // Unaccepted fields (timestamps) already stripped via stripUnacceptedFields

    // Perform create operation
    const [created] = await tx
      .insert(${modelNameLower}Table)
      .values(processedInput as New${modelName})
      .returning();

    // Post-create hook (within transaction)
    let result = created;
    if (this.hooks.postCreate) {
      result = await this.hooks.postCreate(processedInput, created, input, tx, context);
    }

    // Sanitize response (strip unexposed fields) unless skipped
    // For create, use CreateUnexposedFields (strips hidden only, keeps create-only visible)
    if (!options?.skipSanitization) {
      result = stripUnexposedFields(result, ${modelNameLower}CreateUnexposedFields) as ${modelName};
    }

    // After-create hook: starts once the transaction has committed, receives what the caller gets
    if (this.hooks.afterCreate) {
      const afterCreate = this.hooks.afterCreate;
      runAfterCommit(tx, () => afterCreate(result, input, context));
    }

    return result;
  }

  /**
   * Find ${modelName} by ID
   */
  async findById(id: string, tx?: DbTransaction, options?: QueryOptions, context?: DomainHookContext<DomainEnvVars>): Promise<${modelName} | null> {
    // Before-find-by-id hook (outside transaction)
    if (this.hooks.beforeFindById) {
      id = await this.hooks.beforeFindById(id, context);
    }

    // Use provided transaction or get database instance
    const db = tx || withoutTransaction();

    // Pre-find hook
    if (this.hooks.preFindById) {
      const preResult = await this.hooks.preFindById(id, tx, context);
      id = preResult.id;
    }

    // Build query
    const query = db
      .select()
      .from(${modelNameLower}Table)
      .where(${
      model.softDelete
        ? `options?.withSoftDeleted ? eq(${modelNameLower}Table.${primaryKeyField}, id) : and(eq(${modelNameLower}Table.${primaryKeyField}, id), isNull(${modelNameLower}Table.deletedAt))`
        : `eq(${modelNameLower}Table.${primaryKeyField}, id)`
    });

    const result = await query;
    const found = result[0] || null;

    // Add relationships if requested
    ${this.generateRelationshipIncludes(model)}

    // Post-find hook
    let finalResult: ${modelName} | null = found;
    if (this.hooks.postFindById && found !== null) {
      finalResult = await this.hooks.postFindById(id, found, tx, context);
    }

    // Sanitize response (strip unexposed fields) unless skipped
    if (finalResult && !options?.skipSanitization) {
      finalResult = stripUnexposedFields(finalResult, ${modelNameLower}ReadUnexposedFields) as ${modelName};
    }

    // After-find hook: starts once the transaction has committed, right away without one
    if (this.hooks.afterFindById) {
      const afterFindById = this.hooks.afterFindById;
      runAfterCommit(tx, () => afterFindById(finalResult, context));
    }

    return finalResult;
  }

  /**
   * Find all ${modelName}s with pagination and filtering
   */
  async findMany(
    tx?: DbTransaction,
    options: QueryOptions = {},
    context?: DomainHookContext<DomainEnvVars>,
  ): Promise<{ data: ${modelName}[]; total: number }> {
    // Convert WhereFilter to SQL first (so hooks receive SQL, not raw filter objects). A condition that
    // cannot be applied is refused: dropping it would widen the result.
    if (options.where && isWhereFilter(options.where)) {
      const validation = validateFilter(options.where, ${modelNameLower}FieldMeta);
      if (!validation.valid) {
        throw new InvalidFilterException(validation.error ?? 'Invalid filter');
      }
      options = {
        ...options,
        where: buildWhereSQL(options.where, ${modelNameLower}Table, ${modelNameLower}ExposedFields),
      };
    }

    // Before-find-many hook (outside transaction, receives SQL)
    if (this.hooks.beforeFindMany) {
      options = await this.hooks.beforeFindMany(options, context);
    }

    // Use provided transaction or get database instance
    const db = tx || withoutTransaction();

    // Pre-find hook
    if (this.hooks.preFindMany) {
      options = await this.hooks.preFindMany(tx, options, context);
    }

    // Extract whereSQL from options (already converted to SQL)
    ${
      model.softDelete
        ? `let whereSQL = options.where as SQL | undefined;
    if (!options?.withSoftDeleted) {
      whereSQL = whereSQL ? and(whereSQL, isNull(${modelNameLower}Table.deletedAt)) : isNull(${modelNameLower}Table.deletedAt);
    }`
        : `const whereSQL = options.where as SQL | undefined;`
    }

    // Build query with chaining to avoid type issues
    let baseQuery = db.select().from(${modelNameLower}Table);

    // Apply filters
    if (whereSQL) {
      baseQuery = baseQuery.where(whereSQL) as unknown as typeof baseQuery;
    }

    // Apply pagination from options
    if (options.orderBy) {
      const orderFn = options.orderDirection === 'desc' ? desc : asc;
      // Type-safe column access
      const column = ${modelNameLower}Table[options.orderBy as keyof typeof ${modelNameLower}Table] as AnyColumn;
      if (column) {
        baseQuery = baseQuery.orderBy(orderFn(column)) as unknown as typeof baseQuery;
      }
    }
    if (options.limit) {
      baseQuery = baseQuery.limit(options.limit) as unknown as typeof baseQuery;
    }
    if (options.offset) {
      baseQuery = baseQuery.offset(options.offset) as unknown as typeof baseQuery;
    }

    const query = baseQuery;

    // Execute query
    const results = await query;

    ${this.generateRelationshipIncludesForMany(model)}

    // Get total count (using the same whereSQL)
    const countQueryBase = db
      .select({ count: sql<number>\`count(*)\` })
      .from(${modelNameLower}Table);

    const countQuery = whereSQL
      ? countQueryBase.where(whereSQL)
      : countQueryBase;

    const [{ count }] = await countQuery;

    // Post-find hook
    let finalResults = this.hooks.postFindMany
      ? await this.hooks.postFindMany(options, results, tx, context)
      : results;

    // Sanitize response (strip unexposed fields) unless skipped
    if (!options.skipSanitization) {
      finalResults = stripUnexposedFields(finalResults, ${modelNameLower}ReadUnexposedFields) as ${modelName}[];
    }

    // After-find hook: starts once the transaction has committed, right away without one
    if (this.hooks.afterFindMany) {
      const afterFindMany = this.hooks.afterFindMany;
      runAfterCommit(tx, () => afterFindMany(finalResults, context));
    }

    return {
      data: finalResults,
      total: Number(count)
    };
  }

  /**
   * Update ${modelName}
   */
  async update(id: string, input: Partial<New${modelName}>, tx: DbTransaction, options?: QueryOptions, context?: DomainHookContext<DomainEnvVars>): Promise<${modelName}> {
    // Strip unaccepted fields from input (before any hooks)
    const strippedInput = stripUnacceptedFields(input as unknown as Record<string, unknown>, ${modelNameLower}UpdateUnacceptedFields);

    // Before-update hook (outside transaction, before validation)
    // Hook can inject server-managed fields that were stripped
    let transformedInput: unknown = strippedInput;
    if (this.hooks.beforeUpdate) {
      transformedInput = await this.hooks.beforeUpdate(id, strippedInput, context);
    }

    // Validate input before pre-hook (partial update)
    const validatedInput = ${modelNameLower}UpdateSchema.parse(transformedInput) as Partial<New${modelName}>;

    // Pre-update hook
    let processedInput = validatedInput;
    if (this.hooks.preUpdate) {
      processedInput = await this.hooks.preUpdate(id, validatedInput, input, tx, context);
      // Validate pre-hook output to ensure it didn't emit malformed data
      processedInput = ${modelNameLower}UpdateSchema.parse(processedInput) as Partial<New${modelName}>;
    }

    // Unaccepted fields (id, timestamps) already stripped via stripUnacceptedFields

    // Perform update
    const [updated] = await tx
      .update(${modelNameLower}Table)
      .set({
        ...processedInput,
        ${model.timestamps ? 'updatedAt: sql`(extract(epoch from now()) * 1000)::bigint`,' : ''}
      })
      .where(${
      model.softDelete
        ? `and(eq(${modelNameLower}Table.${primaryKeyField}, id), isNull(${modelNameLower}Table.deletedAt))`
        : `eq(${modelNameLower}Table.${primaryKeyField}, id)`
    })
      .returning();

    if (!updated) {
      throw new NotFoundException(\`${modelName} with id \${id} not found\`);
    }

    // Post-update hook
    let result = updated;
    if (this.hooks.postUpdate) {
      result = await this.hooks.postUpdate(id, processedInput, updated, input, tx, context);
    }

    // Sanitize response (strip unexposed fields) unless skipped
    if (!options?.skipSanitization) {
      result = stripUnexposedFields(result, ${modelNameLower}ReadUnexposedFields) as ${modelName};
    }

    // After-update hook: starts once the transaction has committed, receives what the caller gets
    if (this.hooks.afterUpdate) {
      const afterUpdate = this.hooks.afterUpdate;
      runAfterCommit(tx, () => afterUpdate(result, input, context));
    }

    return result;
  }

  /**
   * Delete ${modelName}
   */
  async delete(id: string, tx: DbTransaction, options?: QueryOptions, context?: DomainHookContext<DomainEnvVars>): Promise<${modelName}> {
    // Before-delete hook (outside transaction)
    if (this.hooks.beforeDelete) {
      await this.hooks.beforeDelete(id, context);
    }

    // Pre-delete hook
    if (this.hooks.preDelete) {
      const preResult = await this.hooks.preDelete(id, tx, context);
      id = preResult.id;
    }

    // Perform delete
    ${this.generateDeleteStatement(model, 'tx')}

    if (!deleted) {
      throw new NotFoundException(\`${modelName} with id \${id} not found\`);
    }

    // Post-delete hook
    let result = deleted;
    if (this.hooks.postDelete) {
      result = await this.hooks.postDelete(id, deleted, tx, context);
    }

    // Sanitize response (strip unexposed fields) unless skipped
    if (!options?.skipSanitization) {
      result = stripUnexposedFields(result, ${modelNameLower}ReadUnexposedFields) as ${modelName};
    }

    // After-delete hook: starts once the transaction has committed, receives what the caller gets
    if (this.hooks.afterDelete) {
      const afterDelete = this.hooks.afterDelete;
      runAfterCommit(tx, () => afterDelete(result, context));
    }

    return result;
  }

  ${this.generateRelationshipMethods(model)}
}

// Export singleton instance (uses default Record<string, unknown> for EnvVars)
export const ${modelNameLower}Domain = new ${modelName}Domain();
`;
  }

  /**
   * Generate junction table imports for many-to-many relationships
   */
  private generateJunctionTableImports(model: ModelDefinition): string {
    if (!model.relationships || model.relationships.length === 0) {
      return '';
    }

    const imports: string[] = [];
    const addedImports = new Set<string>();

    for (const rel of model.relationships) {
      // Add junction table insert type imports for manyToMany relationships
      if (rel.type === 'manyToMany' && rel.through && !addedImports.has(rel.through)) {
        const junctionTableName = rel.through.toLowerCase();
        // Type name matches schema export: User_spaces (capitalize first part only)
        const parts = rel.through.split('_');
        const junctionTypeName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + '_' + parts.slice(1).join('_');
        imports.push(
          `import { type New${junctionTypeName} } from '../schema/${junctionTableName}.schema.ts';`,
        );
        addedImports.add(rel.through);
      }
    }

    return imports.length > 0 ? imports.join('\n') : '';
  }

  /**
   * Generate relation imports (schema tables and domain instances)
   */
  private generateRelationImports(model: ModelDefinition): string {
    if (!model.relationships || model.relationships.length === 0) {
      return '';
    }

    const schemaImports: string[] = [];
    const domainImports: string[] = [];
    const addedSchemaImports = new Set<string>();
    const addedDomainImports = new Set<string>();

    for (const rel of model.relationships) {
      // Junction tables of many-to-many relationships
      if (rel.type === 'manyToMany' && rel.through && !addedSchemaImports.has(rel.through)) {
        schemaImports.push(
          `import { ${rel.through.toLowerCase()}Table } from '../schema/${rel.through.toLowerCase()}.schema.ts';`,
        );
        addedSchemaImports.add(rel.through);
      }

      // Target table for the SQL conditions of relation includes, and target type for the many-to-many
      // get* methods; a self-reference uses this model's own table and type
      if (rel.target !== model.name && !addedSchemaImports.has(rel.target)) {
        schemaImports.push(
          `import { ${rel.target.toLowerCase()}Table, type ${rel.target} } from '../schema/${rel.target.toLowerCase()}.schema.ts';`,
        );
        addedSchemaImports.add(rel.target);
      }

      // Domain imports for related entities (skip self-referential - will use this.findById/findMany)
      if (rel.target !== model.name && !addedDomainImports.has(rel.target)) {
        domainImports.push(
          `import { ${rel.target.toLowerCase()}Domain } from './${rel.target.toLowerCase()}.domain.ts';`,
        );
        addedDomainImports.add(rel.target);
      }
    }

    return [...schemaImports, ...domainImports].join('\n');
  }

  /**
   * Generate relationship includes using domain methods
   */
  private generateRelationshipIncludes(model: ModelDefinition): string {
    if (!model.relationships || model.relationships.length === 0) {
      return '// No relationships to include';
    }

    // const modelNameLower = model.name.toLowerCase();

    // Generate the include logic for relationships
    let code = '\n    // Handle relationship includes\n';
    code += '    if (options?.include && options.include.length > 0 && found) {\n';

    for (const rel of model.relationships) {
      const targetDomain = rel.target === model.name
        ? 'this' // Self-referential
        : `${rel.target.toLowerCase()}Domain`;
      // Relation includes filter the target with SQL, which does not depend on field exposure
      const targetTable = `${(rel.target === model.name ? model.name : rel.target).toLowerCase()}Table`;

      code += `        if (options.include.includes('${rel.name}')) {\n`;

      if (rel.type === 'manyToOne') {
        // For manyToOne, fetch the single related entity via domain
        const foreignKey = rel.foreignKey || rel.target.toLowerCase() + 'Id';
        code += `          // Load ${rel.name} (manyToOne) via domain\n`;
        code += `          if (found.${foreignKey}) {\n`;
        code +=
          `            const ${rel.name} = await ${targetDomain}.findById(found.${foreignKey}, tx, { skipSanitization: options.skipSanitization }, context);\n`;
        code += `            (found as unknown as Record<string, unknown>).${rel.name} = ${rel.name};\n`;
        code += `          } else {\n`;
        code += `            (found as unknown as Record<string, unknown>).${rel.name} = null;\n`;
        code += `          }\n`;
      } else if (rel.type === 'oneToMany') {
        // For oneToMany, fetch the array of related entities via domain
        const foreignKey = rel.foreignKey || model.name.toLowerCase() + 'Id';
        code += `          // Load ${rel.name} (oneToMany) via domain\n`;
        code += `          const { data: ${rel.name} } = await ${targetDomain}.findMany(tx, {\n`;
        code += `            where: eq(${targetTable}.${foreignKey}, id),\n`;
        code += `            skipSanitization: options.skipSanitization\n`;
        code += `          }, context);\n`;
        code += `          (found as unknown as Record<string, unknown>).${rel.name} = ${rel.name};\n`;
      } else if (rel.type === 'manyToMany' && rel.through) {
        // For manyToMany, get IDs from junction table then fetch via domain
        const junctionTable = rel.through.toLowerCase();
        const sourceFK = rel.foreignKey || toSnakeCase(model.name) + '_id';
        const targetFK = rel.targetForeignKey || toSnakeCase(rel.target) + '_id';
        code += `          // Load ${rel.name} (manyToMany) via domain\n`;
        code += `          const ${rel.name}JunctionData = await db\n`;
        code += `            .select({ targetId: ${junctionTable}Table.${targetFK} })\n`;
        code += `            .from(${junctionTable}Table)\n`;
        code += `            .where(eq(${junctionTable}Table.${sourceFK}, id));\n`;
        code += `          const ${rel.name}TargetIds = ${rel.name}JunctionData.map(j => j.targetId);\n`;
        code += `          if (${rel.name}TargetIds.length > 0) {\n`;
        code += `            const { data: ${rel.name} } = await ${targetDomain}.findMany(tx, {\n`;
        code += `              where: inArray(${targetTable}.id, ${rel.name}TargetIds),\n`;
        code += `              skipSanitization: options.skipSanitization\n`;
        code += `            }, context);\n`;
        code += `            (found as unknown as Record<string, unknown>).${rel.name} = ${rel.name};\n`;
        code += `          } else {\n`;
        code += `            (found as unknown as Record<string, unknown>).${rel.name} = [];\n`;
        code += `          }\n`;
      } else if (rel.type === 'oneToOne') {
        // For oneToOne, check if foreign key is on this model
        const hasFK = model.fields.some((f) => f.name === rel.foreignKey);
        if (hasFK) {
          // Foreign key is on this model, fetch the related entity via domain
          const foreignKey = rel.foreignKey!;
          code += `          // Load ${rel.name} (oneToOne - owned) via domain\n`;
          code += `          if (found.${foreignKey}) {\n`;
          code +=
            `            const ${rel.name} = await ${targetDomain}.findById(found.${foreignKey}, tx, { skipSanitization: options.skipSanitization }, context);\n`;
          code += `            (found as unknown as Record<string, unknown>).${rel.name} = ${rel.name};\n`;
          code += `          } else {\n`;
          code += `            (found as unknown as Record<string, unknown>).${rel.name} = null;\n`;
          code += `          }\n`;
        } else {
          // Foreign key is on the target model, fetch the related entity via domain
          const foreignKey = rel.foreignKey || model.name.toLowerCase() + 'Id';
          code += `          // Load ${rel.name} (oneToOne - inverse) via domain\n`;
          code += `          const { data: ${rel.name}List } = await ${targetDomain}.findMany(tx, {\n`;
          code += `            where: eq(${targetTable}.${foreignKey}, id),\n`;
          code += `            limit: 1,\n`;
          code += `            skipSanitization: options.skipSanitization\n`;
          code += `          }, context);\n`;
          code += `          (found as unknown as Record<string, unknown>).${rel.name} = ${rel.name}List[0] || null;\n`;
        }
      }

      code += `        }\n`;
    }

    code += '    }';

    return code;
  }

  /**
   * Generate relationship includes for findMany using domain methods
   */
  private generateRelationshipIncludesForMany(model: ModelDefinition): string {
    if (!model.relationships || model.relationships.length === 0) {
      return '// No relationships to include';
    }

    // Generate the include logic for relationships in findMany
    let code = '// Handle relationship includes for multiple results\n';
    code += '    if (options?.include && options.include.length > 0 && results.length > 0) {\n';

    for (const rel of model.relationships) {
      const targetDomain = rel.target === model.name
        ? 'this' // Self-referential
        : `${rel.target.toLowerCase()}Domain`;
      // Relation includes filter the target with SQL, which does not depend on field exposure
      const targetTable = `${(rel.target === model.name ? model.name : rel.target).toLowerCase()}Table`;

      code += `      if (options.include.includes('${rel.name}')) {\n`;

      if (rel.type === 'manyToOne') {
        // For manyToOne, batch fetch related entities via domain
        const foreignKey = rel.foreignKey || rel.target.toLowerCase() + 'Id';
        code += `        // Load ${rel.name} (manyToOne) for all results via domain\n`;
        code +=
          `        const ${rel.name}Ids = [...new Set(results.map(r => r.${foreignKey}).filter(id => id !== null && id !== undefined))] as string[];\n`;
        code += `        if (${rel.name}Ids.length > 0) {\n`;
        code += `          const { data: ${rel.name}Data } = await ${targetDomain}.findMany(tx, {\n`;
        code += `            where: inArray(${targetTable}.id, ${rel.name}Ids),\n`;
        code += `            skipSanitization: options.skipSanitization\n`;
        code += `          }, context);\n`;
        code += `          const ${rel.name}Map = new Map(${rel.name}Data.map(item => [item.id, item]));\n`;
        code += `          results.forEach(result => {\n`;
        code +=
          `            (result as unknown as Record<string, unknown>).${rel.name} = result.${foreignKey} ? ${rel.name}Map.get(result.${foreignKey}) || null : null;\n`;
        code += `          });\n`;
        code += `        } else {\n`;
        code += `          results.forEach(result => {\n`;
        code += `            (result as unknown as Record<string, unknown>).${rel.name} = null;\n`;
        code += `          });\n`;
        code += `        }\n`;
      } else if (rel.type === 'oneToMany') {
        // For oneToMany, batch fetch all related entities via domain
        const foreignKey = rel.foreignKey || model.name.toLowerCase() + 'Id';
        code += `        // Load ${rel.name} (oneToMany) for all results via domain\n`;
        code += `        const resultIds = results.map(r => r.id);\n`;
        code += `        const { data: ${rel.name}Data } = await ${targetDomain}.findMany(tx, {\n`;
        code += `          where: inArray(${targetTable}.${foreignKey}, resultIds),\n`;
        code += `          skipSanitization: options.skipSanitization\n`;
        code += `        }, context);\n`;
        code += `        const ${rel.name}Map = new Map<string, unknown[]>();\n`;
        code += `        resultIds.forEach(id => ${rel.name}Map.set(id, []));\n`;
        code += `        ${rel.name}Data.forEach(item => {\n`;
        code += `          const fkValue = (item as unknown as Record<string, unknown>).${foreignKey} as string;\n`;
        code += `          if (fkValue) {\n`;
        code += `            const list = ${rel.name}Map.get(fkValue);\n`;
        code += `            if (list) list.push(item);\n`;
        code += `          }\n`;
        code += `        });\n`;
        code += `        results.forEach(result => {\n`;
        code +=
          `          (result as unknown as Record<string, unknown>).${rel.name} = ${rel.name}Map.get(result.id) || [];\n`;
        code += `        });\n`;
      } else if (rel.type === 'manyToMany' && rel.through) {
        // For manyToMany, get IDs from junction table then batch fetch via domain
        const junctionTable = rel.through.toLowerCase();
        const sourceFK = rel.foreignKey || toSnakeCase(model.name) + '_id';
        const targetFK = rel.targetForeignKey || toSnakeCase(rel.target) + '_id';
        code += `        // Load ${rel.name} (manyToMany) for all results via domain\n`;
        code += `        const resultIds = results.map(r => r.id);\n`;
        code += `        const ${rel.name}JunctionData = await db\n`;
        code +=
          `          .select({ sourceId: ${junctionTable}Table.${sourceFK}, targetId: ${junctionTable}Table.${targetFK} })\n`;
        code += `          .from(${junctionTable}Table)\n`;
        code += `          .where(inArray(${junctionTable}Table.${sourceFK}, resultIds));\n`;
        code += `        const ${rel.name}TargetIds = [...new Set(${rel.name}JunctionData.map(j => j.targetId))];\n`;
        code += `        if (${rel.name}TargetIds.length > 0) {\n`;
        code += `          const { data: ${rel.name}Data } = await ${targetDomain}.findMany(tx, {\n`;
        code += `            where: inArray(${targetTable}.id, ${rel.name}TargetIds),\n`;
        code += `            skipSanitization: options.skipSanitization\n`;
        code += `          }, context);\n`;
        code += `          const ${rel.name}EntityMap = new Map(${rel.name}Data.map(item => [item.id, item]));\n`;
        code += `          const ${rel.name}Map = new Map<string, unknown[]>();\n`;
        code += `          resultIds.forEach(id => ${rel.name}Map.set(id, []));\n`;
        code += `          ${rel.name}JunctionData.forEach(j => {\n`;
        code += `            const entity = ${rel.name}EntityMap.get(j.targetId);\n`;
        code += `            if (entity) {\n`;
        code += `              const list = ${rel.name}Map.get(j.sourceId);\n`;
        code += `              if (list) list.push(entity);\n`;
        code += `            }\n`;
        code += `          });\n`;
        code += `          results.forEach(result => {\n`;
        code +=
          `            (result as unknown as Record<string, unknown>).${rel.name} = ${rel.name}Map.get(result.id) || [];\n`;
        code += `          });\n`;
        code += `        } else {\n`;
        code += `          results.forEach(result => {\n`;
        code += `            (result as unknown as Record<string, unknown>).${rel.name} = [];\n`;
        code += `          });\n`;
        code += `        }\n`;
      } else if (rel.type === 'oneToOne') {
        // For oneToOne, batch fetch related entities via domain
        const hasFK = model.fields.some((f) => f.name === rel.foreignKey);
        if (hasFK) {
          // Foreign key is on this model
          const foreignKey = rel.foreignKey!;
          code += `        // Load ${rel.name} (oneToOne - owned) for all results via domain\n`;
          code +=
            `        const ${rel.name}Ids = [...new Set(results.map(r => r.${foreignKey}).filter(id => id !== null && id !== undefined))] as string[];\n`;
          code += `        if (${rel.name}Ids.length > 0) {\n`;
          code += `          const { data: ${rel.name}Data } = await ${targetDomain}.findMany(tx, {\n`;
          code += `            where: inArray(${targetTable}.id, ${rel.name}Ids),\n`;
          code += `            skipSanitization: options.skipSanitization\n`;
          code += `          }, context);\n`;
          code += `          const ${rel.name}Map = new Map(${rel.name}Data.map(item => [item.id, item]));\n`;
          code += `          results.forEach(result => {\n`;
          code +=
            `            (result as unknown as Record<string, unknown>).${rel.name} = result.${foreignKey} ? ${rel.name}Map.get(result.${foreignKey}) || null : null;\n`;
          code += `          });\n`;
          code += `        } else {\n`;
          code += `          results.forEach(result => {\n`;
          code += `            (result as unknown as Record<string, unknown>).${rel.name} = null;\n`;
          code += `          });\n`;
          code += `        }\n`;
        } else {
          // Foreign key is on the target model
          const foreignKey = rel.foreignKey || model.name.toLowerCase() + 'Id';
          code += `        // Load ${rel.name} (oneToOne - inverse) for all results via domain\n`;
          code += `        const resultIds = results.map(r => r.id);\n`;
          code += `        const { data: ${rel.name}Data } = await ${targetDomain}.findMany(tx, {\n`;
          code += `          where: inArray(${targetTable}.${foreignKey}, resultIds),\n`;
          code += `          skipSanitization: options.skipSanitization\n`;
          code += `        }, context);\n`;
          code += `        const ${rel.name}Map = new Map<string, unknown>();\n`;
          code += `        ${rel.name}Data.forEach(item => {\n`;
          code += `          const fkValue = (item as unknown as Record<string, unknown>).${foreignKey} as string;\n`;
          code += `          ${rel.name}Map.set(fkValue, item);\n`;
          code += `        });\n`;
          code += `        results.forEach(result => {\n`;
          code +=
            `          (result as unknown as Record<string, unknown>).${rel.name} = ${rel.name}Map.get(result.id) || null;\n`;
          code += `        });\n`;
        }
      }

      code += `      }\n`;
    }

    code += '    }\n';

    return code;
  }

  /**
   * Generate the delete statement: a soft-delete UPDATE when enabled,
   * otherwise a hard DELETE. Both bind `const [deleted]`.
   */
  private generateDeleteStatement(
    model: ModelDefinition,
    txVar: string = 'tx',
  ): string {
    const table = `${model.name.toLowerCase()}Table`;
    const pk = model.fields.find((f) => f.primaryKey)?.name || 'id';
    if (model.softDelete) {
      return `const [deleted] = await ${txVar}
      .update(${table})
      .set({ deletedAt: sql\`(extract(epoch from now()) * 1000)::bigint\` })
      .where(and(eq(${table}.${pk}, id), isNull(${table}.deletedAt)))
      .returning();`;
    }
    return `const [deleted] = await ${txVar}
      .delete(${table})
      .where(eq(${table}.${pk}, id))
      .returning();`;
  }

  /**
   * Generate relationship methods
   */
  private generateRelationshipMethods(model: ModelDefinition): string {
    if (!model.relationships || model.relationships.length === 0) {
      return '';
    }

    const methods: string[] = [];

    for (const rel of model.relationships) {
      if (rel.type === 'manyToMany' && rel.through) {
        // Generate manyToMany methods using junction utilities
        const targetName = rel.target;
        const targetNameLower = targetName.toLowerCase();
        const relName = rel.name;
        const RelName = capitalize(relName);
        const junctionTable = rel.through.toLowerCase();
        const sourceFK = rel.foreignKey || toSnakeCase(model.name) + '_id';
        const targetFK = rel.targetForeignKey || toSnakeCase(targetName) + '_id';

        // Derive singular form by removing "List" suffix if present
        const singularRelName = relName.endsWith('List') ? relName.slice(0, -4) : relName;
        const SingularRelName = capitalize(singularRelName);

        // Junction config object for this relationship
        const junctionConfigVar = `${relName}JunctionConfig`;
        // The targets are read through their own domain; a self-reference uses this one
        const targetDomain = rel.target === model.name ? 'this' : `${targetNameLower}Domain`;
        const targetTable = `${(rel.target === model.name ? model.name : rel.target).toLowerCase()}Table`;

        methods.push(`
  // Junction config for ${relName}
  private ${junctionConfigVar} = {
    junctionTable: ${junctionTable}Table,
    sourceColumn: '${sourceFK}' as const,
    targetColumn: '${targetFK}' as const,
    sourceIdKey: '${toCamelCase(sourceFK)}',
    targetIdKey: '${toCamelCase(targetFK)}',
  };

  /**
   * Get ${relName} for ${model.name}
   *
   * The ${model.name} is read through its own find hooks first and must be visible (NotFoundException
   * otherwise). The ${targetName} rows come through the ${targetName} domain, so its hooks run with the
   * same context, and its exposure and soft-delete rules apply.
   */
  async get${RelName}(
    id: string,
    tx?: DbTransaction,
    options?: QueryOptions,
    context?: DomainHookContext<DomainEnvVars>,
  ): Promise<Array<${targetName}>> {
    const parent = await this.findById(id, tx, {}, context);
    if (!parent) {
      throw new NotFoundException(\`${model.name} with id \${id} not found\`);
    }

    const junctionRows = await (tx || withoutTransaction())
      .select({ targetId: ${junctionTable}Table.${targetFK} })
      .from(${junctionTable}Table)
      .where(eq(${junctionTable}Table.${sourceFK}, id));
    const targetIds = junctionRows.map((row) => row.targetId);
    if (targetIds.length === 0) {
      return [];
    }

    const { data } = await ${targetDomain}.findMany(tx, {
      where: inArray(${targetTable}.id, targetIds),
      skipSanitization: options?.skipSanitization,
    }, context);
    return data;
  }

  /**
   * Add ${singularRelName} to ${model.name}
   */
  async add${SingularRelName}(id: string, ${targetNameLower}Id: string, rawInput: unknown, tx: DbTransaction, context?: DomainHookContext<DomainEnvVars>): Promise<void> {
    return await addJunctionWithHooks(
      this.${junctionConfigVar},
      id,
      ${targetNameLower}Id,
      rawInput,
      tx,
      this.${relName}JunctionHooks,
      context,
    );
  }

  /**
   * Add multiple ${relName} to ${model.name}
   */
  async add${RelName}(id: string, ${targetNameLower}Ids: string[], rawInput: unknown, tx: DbTransaction, context?: DomainHookContext<DomainEnvVars>): Promise<void> {
    return await addManyJunctions(
      this.${junctionConfigVar},
      id,
      ${targetNameLower}Ids,
      rawInput,
      tx,
      this.${relName}JunctionHooks,
      context,
    );
  }

  /**
   * Remove ${singularRelName} from ${model.name}
   */
  async remove${SingularRelName}(id: string, ${targetNameLower}Id: string, rawInput: unknown, tx: DbTransaction, context?: DomainHookContext<DomainEnvVars>): Promise<void> {
    return await removeJunctionWithHooks(
      this.${junctionConfigVar},
      id,
      ${targetNameLower}Id,
      rawInput,
      tx,
      this.${relName}JunctionHooks,
      context,
    );
  }

  /**
   * Remove multiple ${relName} from ${model.name}
   */
  async remove${RelName}(id: string, ${targetNameLower}Ids: string[], rawInput: unknown, tx: DbTransaction, context?: DomainHookContext<DomainEnvVars>): Promise<void> {
    return await removeManyJunctions(
      this.${junctionConfigVar},
      id,
      ${targetNameLower}Ids,
      rawInput,
      tx,
      this.${relName}JunctionHooks,
      context,
    );
  }

  /**
   * Set ${relName} for ${model.name} (replace all)
   */
  async set${RelName}(id: string, ${targetNameLower}Ids: string[], rawInput: unknown, tx: DbTransaction, context?: DomainHookContext<DomainEnvVars>): Promise<void> {
    return await setJunctions(
      this.${junctionConfigVar},
      id,
      ${targetNameLower}Ids,
      rawInput,
      tx,
      this.${relName}JunctionHooks,
      context,
    );
  }

  /**
   * Check if ${model.name} has a specific ${singularRelName}
   */
  async has${SingularRelName}(id: string, ${targetNameLower}Id: string, tx?: DbTransaction): Promise<boolean> {
    return await hasJunction(
      this.${junctionConfigVar},
      id,
      ${targetNameLower}Id,
      tx,
    );
  }`);
      }
    }

    return methods.join('\n');
  }

  /**
   * Generate domain index file
   */
  private generateDomainIndex(): string {
    let code = '// Export all domain APIs\n';

    for (const model of this.models) {
      code += `export * from './${model.name.toLowerCase()}.domain.ts';\n`;
    }

    code += `export * from './hooks.types.ts';\n`;
    code += `export * from './exceptions.ts';\n`;

    return code;
  }

  /**
   * Get TypeScript type for a field
   */
  private getTypeScriptType(fieldType: string, field?: FieldDefinition): string {
    // If it's an enum field with values, generate union type
    if (fieldType === 'enum' && field) {
      if (field.enumValues && field.enumValues.length > 0) {
        return field.enumValues.map((v) => `"${v}"`).join(' | ');
      }
    }

    const typeMap: Record<string, string> = {
      'text': 'string',
      'string': 'string',
      'integer': 'number',
      'bigint': 'number',
      'decimal': 'number',
      'boolean': 'boolean',
      'date': 'number',
      'uuid': 'string',
      'json': 'unknown',
      'jsonb': 'unknown',
      'enum': 'string',
      // PostGIS types
      'point': 'unknown',
      'linestring': 'unknown',
      'polygon': 'unknown',
      'multipoint': 'unknown',
      'multilinestring': 'unknown',
      'multipolygon': 'unknown',
      'geometry': 'unknown',
      'geography': 'unknown',
    };
    return typeMap[fieldType] || 'unknown';
  }

  /**
   * Generate junction hooks fields for domain class
   */
  private generateJunctionHooksFields(model: ModelDefinition): string {
    const manyToManyRels = model.relationships?.filter((rel) => rel.type === 'manyToMany') || [];
    if (manyToManyRels.length === 0) return '';

    const fields = manyToManyRels.map((rel) => {
      const relName = rel.name;
      return `private ${relName}JunctionHooks: JunctionTableHooks<DomainEnvVars>;`;
    });

    return fields.join('\n  ');
  }

  /**
   * Generate junction hooks constructor parameters
   */
  private generateJunctionHooksParams(model: ModelDefinition): string {
    const manyToManyRels = model.relationships?.filter((rel) => rel.type === 'manyToMany') || [];
    if (manyToManyRels.length === 0) return '';

    const params = manyToManyRels.map((rel) => {
      const relName = rel.name;
      return `${relName}JunctionHooks?: JunctionTableHooks<DomainEnvVars>`;
    });

    return params.join(',\n    ');
  }

  /**
   * Generate junction hooks assignments in constructor
   */
  private generateJunctionHooksAssignments(model: ModelDefinition): string {
    const manyToManyRels = model.relationships?.filter((rel) => rel.type === 'manyToMany') || [];
    if (manyToManyRels.length === 0) return '';

    const assignments = manyToManyRels.map((rel) => {
      const relName = rel.name;
      return `this.${relName}JunctionHooks = ${relName}JunctionHooks || {};`;
    });

    return assignments.join('\n    ');
  }
}
