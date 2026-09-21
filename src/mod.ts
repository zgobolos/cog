/**
 * Main module exports for the CRUD Operations Generator
 */

import { ModelParser } from './parser/model-parser.ts';
import { DrizzleSchemaGenerator } from './generators/drizzle-schema.generator.ts';
import { DatabaseInitGenerator } from './generators/database-init.generator.ts';
import { DomainAPIGenerator } from './generators/domain-api.generator.ts';
import { DomainExceptionsGenerator } from './generators/domain-exceptions.generator.ts';
import { RestAPIGenerator } from './generators/rest-api.generator.ts';
import { RestCrudFactoryGenerator } from './generators/rest-crud-factory.generator.ts';
import { OpenAPIMetadataGenerator } from './generators/openapi-metadata.generator.ts';
import { OpenAPIBuilderGenerator } from './generators/openapi-builder.generator.ts';
import { FilterUtilsGenerator } from './generators/filter-utils.generator.ts';
import { JunctionUtilsGenerator } from './generators/junction-utils.generator.ts';
import { FieldMetaUtilsGenerator } from './generators/field-meta-utils.generator.ts';
import { BaseDomainGenerator } from './generators/base-domain.generator.ts';
import { GeneratorConfig, ModelDefinition } from './types/model.types.ts';
import { type DependencyReport, resolveDependencies } from './utils/dependency.utils.ts';
import { isPostGISType } from './constants.ts';

export * from './types/model.types.ts';

/**
 * Generate CRUD backend code from model definitions
 * @param modelsPath - Path to the directory containing model JSON files
 * @param outputPath - Path where generated code will be written
 * @param options - Additional generation options
 */
export async function generateFromModels(
  modelsPath: string,
  outputPath: string,
  options: Partial<GeneratorConfig> = {},
) {
  // Default configuration
  const config: GeneratorConfig = {
    modelsPath,
    outputPath,
    database: {
      type: options.database?.type || 'postgresql',
      postgis: options.database?.postgis !== false,
      schema: options.database?.schema,
    },
    features: {
      timestamps: options.features?.timestamps !== false,
      hooks: true,
    },
    naming: {
      tableNaming: 'snake_case',
      columnNaming: 'snake_case',
    },
    verbose: options.verbose,
  };

  const verbose = config.verbose === true;

  // Step 1: Parse models
  const parser = new ModelParser();
  const { models, errors } = await parser.parseModelsFromDirectory(modelsPath);

  if (errors.length > 0) {
    const hasErrors = errors.some((e) => e.severity === 'error');
    console.log(errors.filter((e) => e.severity === 'error'));

    if (hasErrors) {
      throw new Error('Generation aborted due to validation errors');
    }
  }

  // With PostGIS disabled the generated code has no spatial support at all, so a spatial field
  // is a configuration error rather than something to silently downgrade
  if (!config.database.postgis) {
    const spatialFields = models.flatMap((model) =>
      model.fields.filter((field) => isPostGISType(field.type)).map((field) => `${model.name}.${field.name}`)
    );
    if (spatialFields.length > 0) {
      throw new Error(
        `PostGIS is disabled but spatial fields are declared: ${spatialFields.join(', ')}. ` +
          'Enable PostGIS or remove these fields.',
      );
    }
  }

  // Apply global configuration to all models
  for (const model of models) {
    // Apply global schema if specified
    if (config.database.schema) {
      model.schema = config.database.schema;
    }
  }

  // Step 2: Generate code
  const files = new Map<string, string>();

  // Generate Drizzle schemas
  const schemaGenerator = new DrizzleSchemaGenerator(models, {
    isCockroachDB: config.database.type === 'cockroachdb',
    postgis: config.database.postgis,
  });
  const schemas = schemaGenerator.generateSchemas();
  schemas.forEach((content, path) => files.set(path, content));

  // Generate database initialization and utilities
  const dbInitGenerator = new DatabaseInitGenerator(models, {
    dbType: config.database.type,
    postgis: config.database.postgis,
  });

  files.set('db/database.ts', dbInitGenerator.generateDatabaseInit());
  files.set(
    'db/initialize-database.ts',
    dbInitGenerator.generateDatabaseInitialization(),
  );

  // Generate domain exceptions
  const exceptionsGenerator = new DomainExceptionsGenerator();
  files.set('domain/exceptions.ts', exceptionsGenerator.generate());

  // Generate filter utilities
  const filterUtilsGenerator = new FilterUtilsGenerator();
  files.set('utils/filter.utils.ts', filterUtilsGenerator.generate());

  // Generate field metadata utilities
  const fieldMetaUtilsGenerator = new FieldMetaUtilsGenerator();
  files.set('utils/field-meta.utils.ts', fieldMetaUtilsGenerator.generate());

  files.set('utils/index.ts', generateUtilsIndex());

  // Generate junction utilities (for many-to-many relationships)
  const hasManyToMany = models.some(
    (m) => m.relationships?.some((r) => r.type === 'manyToMany'),
  );
  if (hasManyToMany) {
    const junctionUtilsGenerator = new JunctionUtilsGenerator();
    files.set('domain/junction.utils.ts', junctionUtilsGenerator.generate());
  }

  // Generate base domain class
  const baseDomainGenerator = new BaseDomainGenerator();
  files.set('domain/base.domain.ts', baseDomainGenerator.generate());

  // Generate domain APIs
  const domainGenerator = new DomainAPIGenerator(models);
  const domainFiles = domainGenerator.generateDomainAPIs();
  domainFiles.forEach((content, path) => files.set(path, content));

  // Generate REST CRUD factory
  const restCrudFactoryGenerator = new RestCrudFactoryGenerator();
  files.set('rest/crud.factory.ts', restCrudFactoryGenerator.generate());

  // Generate REST APIs
  const restGenerator = new RestAPIGenerator(models);
  const restFiles = restGenerator.generateRestAPIs();
  restFiles.forEach((content, path) => files.set(path, content));

  // Generate OpenAPI metadata and dynamic builder
  const openAPIMetadataGenerator = new OpenAPIMetadataGenerator(models);
  files.set('rest/openapi-metadata.ts', openAPIMetadataGenerator.generate());

  const openAPIBuilderGenerator = new OpenAPIBuilderGenerator();
  files.set('rest/openapi.ts', openAPIBuilderGenerator.generate());

  // Generate main index file
  files.set('index.ts', generateMainIndex(models));

  // Step 3: Write files
  await writeGeneratedFiles(outputPath, files, verbose);

  // Step 4: Report the dependency contract of what was just generated
  const dependencies: DependencyReport = resolveDependencies(files);

  return {
    models,
    fileCount: files.size,
    outputPath,
    dependencies,
  };
}

/**
 * Generate utils index file
 */
function generateUtilsIndex(): string {
  return `/**
 * Utility Exports
 *
 * Re-exports all utility functions for convenient access.
 */

export * from './filter.utils.ts';
export * from './field-meta.utils.ts';
`;
}

/**
 * Generate main index file
 */
function generateMainIndex(models: ModelDefinition[]): string {
  return `/**
 * Generated CRUD Backend
 *
 * This is the main entry point for the generated backend code.
 */

import { Hono } from '@hono/hono';
import { connect, type DatabaseConfig } from './db/database.ts';
import { registerRestRoutes, ${models.map((m) => `initialize${m.name}RestRoutes`).join(', ')} } from './rest/index.ts';
import * as domain from './domain/index.ts';
import * as schema from './schema/index.ts';

// Generic initialization config - works with any Hono Env type
export interface InitializationConfig<Env extends { Variables: Record<string, unknown> } = { Variables: Record<string, unknown> }> {
  database: DatabaseConfig;
  app: Hono<Env>;
  api?: {
    basePath?: string; // Optional base path prefix for API routes (e.g., '/api/v1', default: '/api')
  };
  logging?: {
    trace?: (message: string, ...args: unknown[]) => void;
    debug?: (message: string, ...args: unknown[]) => void;
    info?: (message: string, ...args: unknown[]) => void;
    warn?: (message: string, ...args: unknown[]) => void;
    error?: (message: string, ...args: unknown[]) => void;
  };
  domainHooks?: {
    [modelName: string]: unknown;
  };
}

/**
 * Initialize the generated backend
 * @param config Configuration object with database, app, and optional hooks
 * @returns Initialized database connection, SQL client, domain objects, and schema
 */
export async function initializeGenerated<Env extends { Variables: Record<string, unknown> } = { Variables: Record<string, unknown> }>(config: InitializationConfig<Env>) {
  // Initialize database
  const { db, sql } = await connect(config.database, config.logging);

  // Initialize domain layers with hooks if provided
  if (config.domainHooks) {
    ${
    models
      .map(
        (m) => `
    if (config.domainHooks.${m.name.toLowerCase()}) {
      Object.assign(domain.${m.name.toLowerCase()}Domain,
        new domain.${m.name}Domain(
        config.domainHooks.${m.name.toLowerCase()}
      ));
    }`,
      )
      .join('')
  }
  }

  // Register REST routes
  registerRestRoutes(config.app, config.api?.basePath);

  return {
    db,
    sql,
    domain,
    schema
  };
}

// Re-export everything for convenience
export * from './db/database.ts';
export * from './rest/index.ts';
export * from './domain/index.ts';
export * from './schema/index.ts';
export * from './utils/index.ts';
export type { DefaultEnv } from './rest/types.ts';
`;
}

/**
 * Write generated files to disk
 */
async function writeGeneratedFiles(
  outputPath: string,
  files: Map<string, string>,
  verbose = false,
) {
  // Create output directory
  await Deno.mkdir(outputPath, { recursive: true });

  for (const [relativePath, content] of files) {
    const fullPath = `${outputPath}/${relativePath}`;
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));

    // Create directory if needed
    await Deno.mkdir(dir, { recursive: true });

    // Write file
    await Deno.writeTextFile(fullPath, content);

    // Only output file paths if verbose flag is true
    if (verbose) {
      console.log(relativePath);
    }
  }
}
