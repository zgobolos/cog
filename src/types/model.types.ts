/**
 * Model definition types for the CRUD Operations Generator
 */

// Supported primitive data types
export type PrimitiveType =
  | 'text'
  | 'string'
  | 'integer'
  | 'bigint'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'uuid'
  | 'json'
  | 'jsonb'
  | 'enum';

// PostGIS data types (supporting both standard and CockroachDB implementations)
export type PostGISType =
  | 'point'
  | 'linestring'
  | 'polygon'
  | 'multipoint'
  | 'multilinestring'
  | 'multipolygon'
  | 'geometry'
  | 'geography';

export type DataType = PrimitiveType | PostGISType;

// Enum definition
export interface EnumDefinition {
  name: string; // Enum name (e.g., "Gender")
  values: string[]; // Allowed values (e.g., ["man", "woman", "non_binary"])
  useBitwise?: boolean; // Store as integer with bitwise flags for efficient queries
}

// Field expose type - controls field visibility in responses and filtering
// "default" (or omit) - visible in all responses, filterable
// "hidden" - never visible in responses, not filterable
// "create" - visible in POST response only, not visible in GET/PUT/DELETE, not filterable
export type ExposeType = 'default' | 'hidden' | 'create';

// Field accept type - controls which fields are accepted as input
// "default" (or omit) - accepted on both create and update
// "create" - accepted on create only (immutable after creation)
// "never" - never accepted (server-managed field, must have defaultValue or beforeCreate hook)
export type AcceptType = 'default' | 'create' | 'never';

// Field definition
export interface FieldDefinition {
  name: string;
  type: DataType;
  primaryKey?: boolean;
  unique?: boolean;
  required?: boolean;
  defaultValue?: string | number | boolean | null;
  maxLength?: number; // For string/text type (varchar length for string; Zod max length for both)
  minLength?: number; // For string/text type (Zod min length validation)
  precision?: number; // For decimal type
  scale?: number; // For decimal type
  array?: boolean; // Support for array types
  enumName?: string; // For enum type: reference to enum name
  enumValues?: string[]; // For inline enum definition (alternative to enumName)
  srid?: number; // For PostGIS types (Spatial Reference ID)
  geometryType?: string; // For PostGIS geometry specification
  dimensions?: number; // For PostGIS dimensions (2D, 3D, 4D)
  index?: boolean;
  description?: string; // Custom description for OpenAPI docs
  expose?: ExposeType; // Field visibility: "default" | "hidden" | "create" (default: visible everywhere)
  accept?: AcceptType; // Field input acceptance: "default" | "create" | "never" (default: accepted on create and update)
  references?: {
    model: string;
    field: string;
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
    onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  };
}

// Relationship types
export type RelationshipType = 'oneToMany' | 'manyToOne' | 'manyToMany' | 'oneToOne';

// Model endpoint configuration for CRUD operations
export interface ModelEndpointConfig {
  create?: boolean; // POST /api/{model} (default: true)
  readOne?: boolean; // GET /api/{model}/:id (default: true)
  readMany?: boolean; // GET /api/{model} (default: true)
  update?: boolean; // PUT /api/{model}/:id (default: true)
  delete?: boolean; // DELETE /api/{model}/:id (default: true)
}

// Relationship endpoint configuration (many-to-many only)
export interface RelationshipEndpointConfig {
  get?: boolean; // GET /api/{model}/:id/{relation}List (default: true)
  add?: boolean; // POST /api/{model}/:id/{relation}List (default: true)
  remove?: boolean; // DELETE /api/{model}/:id/{relation}List and /:id/{singular}, JSON body (default: true)
  replace?: boolean; // PUT /api/{model}/:id/{relation}List (default: true)
}

// Relationship definition
export interface RelationshipDefinition {
  type: RelationshipType;
  name: string; // Name of the relationship field
  target: string; // Target model name
  through?: string; // For many-to-many: junction table name
  foreignKey?: string; // Foreign key field name
  targetForeignKey?: string; // For many-to-many: foreign key in junction table pointing to target
  onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  eager?: boolean; // Whether to eagerly load this relationship
  nullable?: boolean;
  endpoints?: RelationshipEndpointConfig; // Control which relationship endpoints are generated (many-to-many only)
}

// Index definition
export interface IndexDefinition {
  name?: string;
  fields: string[];
  unique?: boolean;
  type?: 'btree' | 'hash' | 'gist' | 'gin' | 'spgist' | 'brin';
  where?: string; // Partial index condition
}

// Check constraint definition
// Format: { "numNotNulls": [{ "fields": ["field1", "field2"], "num": 1 }] }
// For num_nonnulls: { "numNotNulls": [{ "fields": ["avatarUrl", "socialLinks"], "num": 1 }] } -> num_nonnulls(avatarUrl, socialLinks) = 1
export type CheckConstraints = {
  numNotNulls?: Array<{
    fields: string[]; // Array of field names to check
    num: number; // Required count of non-null fields
  }>;
};

// Model definition
export interface ModelDefinition {
  name: string; // Model name (e.g., "User")
  tableName: string; // Database table name (e.g., "users")
  schema?: string; // Database schema name
  fields: FieldDefinition[];
  enums?: EnumDefinition[]; // Enum definitions for this model
  relationships?: RelationshipDefinition[];
  indexes?: IndexDefinition[];
  check?: CheckConstraints; // Check constraints for this model
  timestamps?: boolean | {
    createdAt?: string | boolean;
    updatedAt?: string | boolean;
  };
  softDelete?: boolean | {
    deletedAt?: string; // custom column name (default: "deleted_at")
  };
  description?: string;
  endpoints?: ModelEndpointConfig; // Control which CRUD endpoints are generated
  hooks?: {
    // Hook definitions at the model level
    beforeCreate?: boolean;
    afterCreate?: boolean;
    beforeUpdate?: boolean;
    afterUpdate?: boolean;
    beforeDelete?: boolean;
    afterDelete?: boolean;
    beforeFind?: boolean;
    afterFind?: boolean;
  };
}

// Generator configuration
export interface GeneratorConfig {
  modelsPath: string; // Path to models JSON files
  outputPath: string; // Path where generated code will be written
  database: {
    type: 'postgresql' | 'cockroachdb';
    postgis?: boolean; // PostGIS support: spatial types in the generated code and the extension itself
    schema?: string; // Default schema
  };
  features?: {
    timestamps?: boolean;
    hooks?: boolean;
  };
  naming?: {
    tableNaming?: 'snake_case' | 'camelCase' | 'PascalCase';
    columnNaming?: 'snake_case' | 'camelCase';
  };
  verbose?: boolean; // Show detailed generation progress
}

// Generated file metadata
export interface GeneratedFile {
  path: string;
  content: string;
  description: string;
}

// Validation error
export interface ValidationError {
  model?: string;
  field?: string;
  relationship?: string;
  message: string;
  severity: 'error' | 'warning';
}
