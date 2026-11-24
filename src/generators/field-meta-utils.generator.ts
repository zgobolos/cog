/**
 * Generates field metadata utility functions
 * These utilities derive exposed/accepted field arrays from FieldMeta at runtime
 */
export class FieldMetaUtilsGenerator {
  /**
   * Generate field metadata utilities file
   */
  generate(): string {
    return `/**
 * Field Metadata Utilities
 *
 * Provides runtime derivation of field visibility and acceptance arrays from FieldMeta.
 * This centralizes the logic instead of generating static arrays per model.
 */

/**
 * Enhanced field metadata with visibility and acceptance controls
 */
export interface FieldMeta {
  /** Field data type */
  type: string;
  /** Whether field is an array type */
  array: boolean;
  /** Whether field is visible in create (POST) responses */
  exposeCreate: boolean;
  /** Whether field is visible in read (GET) responses */
  exposeRead: boolean;
  /** Whether field is accepted in create (POST) input */
  acceptCreate: boolean;
  /** Whether field is accepted in update (PUT) input */
  acceptUpdate: boolean;
  /** Whether a trusted create (options.trusted) writes the field: false only for columns COG manages */
  acceptTrustedCreate: boolean;
  /** Whether a trusted update writes the field: false for columns COG manages and the primary key */
  acceptTrustedUpdate: boolean;
}

/**
 * Names of the fields whose metadata matches the predicate
 */
const fieldNamesWhere = (fieldMeta: Map<string, FieldMeta>, predicate: (meta: FieldMeta) => boolean): string[] => {
  const fields: string[] = [];
  for (const [name, meta] of fieldMeta) {
    if (predicate(meta)) {
      fields.push(name);
    }
  }
  return fields;
};

/**
 * Get all fields that are exposed (visible) in responses
 * Used for filter validation - only exposed fields can be filtered
 */
export const getExposedFields = (fieldMeta: Map<string, FieldMeta>): Set<string> => {
  return new Set(fieldNamesWhere(fieldMeta, (meta) => meta.exposeRead));
};

/**
 * Get fields to strip from create (POST) responses
 * Fields where exposeCreate is false
 */
export const getCreateUnexposedFields = (fieldMeta: Map<string, FieldMeta>): string[] => {
  return fieldNamesWhere(fieldMeta, (meta) => !meta.exposeCreate);
};

/**
 * Get fields to strip from read (GET) responses
 * Fields where exposeRead is false
 */
export const getReadUnexposedFields = (fieldMeta: Map<string, FieldMeta>): string[] => {
  return fieldNamesWhere(fieldMeta, (meta) => !meta.exposeRead);
};

/**
 * Get fields to strip from create (POST) input
 * Fields where acceptCreate is false (e.g., timestamps, server-managed fields)
 */
export const getCreateUnacceptedFields = (fieldMeta: Map<string, FieldMeta>): string[] => {
  return fieldNamesWhere(fieldMeta, (meta) => !meta.acceptCreate);
};

/**
 * Get fields to strip from update (PUT) input
 * Fields where acceptUpdate is false (e.g., id, timestamps, immutable fields)
 */
export const getUpdateUnacceptedFields = (fieldMeta: Map<string, FieldMeta>): string[] => {
  return fieldNamesWhere(fieldMeta, (meta) => !meta.acceptUpdate);
};

/**
 * Get fields to strip from a trusted create's input: only the columns COG manages
 * (timestamps, soft-delete column)
 */
export const getTrustedCreateUnacceptedFields = (fieldMeta: Map<string, FieldMeta>): string[] => {
  return fieldNamesWhere(fieldMeta, (meta) => !meta.acceptTrustedCreate);
};

/**
 * Get fields to strip from a trusted update's input: the columns COG manages and the primary key
 */
export const getTrustedUpdateUnacceptedFields = (fieldMeta: Map<string, FieldMeta>): string[] => {
  return fieldNamesWhere(fieldMeta, (meta) => !meta.acceptTrustedUpdate);
};

/**
 * Check if a field is exposed (for backwards compatibility)
 * A field is considered exposed if it's visible in read responses
 */
export const isFieldExposed = (fieldMeta: Map<string, FieldMeta>, fieldName: string): boolean => {
  const meta = fieldMeta.get(fieldName);
  return meta?.exposeRead ?? false;
};
`;
  }
}
