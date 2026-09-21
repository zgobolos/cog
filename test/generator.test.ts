/**
 * Basic generator tests for CI pipeline
 */

import { assertEquals, assertExists, assertRejects } from '@std/assert';
import { generateFromModels } from '../src/mod.ts';
import { GENERATED_CODE_DEPENDENCIES } from '../src/constants.ts';

const TEST_OUTPUT_PATH = './test/test-generated';
const TEST_MODELS_PATH = './test/test-models';

/**
 * Setup: Create test model directory and a simple model
 */
async function setup() {
  await Deno.mkdir(TEST_MODELS_PATH, { recursive: true });

  const simpleModel = {
    name: 'TestEntity',
    tableName: 'test_entity',
    fields: [
      {
        name: 'id',
        type: 'uuid',
        primaryKey: true,
        defaultValue: 'gen_random_uuid()',
        required: true,
      },
      {
        name: 'name',
        type: 'string',
        maxLength: 100,
        required: true,
      },
      {
        name: 'isActive',
        type: 'boolean',
        defaultValue: true,
      },
    ],
    timestamps: true,
  };

  await Deno.writeTextFile(`${TEST_MODELS_PATH}/test-entity.json`, JSON.stringify(simpleModel, null, 2));
}

/**
 * Cleanup: Remove test directories
 */
async function cleanup() {
  try {
    await Deno.remove(TEST_OUTPUT_PATH, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }
  try {
    await Deno.remove(TEST_MODELS_PATH, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }
}

Deno.test('generator - generates expected file structure', async () => {
  await cleanup();
  await setup();

  try {
    const result = await generateFromModels(TEST_MODELS_PATH, TEST_OUTPUT_PATH);

    // Verify result
    assertEquals(result.models.length, 1);
    assertEquals(result.models[0].name, 'TestEntity');
    assertEquals(result.outputPath, TEST_OUTPUT_PATH);

    // Verify main index file exists
    const indexStat = await Deno.stat(`${TEST_OUTPUT_PATH}/index.ts`);
    assertExists(indexStat);

    // Verify schema files
    const schemaStat = await Deno.stat(`${TEST_OUTPUT_PATH}/schema/testentity.schema.ts`);
    assertExists(schemaStat);
    const relStat = await Deno.stat(`${TEST_OUTPUT_PATH}/schema/relations.ts`);
    assertExists(relStat);

    // Verify domain files
    const domainStat = await Deno.stat(`${TEST_OUTPUT_PATH}/domain/testentity.domain.ts`);
    assertExists(domainStat);
    const exceptionsStat = await Deno.stat(`${TEST_OUTPUT_PATH}/domain/exceptions.ts`);
    assertExists(exceptionsStat);

    // Verify REST files
    const restStat = await Deno.stat(`${TEST_OUTPUT_PATH}/rest/testentity.rest.ts`);
    assertExists(restStat);
    const openApiStat = await Deno.stat(`${TEST_OUTPUT_PATH}/rest/openapi.ts`);
    assertExists(openApiStat);

    // Verify database files
    const dbStat = await Deno.stat(`${TEST_OUTPUT_PATH}/db/database.ts`);
    assertExists(dbStat);
    const initDbStat = await Deno.stat(`${TEST_OUTPUT_PATH}/db/initialize-database.ts`);
    assertExists(initDbStat);

    // Verify utils files
    const filterStat = await Deno.stat(`${TEST_OUTPUT_PATH}/utils/filter.utils.ts`);
    assertExists(filterStat);
  } finally {
    await cleanup();
  }
});

Deno.test('generator - handles multiple models', async () => {
  await cleanup();
  await setup();

  try {
    // Add a second model
    const secondModel = {
      name: 'AnotherEntity',
      tableName: 'another_entity',
      fields: [
        {
          name: 'id',
          type: 'uuid',
          primaryKey: true,
          defaultValue: 'gen_random_uuid()',
          required: true,
        },
        {
          name: 'title',
          type: 'text',
          required: true,
        },
      ],
    };
    await Deno.writeTextFile(`${TEST_MODELS_PATH}/another-entity.json`, JSON.stringify(secondModel, null, 2));

    const result = await generateFromModels(TEST_MODELS_PATH, TEST_OUTPUT_PATH);

    assertEquals(result.models.length, 2);

    // Verify both schema files exist
    const schema1 = await Deno.stat(`${TEST_OUTPUT_PATH}/schema/testentity.schema.ts`);
    assertExists(schema1);
    const schema2 = await Deno.stat(`${TEST_OUTPUT_PATH}/schema/anotherentity.schema.ts`);
    assertExists(schema2);

    // Verify both domain files exist
    const domain1 = await Deno.stat(`${TEST_OUTPUT_PATH}/domain/testentity.domain.ts`);
    assertExists(domain1);
    const domain2 = await Deno.stat(`${TEST_OUTPUT_PATH}/domain/anotherentity.domain.ts`);
    assertExists(domain2);
  } finally {
    await cleanup();
  }
});

Deno.test('generator - supports cockroachdb option', async () => {
  await cleanup();
  await setup();

  try {
    const result = await generateFromModels(TEST_MODELS_PATH, TEST_OUTPUT_PATH, {
      database: {
        type: 'cockroachdb',
      },
    });

    assertEquals(result.models.length, 1);

    // Verify files were generated
    const indexStat = await Deno.stat(`${TEST_OUTPUT_PATH}/index.ts`);
    assertExists(indexStat);
  } finally {
    await cleanup();
  }
});

Deno.test('parser - parses softDelete property', async () => {
  const { parseModel } = await import('../src/parser/model-parser.ts');
  const model = parseModel({
    name: 'Sd',
    tableName: 'sd',
    fields: [{ name: 'id', type: 'uuid', primaryKey: true, required: true }],
    softDelete: true,
  });
  assertEquals(model!.softDelete, true);

  const model2 = parseModel({
    name: 'Sd2',
    tableName: 'sd2',
    fields: [{ name: 'id', type: 'uuid', primaryKey: true, required: true }],
    softDelete: { deletedAt: 'removed_at' },
  });
  assertEquals((model2!.softDelete as { deletedAt?: string }).deletedAt, 'removed_at');
});

Deno.test('field.utils - getSoftDeleteColumn', async () => {
  const { getSoftDeleteColumn } = await import('../src/utils/field.utils.ts');
  const base = { name: 'X', tableName: 'x', fields: [] };
  assertEquals(getSoftDeleteColumn({ ...base }), null);
  assertEquals(getSoftDeleteColumn({ ...base, softDelete: true }), 'deleted_at');
  assertEquals(getSoftDeleteColumn({ ...base, softDelete: { deletedAt: 'removed_at' } }), 'removed_at');
});

Deno.test('parser - preserves minLength on string/text fields', async () => {
  const { parseModel } = await import('../src/parser/model-parser.ts');
  const model = parseModel({
    name: 'Lm',
    tableName: 'lm',
    fields: [
      { name: 'id', type: 'uuid', primaryKey: true, required: true },
      { name: 'code', type: 'string', maxLength: 10, minLength: 3, required: true },
      { name: 'bio', type: 'text', minLength: 1 },
    ],
  });
  assertExists(model);
  const code = model!.fields.find((f) => f.name === 'code');
  assertEquals(code!.minLength, 3);
  assertEquals(code!.maxLength, 10);
  assertEquals(model!.fields.find((f) => f.name === 'bio')!.minLength, 1);
});

const LEN_MODELS = './test/test-len-models';
const LEN_OUTPUT = './test/test-len-generated';

async function cleanupLength() {
  for (const p of [LEN_MODELS, LEN_OUTPUT]) {
    try {
      await Deno.remove(p, { recursive: true });
    } catch { /* ignore */ }
  }
}

Deno.test('generator - emits Zod length refinements for minLength/maxLength', async () => {
  await cleanupLength();
  try {
    await Deno.mkdir(LEN_MODELS, { recursive: true });
    const model = {
      name: 'LengthEntity',
      tableName: 'length_entity',
      fields: [
        { name: 'id', type: 'uuid', primaryKey: true, defaultValue: 'gen_random_uuid()', required: true },
        // string with both bounds -> .min().max()
        { name: 'code', type: 'string', maxLength: 10, minLength: 3, required: true },
        // text with only minLength -> .min() (text column stays unbounded)
        { name: 'bio', type: 'text', minLength: 5 },
        // string with only maxLength -> .max() (Zod check, not just varchar length)
        { name: 'name', type: 'string', maxLength: 50, required: true },
        // array of strings must NOT be refined (refinement would constrain array length)
        { name: 'tags', type: 'string', array: true, minLength: 2 },
      ],
    };
    await Deno.writeTextFile(`${LEN_MODELS}/length-entity.json`, JSON.stringify(model, null, 2));
    await generateFromModels(LEN_MODELS, LEN_OUTPUT);

    const schema = await Deno.readTextFile(`${LEN_OUTPUT}/schema/lengthentity.schema.ts`);

    // Refinements are passed to BOTH insert and update schema builders
    assertEquals(/createInsertSchema\(lengthentityTable,\s*\{/.test(schema), true);
    assertEquals(/createUpdateSchema\(lengthentityTable,\s*\{/.test(schema), true);
    // select schema is never refined
    assertEquals(schema.includes('createSelectSchema(lengthentityTable)'), true);

    // code: both bounds
    assertEquals(/code:\s*\(schema\)\s*=>\s*schema\.min\(3\)\.max\(10\)/.test(schema), true);
    // bio (text): min only
    assertEquals(/bio:\s*\(schema\)\s*=>\s*schema\.min\(5\)\s*,/.test(schema), true);
    // name: max only
    assertEquals(/name:\s*\(schema\)\s*=>\s*schema\.max\(50\)/.test(schema), true);
    // tags (array): excluded from refinements entirely
    assertEquals(/tags:\s*\(schema\)/.test(schema), false);
  } finally {
    await cleanupLength();
  }
});

const SD_MODELS = './test/test-sd-models';
const SD_OUTPUT = './test/test-sd-generated';

async function generateSoftDeleteModel() {
  await Deno.mkdir(SD_MODELS, { recursive: true });
  const model = {
    name: 'SoftDeletedEntity',
    tableName: 'soft_deleted_entity',
    fields: [
      { name: 'id', type: 'uuid', primaryKey: true, defaultValue: 'gen_random_uuid()', required: true },
      { name: 'code', type: 'string', maxLength: 100, required: true, unique: true },
      { name: 'name', type: 'string', maxLength: 100, required: true },
    ],
    indexes: [{ fields: ['code', 'name'], unique: true }],
    timestamps: true,
    softDelete: true,
  };
  await Deno.writeTextFile(`${SD_MODELS}/sde.json`, JSON.stringify(model, null, 2));
  await generateFromModels(SD_MODELS, SD_OUTPUT);
}

async function cleanupSoftDelete() {
  for (const p of [SD_MODELS, SD_OUTPUT]) {
    try {
      await Deno.remove(p, { recursive: true });
    } catch { /* ignore */ }
  }
}

Deno.test('generator - soft delete partial unique indexes', async () => {
  await cleanupSoftDelete();
  try {
    await generateSoftDeleteModel();
    const schema = await Deno.readTextFile(`${SD_OUTPUT}/schema/softdeletedentity.schema.ts`);
    // Field-level unique becomes a partial unique index, not an inline .unique() modifier
    assertEquals(schema.includes('.unique()'), false);
    assertEquals(/uniqueIndex\([^)]*\)\s*\.on\(table\.code\)\s*\.where\(sql`deleted_at IS NULL`\)/.test(schema), true);
    // Model-level unique index gains the partial WHERE clause
    assertEquals(
      /uniqueIndex\([^)]*\)\.on\(table\.code,\s*table\.name\)\.where\(sql`deleted_at IS NULL`\)/.test(schema),
      true,
    );
  } finally {
    await cleanupSoftDelete();
  }
});

Deno.test('generator - soft delete schema column and field meta', async () => {
  await cleanupSoftDelete();
  try {
    await generateSoftDeleteModel();
    const schema = await Deno.readTextFile(`${SD_OUTPUT}/schema/softdeletedentity.schema.ts`);
    // Nullable deletedAt: no .notNull(), no .default()
    assertEquals(/deletedAt:\s*bigint\('deleted_at',\s*\{\s*mode:\s*'number'\s*\}\)\s*,/.test(schema), true);
    assertEquals(schema.includes("deletedAt: bigint('deleted_at', { mode: 'number' }).default"), false);
    // Field meta hidden + never-accept
    assertEquals(
      schema.includes(
        "['deletedAt', { type: 'date', array: false, exposeCreate: false, exposeRead: false, acceptCreate: false, acceptUpdate: false }]",
      ),
      true,
    );
  } finally {
    await cleanupSoftDelete();
  }
});

Deno.test('generator - soft delete DDL column and partial unique index', async () => {
  await cleanupSoftDelete();
  try {
    await generateSoftDeleteModel();
    const ddl = await Deno.readTextFile(`${SD_OUTPUT}/db/initialize-database.ts`);
    // Nullable deleted_at column (no DEFAULT, no NOT NULL)
    assertEquals(/deleted_at INT8(?!\s+DEFAULT)(?!\s+NOT NULL)/.test(ddl), true);
    // No plain UNIQUE constraint for the soft-delete table's unique field
    assertEquals(ddl.includes('"softdeletedentity_code_unique" UNIQUE'), false);
    // Partial unique index for field-level unique
    assertEquals(ddl.includes('CREATE UNIQUE INDEX') && ddl.includes('WHERE deleted_at IS NULL'), true);
  } finally {
    await cleanupSoftDelete();
  }
});

Deno.test('generator - soft delete domain behavior', async () => {
  await cleanupSoftDelete();
  try {
    await generateSoftDeleteModel();
    const domain = await Deno.readTextFile(`${SD_OUTPUT}/domain/softdeletedentity.domain.ts`);
    // imports
    assertEquals(/import \{[^}]*\band\b[^}]*\bisNull\b[^}]*\} from 'drizzle-orm';/.test(domain), true);
    // delete() is a soft update, not a hard .delete()
    assertEquals(domain.includes('.delete(softdeletedentityTable)'), false);
    assertEquals(domain.includes('deletedAt: sql`(extract(epoch from now()) * 1000)::bigint`'), true);
    // delete + update guard on deletedAt
    assertEquals(domain.includes('isNull(softdeletedentityTable.deletedAt)'), true);
    // find filter respects withSoftDeleted
    assertEquals(domain.includes('options?.withSoftDeleted'), true);
  } finally {
    await cleanupSoftDelete();
  }
});

Deno.test('generator - non-soft-delete model keeps hard delete', async () => {
  await cleanup();
  await setup(); // existing TestEntity has no softDelete
  try {
    await generateFromModels(TEST_MODELS_PATH, TEST_OUTPUT_PATH);
    const domain = await Deno.readTextFile(`${TEST_OUTPUT_PATH}/domain/testentity.domain.ts`);
    assertEquals(domain.includes('.delete(testentityTable)'), true);
    assertEquals(domain.includes('deletedAt:'), false);
  } finally {
    await cleanup();
  }
});

const M2M_MODELS = './test/test-m2m-models';
const M2M_OUTPUT = './test/test-m2m-generated';

async function generateM2MSoftDelete() {
  await Deno.mkdir(M2M_MODELS, { recursive: true });
  const parent = {
    name: 'SdParent',
    tableName: 'sd_parent',
    fields: [
      { name: 'id', type: 'uuid', primaryKey: true, defaultValue: 'gen_random_uuid()', required: true },
      { name: 'name', type: 'string', maxLength: 100, required: true },
    ],
    relationships: [
      {
        type: 'manyToMany',
        name: 'tagList',
        target: 'SdTag',
        through: 'sd_parent_sd_tag',
        foreignKey: 'sd_parent_id',
        targetForeignKey: 'sd_tag_id',
        endpoints: { get: true, add: true, remove: true },
      },
    ],
    endpoints: { create: true, readOne: true, readMany: true, update: true, delete: true },
  };
  const tag = {
    name: 'SdTag',
    tableName: 'sd_tag',
    fields: [
      { name: 'id', type: 'uuid', primaryKey: true, defaultValue: 'gen_random_uuid()', required: true },
      { name: 'label', type: 'string', maxLength: 100, required: true },
    ],
    softDelete: true,
    endpoints: { create: true, readOne: true, readMany: true, update: true, delete: true },
  };
  await Deno.writeTextFile(`${M2M_MODELS}/sd-parent.json`, JSON.stringify(parent, null, 2));
  await Deno.writeTextFile(`${M2M_MODELS}/sd-tag.json`, JSON.stringify(tag, null, 2));
  await generateFromModels(M2M_MODELS, M2M_OUTPUT);
}

async function cleanupM2M() {
  for (const p of [M2M_MODELS, M2M_OUTPUT]) {
    try {
      await Deno.remove(p, { recursive: true });
    } catch { /* ignore */ }
  }
}

Deno.test('generator - soft delete column is hidden from OpenAPI', async () => {
  await cleanupSoftDelete();
  try {
    await generateSoftDeleteModel();
    const meta = await Deno.readTextFile(`${SD_OUTPUT}/rest/openapi-metadata.ts`);
    // deletedAt must not appear as an exposed/advertised property
    assertEquals(meta.includes('deletedAt'), false);
  } finally {
    await cleanupSoftDelete();
  }
});

Deno.test('generator - m2m junction config flags soft-deletable target', async () => {
  await cleanupM2M();
  try {
    await generateM2MSoftDelete();
    const domain = await Deno.readTextFile(`${M2M_OUTPUT}/domain/sdparent.domain.ts`);
    assertEquals(domain.includes('targetHasSoftDelete: true'), true);
    // targetTableName must be the SQL table name (how drizzle keys join results),
    // not the lowercased model name. SdTag -> table "sd_tag".
    assertEquals(domain.includes("targetTableName: 'sd_tag'"), true);
    assertEquals(domain.includes("targetTableName: 'sdtag'"), false);
    const junction = await Deno.readTextFile(`${M2M_OUTPUT}/domain/junction.utils.ts`);
    // getJunctionTargets honors the flag with an isNull filter on the target's deletedAt
    assertEquals(junction.includes('targetHasSoftDelete'), true);
    assertEquals(junction.includes("config.targetTable['deletedAt'"), true);
    assertEquals(junction.includes('isNull('), true);
  } finally {
    await cleanupM2M();
  }
});

const SD_UQIDX_MODELS = './test/test-sd-uqidx-models';
const SD_UQIDX_OUTPUT = './test/test-sd-uqidx-generated';

async function generateSoftDeleteUniqueIndexModel() {
  await Deno.mkdir(SD_UQIDX_MODELS, { recursive: true });
  // Model has a field with BOTH index:true AND unique:true — on a soft-delete model
  const model = {
    name: 'SdUqIdx',
    tableName: 'sd_uq_idx',
    fields: [
      { name: 'id', type: 'uuid', primaryKey: true, defaultValue: 'gen_random_uuid()', required: true },
      { name: 'code', type: 'string', maxLength: 100, required: true, unique: true, index: true },
      { name: 'label', type: 'string', maxLength: 100, required: true },
    ],
    timestamps: true,
    softDelete: true,
  };
  await Deno.writeTextFile(`${SD_UQIDX_MODELS}/sd-uq-idx.json`, JSON.stringify(model, null, 2));
  await generateFromModels(SD_UQIDX_MODELS, SD_UQIDX_OUTPUT);
}

async function cleanupSoftDeleteUniqueIndex() {
  for (const p of [SD_UQIDX_MODELS, SD_UQIDX_OUTPUT]) {
    try {
      await Deno.remove(p, { recursive: true });
    } catch { /* ignore */ }
  }
}

Deno.test('generator - soft delete: field with index+unique emits no non-partial CREATE UNIQUE INDEX', async () => {
  await cleanupSoftDeleteUniqueIndex();
  try {
    await generateSoftDeleteUniqueIndexModel();
    const ddl = await Deno.readTextFile(`${SD_UQIDX_OUTPUT}/db/initialize-database.ts`);

    // The field-level loop must NOT emit a non-partial CREATE UNIQUE INDEX for `code`
    // (the only UNIQUE index on `code` must be the partial one with WHERE deleted_at IS NULL)
    const lines = ddl.split('\n');
    for (const line of lines) {
      if (line.includes('CREATE UNIQUE INDEX') && line.includes('"code"') && !line.includes('WHERE')) {
        throw new Error(
          `Found a non-partial CREATE UNIQUE INDEX on "code" in a soft-delete model — this is the leak: ${line}`,
        );
      }
    }

    // The partial unique index must still be there
    assertEquals(
      ddl.includes('CREATE UNIQUE INDEX') && ddl.includes('WHERE deleted_at IS NULL'),
      true,
      'Partial unique index (WHERE deleted_at IS NULL) must exist',
    );

    // A plain non-unique index (idx_) for code is fine (for query performance)
    assertEquals(
      ddl.includes('"idx_sd_uq_idx_code"'),
      true,
      'A plain non-unique index for code must still be emitted',
    );
  } finally {
    await cleanupSoftDeleteUniqueIndex();
  }
});

const SCHEMA_MODELS = './test/test-schema-models';
const SCHEMA_OUTPUT = './test/test-schema-generated';

async function cleanupSchemaTest() {
  for (const p of [SCHEMA_MODELS, SCHEMA_OUTPUT]) {
    try {
      await Deno.remove(p, { recursive: true });
    } catch {
      // ignore
    }
  }
}

// Regression: drizzle-orm 0.45+ forbids pgSchema('public'). A model declaring the
// default "public" schema must emit pgTable() directly, not pgSchema('public').
// A genuine non-default schema must still emit pgSchema(<name>).
Deno.test('generator - schema "public" uses pgTable, non-public uses pgSchema', async () => {
  await cleanupSchemaTest();
  await Deno.mkdir(SCHEMA_MODELS, { recursive: true });
  try {
    const publicModel = {
      name: 'PublicEntity',
      tableName: 'public_entity',
      schema: 'public',
      fields: [
        { name: 'id', type: 'uuid', primaryKey: true, defaultValue: 'gen_random_uuid()', required: true },
        { name: 'name', type: 'string', maxLength: 100, required: true },
      ],
    };
    const analyticsModel = {
      name: 'AnalyticsEntity',
      tableName: 'analytics_entity',
      schema: 'analytics',
      fields: [
        { name: 'id', type: 'uuid', primaryKey: true, defaultValue: 'gen_random_uuid()', required: true },
        { name: 'name', type: 'string', maxLength: 100, required: true },
      ],
    };
    await Deno.writeTextFile(`${SCHEMA_MODELS}/public-entity.json`, JSON.stringify(publicModel, null, 2));
    await Deno.writeTextFile(`${SCHEMA_MODELS}/analytics-entity.json`, JSON.stringify(analyticsModel, null, 2));
    await generateFromModels(SCHEMA_MODELS, SCHEMA_OUTPUT);

    const publicSchema = await Deno.readTextFile(`${SCHEMA_OUTPUT}/schema/publicentity.schema.ts`);
    assertEquals(
      publicSchema.includes("pgSchema('public')"),
      false,
      "must NOT emit pgSchema('public') — drizzle 0.45+ forbids it",
    );
    assertEquals(
      publicSchema.includes("publicentityTable = pgTable('public_entity'"),
      true,
      'public-schema model must use pgTable() directly',
    );

    const analyticsSchema = await Deno.readTextFile(`${SCHEMA_OUTPUT}/schema/analyticsentity.schema.ts`);
    assertEquals(
      analyticsSchema.includes("pgSchema('analytics')"),
      true,
      'genuine non-public schema must still emit pgSchema(<name>)',
    );
  } finally {
    await cleanupSchemaTest();
  }
});

const PG_MODELS = './test/test-postgis-models';
const PG_OUTPUT = './test/test-postgis-generated';

async function cleanupPostGIS() {
  for (const p of [PG_MODELS, PG_OUTPUT]) {
    try {
      await Deno.remove(p, { recursive: true });
    } catch { /* ignore */ }
  }
}

async function writePostGISModels(withSpatialField: boolean) {
  await Deno.mkdir(PG_MODELS, { recursive: true });
  const model = {
    name: 'PlainEntity',
    tableName: 'plain_entity',
    fields: [
      { name: 'id', type: 'uuid', primaryKey: true, defaultValue: 'gen_random_uuid()', required: true },
      { name: 'name', type: 'string', maxLength: 100, required: true },
      ...(withSpatialField ? [{ name: 'location', type: 'point', srid: 4326 }] : []),
    ],
  };
  await Deno.writeTextFile(`${PG_MODELS}/plain-entity.json`, JSON.stringify(model, null, 2));
}

Deno.test('generator - no PostGIS extension without spatial fields', async () => {
  await cleanupPostGIS();
  try {
    await writePostGISModels(false);
    await generateFromModels(PG_MODELS, PG_OUTPUT);

    const init = await Deno.readTextFile(`${PG_OUTPUT}/db/initialize-database.ts`);
    // CREATE EXTENSION fails on a plain PostgreSQL without PostGIS installed
    assertEquals(init.includes('CREATE EXTENSION'), false);
    assertEquals(init.toLowerCase().includes('postgis'), false);

    // spatial utilities must not be emitted either
    let spatialUtilsExists = true;
    try {
      await Deno.stat(`${PG_OUTPUT}/schema/spatial-utils.ts`);
    } catch {
      spatialUtilsExists = false;
    }
    assertEquals(spatialUtilsExists, false);
  } finally {
    await cleanupPostGIS();
  }
});

Deno.test('generator - PostGIS extension is created when a model has a spatial field', async () => {
  await cleanupPostGIS();
  try {
    await writePostGISModels(true);
    await generateFromModels(PG_MODELS, PG_OUTPUT);

    const init = await Deno.readTextFile(`${PG_OUTPUT}/db/initialize-database.ts`);
    assertEquals(init.includes('CREATE EXTENSION IF NOT EXISTS postgis'), true);
    assertExists(await Deno.readTextFile(`${PG_OUTPUT}/schema/spatial-utils.ts`));
  } finally {
    await cleanupPostGIS();
  }
});

Deno.test('generator - postgis: false rejects models with spatial fields', async () => {
  await cleanupPostGIS();
  try {
    await writePostGISModels(true);
    // Disabling PostGIS omits both the generated spatial support and the extension,
    // so a spatial field has no valid representation left
    await assertRejects(
      () => generateFromModels(PG_MODELS, PG_OUTPUT, { database: { type: 'postgresql', postgis: false } }),
      Error,
      'PostGIS is disabled but spatial fields are declared',
    );
  } finally {
    await cleanupPostGIS();
  }
});

Deno.test('generator - postgis: false generates normally without spatial fields', async () => {
  await cleanupPostGIS();
  try {
    await writePostGISModels(false);
    await generateFromModels(PG_MODELS, PG_OUTPUT, { database: { type: 'postgresql', postgis: false } });

    const init = await Deno.readTextFile(`${PG_OUTPUT}/db/initialize-database.ts`);
    assertEquals(init.includes('CREATE EXTENSION'), false);
    assertEquals(init.includes('"plain_entity"'), true);
  } finally {
    await cleanupPostGIS();
  }
});

Deno.test('generator - client errors map to HTTP 400 in the REST layer', async () => {
  await cleanupPostGIS();
  try {
    await writePostGISModels(false);
    await generateFromModels(PG_MODELS, PG_OUTPUT);

    const helpers = await Deno.readTextFile(`${PG_OUTPUT}/rest/helpers.ts`);

    // Zod errors are detected structurally: instanceof breaks when the consuming project
    // resolves the root 'zod' namespace while drizzle-zod builds schemas with 'zod/v4'
    assertEquals(helpers.includes("from 'zod'"), false);
    assertEquals(/const isZodError\s*=\s*\(error: unknown\)/.test(helpers), true);
    assertEquals(helpers.includes("=== 'ZodError'"), true);
    assertEquals(/if \(isZodError\(error\)\) \{\s*\n\s*throw new HTTPException\(400/.test(helpers), true);

    // A malformed JSON body is a client error, not a 500
    assertEquals(/export const parseJsonBody\s*=\s*async </.test(helpers), true);
    assertEquals(helpers.includes("throw new HTTPException(400, { message: 'Invalid JSON in request body' })"), true);

    // Handlers must go through parseJsonBody instead of c.req.json()
    const factory = await Deno.readTextFile(`${PG_OUTPUT}/rest/crud.factory.ts`);
    assertEquals(factory.includes('c.req.json()'), false);
    assertEquals(factory.includes('await parseJsonBody<TNew>(c)'), true);
    assertEquals(factory.includes('await parseJsonBody<Partial<TNew>>(c)'), true);
  } finally {
    await cleanupPostGIS();
  }
});

const DEP_MODELS = './test/test-dep-models';
const DEP_OUTPUT = './test/test-dep-generated';

async function cleanupDependencies() {
  for (const p of [DEP_MODELS, DEP_OUTPUT]) {
    try {
      await Deno.remove(p, { recursive: true });
    } catch { /* ignore */ }
  }
}

/**
 * Reads the first ```json import map block that follows a markdown heading
 */
async function readImportMapBlock(path: string, heading: string): Promise<Record<string, string>> {
  const content = await Deno.readTextFile(path);
  const headingIndex = content.indexOf(heading);
  assertEquals(headingIndex >= 0, true, `${path} must contain the heading "${heading}"`);

  const section = content.slice(headingIndex);
  const fenceStart = section.indexOf('```json');
  assertEquals(fenceStart >= 0, true, `${path} must contain a json block under "${heading}"`);

  const bodyStart = fenceStart + '```json'.length;
  const fenceEnd = section.indexOf('```', bodyStart);
  const parsed = JSON.parse(section.slice(bodyStart, fenceEnd)) as { imports: Record<string, string> };
  return parsed.imports;
}

Deno.test('generator - reports the dependencies the generated code imports', async () => {
  await cleanupDependencies();
  try {
    await Deno.mkdir(DEP_MODELS, { recursive: true });
    const model = {
      name: 'DepEntity',
      tableName: 'dep_entity',
      fields: [
        { name: 'id', type: 'uuid', primaryKey: true, defaultValue: 'gen_random_uuid()', required: true },
        { name: 'name', type: 'string', maxLength: 100, required: true },
      ],
    };
    await Deno.writeTextFile(`${DEP_MODELS}/dep-entity.json`, JSON.stringify(model, null, 2));

    const { dependencies } = await generateFromModels(DEP_MODELS, DEP_OUTPUT);

    // Every package the generated files import must have a known version
    assertEquals(dependencies.unresolved, []);
    // The set is scanned from the emitted files, sorted by package name
    assertEquals(Object.keys(dependencies.runtime), [
      '@hono/hono',
      'drizzle-orm',
      'drizzle-zod',
      'postgres',
      'zod',
    ]);
    // openapi-types is only ever imported as a type
    assertEquals(Object.keys(dependencies.types), ['openapi-types']);
    // Scalar is never imported by the generated code - it stays an optional suggestion
    assertEquals(Object.keys(dependencies.optional), ['@scalar/hono-api-reference']);
  } finally {
    await cleanupDependencies();
  }
});

Deno.test('generator - dependency contract is in sync across docs and example', async () => {
  // The generator emits no deno.json, so the same contract is duplicated in the docs.
  // This is the drift guard: all four copies must agree.
  const expected = Object.fromEntries(
    Object.entries(GENERATED_CODE_DEPENDENCIES).map(([name, dependency]) => [name, dependency.specifier]),
  );

  assertEquals(await readImportMapBlock('README.md', '### Generated Code Dependencies'), expected);
  assertEquals(await readImportMapBlock('AGENTS.md', '## Dependencies (Generated Code)'), expected);

  const exampleConfig = JSON.parse(await Deno.readTextFile('example/deno.json')) as {
    imports: Record<string, string>;
  };
  for (const [name, specifier] of Object.entries(expected)) {
    assertEquals(exampleConfig.imports[name], specifier, `example/deno.json must pin ${name} as ${specifier}`);
  }
});

const SCHEMA_DDL_MODELS = './test/test-schema-ddl-models';
const SCHEMA_DDL_OUTPUT = './test/test-schema-ddl-generated';

async function cleanupSchemaDDL() {
  for (const p of [SCHEMA_DDL_MODELS, SCHEMA_DDL_OUTPUT]) {
    try {
      await Deno.remove(p, { recursive: true });
    } catch { /* ignore */ }
  }
}

// Regression: the Drizzle schema wraps a non-default schema in pgSchema(), so the DDL has to
// create that schema and qualify every table reference with it. Unqualified DDL creates the
// table in the default schema while the ORM queries the declared one.
Deno.test('generator - DDL creates and qualifies a non-default schema', async () => {
  await cleanupSchemaDDL();
  try {
    await Deno.mkdir(SCHEMA_DDL_MODELS, { recursive: true });
    const owner = {
      name: 'Owner',
      tableName: 'owner',
      fields: [
        { name: 'id', type: 'uuid', primaryKey: true, defaultValue: 'gen_random_uuid()', required: true },
        { name: 'name', type: 'string', maxLength: 100, required: true },
      ],
    };
    const report = {
      name: 'Report',
      tableName: 'report',
      schema: 'analytics',
      fields: [
        { name: 'id', type: 'uuid', primaryKey: true, defaultValue: 'gen_random_uuid()', required: true },
        { name: 'title', type: 'string', maxLength: 100, required: true, index: true },
        { name: 'ownerId', type: 'uuid', references: { model: 'Owner', field: 'id' } },
      ],
    };
    await Deno.writeTextFile(`${SCHEMA_DDL_MODELS}/owner.json`, JSON.stringify(owner, null, 2));
    await Deno.writeTextFile(`${SCHEMA_DDL_MODELS}/report.json`, JSON.stringify(report, null, 2));
    await generateFromModels(SCHEMA_DDL_MODELS, SCHEMA_DDL_OUTPUT);

    const init = await Deno.readTextFile(`${SCHEMA_DDL_OUTPUT}/db/initialize-database.ts`);

    // The schema itself has to exist before the tables are created
    assertEquals(init.includes('CREATE SCHEMA IF NOT EXISTS "analytics"'), true);
    assertEquals(init.includes('CREATE SCHEMA IF NOT EXISTS "public"'), false);

    // Every reference to the analytics table is qualified
    assertEquals(init.includes('CREATE TABLE IF NOT EXISTS "analytics"."report"'), true);
    assertEquals(init.includes('DROP TABLE IF EXISTS "analytics"."report" CASCADE'), true);
    assertEquals(/ON "analytics"\."report"/.test(init), true);
    assertEquals(/ALTER TABLE "analytics"\."report" .*REFERENCES "owner"\("id"\)/.test(init), true);

    // A model on the default schema stays unqualified
    assertEquals(init.includes('CREATE TABLE IF NOT EXISTS "owner"'), true);
    assertEquals(init.includes('"public"."owner"'), false);

    // ... and the Drizzle side still agrees with it
    const reportSchema = await Deno.readTextFile(`${SCHEMA_DDL_OUTPUT}/schema/report.schema.ts`);
    assertEquals(reportSchema.includes("pgSchema('analytics')"), true);
    assertEquals(reportSchema.includes("analyticsSchema.table('report'"), true);
  } finally {
    await cleanupSchemaDDL();
  }
});
