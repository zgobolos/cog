import { FieldDefinition, IndexDefinition, ModelDefinition, RelationshipDefinition } from '../types/model.types.ts';
import {
  checkConstraintName,
  fieldIndexName,
  fieldUniqueIndexName,
  junctionForeignKeyName,
  junctionIndexName,
  junctionPrimaryKeyName,
  modelIndexName,
} from '../utils/identifier.utils.ts';
import {
  getCustomSchema,
  getSoftDeleteColumn,
  hasPostGISFields,
  modelsHavePostGISFields,
  normalizeAccept,
  normalizeExpose,
} from '../utils/field.utils.ts';
import { capitalize, toSnakeCase } from '../utils/string.utils.ts';
import { isPostGISType } from '../constants.ts';
import { SpatialUtilsGenerator } from './spatial-utils.generator.ts';

/**
 * Generates Drizzle ORM schema files from model definitions
 */
export class DrizzleSchemaGenerator {
  private models: ModelDefinition[];
  private isCockroachDB: boolean;
  private postgis: boolean;

  constructor(
    models: ModelDefinition[],
    options: {
      isCockroachDB?: boolean;
      postgis?: boolean;
    } = {},
  ) {
    this.models = models;
    this.isCockroachDB = options.isCockroachDB || false;
    this.postgis = options.postgis !== false;
  }

  /**
   * Generate all schema files
   */
  generateSchemas(): Map<string, string> {
    const schemas = new Map<string, string>();

    // Generate individual model schemas
    for (const model of this.models) {
      const schemaContent = this.generateModelSchema(model);
      schemas.set(
        `schema/${model.name.toLowerCase()}.schema.ts`,
        schemaContent,
      );
    }

    // Generate junction tables for manyToMany relationships
    const junctionTables = this.generateJunctionTables();
    for (const [path, content] of junctionTables) {
      schemas.set(path, content);
    }

    // Generate spatial utilities if PostGIS is enabled and any model has PostGIS fields
    if (this.postgis && modelsHavePostGISFields(this.models)) {
      const spatialUtilsGenerator = new SpatialUtilsGenerator();
      const spatialUtilsContent = spatialUtilsGenerator.generate();
      schemas.set('schema/spatial-utils.ts', spatialUtilsContent);
    }

    // Generate relations file
    const relationsContent = this.generateRelations();
    schemas.set('schema/relations.ts', relationsContent);

    // Generate index file that exports everything
    const indexContent = this.generateIndexFile();
    schemas.set('schema/index.ts', indexContent);

    return schemas;
  }

  /**
   * Generate schema for a single model
   */
  private generateModelSchema(model: ModelDefinition): string {
    // Add foreign key fields from incoming relationships
    const enhancedModel = this.addForeignKeyFields(model);

    const imports = this.generateImports(enhancedModel);
    const enumDefinitions = this.generateEnumDefinitions(enhancedModel);
    const tableDefinition = this.generateTableDefinition(enhancedModel);
    const typeExports = this.generateTypeExports(enhancedModel);
    const zodSchemas = this.generateZodSchemas(enhancedModel);
    const fieldMetadata = this.generateFieldMetadata(enhancedModel);

    return `${imports}\n\n${enumDefinitions}${tableDefinition}\n\n${typeExports}\n\n${zodSchemas}\n${fieldMetadata}`;
  }

  /**
   * Generate imports for a model schema
   */
  private generateImports(model: ModelDefinition): string {
    const drizzleImports = new Set<string>();

    // Add table import
    drizzleImports.add('pgTable');
    if (getCustomSchema(model)) {
      drizzleImports.add('pgSchema');
    }

    // Check if model has enum fields
    const hasEnums = model.enums && model.enums.length > 0;
    if (hasEnums) {
      drizzleImports.add('pgEnum');
    }

    // Check if this table has self-referential foreign keys
    const hasSelfReference = model.fields.some((field) =>
      field.references &&
      field.references.model.toLowerCase() === model.name.toLowerCase()
    );

    // Add AnyPgColumn for self-referential tables
    if (hasSelfReference) {
      drizzleImports.add('AnyPgColumn');
    }

    // Add field type imports based on model fields
    for (const field of model.fields) {
      const importType = this.getDrizzleImportForType(field);
      if (importType) {
        drizzleImports.add(importType);
      }
    }

    // Check if we need customType for PostGIS
    if (this.postgis && hasPostGISFields(model)) {
      drizzleImports.add('customType');
    }

    // Ensure bigint is imported when generated timestamp/soft-delete columns are present
    if (model.timestamps || model.softDelete) {
      drizzleImports.add('bigint');
    }

    // Base imports from pg-core and drizzle-orm
    let imports = `import { ${Array.from(drizzleImports).join(', ')} } from 'drizzle-orm/pg-core';\n`;

    // Always add index and check imports since we're using table-level definitions
    imports += `import { index, uniqueIndex, check } from 'drizzle-orm/pg-core';\n`;

    imports += `import { sql } from 'drizzle-orm';\n`;

    // Add drizzle-zod imports for schema validation
    imports += `import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'drizzle-zod';\n`;

    // Add field metadata utilities import
    imports += `import type { FieldMeta } from '../utils/field-meta.utils.ts';\n`;

    // Import spatial utilities if PostGIS fields exist
    if (this.postgis && hasPostGISFields(model)) {
      imports += `import { geoJsonToWKT, wktToGeoJSON, type GeoJSON } from './spatial-utils.ts';\n`;
    }

    // Import other tables referenced by foreign keys in this schema
    const referencedModels = new Set<string>();
    for (const field of model.fields) {
      if (field.references && field.references.model) {
        const refModel = field.references.model;
        if (refModel && refModel.toLowerCase() !== model.name.toLowerCase()) {
          referencedModels.add(refModel);
        }
      }
    }
    for (const refModel of referencedModels) {
      const refLower = refModel.toLowerCase();
      imports += `import { ${refLower}Table } from './${refLower}.schema.ts';\n`;
    }

    return imports;
  }

  /**
   * Get Drizzle import type for a field type
   */
  private getDrizzleImportForType(field: FieldDefinition): string | null {
    const typeMap: Record<string, string | null> = {
      'text': 'text',
      'string': 'varchar',
      'integer': 'integer',
      'bigint': 'bigint',
      'decimal': 'decimal',
      'boolean': 'boolean',
      'date': 'bigint', // Dates are stored as EPOCH milliseconds (bigint)
      'uuid': 'uuid',
      'json': 'json',
      'jsonb': 'jsonb',
      'enum': null, // Enums use pgEnum, not a direct import
      // PostGIS types don't have direct imports, they use customType
      'point': null,
      'linestring': null,
      'polygon': null,
      'multipoint': null,
      'multilinestring': null,
      'multipolygon': null,
      'geometry': null,
      'geography': null,
    };

    return typeMap[field.type] || null;
  }

  /**
   * Generate enum definitions
   */
  private generateEnumDefinitions(model: ModelDefinition): string {
    if (!model.enums || model.enums.length === 0) {
      return '';
    }

    let code = '// Enum definitions\n';

    // Add CockroachDB compatibility note
    if (this.isCockroachDB) {
      code += '// Note: CockroachDB supports enums from v22.2+\n';
      code += '// For earlier versions, consider using varchar with CHECK constraints\n';
    }

    for (const enumDef of model.enums) {
      const enumName = `${enumDef.name.toLowerCase()}Enum`;
      const values = enumDef.values.map((v) => `'${v}'`).join(', ');
      code += `export const ${enumName} = pgEnum('${toSnakeCase(enumDef.name)}', [${values}]);\n`;
    }
    code += '\n';
    return code;
  }

  /**
   * Referential actions as drizzle's options object.
   *
   * A foreign key does not only say where a row points, it also says what happens when the
   * parent goes away. Without these the database falls back to NO ACTION and the declared
   * intent is silently lost. The model writes them in SQL's uppercase form, drizzle expects
   * lowercase.
   */
  private referentialActions(actions: { onDelete?: string; onUpdate?: string }): string {
    const options = [
      actions.onDelete ? `onDelete: '${actions.onDelete.toLowerCase()}'` : null,
      actions.onUpdate ? `onUpdate: '${actions.onUpdate.toLowerCase()}'` : null,
    ].filter(Boolean);

    return options.length > 0 ? `, { ${options.join(', ')} }` : '';
  }

  /**
   * Referential actions as a drizzle foreignKey() builder chain.
   * A junction row is meaningless once either side is gone, so it cascades by default.
   */
  private junctionReferentialActions(relationship: RelationshipDefinition): string {
    const onDelete = (relationship.onDelete ?? 'CASCADE').toLowerCase();
    const onUpdate = relationship.onUpdate ? `.onUpdate('${relationship.onUpdate.toLowerCase()}')` : '';

    return `.onDelete('${onDelete}')${onUpdate}`;
  }

  /**
   * Index method for a column, or null for the default (btree).
   * GiST for spatial and GIN for JSON are accepted by both PostgreSQL and CockroachDB -
   * CockroachDB maps both onto its inverted indexes.
   */
  private indexMethod(field?: FieldDefinition): string | null {
    if (!field) return null;
    if (isPostGISType(field.type)) return 'gist';
    if (field.type === 'json' || field.type === 'jsonb') return 'gin';
    return null;
  }

  /**
   * Generate table definition
   */
  private generateTableDefinition(model: ModelDefinition): string {
    let code = '';

    // Handle schema if specified. "public" is Postgres' default schema, and
    // drizzle-orm (>=0.45) forbids pgSchema('public') — use pgTable() directly.
    const customSchema = getCustomSchema(model);
    if (customSchema) {
      // Exported on purpose: drizzle-kit discovers declared schemas through the module's
      // exports, and creates (or drops) them accordingly. A non-exported instance makes it
      // treat the schema as unknown and try to drop it.
      code += `export const ${customSchema}Schema = pgSchema('${customSchema}');\n\n`;
    }

    // Start table definition (no type annotation needed)
    const tableFunction = customSchema ? `${customSchema}Schema.table` : 'pgTable';
    const tableName = model.tableName || model.name.toLowerCase();
    code += `export const ${model.name.toLowerCase()}Table = ${tableFunction}('${tableName}', {\n`;

    // Add fields
    const fieldDefinitions: string[] = [];

    for (const field of model.fields) {
      fieldDefinitions.push(this.generateFieldDefinition(field, model));
    }

    // Add timestamp fields if enabled
    if (model.timestamps) {
      const timestampFields = this.generateTimestampFields(model.timestamps);
      fieldDefinitions.push(...timestampFields);
    }

    // Add soft-delete column if enabled (nullable, no default)
    const softDeleteColumn = getSoftDeleteColumn(model);
    if (softDeleteColumn) {
      fieldDefinitions.push(`  deletedAt: bigint('${softDeleteColumn}', { mode: 'number' })`);
    }

    code += fieldDefinitions.map((def) => {
      // For lines with comments, put the comma before the comment
      if (def.includes(' // ')) {
        const [code, comment] = def.split(' // ');
        return `${code}, // ${comment}`;
      }
      return def + ',';
    }).join('\n') + '\n';

    // Close the fields object and start the table-level definitions
    code += '}, (table) => [\n';

    // Generate indexes and checks within the table definition
    const tableConstraints = [];

    // Field-level indexes
    for (const field of model.fields) {
      if (field.index) {
        const method = this.indexMethod(field);
        const target = method ? `.using('${method}', table.${field.name})` : `.on(table.${field.name})`;

        tableConstraints.push(`  index('${fieldIndexName(model, field.name)}')${target}`);
      }
    }

    // Field-level unique → partial unique index for soft-delete models
    const sdCol = getSoftDeleteColumn(model);
    if (sdCol) {
      for (const field of model.fields) {
        if (field.unique) {
          tableConstraints.push(
            `  uniqueIndex('${fieldUniqueIndexName(model, field.name)}')` +
              `.on(table.${field.name}).where(sql\`${sdCol} IS NULL\`)`,
          );
        }
      }
    }

    // Model-level indexes
    if (model.indexes) {
      for (const idx of model.indexes) {
        const indexName = idx.name || modelIndexName(model, idx.fields);
        const indexType = idx.unique ? 'uniqueIndex' : 'index';
        const fields = idx.fields.map((f) => `table.${f}`).join(', ');

        // An explicitly declared method wins, otherwise it follows the first column's type
        const firstField = model.fields.find((f) => f.name === idx.fields[0]);
        const method = idx.type ?? this.indexMethod(firstField);
        const target = method ? `.using('${method}', ${fields})` : `.on(${fields})`;

        // A declared partial condition and the soft-delete filter are combined
        const conditions = [idx.where, idx.unique && sdCol ? `${sdCol} IS NULL` : null].filter(Boolean);
        const partial = conditions.length > 0 ? `.where(sql\`${conditions.join(' AND ')}\`)` : '';

        tableConstraints.push(`  ${indexType}('${indexName}')${target}${partial}`);
      }
    }

    // Check constraints - handle numNotNulls
    if (model.check && model.check.numNotNulls) {
      const constraintDefs = model.check.numNotNulls;

      constraintDefs.forEach((constraint, index) => {
        // Generate numbered constraint name (1-indexed)
        const checkName = checkConstraintName(model, index);
        // Convert field names to snake_case for SQL
        const columnNames = constraint.fields.map((f) => toSnakeCase(f)).join(', ');
        // Use the specified count from constraint.num
        const checkSql = `num_nonnulls(${columnNames}) = ${constraint.num}`;

        tableConstraints.push(`  check('${checkName}', sql\`${checkSql}\`)`);
      });
    }

    code += tableConstraints.join(',\n') + '\n]);';

    return code;
  }

  /**
   * Generate field definition
   */
  private generateFieldDefinition(
    field: FieldDefinition,
    model: ModelDefinition,
  ): string {
    let definition = `  ${field.name}: `;
    let comment = '';

    // Generate the field type
    switch (field.type) {
      case 'text':
        definition += `text('${toSnakeCase(field.name)}')`;
        break;
      case 'string':
        definition += `varchar('${toSnakeCase(field.name)}'${
          field.maxLength ? `, { length: ${field.maxLength} }` : ''
        })`;
        break;
      case 'integer':
        definition += `integer('${toSnakeCase(field.name)}')`;
        break;
      case 'bigint':
        // mode: 'number' returns JavaScript numbers (safe for EPOCH milliseconds)
        definition += `bigint('${toSnakeCase(field.name)}', { mode: 'number' })`;
        break;
      case 'decimal': {
        const decimalOpts = [];
        if (field.precision) decimalOpts.push(`precision: ${field.precision}`);
        if (field.scale !== undefined) {
          decimalOpts.push(`scale: ${field.scale}`);
        }
        definition += `decimal('${toSnakeCase(field.name)}'${
          decimalOpts.length ? `, { ${decimalOpts.join(', ')} }` : ''
        })`;
        break;
      }
      case 'boolean':
        definition += `boolean('${toSnakeCase(field.name)}')`;
        break;
      case 'date':
        // Store dates as EPOCH milliseconds (bigint)
        // mode: 'number' returns JavaScript numbers (safe for EPOCH milliseconds)
        definition += `bigint('${toSnakeCase(field.name)}', { mode: 'number' })`;
        break;
      case 'uuid':
        definition += `uuid('${toSnakeCase(field.name)}')`;
        break;
      case 'json':
        definition += `json('${toSnakeCase(field.name)}')`;
        break;
      case 'jsonb':
        definition += `jsonb('${toSnakeCase(field.name)}')`;
        break;
      case 'enum':
        definition += this.generateEnumField(field, model);
        break;
      case 'point':
      case 'linestring':
      case 'polygon':
      case 'multipoint':
      case 'multilinestring':
      case 'multipolygon':
      case 'geometry':
      case 'geography':
        if (this.postgis) {
          definition += this.generatePostGISField(field);
        } else {
          // Fall back to JSONB when PostGIS is disabled
          definition += `jsonb('${toSnakeCase(field.name)}')`;
        }
        break;
      default:
        definition += `text('${toSnakeCase(field.name)}')`;
    }

    // Add modifiers
    const modifiers: string[] = [];

    if (field.primaryKey) {
      modifiers.push('.primaryKey()');
    }

    // For soft-delete models, uniqueness is enforced via a partial unique index
    // (see table-level constraints) so live rows are unique but soft-deleted rows
    // do not reserve the value. A plain .unique() cannot be partial.
    if (field.unique && !getSoftDeleteColumn(model)) {
      modifiers.push('.unique()');
    }

    if (field.required || field.primaryKey) {
      modifiers.push('.notNull()');
    }

    if (field.defaultValue !== undefined) {
      if (
        typeof field.defaultValue === 'string' &&
        field.defaultValue.includes('()')
      ) {
        // SQL function
        modifiers.push(`.default(sql\`${field.defaultValue}\`)`);
      } else if (typeof field.defaultValue === 'string') {
        modifiers.push(`.default('${field.defaultValue}')`);
      } else {
        modifiers.push(`.default(${field.defaultValue})`);
      }
    }

    if (field.references) {
      const target = `${field.references.model.toLowerCase()}Table.${field.references.field}`;
      const actions = this.referentialActions(field.references);

      // Check if this is a self-reference
      if (field.references.model.toLowerCase() === model.name.toLowerCase()) {
        // Use AnyPgColumn type hint for self-references
        modifiers.push(`.references((): AnyPgColumn => ${target}${actions})`);
        comment = ' // Self-reference: AnyPgColumn breaks circular type dependency';
      } else {
        modifiers.push(`.references(() => ${target}${actions})`);
      }
    }

    if (field.array) {
      modifiers.push('.array()');
    }

    definition += modifiers.join('') + comment;

    return definition;
  }

  /**
   * Generate enum field definition
   */
  private generateEnumField(field: FieldDefinition, model: ModelDefinition): string {
    const fieldName = toSnakeCase(field.name);

    // Check if using named enum from model.enums
    if (field.enumName) {
      const enumDef = model.enums?.find((e) => e.name === field.enumName);
      if (!enumDef) {
        throw new Error(`Enum '${field.enumName}' not found in model '${model.name}'`);
      }

      // Check if using bitwise storage
      if (enumDef.useBitwise) {
        // Store as integer for bitwise operations
        return `integer('${fieldName}')`;
      } else {
        // Use pgEnum
        const enumName = `${enumDef.name.toLowerCase()}Enum`;
        return `${enumName}('${fieldName}')`;
      }
    }

    // Inline enum values (create inline pgEnum)
    if (field.enumValues) {
      // For inline enums, create an inline pgEnum - not recommended but supported
      const _values = field.enumValues.map((v) => `'${v}'`).join(', ');
      const _enumName = `${field.name.toLowerCase()}Enum`;
      // This would need to be defined earlier - for now throw error
      throw new Error(
        `Field '${field.name}' uses inline enumValues. Please define enums in model.enums instead.`,
      );
    }

    throw new Error(`Enum field '${field.name}' must have either enumName or enumValues`);
  }

  /**
   * Generate PostGIS field definition
   */
  private generatePostGISField(field: FieldDefinition): string {
    const fieldName = toSnakeCase(field.name);
    const geometryType = field.geometryType || field.type.toUpperCase();
    const srid = field.srid || 4326;
    const isGeography = field.type === 'geography';
    // drizzle-kit renders any type it does not know natively as a quoted identifier. It knows
    // "geometry", so geometry(SUBTYPE, SRID) comes out as a real type, but a parameterised
    // geography would become the invalid "geography(...)" - so geography stays unmodified.
    const columnType = isGeography ? 'geography' : `geometry(${geometryType}, ${srid})`;

    // Use customType for PostGIS fields since Drizzle doesn't have native support
    // Convert between GeoJSON (JavaScript standard) and WKT (PostGIS format)
    // Supports both PostgreSQL (GEOMETRY/GEOGRAPHY) and CockroachDB (GEOMETRY only)
    const code = [
      `customType<{`,
      `    data: GeoJSON;`,
      `    driverData: string;`,
      `  }>({`,
      `    dataType() {`,
      `      return '${columnType}';`,
      `    },`,
      `    toDriver(value: GeoJSON): string {`,
      `      return geoJsonToWKT(value, ${srid});`,
      `    },`,
      `    fromDriver(value: string): GeoJSON {`,
      `      return wktToGeoJSON(value);`,
      `    }`,
      `  })('${fieldName}')`,
    ].join('\n');

    return code;
  }

  /**
   * Generate timestamp fields
   */
  private generateTimestampFields(
    timestamps: boolean | { createdAt?: string | boolean; updatedAt?: string | boolean },
  ): string[] {
    const fields: string[] = [];

    // Timestamps are stored as EPOCH milliseconds (bigint)
    // mode: 'number' returns JavaScript numbers (safe for EPOCH milliseconds)
    const defaultEpochMillis = `sql\`(extract(epoch from now()) * 1000)::bigint\``;

    if (timestamps === true) {
      fields.push(
        `  createdAt: bigint('created_at', { mode: 'number' }).default(${defaultEpochMillis}).notNull()`,
      );
      fields.push(
        `  updatedAt: bigint('updated_at', { mode: 'number' }).default(${defaultEpochMillis}).notNull()`,
      );
    } else if (typeof timestamps === 'object') {
      if (timestamps.createdAt) {
        const fieldName = typeof timestamps.createdAt === 'string' ? timestamps.createdAt : 'created_at';
        fields.push(
          `  createdAt: bigint('${fieldName}', { mode: 'number' }).default(${defaultEpochMillis}).notNull()`,
        );
      }
      if (timestamps.updatedAt) {
        const fieldName = typeof timestamps.updatedAt === 'string' ? timestamps.updatedAt : 'updated_at';
        fields.push(
          `  updatedAt: bigint('${fieldName}', { mode: 'number' }).default(${defaultEpochMillis}).notNull()`,
        );
      }
    }

    return fields;
  }

  /**
   * Generate modern index definition (outside of table definition)
   */
  private generateModernIndexDefinition(tableName: string, idx: IndexDefinition): string {
    const indexName = idx.name || `idx_${tableName}_${idx.fields.join('_')}`;
    const indexType = idx.unique ? 'uniqueIndex' : 'index';
    const fields = idx.fields.map((f: string) => `${tableName}Table.${f}`);

    // Check if any of the fields is a PostGIS type
    const model = this.models.find((m) => m.name.toLowerCase() === tableName);
    const firstField = model?.fields.find((f) => f.name === idx.fields[0]);
    const isPostGISIdx = firstField && isPostGISType(firstField.type);

    let definition = `export const ${indexName} = ${indexType}('${indexName}')`;

    // For PostGIS fields, use GiST index method
    if (isPostGISIdx) {
      definition += `\n  .using('gist', ${fields.join(', ')})`;
    } else {
      // For normal fields, use the new .on() API
      definition += `\n  .on(${fields.join(', ')})`;
    }

    if (idx.where) {
      definition += `\n  .where(sql\`${idx.where}\`)`;
    }

    // Add concurrent creation for PostgreSQL (not supported in CockroachDB)
    if (!this.isCockroachDB) {
      definition += '\n  .concurrently()';
    }

    definition += ';';
    return definition;
  }

  /**
   * Generate junction tables for manyToMany relationships
   */
  private generateJunctionTables(): Map<string, string> {
    const junctionTables = new Map<string, string>();
    const processedJunctions = new Set<string>();

    for (const model of this.models) {
      if (!model.relationships) continue;

      for (const rel of model.relationships) {
        if (rel.type === 'manyToMany' && rel.through) {
          // Avoid generating the same junction table twice
          if (processedJunctions.has(rel.through)) continue;
          processedJunctions.add(rel.through);

          const junctionSchema = this.generateJunctionTableSchema(
            model,
            rel,
            rel.through,
          );

          junctionTables.set(
            `schema/${rel.through.toLowerCase()}.schema.ts`,
            junctionSchema,
          );
        }
      }
    }

    return junctionTables;
  }

  /**
   * Generate schema for a junction table
   */
  private generateJunctionTableSchema(
    sourceModel: ModelDefinition,
    relationship: RelationshipDefinition,
    tableName: string,
  ): string {
    // Find the target model
    const targetModel = this.models.find((m) => m.name === relationship.target);
    if (!targetModel) {
      throw new Error(`Target model ${relationship.target} not found for relationship ${relationship.name}`);
    }

    // Find the primary key fields
    const sourcePK = sourceModel.fields.find((f) => f.primaryKey);
    const targetPK = targetModel.fields.find((f) => f.primaryKey);

    if (!sourcePK || !targetPK) {
      throw new Error(`Primary keys not found for junction table ${tableName}`);
    }

    // Determine the foreign key column names
    const sourceFKColumn = relationship.foreignKey || toSnakeCase(sourceModel.name) + '_id';
    const targetFKColumn = relationship.targetForeignKey || toSnakeCase(targetModel.name) + '_id';

    // Determine what imports we need based on the primary key types
    // Note: timestamps are stored as EPOCH milliseconds using bigint
    const imports = new Set<string>(['pgTable', 'bigint', 'primaryKey', 'foreignKey', 'index']);

    // Add the appropriate type import for each foreign key
    const sourceDrizzleType = this.getDrizzleImportForType(sourcePK);
    if (sourceDrizzleType) imports.add(sourceDrizzleType);
    else if (sourcePK.type === 'uuid') imports.add('uuid');

    const targetDrizzleType = this.getDrizzleImportForType(targetPK);
    if (targetDrizzleType) imports.add(targetDrizzleType);
    else if (targetPK.type === 'uuid') imports.add('uuid');

    // Generate imports
    let code = `import { ${Array.from(imports).join(', ')} } from 'drizzle-orm/pg-core';
`;
    code += `import { sql } from 'drizzle-orm';\n`;

    // Import source table
    code += `import { ${sourceModel.name.toLowerCase()}Table } from './${sourceModel.name.toLowerCase()}.schema.ts';
`;

    // Import target table only if different from source (avoid duplicate imports in self-referential relationships)
    if (sourceModel.name.toLowerCase() !== targetModel.name.toLowerCase()) {
      code += `import { ${targetModel.name.toLowerCase()}Table } from './${targetModel.name.toLowerCase()}.schema.ts';
`;
    }

    // Add Zod imports for validation
    code += `import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'drizzle-zod';\n`;
    code += `\n`;

    // Generate table definition
    code += `export const ${tableName.toLowerCase()}Table = pgTable('${tableName.toLowerCase()}', {
`;

    // Generate source foreign key column
    code += this.generateJunctionFKColumn(sourceFKColumn, sourcePK);
    code += `,
`;

    // Generate target foreign key column
    code += this.generateJunctionFKColumn(targetFKColumn, targetPK);

    // Add timestamps if enabled globally (stored as EPOCH milliseconds)
    // mode: 'number' returns JavaScript numbers (safe for EPOCH milliseconds)
    const hasTimestamps = sourceModel.timestamps || targetModel.timestamps;
    if (hasTimestamps) {
      code +=
        `,\n  createdAt: bigint('created_at', { mode: 'number' }).default(sql\`(extract(epoch from now()) * 1000)::bigint\`).notNull()`;
    }

    code += `\n}, (table) => [\n`;

    // Add composite primary key
    // Constraints are named explicitly: drizzle derives names by concatenating table and
    // column names of both sides, which for a junction table exceeds the 63 byte identifier
    // limit and can collide with the primary key's name once the database truncates it.
    code += `  primaryKey({ columns: [table.${sourceFKColumn}, table.${targetFKColumn}], ` +
      `name: '${junctionPrimaryKeyName(tableName)}' }),\n`;

    const junctionActions = this.junctionReferentialActions(relationship);

    code += `  foreignKey({\n` +
      `    columns: [table.${sourceFKColumn}],\n` +
      `    foreignColumns: [${sourceModel.name.toLowerCase()}Table.${sourcePK.name}],\n` +
      `    name: '${junctionForeignKeyName(tableName, sourceFKColumn)}',\n` +
      `  })${junctionActions},\n`;
    code += `  foreignKey({\n` +
      `    columns: [table.${targetFKColumn}],\n` +
      `    foreignColumns: [${targetModel.name.toLowerCase()}Table.${targetPK.name}],\n` +
      `    name: '${junctionForeignKeyName(tableName, targetFKColumn)}',\n` +
      `  })${junctionActions},\n`;

    // Add indexes for foreign keys
    code += `  index('${junctionIndexName(tableName, sourceFKColumn)}').on(table.${sourceFKColumn}),\n`;
    code += `  index('${junctionIndexName(tableName, targetFKColumn)}').on(table.${targetFKColumn})`;

    code += `\n]);\n`;
    code += `\n`;

    // Add type exports
    code += `// Type exports\n`;
    code += `export type ${capitalize(tableName)} = typeof ${tableName.toLowerCase()}Table.$inferSelect;\n`;
    code += `export type New${capitalize(tableName)} = typeof ${tableName.toLowerCase()}Table.$inferInsert;\n`;
    code += `\n`;

    // Add Zod schemas
    code += `// Zod schemas for validation\n`;
    code +=
      `export const ${tableName.toLowerCase()}InsertSchema = createInsertSchema(${tableName.toLowerCase()}Table);\n`;
    code +=
      `export const ${tableName.toLowerCase()}UpdateSchema = createUpdateSchema(${tableName.toLowerCase()}Table);\n`;
    code +=
      `export const ${tableName.toLowerCase()}SelectSchema = createSelectSchema(${tableName.toLowerCase()}Table);`;

    return code;
  }

  /**
   * Generate foreign key column for junction table
   */
  private generateJunctionFKColumn(columnName: string, pkField: FieldDefinition): string {
    let columnDef = '';

    // Generate the appropriate column type based on the primary key type
    switch (pkField.type) {
      case 'uuid':
        columnDef = `  ${columnName}: uuid('${columnName}')`;
        break;
      case 'string': {
        const maxLength = pkField.maxLength || 255;
        columnDef = `  ${columnName}: varchar('${columnName}', { length: ${maxLength} })`;
        break;
      }
      case 'integer':
        columnDef = `  ${columnName}: integer('${columnName}')`;
        break;
      case 'bigint':
        columnDef = `  ${columnName}: bigint('${columnName}')`;
        break;
      default:
        // Fallback to text for unknown types
        columnDef = `  ${columnName}: text('${columnName}')`;
    }

    // The foreign key is declared at table level so it can carry an explicit, short name
    columnDef += `\n    .notNull()`;

    return columnDef;
  }

  /**
   * Generate relations file
   */
  private generateRelations(): string {
    let code = `import { relations } from 'drizzle-orm';\n`;

    // Import all tables
    for (const model of this.models) {
      code += `import { ${model.name.toLowerCase()}Table } from './${model.name.toLowerCase()}.schema.ts';\n`;
    }

    code += '\n';

    // Generate relations for each model
    for (const model of this.models) {
      if (!model.relationships || model.relationships.length === 0) continue;

      code +=
        `export const ${model.name.toLowerCase()}Relations = relations(${model.name.toLowerCase()}Table, ({ one, many }) => ({\n`;

      const relationDefinitions: string[] = [];

      for (const rel of model.relationships) {
        relationDefinitions.push(this.generateRelationDefinition(model, rel));
      }

      code += relationDefinitions.join(',\n');
      code += '\n}));\n\n';
    }

    return code;
  }

  /**
   * Generate relation definition
   */
  private generateRelationDefinition(
    model: ModelDefinition,
    rel: RelationshipDefinition,
  ): string {
    switch (rel.type) {
      case 'oneToMany':
        return `  ${rel.name}: many(${rel.target.toLowerCase()}Table)`;
      case 'manyToOne':
        return `  ${rel.name}: one(${rel.target.toLowerCase()}Table, {
    fields: [${model.name.toLowerCase()}Table.${rel.foreignKey}],
    references: [${rel.target.toLowerCase()}Table.id]
  })`;
      case 'oneToOne': {
        // Check if the foreign key is on this model's table
        const hasFK = model.fields.some((f) => f.name === rel.foreignKey);
        if (hasFK) {
          // Foreign key is on this table - we own the relationship
          return `  ${rel.name}: one(${rel.target.toLowerCase()}Table, {
    fields: [${model.name.toLowerCase()}Table.${rel.foreignKey}],
    references: [${rel.target.toLowerCase()}Table.id]
  })`;
        } else {
          // Foreign key is on the target table - inverse relationship
          // For inverse oneToOne, we don't specify fields/references in Drizzle
          return `  ${rel.name}: one(${rel.target.toLowerCase()}Table)`;
        }
      }
      case 'manyToMany':
        // Many-to-many relationships are handled through a junction table
        return `  ${rel.name}: many(${rel.target.toLowerCase()}Table)`;
      default:
        return '';
    }
  }

  /**
   * Generate type exports
   */
  private generateTypeExports(model: ModelDefinition): string {
    let code = `// Type exports\n`;
    code += `export type ${model.name} = typeof ${model.name.toLowerCase()}Table.$inferSelect;\n`;
    code += `export type New${model.name} = typeof ${model.name.toLowerCase()}Table.$inferInsert;`;

    return code;
  }

  /**
   * Generate field metadata for filtering and response sanitization
   * Uses enhanced FieldMeta with all visibility/acceptance flags
   */
  private generateFieldMetadata(model: ModelDefinition): string {
    const modelNameLower = model.name.toLowerCase();
    let code = `\n// Field metadata for filtering and response sanitization\n`;

    // Get all fields including timestamps
    const allFields = this.getAllFieldsWithTimestamps(model);

    // Helper to get effective accept config (primary key defaults to 'create')
    const getEffectiveAccept = (f: FieldDefinition) => {
      if (f.accept) return f.accept;
      if (f.primaryKey) return 'create' as const;
      return undefined;
    };

    // Build fieldMeta map with enhanced metadata
    code += `export const ${modelNameLower}FieldMeta: Map<string, FieldMeta> = new Map([\n`;

    const entries: string[] = [];
    for (const field of allFields) {
      const exposeConfig = normalizeExpose(field.expose);
      const acceptConfig = normalizeAccept(getEffectiveAccept(field));
      const isArray = field.array === true;

      entries.push(
        `  ['${field.name}', { type: '${field.type}', array: ${isArray}, exposeCreate: ${exposeConfig.create}, exposeRead: ${exposeConfig.read}, acceptCreate: ${acceptConfig.create}, acceptUpdate: ${acceptConfig.update} }]`,
      );
    }

    code += entries.join(',\n') + '\n]);\n';

    return code;
  }

  /**
   * Get all fields including generated timestamp fields
   */
  private getAllFieldsWithTimestamps(model: ModelDefinition): FieldDefinition[] {
    const fields = [...model.fields];

    // Add timestamp fields if enabled
    // Timestamps are: expose by default, never accepted from input (server-managed)
    if (model.timestamps === true) {
      fields.push({ name: 'createdAt', type: 'date', expose: 'default', accept: 'never' });
      fields.push({ name: 'updatedAt', type: 'date', expose: 'default', accept: 'never' });
    } else if (typeof model.timestamps === 'object') {
      if (model.timestamps.createdAt) {
        fields.push({ name: 'createdAt', type: 'date', expose: 'default', accept: 'never' });
      }
      if (model.timestamps.updatedAt) {
        fields.push({ name: 'updatedAt', type: 'date', expose: 'default', accept: 'never' });
      }
    }

    // Soft-delete column: hidden from responses, never accepted from input
    if (model.softDelete) {
      fields.push({ name: 'deletedAt', type: 'date', expose: 'hidden', accept: 'never' });
    }

    return fields;
  }

  /**
   * Generate Zod schemas for validation
   */
  private generateZodSchemas(model: ModelDefinition): string {
    const modelNameLower = model.name.toLowerCase();
    let code = `// Zod schemas for validation\n`;

    // Generate Zod schemas - use default generation
    // Note: Spatial/GeoJSON fields are validated at runtime via customType
    // Type safety is ensured via type assertions in the domain layer
    //
    // String/text length bounds (minLength/maxLength) are emitted as per-column
    // refinements so they are enforced at the API layer (insert + update). Only
    // non-array string/text fields are refined: for array fields the element schema
    // is wrapped in z.array(), where .min()/.max() would constrain array length.
    const lengthRefinements = model.fields
      .filter((field) =>
        (field.type === 'string' || field.type === 'text') && !field.array &&
        (field.minLength !== undefined || field.maxLength !== undefined)
      )
      .map((field) => {
        const checks: string[] = [];
        if (field.minLength !== undefined) checks.push(`.min(${field.minLength})`);
        if (field.maxLength !== undefined) checks.push(`.max(${field.maxLength})`);
        return `    ${field.name}: (schema) => schema${checks.join('')},`;
      });

    const refineArg = lengthRefinements.length > 0 ? `, {\n${lengthRefinements.join('\n')}\n  }` : '';

    code += `export const ${modelNameLower}InsertSchema = createInsertSchema(${modelNameLower}Table${refineArg});\n`;
    code += `export const ${modelNameLower}UpdateSchema = createUpdateSchema(${modelNameLower}Table${refineArg});\n`;
    code += `export const ${modelNameLower}SelectSchema = createSelectSchema(${modelNameLower}Table);`;

    return code;
  }

  /**
   * Generate index file
   */
  private generateIndexFile(): string {
    let code = '// Export all schemas and relations\n';

    // Export model schemas
    for (const model of this.models) {
      code += `export * from './${model.name.toLowerCase()}.schema.ts';\n`;
    }

    // Export junction table schemas
    const processedJunctions = new Set<string>();
    for (const model of this.models) {
      if (!model.relationships) continue;
      for (const rel of model.relationships) {
        if (rel.type === 'manyToMany' && rel.through && !processedJunctions.has(rel.through)) {
          processedJunctions.add(rel.through);
          code += `export * from './${rel.through.toLowerCase()}.schema.ts';\n`;
        }
      }
    }

    code += `export * from './relations.ts';\n`;

    return code;
  }

  /**
   * Add foreign key fields from incoming oneToMany relationships
   */
  private addForeignKeyFields(model: ModelDefinition): ModelDefinition {
    // Create a copy of the model to avoid mutations
    const enhancedModel = { ...model, fields: [...model.fields] };

    // Find all models that have oneToMany relationships pointing to this model
    for (const sourceModel of this.models) {
      if (!sourceModel.relationships) continue;

      for (const rel of sourceModel.relationships) {
        if (rel.type === 'oneToMany' && rel.target === model.name) {
          // Check if the foreign key field already exists
          const foreignKeyField = rel.foreignKey || toSnakeCase(sourceModel.name) + 'Id';
          const fieldExists = enhancedModel.fields.some((f) => f.name === foreignKeyField);

          if (!fieldExists) {
            // Find the primary key of the source model
            const sourcePK = sourceModel.fields.find((f) => f.primaryKey);
            if (sourcePK) {
              // Add the foreign key field
              const fkField: FieldDefinition = {
                name: foreignKeyField,
                type: sourcePK.type, // Match the type of the source primary key
                required: false, // Usually nullable for oneToMany
                references: {
                  model: sourceModel.name,
                  field: sourcePK.name,
                },
              };

              // Add index for the foreign key for better performance
              fkField.index = true;

              enhancedModel.fields.push(fkField);
            }
          }
        }
      }
    }

    return enhancedModel;
  }
}
