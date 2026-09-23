/**
 * Generates shared junction table utilities for many-to-many relationships
 */
export class JunctionUtilsGenerator {
  /**
   * Generate junction utilities file
   */
  generate(): string {
    return `import { eq, and, sql, isNull } from 'drizzle-orm';
import type { PgTable, TableConfig } from 'drizzle-orm/pg-core';
import { withoutTransaction, runAfterCommit, type DbTransaction } from '../db/database.ts';
import type { JunctionTableHooks, DomainHookContext } from './hooks.types.ts';

/**
 * Configuration for junction table operations
 */
export interface JunctionConfig<
  TJunctionTable extends PgTable<TableConfig>,
  TTargetTable extends PgTable<TableConfig>,
  TTarget,
> {
  /** The junction table */
  junctionTable: TJunctionTable;
  /** The target entity table */
  targetTable: TTargetTable;
  /** Column name for source entity FK in junction table */
  sourceColumn: keyof TJunctionTable['_']['columns'];
  /** Column name for target entity FK in junction table */
  targetColumn: keyof TJunctionTable['_']['columns'];
  /** Key name for source ID in hook ids object (camelCase) */
  sourceIdKey: string;
  /** Key name for target ID in hook ids object (camelCase) */
  targetIdKey: string;
}

/**
 * Execute add junction operation with full hook lifecycle
 */
export const addJunctionWithHooks = async <
  TJunctionTable extends PgTable<TableConfig>,
  DomainEnvVars extends Record<string, unknown> = Record<string, unknown>,
>(
  config: {
    junctionTable: TJunctionTable;
    sourceColumn: keyof TJunctionTable['_']['columns'];
    targetColumn: keyof TJunctionTable['_']['columns'];
    sourceIdKey: string;
    targetIdKey: string;
  },
  sourceId: string,
  targetId: string,
  rawInput: unknown,
  tx: DbTransaction,
  hooks: JunctionTableHooks<DomainEnvVars>,
  context?: DomainHookContext<DomainEnvVars>,
): Promise<void> => {
  // Before-add hook (outside transaction, before validation)
  let ids: Record<string, string> = {
    [config.sourceIdKey]: sourceId,
    [config.targetIdKey]: targetId,
  };

  if (hooks.beforeAddJunction) {
    ids = await hooks.beforeAddJunction(ids, rawInput, context);
  }

  // Pre-add hook
  if (hooks.preAddJunction) {
    const preResult = await hooks.preAddJunction(ids, rawInput, tx, context);
    ids = preResult.ids as typeof ids;
  }

  // Perform add operation
  const insertValues = {
    [config.sourceColumn as string]: ids[config.sourceIdKey],
    [config.targetColumn as string]: ids[config.targetIdKey],
  };
  await tx.insert(config.junctionTable).values(insertValues as never);

  // Post-add hook
  if (hooks.postAddJunction) {
    await hooks.postAddJunction(ids, rawInput, tx, context);
  }

  // After-add hook: starts once the transaction has committed
  if (hooks.afterAddJunction) {
    const afterAddJunction = hooks.afterAddJunction;
    runAfterCommit(tx, () => afterAddJunction(ids, rawInput, context));
  }
};

/**
 * Execute remove junction operation with full hook lifecycle
 */
export const removeJunctionWithHooks = async <
  TJunctionTable extends PgTable<TableConfig>,
  DomainEnvVars extends Record<string, unknown> = Record<string, unknown>,
>(
  config: {
    junctionTable: TJunctionTable;
    sourceColumn: keyof TJunctionTable['_']['columns'];
    targetColumn: keyof TJunctionTable['_']['columns'];
    sourceIdKey: string;
    targetIdKey: string;
  },
  sourceId: string,
  targetId: string,
  rawInput: unknown,
  tx: DbTransaction,
  hooks: JunctionTableHooks<DomainEnvVars>,
  context?: DomainHookContext<DomainEnvVars>,
): Promise<void> => {
  // Before-remove hook (outside transaction, before validation)
  let ids: Record<string, string> = {
    [config.sourceIdKey]: sourceId,
    [config.targetIdKey]: targetId,
  };

  if (hooks.beforeRemoveJunction) {
    ids = await hooks.beforeRemoveJunction(ids, rawInput, context);
  }

  // Pre-remove hook
  if (hooks.preRemoveJunction) {
    const preResult = await hooks.preRemoveJunction(ids, rawInput, tx, context);
    ids = preResult.ids as typeof ids;
  }

  // Perform remove operation
  const sourceCol = config.junctionTable[config.sourceColumn as keyof typeof config.junctionTable] as unknown;
  const targetCol = config.junctionTable[config.targetColumn as keyof typeof config.junctionTable] as unknown;

  await tx.delete(config.junctionTable).where(
    and(
      eq(sourceCol as never, ids[config.sourceIdKey]),
      eq(targetCol as never, ids[config.targetIdKey]),
    ),
  );

  // Post-remove hook
  if (hooks.postRemoveJunction) {
    await hooks.postRemoveJunction(ids, rawInput, tx, context);
  }

  // After-remove hook: starts once the transaction has committed
  if (hooks.afterRemoveJunction) {
    const afterRemoveJunction = hooks.afterRemoveJunction;
    runAfterCommit(tx, () => afterRemoveJunction(ids, rawInput, context));
  }
};

/**
 * Add multiple junction records (calls singular add for each to trigger hooks)
 */
export const addManyJunctions = async <
  TJunctionTable extends PgTable<TableConfig>,
  DomainEnvVars extends Record<string, unknown> = Record<string, unknown>,
>(
  config: {
    junctionTable: TJunctionTable;
    sourceColumn: keyof TJunctionTable['_']['columns'];
    targetColumn: keyof TJunctionTable['_']['columns'];
    sourceIdKey: string;
    targetIdKey: string;
  },
  sourceId: string,
  targetIds: string[],
  rawInput: unknown,
  tx: DbTransaction,
  hooks: JunctionTableHooks<DomainEnvVars>,
  context?: DomainHookContext<DomainEnvVars>,
): Promise<void> => {
  if (targetIds.length === 0) return;

  for (const targetId of targetIds) {
    await addJunctionWithHooks(config, sourceId, targetId, rawInput, tx, hooks, context);
  }
};

/**
 * Remove multiple junction records (calls singular remove for each to trigger hooks)
 */
export const removeManyJunctions = async <
  TJunctionTable extends PgTable<TableConfig>,
  DomainEnvVars extends Record<string, unknown> = Record<string, unknown>,
>(
  config: {
    junctionTable: TJunctionTable;
    sourceColumn: keyof TJunctionTable['_']['columns'];
    targetColumn: keyof TJunctionTable['_']['columns'];
    sourceIdKey: string;
    targetIdKey: string;
  },
  sourceId: string,
  targetIds: string[],
  rawInput: unknown,
  tx: DbTransaction,
  hooks: JunctionTableHooks<DomainEnvVars>,
  context?: DomainHookContext<DomainEnvVars>,
): Promise<void> => {
  if (targetIds.length === 0) return;

  for (const targetId of targetIds) {
    await removeJunctionWithHooks(config, sourceId, targetId, rawInput, tx, hooks, context);
  }
};

/**
 * Replace all junction records for a source entity
 */
export const setJunctions = async <
  TJunctionTable extends PgTable<TableConfig>,
  DomainEnvVars extends Record<string, unknown> = Record<string, unknown>,
>(
  config: {
    junctionTable: TJunctionTable;
    sourceColumn: keyof TJunctionTable['_']['columns'];
    targetColumn: keyof TJunctionTable['_']['columns'];
    sourceIdKey: string;
    targetIdKey: string;
  },
  sourceId: string,
  targetIds: string[],
  rawInput: unknown,
  tx: DbTransaction,
  hooks: JunctionTableHooks<DomainEnvVars>,
  context?: DomainHookContext<DomainEnvVars>,
): Promise<void> => {
  // Delete all existing relationships
  const sourceCol = config.junctionTable[config.sourceColumn as keyof typeof config.junctionTable] as unknown;
  await tx.delete(config.junctionTable).where(eq(sourceCol as never, sourceId));

  // Add new relationships (hooks will be called for each item)
  if (targetIds.length > 0) {
    await addManyJunctions(config, sourceId, targetIds, rawInput, tx, hooks, context);
  }
};

/**
 * Get related entities via junction table
 */
export const getJunctionTargets = async <
  TJunctionTable extends PgTable<TableConfig>,
  TTargetTable extends PgTable<TableConfig>,
  TTarget,
>(
  config: {
    junctionTable: TJunctionTable;
    targetTable: TTargetTable;
    sourceColumn: keyof TJunctionTable['_']['columns'];
    targetColumn: keyof TJunctionTable['_']['columns'];
    /** SQL table name of the target — the key drizzle uses for it in join-result rows */
    targetTableName: string;
    /** When true, excludes soft-deleted rows from the target table */
    targetHasSoftDelete?: boolean;
  },
  sourceId: string,
  tx?: DbTransaction,
): Promise<TTarget[]> => {
  const db = tx || withoutTransaction();

  const sourceCol = config.junctionTable[config.sourceColumn as keyof typeof config.junctionTable] as unknown;
  const targetCol = config.junctionTable[config.targetColumn as keyof typeof config.junctionTable] as unknown;
  const targetId = config.targetTable['id' as keyof typeof config.targetTable] as unknown;

  const liveCondition = config.targetHasSoftDelete
    ? and(
      eq(sourceCol as never, sourceId),
      isNull(config.targetTable['deletedAt' as keyof typeof config.targetTable] as never),
    )
    : eq(sourceCol as never, sourceId);

  const result = await db
    .select()
    .from(config.junctionTable as never)
    .innerJoin(config.targetTable as never, eq(targetCol as never, targetId as never))
    .where(liveCondition as never);

  return result.map((r) => r[config.targetTableName as keyof typeof r] as TTarget);
};

/**
 * Check if a junction record exists
 */
export const hasJunction = async <TJunctionTable extends PgTable<TableConfig>>(
  config: {
    junctionTable: TJunctionTable;
    sourceColumn: keyof TJunctionTable['_']['columns'];
    targetColumn: keyof TJunctionTable['_']['columns'];
  },
  sourceId: string,
  targetId: string,
  tx?: DbTransaction,
): Promise<boolean> => {
  const db = tx || withoutTransaction();

  const sourceCol = config.junctionTable[config.sourceColumn as keyof typeof config.junctionTable] as unknown;
  const targetCol = config.junctionTable[config.targetColumn as keyof typeof config.junctionTable] as unknown;

  const result = await db
    .select({ count: sql<number>\`count(*)\` })
    .from(config.junctionTable as never)
    .where(and(eq(sourceCol as never, sourceId), eq(targetCol as never, targetId))) as { count: number }[];

  return result[0].count > 0;
};
`;
  }
}
