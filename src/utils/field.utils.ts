/**
 * Shared field utility functions for code generators
 */

import { AcceptType, ExposeType, ModelDefinition } from '../types/model.types.ts';
import { isPostGISType } from '../constants.ts';

/**
 * Normalize expose config to a consistent object format
 * Handles string enum values: "default", "hidden", "create"
 */
export const normalizeExpose = (expose?: ExposeType): { create: boolean; read: boolean } => {
  if (expose === undefined || expose === 'default') {
    return { create: true, read: true };
  }
  if (expose === 'hidden') {
    return { create: false, read: false };
  }
  if (expose === 'create') {
    return { create: true, read: false };
  }
  // fallback (should never happen with proper validation)
  return { create: true, read: true };
};

/**
 * Normalize accept config to a consistent object format
 * Handles string enum values: "default", "create", "never"
 */
export const normalizeAccept = (accept?: AcceptType): { create: boolean; update: boolean } => {
  if (accept === 'create') {
    return { create: true, update: false };
  }
  if (accept === 'never') {
    return { create: false, update: false };
  }
  return { create: true, update: true };
};

/**
 * Returns the snake_case DB column name for the soft-delete timestamp,
 * or null when soft delete is not enabled for the model.
 */
export const getSoftDeleteColumn = (model: ModelDefinition): string | null => {
  if (!model.softDelete) return null;
  if (model.softDelete === true) return 'deleted_at';
  return model.softDelete.deletedAt ?? 'deleted_at';
};

/**
 * Returns true when the model has at least one PostGIS (spatial) field.
 */
export const hasPostGISFields = (model: ModelDefinition): boolean => {
  return model.fields.some((f) => isPostGISType(f.type));
};

/**
 * Returns true when at least one of the models has a PostGIS (spatial) field.
 * Spatial-only artifacts (the PostGIS extension, the spatial utilities module) must
 * not be emitted for a model set that has no spatial field at all.
 */
export const modelsHavePostGISFields = (models: ModelDefinition[]): boolean => {
  return models.some(hasPostGISFields);
};

/**
 * Returns the model's schema when it is not Postgres' default schema, otherwise null.
 * "public" and an unset schema both mean the default: drizzle-orm (>=0.45) forbids
 * pgSchema('public'), and DDL for the default schema stays unqualified.
 */
export const getCustomSchema = (model: ModelDefinition): string | null => {
  return model.schema && model.schema !== 'public' ? model.schema : null;
};
