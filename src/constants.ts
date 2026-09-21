/**
 * Shared constants for COG code generators
 */

/**
 * PostGIS spatial data types
 */
export const POSTGIS_TYPES = [
  'point',
  'linestring',
  'polygon',
  'multipoint',
  'multilinestring',
  'multipolygon',
  'geometry',
  'geography',
] as const;

/**
 * PostGIS type union
 */
export type PostGISType = (typeof POSTGIS_TYPES)[number];

/**
 * Check if a type is a PostGIS spatial type
 */
export const isPostGISType = (type: string): type is PostGISType => {
  return POSTGIS_TYPES.includes(type as PostGISType);
};

/**
 * All valid data types supported by COG
 */
export const VALID_DATA_TYPES = [
  'text',
  'string',
  'integer',
  'bigint',
  'decimal',
  'boolean',
  'date',
  'uuid',
  'json',
  'jsonb',
  'enum',
  ...POSTGIS_TYPES,
] as const;

/**
 * Data type union
 */
export type DataType = (typeof VALID_DATA_TYPES)[number];

/**
 * Check if a type is a valid data type
 */
export const isValidDataType = (type: string): type is DataType => {
  return VALID_DATA_TYPES.includes(type as DataType);
};

/**
 * How a consuming project should declare a dependency
 *
 * - `runtime`: needed when the application runs
 * - `dev`: not present at runtime - a type-only import or a build/migration tool
 * - `optional`: never imported by the generated code, only by an application that wants the feature
 */
export type DependencyKind = 'runtime' | 'dev' | 'optional';

export interface GeneratedDependency {
  specifier: string;
  kind: DependencyKind;
  /** Why it is needed - shown in the generator output for anything that is not plainly required */
  reason?: string;
}

/**
 * The dependency contract of the generated code, as deno.json import map specifiers.
 *
 * The generator emits no deno.json, so this same list has to appear in README.md and AGENTS.md.
 * A generator test keeps all of them in sync with example/deno.json.
 */
export const GENERATED_CODE_DEPENDENCIES: Record<string, GeneratedDependency> = {
  '@hono/hono': { specifier: 'jsr:@hono/hono@^4.13.8', kind: 'runtime' },
  '@scalar/hono-api-reference': {
    specifier: 'npm:@scalar/hono-api-reference@^0.12.2',
    kind: 'optional',
    reason: 'only if the application serves the API documentation UI',
  },
  'drizzle-kit': {
    specifier: 'npm:drizzle-kit@^0.31.10',
    kind: 'dev',
    reason: 'creates and migrates the database from the generated schema',
  },
  'drizzle-orm': { specifier: 'npm:drizzle-orm@^0.45.2', kind: 'runtime' },
  'drizzle-zod': { specifier: 'npm:drizzle-zod@^0.8.3', kind: 'runtime' },
  'openapi-types': { specifier: 'npm:openapi-types@^12.1.3', kind: 'dev' },
  'postgres': { specifier: 'npm:postgres@^3.4.9', kind: 'runtime' },
  // Imported as a type only, but drizzle-zod resolves it as a runtime peer dependency
  'zod': { specifier: 'npm:zod@^4.6.5', kind: 'runtime' },
};
