/**
 * Database identifier rules shared by the parser and the generators
 */

import { ModelDefinition } from '../types/model.types.ts';
import { toSnakeCase } from './string.utils.ts';

/**
 * PostgreSQL truncates identifiers at NAMEDATALEN - 1 bytes. A truncated table name is not an
 * inconvenience but a broken schema: the ORM keeps using the full name and every query fails,
 * and two derived names can collide after truncation. COG therefore refuses to generate
 * anything that would be truncated instead of letting the database silently shorten it.
 */
export const MAX_IDENTIFIER_LENGTH = 63;

const encoder = new TextEncoder();

/**
 * Identifier length in bytes - the limit is a byte limit, not a character limit
 */
export const identifierLength = (identifier: string): number => encoder.encode(identifier).length;

/**
 * True when the database would truncate this identifier
 */
export const isIdentifierTooLong = (identifier: string): boolean => {
  return identifierLength(identifier) > MAX_IDENTIFIER_LENGTH;
};

/**
 * Names COG derives for a model. Both the generators and the parser's length validation use
 * these, so what is validated is exactly what gets emitted.
 */
export const fieldIndexName = (model: ModelDefinition, fieldName: string): string => {
  return `idx_${model.name.toLowerCase()}_${fieldName}`;
};

export const fieldUniqueIndexName = (model: ModelDefinition, fieldName: string): string => {
  return `uq_${model.name.toLowerCase()}_${fieldName}`;
};

export const modelIndexName = (model: ModelDefinition, fields: string[]): string => {
  return `idx_${model.name.toLowerCase()}_${fields.join('_')}`;
};

export const checkConstraintName = (model: ModelDefinition, index: number): string => {
  return `check_${model.name.toLowerCase()}_numNotNulls${index + 1}`;
};

export const junctionPrimaryKeyName = (junctionTable: string): string => {
  return `pk_${junctionTable.toLowerCase()}`;
};

export const junctionForeignKeyName = (junctionTable: string, column: string): string => {
  return `${junctionTable.toLowerCase()}_${column}_fk`;
};

export const junctionIndexName = (junctionTable: string, column: string): string => {
  return `idx_${junctionTable.toLowerCase()}_${column}`;
};

/**
 * Column name as emitted in DDL
 */
export const columnName = (fieldName: string): string => toSnakeCase(fieldName);
