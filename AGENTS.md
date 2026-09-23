# COG - Technical Reference

**COG (CRUD Operations Generator)** transforms JSON model definitions into production-ready TypeScript backends.

**Stack**: Deno + TypeScript + Drizzle ORM + Hono + Zod + PostgreSQL/CockroachDB

## Project Structure

```
cog/
├── src/
│   ├── cli.ts                              # CLI entry point
│   ├── mod.ts                              # Main generator orchestrator
│   ├── constants.ts                        # Shared constants (POSTGIS_TYPES, etc.)
│   ├── types/model.types.ts                # TypeScript type definitions
│   ├── parser/model-parser.ts              # JSON model validation & parsing
│   ├── utils/
│   │   ├── string.utils.ts                 # String utilities (capitalize, toSnakeCase, toCamelCase)
│   │   ├── field.utils.ts                  # Field normalization, soft-delete column, PostGIS field detection
│   │   └── dependency.utils.ts             # Dependency contract of the generated code (scan + report)
│   └── generators/
│       ├── drizzle-schema.generator.ts     # Drizzle ORM schemas
│       ├── database-init.generator.ts      # DB connection & init
│       ├── domain-api.generator.ts         # Business logic layer (per-model)
│       ├── domain-exceptions.generator.ts  # Exception classes
│       ├── base-domain.generator.ts        # Abstract base domain class
│       ├── junction-utils.generator.ts     # Many-to-many junction utilities
│       ├── rest-api.generator.ts           # Hono REST endpoints (per-model)
│       ├── rest-crud-factory.generator.ts  # Generic CRUD handler factory
│       ├── openapi-metadata.generator.ts   # OpenAPI model metadata
│       ├── openapi-builder.generator.ts    # Dynamic OpenAPI spec builder
│       ├── filter-utils.generator.ts       # Filter system utilities
│       ├── field-meta-utils.generator.ts   # Field metadata utilities
│       └── spatial-utils.generator.ts      # PostGIS GeoJSON conversion
├── test/generator.test.ts                  # Generator unit tests
├── example/
│   ├── models/                             # Example JSON model definitions
│   ├── generated/                          # Example generated code
│   ├── src/main.ts                         # Example server entry point
│   ├── test/integration.test.ts            # Integration tests
│   ├── db-bootstrap.ts                     # Database bootstrap (PostGIS extension)
│   └── db-clean.ts                         # Database cleanup script
├── .github/
│   ├── workflows/ci.yml                    # CI pipeline (lint, check, test, coverage)
│   └── hooks/pre-commit                    # Pre-commit checks on a checkout of the index (never stages)
├── .vscode/                                # VSCode Deno configuration
├── deno.json                               # Root workspace config & tasks
├── AGENTS.md                               # This file
└── README.md                               # User-facing documentation
```

## Deno Tasks Reference

**Root (`deno.json`):**

| Task          | Command                  |
| ------------- | ------------------------ |
| `setup:hooks` | Install pre-commit hook  |
| `fmt`         | Format code              |
| `fmt:check`   | Check formatting         |
| `lint`        | Lint src/                |
| `check`       | Type check src/          |
| `test`        | Run generator tests      |
| `cov`         | Generate coverage report |

**Example (`example/deno.json`):**

| Task                | Command                   |
| ------------------- | ------------------------- |
| `cog:psql:generate` | Generate for PostgreSQL   |
| `cog:crdb:generate` | Generate for CockroachDB  |
| `db:bootstrap`      | Prepare extensions        |
| `drizzle:push`      | Sync schema (dev/test)    |
| `drizzle:generate`  | Create a migration        |
| `drizzle:migrate`   | Apply migrations          |
| `db:clean`          | Clean database            |
| `fmt` / `fmt:check` | Format / check formatting |
| `lint` / `check`    | Lint / type check         |
| `test:integration`  | Run integration tests     |

## Generated Code Architecture

```
generated/
├── index.ts                    # initializeGenerated() entry point
├── drizzle.config.ts           # drizzle-kit config (schema path, filters, credentials)
├── db/
│   ├── database.ts             # Connection pooling, transactions, after-commit queue
│   └── bootstrap.ts            # PostGIS extension (PostgreSQL only)
├── schema/
│   ├── [model].schema.ts       # Drizzle tables + Zod schemas
│   ├── spatial-utils.ts        # GeoJSON <-> WKT conversion
│   └── relations.ts            # Drizzle relationships
├── domain/
│   ├── [model].domain.ts       # CRUD operations with hooks (per-model)
│   ├── base.domain.ts          # Abstract base class with shared CRUD logic
│   ├── junction.utils.ts       # Many-to-many relationship utilities
│   ├── exceptions.ts           # DomainException, NotFoundException
│   └── hooks.types.ts          # Hook type definitions
├── utils/
│   ├── filter.utils.ts         # Filter parsing & SQL building
│   └── field-meta.utils.ts     # Field metadata utilities
└── rest/
    ├── [model].rest.ts         # Hono REST endpoints (thin routing layer)
    ├── crud.factory.ts         # Generic CRUD handler factory
    ├── openapi.ts              # Dynamic OpenAPI spec builder
    ├── openapi-metadata.ts     # Model metadata for OpenAPI
    ├── types.ts                # Shared REST types
    └── helpers.ts              # Shared REST helpers
```

## Database Lifecycle

COG generates **no DDL**. The generated Drizzle schema is the single source of truth and drizzle-kit turns it into
tables, so one description produces one database and there is a real migration path.

**Two vocabularies, one word.** `cog:*:generate` produces the _current_ schema from the models and never migration
material. `drizzle-kit generate` diffs that schema against its own snapshot history and writes migration SQL. The
example tasks keep them apart: `cog:psql:generate` / `cog:crdb:generate` are COG's, `drizzle:push`, `drizzle:generate`
and `drizzle:migrate` are drizzle-kit's. The generated output is a plain Drizzle schema and a plain `drizzle.config.ts`,
so everything in the drizzle-kit documentation applies to it unchanged.

| Step        | Command                                   | When                                                           |
| ----------- | ----------------------------------------- | -------------------------------------------------------------- |
| Bootstrap   | `db:bootstrap`                            | Before the first push/migrate. Installs the PostGIS extension. |
| Development | `drizzle:push`                            | Syncs the database to the schema, no migration files.          |
| Production  | `drizzle:generate` then `drizzle:migrate` | Versioned migration files, committed to the repository.        |

**The two paths are exclusive per database.** `push` writes no migration history, so a pushed database cannot be
migrated later: the first `generate` emits a full `CREATE TABLE` baseline and `migrate` fails against the tables that
already exist. `db/bootstrap.ts` is runnable on its own (`deno run -A --env-file=.env <generated>/db/bootstrap.ts`), so
a consuming project needs no wrapper script.

- The `pgSchema()` instance of a non-default schema is **exported** on purpose: drizzle-kit discovers declared schemas
  through the module's exports and creates them. A non-exported instance makes it try to _drop_ the schema.
- `drizzle.config.ts` carries `schemaFilter` for every schema the models use, and `extensionsFilters: ['postgis']` when
  spatial fields exist - otherwise push offers to drop `spatial_ref_sys`, PostGIS' own table.
- Credentials come from `process.env.DB_URL`: drizzle-kit loads its config with its own loader, not Deno's dotenv, so
  the tasks pass `--env-file`.
- Junction table constraints are named explicitly. drizzle derives names by concatenating both sides, which for a
  junction table exceeds the 63 byte identifier limit and collides with the primary key's name after truncation.
- The same schema serves both databases: CockroachDB accepts `USING GIST` and `USING GIN` (mapped onto its inverted
  indexes) and has native `GEOMETRY`/`GEOGRAPHY`.
- A `geography` column is emitted without a type modifier. drizzle-kit renders any type it does not know natively as a
  quoted identifier, and `"geography(Point,4326)"` is not a type - plain `"geography"` is.

## Architecture Patterns

### REST Layer (Thin Routing)

REST files are thin routing layers that delegate to the CRUD factory:

```typescript
// [model].rest.ts - delegates to factory
const config: CrudConfig<Model, NewModel> = {
  domain: modelDomain,
  fieldMeta: modelFieldMeta,
  modelName: 'Model',
  endpoints: { readMany: true, readOne: true, create: true, update: true, delete: true },
};
registerCrudRoutes(this.routes, config);
```

The `crud.factory.ts` provides generic handlers (`createListHandler`, `createGetByIdHandler`, etc.) that:

1. Parse query parameters (limit, offset, orderBy, include, where)
2. Validate filters against field metadata
3. Call domain methods
4. Convert BigInt to Number for JSON serialization

### Domain Layer (Business Logic)

Each model has a domain class with CRUD operations and hook orchestration:

- `create()`, `findById()`, `findMany()`, `update()`, `delete()`
- Hook flow: before → validate → pre → DB operation → post → after
- Relationship loading via `include` parameter
- Field sanitization (strip unexposed/unaccepted fields)

The `base.domain.ts` provides an abstract `BaseDomain<T, TNew>` class with shared CRUD logic. The `junction.utils.ts`
provides utilities for many-to-many relationships.

### OpenAPI (Dynamic Generation)

OpenAPI spec is built dynamically from metadata at runtime:

- `openapi-metadata.ts` - exports model metadata (fields, relationships, endpoints)
- `openapi.ts` - builds OpenAPI 3.1.0 spec from metadata using `buildOpenAPISpec()`

## Model Definition

```json
{
  "name": "User",
  "tableName": "user",
  "schema": "public",
  "enums": [{ "name": "AccountType", "values": ["free", "premium"] }],
  "fields": [
    { "name": "id", "type": "uuid", "primaryKey": true, "defaultValue": "gen_random_uuid()", "required": true },
    { "name": "email", "type": "string", "maxLength": 255, "required": true, "unique": true }
  ],
  "relationships": [{ "type": "oneToMany", "name": "postList", "target": "Post", "foreignKey": "authorId" }],
  "indexes": [{ "fields": ["email", "isActive"], "unique": true }],
  "check": { "numNotNulls": [{ "fields": ["field1", "field2"], "num": 1 }] },
  "endpoints": { "create": true, "readOne": true, "readMany": true, "update": true, "delete": true },
  "timestamps": true,
  "softDelete": true
}
```

**`schema`**: `"public"` and an omitted value both mean Postgres' default schema (`getCustomSchema` in
`src/utils/field.utils.ts` is the shared rule — drizzle-orm >=0.45 forbids `pgSchema('public')`). Any other value is
emitted as `CREATE SCHEMA IF NOT EXISTS` and qualifies every DDL statement of the model: `CREATE TABLE`, `DROP TABLE`,
`CREATE INDEX ... ON`, `ALTER TABLE` and the `REFERENCES` target of incoming foreign keys. The DDL side and the Drizzle
`pgSchema()` wrapper must stay in agreement — an unqualified `CREATE TABLE` puts the table in the default schema while
the ORM queries the declared one. Junction tables are always created in the default schema, mirroring their `pgTable()`
definition.

## Data Types

| Category   | Types                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| Primitives | `text`, `string`, `integer`, `bigint`, `decimal`, `boolean`, `uuid`                                        |
| Date       | `date` - stored as EPOCH milliseconds (`bigint`)                                                           |
| Structured | `json`, `jsonb`, `enum` (standard or bitwise)                                                              |
| Spatial    | `point`, `linestring`, `polygon`, `multipoint`, `multilinestring`, `multipolygon`, `geometry`, `geography` |
| Arrays     | Any type with `"array": true`                                                                              |

**Notes:**

- Date fields: API uses numeric timestamps (e.g., `1704067200000`), stored as `bigint`
- Spatial fields: API uses GeoJSON, stored as WKT/EWKB
- `CREATE EXTENSION IF NOT EXISTS postgis` is emitted into `db/bootstrap.ts` **only** for PostgreSQL and only when at
  least one model declares a spatial field, so a project without spatial fields initializes on a plain PostgreSQL.
  CockroachDB has spatial support built in and does not implement `CREATE EXTENSION`, so it never gets the statement;
  `GEOGRAPHY` is a native, indexable type there as well
- `postgis: false` (`--no-postgis`) turns PostGIS off completely — no spatial support in the generated code and no
  extension statement. Declaring a spatial field is then a configuration error: `generateFromModels` throws and names
  the offending fields instead of downgrading the columns
- Numeric defaults limited to `Number.MAX_SAFE_INTEGER` (2^53-1)

## Field Properties

| Property     | Values                                   | Description                        |
| ------------ | ---------------------------------------- | ---------------------------------- |
| `expose`     | `default`, `hidden`, `create`            | Controls response visibility       |
| `accept`     | `default`, `create`, `never`             | Controls input acceptance          |
| `references` | `{ model, field, onDelete?, onUpdate? }` | Foreign key definition             |
| `maxLength`  | `number`                                 | String/text max length (see below) |
| `minLength`  | `number`                                 | String/text min length (Zod check) |

**`expose`**: `hidden` = never visible, `create` = visible only in POST response **`accept`**: `create` = immutable
after creation, `never` = server-managed (use hook or defaultValue)

**`minLength` / `maxLength`** (string/text only): emitted as Zod refinements on the generated insert/update schemas, so
both bounds are enforced at the API layer on create and update. A violation throws a `ZodError` → **HTTP 400**.
`maxLength` additionally sets the `varchar` column length for `string` fields (`text` columns stay unbounded). Not
applied to array fields (`"array": true`), where a length check would constrain the array, not its elements.

## Relationships

| Type         | Description       | Generates Endpoints |
| ------------ | ----------------- | ------------------- |
| `oneToMany`  | Parent → Children | No                  |
| `manyToOne`  | Child → Parent    | No                  |
| `manyToMany` | Junction table    | Yes                 |
| `oneToOne`   | Direct link       | No                  |

**Many-to-Many Endpoints:**

```
GET    /:id/{relation}List     POST   /:id/{relation}List     POST   /:id/{relation}
PUT    /:id/{relation}List     DELETE /:id/{relation}List     DELETE /:id/{relation}/:targetId
```

**Relationship endpoint configuration:**

```json
{ "type": "manyToMany", "endpoints": { "get": true, "add": true, "remove": true, "replace": false } }
```

## Hook System

```
Before-hook (outside tx) → Zod validation → Begin TX → Pre-hook → Zod → DB op → Post-hook → Commit → After-hook
```

| Hook           | Signature                                                | When                |
| -------------- | -------------------------------------------------------- | ------------------- |
| `beforeCreate` | `(rawInput, ctx?) => Promise<unknown>`                   | Before validation   |
| `preCreate`    | `(input, rawInput, tx, ctx?) => Promise<input>`          | Before DB operation |
| `postCreate`   | `(input, result, rawInput, tx, ctx?) => Promise<result>` | After DB (in tx)    |
| `afterCreate`  | `(result, rawInput, ctx?) => Promise<void>`              | After commit        |

Same pattern for `Update`, `Delete`, `FindById`, `FindMany`, and junction operations (`AddJunction`, `RemoveJunction`).

**Context**: `{ requestId, userId, metadata }` - set via Hono middleware

**After-hooks are bound to the transaction's outcome.** A domain method does not start its after-hook, it hands it to
`runAfterCommit(tx, task)` (generated `db/database.ts`), which queues it on the transaction it runs in:

- The queue is a `WeakMap` keyed by the transaction object, so it travels wherever `tx` is passed and no signature
  changed. Neither drizzle nor postgres-js has an on-commit callback; the promise of `database.transaction()` is the
  signal, since postgres-js resolves it only after `COMMIT` succeeded (a failing `COMMIT` rejects it).
- `withTransaction` creates a fresh queue per attempt and starts it after that promise resolved, in scheduling order,
  not awaited (`setTimeout(0)` per task, failures go to the configured logger). A rollback, a failing `COMMIT` and a
  failed attempt before a 40001 retry all drop the queue.
- `withNestedTransaction(parent, cb)` opens a savepoint with its own queue. A savepoint is not a commit: on success its
  queue is appended to the parent's, on failure it is dropped. A drizzle `tx.transaction()` returns a new tx object with
  no reference to its parent, which is why nesting has to go through COG.
- A transaction COG did not open (plain `db.transaction()` / `tx.transaction()`) has no queue: `runAfterCommit` throws
  rather than lose the hook silently. Without a transaction (reads) the hook starts right away.
- After-hooks receive the same result the caller gets (sanitized unless `skipSanitization`), so they are scheduled after
  the sanitization step.
- Delivery is at most once: a process that stops right after `COMMIT`, or a connection that breaks during it (an
  ambiguous commit, `40003` on CockroachDB), never runs the hook. A side effect that must not be missed needs an outbox
  row written in the same transaction.

The previous `setTimeout(0)` inside the transaction callback fired before the `COMMIT` round trip finished (other
connections still saw the old state), ran after a rollback, and ran once per retry attempt.

## Exceptions

Domain layer throws `DomainException` or `NotFoundException`. Zod validation (input schema parse) throws `ZodError`.
REST layer (`handleDomainException`) converts these to HTTP status codes.

| Exception               | HTTP Status |
| ----------------------- | ----------- |
| `NotFoundException`     | 404         |
| `ZodError`              | 400         |
| Malformed JSON body     | 400         |
| Unique violation        | 409         |
| Other constraint errors | 400         |
| `DomainException`       | 500         |

`ZodError` → 400 carries the Zod issues array as the message, covering all input validation failures (`minLength`,
`maxLength`, required, enum, type). Exceptions in hooks trigger transaction rollback.

**Zod error detection is structural, not `instanceof`** (`isZodError` in the generated `rest/helpers.ts`): `drizzle-zod`
builds the schemas with the `zod/v4` namespace, while the root `zod` export is the v3-classic namespace on zod 3.25.x
(the package's peer range is `^3.25.0 || ^4.0.0`). An identity check silently fails there and every validation error
surfaces as a 500 — the guard checks `name === 'ZodError'` plus an `issues` array instead, and the generated code no
longer imports `zod` at all.

**Request bodies** are read through `parseJsonBody` (generated `rest/helpers.ts`), never `c.req.json()` directly, so a
malformed body is a 400 instead of an unhandled 500. Call sites pass the expected shape as a type argument
(`parseJsonBody<TNew>(c)`, `parseJsonBody<{ ids?: string[] }>(c)`).

**Database constraint violations** are mapped by SQLSTATE, because the request caused them:

| SQLSTATE          | Condition             | HTTP |
| ----------------- | --------------------- | ---- |
| `23505`           | unique violation      | 409  |
| `23001`           | restrict violation    | 409  |
| `23502`           | not-null violation    | 400  |
| `23503`           | foreign key violation | 400  |
| `23503` on delete | row still referenced  | 409  |
| `23514`           | check violation       | 400  |
| `22001`           | value too long        | 400  |
| `22007` / `22P02` | invalid format        | 400  |

`23503` means two things: a write that references a missing row (400) and a delete of a row that is still referenced
(409). PostgreSQL reports a `NO ACTION` refusal as `23503` and a `RESTRICT` one as `23001`; CockroachDB reports both as
`23503`. The message text would tell the cases apart, but PostgreSQL localizes it (`lc_messages`), so the rule is keyed
on the operation: the CRUD factory's delete handler calls `handleDomainException(error, 'delete')`, which applies
`DELETE_STATUS_BY_SQLSTATE` before the general table. Every other handler keeps the general mapping.

The response message names the violated constraint when the driver reports one. Drizzle wraps driver errors in a
`DrizzleQueryError`, so the code is read from `error.cause` first, falling back to the error itself. Any other SQLSTATE
stays a 500: that is an outage or a bug, not a client mistake.

## Soft Delete

Opt-in per model. Off by default.

**Configuration:**

```json
{ "softDelete": true }
{ "softDelete": { "deletedAt": "custom_column_name" } }
```

- `true` — use the default `deleted_at` column name
- `{ "deletedAt": "<name>" }` — use a custom column name (camelCase, snake_case in DB)

Default column: `deleted_at` (camelCase: `deletedAt`). Nullable `bigint` epoch-ms, no default value. `expose: hidden`,
`accept: never` — never visible in API responses, never accepted as input.

**Behavior:**

| Scenario                                | Result                                                          |
| --------------------------------------- | --------------------------------------------------------------- |
| `delete()` on live record               | Sets `deletedAt` to current epoch-ms (no UPDATE to `updatedAt`) |
| `delete()` on soft-deleted record       | 404 NotFoundException                                           |
| `update()` on soft-deleted record       | 404 NotFoundException                                           |
| `findMany()` / `findById()`             | Excludes soft-deleted rows automatically                        |
| `withSoftDeleted: true` (domain option) | Bypasses the filter — for internal reads only, not REST-exposed |
| Restore                                 | Not supported in v1                                             |

**Unique constraints with soft delete:** Field-level `unique: true` and model-level `indexes` unique constraints are
emitted as partial indexes (`WHERE deleted_at IS NULL`) so a soft-deleted row does not reserve its unique value.

**Relationship propagation:**

- `?include=` of a `oneToMany`/`manyToMany` relation excludes soft-deleted children/targets.
- `?include=` of a `manyToOne`/`oneToOne` relation resolves to `null` when the referenced row is soft-deleted.
- Many-to-many `GET /:id/{relation}List` endpoint excludes soft-deleted targets.
- Junction tables themselves are always hard-deleted.

**Database compatibility:** Requires partial index support — CockroachDB v20.2+ and all supported PostgreSQL versions.

**Scope & referential integrity (by design):** Soft delete is honored across COG's own feature surface — reads,
`?include=`, the m2m relation-list join, filtering, pagination counts, the update/delete 404 lock, and unique indexes.
COG stops at its own boundary. It deliberately does **not** implement cross-aggregate referential integrity:

- It does **not** prevent creating/updating a child whose foreign key references a soft-deleted parent (the FK still
  points at the physically-present row, so the database accepts it).
- It does **not** cascade soft delete to children (soft-deleting a parent leaves children untouched).

This is intentional: the "correct" behavior is application-specific (archived-vs-trashed semantics; a child shared
between a deleted and a live parent has no universal answer). Implement whatever policy fits your data model in the
`before*`/`pre*` hooks — e.g. a `preCreate`/`preUpdate` hook can call `parentDomain.findById(fk)` (which returns `null`
for a soft-deleted parent) and throw to reject the write.

## Filtering

Filters passed via `where` query parameter as base64-encoded JSON.

```json
{ "field": "status", "op": "eq", "value": "active" }
{ "and": [{ "field": "age", "op": "gte", "value": 18 }, { "field": "active", "op": "eq", "value": true }] }
```

| Operators by Type                                                          |
| -------------------------------------------------------------------------- |
| String: `eq`, `neq`, `like`, `ilike`, `in`, `nin`, `isNull`                |
| Numeric/Date: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `isNull` |
| Boolean: `eq`, `isNull`                                                    |
| Array: `contains`, `overlaps`, `isNull`                                    |

**Domain filtering**: Use `skipSanitization: true` to access hidden fields in internal calls.

## Database Compatibility

| Feature   | PostgreSQL                           | CockroachDB                |
| --------- | ------------------------------------ | -------------------------- |
| Indexes   | BTREE, GIN, GIST, HASH, SPGIST, BRIN | BTREE, GIN, GIST only      |
| Enums     | All versions                         | v22.2+                     |
| GEOGRAPHY | Supported                            | Auto-converted to GEOMETRY |

## CLI

```bash
deno run -A src/cli.ts --modelsPath ./models --outputPath ./generated [--dbType postgresql|cockroachdb] [--schema name] [--no-postgis] [--verbose] [--version] [--help]
```

Every run ends with the dependency report (see Dependencies below): the packages the emitted files actually import,
grouped into dependencies, dev dependencies and optional. `generateFromModels` returns the same data as `dependencies`,
so it is available to programmatic callers without parsing stdout.

## Naming Conventions

| Type               | Convention              | Example                 |
| ------------------ | ----------------------- | ----------------------- |
| Model names        | PascalCase              | `User`, `UserProfile`   |
| Table names        | snake_case, singular    | `user`, `user_role`     |
| Field/Column names | camelCase / snake_case  | `userId` / `user_id`    |
| Relationship names | camelCase + List suffix | `postList`, `skillList` |

## Dependencies (Generated Code)

```json
{
  "imports": {
    "@hono/hono": "jsr:@hono/hono@^4.13.8",
    "@scalar/hono-api-reference": "npm:@scalar/hono-api-reference@^0.12.2",
    "drizzle-kit": "npm:drizzle-kit@^0.31.10",
    "drizzle-orm": "npm:drizzle-orm@^0.45.2",
    "drizzle-zod": "npm:drizzle-zod@^0.8.3",
    "openapi-types": "npm:openapi-types@^12.1.3",
    "postgres": "npm:postgres@^3.4.9",
    "zod": "npm:zod@^4.6.5"
  }
}
```

The generator emits no `deno.json` — this list **is** the dependency contract for consuming projects, so a stale entry
here is not cosmetic: it is the install instruction users copy. Source of truth is `GENERATED_CODE_DEPENDENCIES` /
`OPTIONAL_GENERATED_CODE_DEPENDENCIES` in `src/constants.ts`; the generator prints the list at the end of every run
(`resolveDependencies` in `src/utils/dependency.utils.ts` scans the emitted files, so the printed set matches what was
actually generated), and a generator test asserts that the constant, this block, the README block and
`example/deno.json` all agree.

Each entry carries a `kind` that drives the grouping in the generator output:

- `runtime` — `@hono/hono`, `drizzle-orm`, `drizzle-zod`, `postgres`, `zod` (type-only in the generated code, but
  drizzle-zod resolves it as a runtime peer)
- `types` — `openapi-types`, a type-only import in `rest/openapi.ts`; belongs to dev dependencies where that split
  exists
- `optional` — `@scalar/hono-api-reference`, never imported by the generated code, listed as a suggestion for the API
  docs UI

- `@hono/hono` **4.13.5+** is a security floor (4.12.x advisories: query-parser cache-key confusion, CORS ReDoS,
  `parseBody()` memory exhaustion)
- `zod` **4.x** is the tested line; zod 3.25.x also satisfies drizzle-zod's peer range (`^3.25.0 || ^4.0.0`) but then
  the root `zod` export is the v3-classic namespace while drizzle-zod uses `zod/v4` — see the Exceptions section
- Bump versions with `deno add <package spec>` or `deno outdated --update --latest --recursive`, never by editing
  `deno.json` by hand

---

## Agent Rules

### Coding patterns and principles

- Follow separation-of-concerns and single-responsibility design principles
- Complexity must be kept at minimum level
- Avoid code duplication, multiple occurrences of code of very similar patterns must be factored into a function

### Dependency rules

- Add packages using `deno add <package spec>`, never add packages directly to deno.json
- Do not add any packages without approval

### Code quality rules

- Avoid using the "any" type
- Avoid using the "function" keyword, use arrow functions
- Always be type specific in method signatures and returns

### Task rules

- The task plan file you use must be called .{projectName}-agent-plan.md and it must be placed into the project root
- Create a multi step plan on every tasks (or a single step one on simple tasks) that you append to the task plan file
- Mark a task done explicitly
- Clear the task plan file only on developer request, do not auto-clean it

### End-of-a-task rules

Finish each task with the following (in this order):

Update AGENTS.md (this file) whenever major architectural changes, new features or important patterns added to the
codebase, an existing feature changes, new or updated information surfaces. Then:

1. Update integration tests to capture every new features or feature changes
2. Format the code with `deno task fmt` in the project root and in example/
3. Check formatting with with `deno task fmt:check` in the project root and in example/
4. Check for linter errors with `deno task lint` in the project root and in example/
5. Check for type errors with `deno task check` in the project root and in example/
6. Ask the developer to run the integation test

Should any of the deno tasks fail, fix the errors before continuing the restart the above list.

### Never do the following automatically yourselves

- code generation
- database initialization
- database cleaning
- testing

### Never run the following automatically yourselves

- `deno task cog:crdb:generate`, ask the developer to run it
- `deno task cog:psql:generate`, ask the developer to run it
- `deno task drizzle:push`, ask the developer to run it
- `deno task drizzle:migrate`, ask the developer to run it
- `deno task db:bootstrap`, ask the developer to run it
- `deno task db:clean`, ask the developer to run it
- `deno task test`, ask the developer to run it
- `deno task test:integration`, ask the developer to run it
- `deno task test:clean`, ask the developer to run it
