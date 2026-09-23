# COG - CRUD Operations Generator

[![CI](https://github.com/canecomext/cog/actions/workflows/ci.yml/badge.svg)](https://github.com/canecomext/cog/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/canecomext/cog/graph/badge.svg)](https://codecov.io/gh/canecomext/cog)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)
![Deno](https://img.shields.io/badge/Deno-000000?style=flat&logo=deno&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=flat&logo=postgresql&logoColor=white)
![PostGIS](https://img.shields.io/badge/PostGIS-478FCA?style=flat)
![MIT License](https://img.shields.io/badge/License-MIT-green.svg)

**Transform JSON models into production-ready TypeScript backends**

COG is a code generator that creates complete CRUD backends from simple JSON model definitions. Define your data model,
generate everything else.

```
JSON Models --> COG --> REST API + Domain Logic + Database Schema + OpenAPI Docs
```

---

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Features](#features)
- [CLI Reference](#cli-reference)
- [Generated REST Endpoints](#generated-rest-endpoints)
- [Model Definition Reference](#model-definition-reference)
- [Advanced Features](#advanced-features)
- [Example Project](#example)
- [Development Setup](#development-setup)
- [Requirements](#requirements)
- [Documentation](#documentation)

---

## Quick Start

### 1. Define Your Model

Create `models/department.json`:

```json
{
  "name": "Department",
  "tableName": "department",
  "fields": [
    {
      "name": "id",
      "type": "uuid",
      "primaryKey": true,
      "defaultValue": "gen_random_uuid()",
      "required": true
    },
    {
      "name": "name",
      "type": "string",
      "maxLength": 100,
      "required": true,
      "unique": true
    },
    {
      "name": "location",
      "type": "point",
      "srid": 4326,
      "required": true
    }
  ],
  "timestamps": true
}
```

### 2. Generate Code

```bash
deno run -A src/cli.ts --modelsPath ./models --outputPath ./generated
```

### 3. Create the Database

The generated code brings no DDL of its own — [drizzle-kit](https://orm.drizzle.team/kit-docs/overview) creates the
tables from the generated schema, which is also what gives you migrations later.

```bash
# DB_URL in .env, e.g. DB_URL=postgresql://user:pass@localhost:5432/mydb
deno run -A --env-file=.env ./generated/db/bootstrap.ts   # extensions (PostGIS)

# a scratch database you can throw away:
deno run -A --env-file=.env npm:drizzle-kit push --config=./generated/drizzle.config.ts

# a database that will hold real data - start its migration history right away:
deno run -A --env-file=.env npm:drizzle-kit generate --config=./generated/drizzle.config.ts
deno run -A --env-file=.env npm:drizzle-kit migrate --config=./generated/drizzle.config.ts
```

Pick one per database and stay with it — see [Database Lifecycle](#database-lifecycle).

### 4. Use Generated Backend

```typescript
import { Hono } from '@hono/hono';
import { initializeGenerated } from './generated/index.ts';

const app = new Hono();

await initializeGenerated({
  database: {
    connectionString: 'postgresql://user:pass@localhost:5432/mydb',
  },
  app,
});

Deno.serve({ port: 3000 }, app.fetch);
```

That's it! Your REST API is ready:

```bash
GET    /api/department       # List departments
POST   /api/department       # Create department
GET    /api/department/:id   # Get department
PUT    /api/department/:id   # Update department
DELETE /api/department/:id   # Delete department
```

---

## Architecture

```
+---------------------------------------------------------+
|                     HTTP Request                         |
+-----------------------------+---------------------------+
                              |
                    +---------v----------+
                    |    REST Layer      |  HTTP/JSON Interface
                    |   (Hono Routes)    |  - Request validation
                    |                    |  - REST hooks
                    +---------+----------+  - Error handling
                              |
                    +---------v----------+
                    |   Domain Layer     |  Business Logic
                    |  (Pure Functions)  |  - CRUD operations
                    |                    |  - Domain hooks
                    +---------+----------+  - Validation
                              |
                    +---------v----------+
                    |   Schema Layer     |  Type Definitions
                    |   (Drizzle ORM)    |  - Table schemas
                    |                    |  - Relations
                    +---------+----------+  - Zod validation
                              |
                    +---------v----------+
                    |  Database Layer    |  PostgreSQL/CockroachDB
                    |   (Connection)     |  - Transactions
                    |                    |  - PostGIS
                    +--------------------+
```

### Generated Code Structure

```
generated/
+-- index.ts                    # initializeGenerated() entry point
+-- db/
|   +-- database.ts             # Connection pooling, transactions, after-commit queue
|   +-- bootstrap.ts            # PostGIS extension (PostgreSQL only)
+-- schema/
|   +-- [model].schema.ts       # Drizzle tables + Zod schemas
|   +-- spatial-utils.ts        # GeoJSON <-> WKT conversion
|   +-- relations.ts            # Drizzle relationships
+-- domain/
|   +-- [model].domain.ts       # CRUD operations with hooks
|   +-- exceptions.ts           # DomainException, NotFoundException
|   +-- hooks.types.ts          # Hook type definitions
+-- utils/
|   +-- filter.utils.ts         # Filter parsing & SQL building
+-- rest/
    +-- [model].rest.ts         # Hono REST endpoints
    +-- openapi.ts              # OpenAPI spec builder
    +-- helpers.ts              # Shared REST helpers
```

---

## Features

### Comprehensive Type Support

| Category       | Types                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Primitives** | `string`, `text`, `integer`, `bigint`, `decimal`, `boolean`, `date` (EPOCH milliseconds), `uuid`                                            |
| **Structured** | `json`, `jsonb`, `enum` (standard or bitwise)                                                                                               |
| **Spatial**    | `point`, `linestring`, `polygon`, `multipoint`, `multilinestring`, `multipolygon`, `geometry`, `geography` (uses GeoJSON in API, WKT in DB) |
| **Arrays**     | Any type with `"array": true`                                                                                                               |

**Note:** `date` fields are stored as EPOCH millisecond integers (`bigint`) in the database. The API accepts and returns
numeric timestamps (e.g., `1704067200000`). Use `Date.getTime()` in JavaScript/TypeScript. OpenAPI documents these as
`type: integer, format: int64`.

### Relationship Support

```mermaid
erDiagram
    Department ||--o{ Employee : "oneToMany"
    Employee }o--|| Department : "manyToOne"

    Employee ||--|| IDCard : "oneToOne"

    Employee ||--o{ Assignment : "oneToMany"
    Assignment }o--|| Employee : "manyToOne"

    Project ||--o{ Assignment : "oneToMany"
    Assignment }o--|| Project : "manyToOne"

    Employee }o--o{ Skill : "manyToMany (via employee_skill)"

    Employee }o--o{ Employee : "self-referential manyToMany (mentors/mentees)"
```

| Type                 | Description        | Example                                         |
| -------------------- | ------------------ | ----------------------------------------------- |
| **oneToMany**        | Parent -> Children | Department -> Employees, Project -> Assignments |
| **manyToOne**        | Child -> Parent    | Employee -> Department, Assignment -> Project   |
| **manyToMany**       | Junction table     | Employee <-> Skills (via employee_skill)        |
| **oneToOne**         | Direct link        | Employee -> IDCard                              |
| **Self-referential** | Model -> Self      | Employee <-> Employee (mentors/mentees)         |

### Hook System

Extend generated code without modification:

```
HTTP Request
  -> Domain Before-hook (auth, input transformation - outside transaction)
  -> Transaction Start
    -> Domain Pre-hook (business logic)
    -> Database Operation
    -> Domain Post-hook (transform output)
  -> Transaction Commit
  -> Domain After-hook (async side effects)
-> HTTP Response
```

**Available Hooks:** beforeCreate, preCreate, postCreate, afterCreate, beforeUpdate, preUpdate, postUpdate, afterUpdate,
beforeDelete, preDelete, postDelete, afterDelete, beforeFindById, beforeFindMany, and junction hooks for many-to-many
relationships.

**Hook Parameters:** `input` (validated data), `rawInput` (original request body), `result` (database response), `tx`
(transaction), `context` (shared state). See [AGENTS.md](./AGENTS.md#hook-system) for complete signatures.

**HTTP-layer concerns (auth, headers, logging):** Use Hono middleware instead.

#### After-hooks and transactions

An after-hook starts only once the transaction it ran in has committed. The domain method queues it on the transaction;
`withTransaction` starts the queue after a successful `COMMIT`, in scheduling order and without awaiting it. A rollback
drops the queue, and so does a failed attempt before a serialization retry (40001): every attempt is a transaction of
its own. A read without a transaction starts its after-hook right away.

```typescript
import { withNestedTransaction, withTransaction } from './generated/index.ts';

await withTransaction(async (tx) => {
  await orderDomain.create(order, tx); // afterCreate is queued, not started
  try {
    await withNestedTransaction(tx, async (nested) => {
      await auditDomain.create(entry, nested); // queued in the savepoint
    });
  } catch {
    // the savepoint rolled back: the audit entry and its afterCreate are gone, the order stays
  }
}); // COMMIT, then the order's afterCreate starts
```

- **Open transactions through COG.** Use `withTransaction`, and `withNestedTransaction` for a savepoint. A savepoint is
  not a commit, so its after-hooks move to the parent and start with the outermost `COMMIT`. A domain method that
  receives a transaction COG did not open (a plain `db.transaction()` or `tx.transaction()`) throws instead of dropping
  its after-hook silently.
- **Your own post-commit work:** `runAfterCommit(tx, task)` is exported, e.g. for a `post*` hook that has to notify
  another system once the data is committed.
- **What they receive:** the same result the caller gets, sanitized unless `skipSanitization` is set.
- **At most once:** if the process stops right after `COMMIT`, or the connection breaks during it, the after-hook does
  not run. For a side effect that must never be missed, write an outbox row in the same transaction instead.

### Database Compatibility

| Feature            | PostgreSQL |  CockroachDB   |
| ------------------ | :--------: | :------------: |
| **Index Types**    |            |                |
| BTREE, GIN, GIST   |     Y      |       Y        |
| HASH, SPGIST, BRIN |     Y      |   Use BTREE    |
| **Data Types**     |            |                |
| Enums              |     Y      |   Y (v22.2+)   |
| GEOMETRY           |     Y      |       Y        |
| GEOGRAPHY          |     Y      | Auto-converted |
| JSONB, Arrays      |     Y      |       Y        |

### Filtering

Filters passed via `where` query parameter as base64-encoded JSON.

```json
{ "field": "status", "op": "eq", "value": "active" }
{ "and": [{ "field": "age", "op": "gte", "value": 18 }, { "field": "active", "op": "eq", "value": true }] }
```

| Type         | Operators                                                    |
| ------------ | ------------------------------------------------------------ |
| String       | `eq`, `neq`, `like`, `ilike`, `in`, `nin`, `isNull`          |
| Numeric/Date | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `isNull` |
| Boolean      | `eq`, `isNull`                                               |
| Array        | `contains`, `overlaps`, `isNull`                             |

**Domain filtering**: Use `skipSanitization: true` to access hidden fields in internal calls.

---

## CLI Reference

```bash
deno run -A src/cli.ts [options]
```

| Option                | Description                           | Default       |
| --------------------- | ------------------------------------- | ------------- |
| `--modelsPath <path>` | Path to JSON models                   | `./models`    |
| `--outputPath <path>` | Output directory                      | `./generated` |
| `--dbType <type>`     | `postgresql` or `cockroachdb`         | `postgresql`  |
| `--schema <name>`     | Database schema                       | (default)     |
| `--no-postgis`        | Turn PostGIS off entirely (see below) | PostGIS on    |
| `--verbose`           | Show file paths                       | false         |

**PostGIS:** `CREATE EXTENSION IF NOT EXISTS postgis` is emitted into `db/bootstrap.ts` only for PostgreSQL, and only
when at least one model actually declares a spatial field — so a project without spatial fields initializes on a plain
PostgreSQL that has no PostGIS installed. CockroachDB has spatial support built in and never receives the statement.

`--no-postgis` turns PostGIS off completely: no spatial support in the generated code and no extension statement. A
model that declares a spatial field is then a configuration error and generation fails with a message naming the fields
— the generator does not silently downgrade spatial columns.

**After every run** the generator prints the packages the generated code needs, grouped into dependencies, dev
dependencies and optional ones — see [Generated Code Dependencies](#generated-code-dependencies).

---

## Database Lifecycle

COG generates no DDL. The generated Drizzle schema is the source of truth, and
[drizzle-kit](https://orm.drizzle.team/kit-docs/overview) turns it into tables — which is also what gives you
migrations.

The generated output is a plain Drizzle schema plus a plain `drizzle.config.ts`, so the drizzle-kit documentation
applies to it as written. Note the two meanings of "generate": `cog:psql:generate` regenerates the **schema** from your
models, while `drizzle-kit generate` writes a **migration** by diffing that schema against its snapshot history.

```bash
KIT="npm:drizzle-kit --config=./generated/drizzle.config.ts"

deno run -A --env-file=.env ./generated/db/bootstrap.ts   # once: extensions (PostGIS on PostgreSQL)
deno run -A --env-file=.env $KIT push                     # development and tests: sync to the schema
deno run -A --env-file=.env $KIT generate                 # production: write a versioned migration
deno run -A --env-file=.env $KIT migrate                  # production: apply pending migrations
```

Worth adding to your own `deno.json` (this is what `example/deno.json` does):

```json
{
  "tasks": {
    "db:bootstrap": "deno run -A --env-file=.env ./generated/db/bootstrap.ts",
    "drizzle:push": "deno task db:bootstrap && deno run -A --env-file=.env npm:drizzle-kit push --force --config=./generated/drizzle.config.ts",
    "drizzle:generate": "deno run -A --env-file=.env npm:drizzle-kit generate --config=./generated/drizzle.config.ts",
    "drizzle:migrate": "deno task db:bootstrap && deno run -A --env-file=.env npm:drizzle-kit migrate --config=./generated/drizzle.config.ts"
  }
}
```

A model change is then an ordinary migration, safe to run against a database that holds data:

```bash
deno task cog:psql:generate   # regenerate the schema from the changed models
deno task drizzle:generate    # -> drizzle/0001_....sql: ALTER TABLE "skill" ADD COLUMN "category" varchar(50);
deno task drizzle:migrate     # applied to the live database, existing rows untouched
```

Commit the whole `drizzle/` directory, `meta/` included: the journal and the snapshots under it **are** the history
drizzle-kit diffs against. Without them the next `generate` starts over from an empty baseline.

**Read the generated SQL before applying it.** drizzle-kit sees the difference between two schemas, not your intention:
a renamed column looks like a dropped one plus a new one, which loses its data. It asks interactively when it suspects a
rename, so run `drizzle:generate` in a terminal rather than in CI, and hand-edit the migration when the diff is not what
you meant. `drizzle:migrate` is the only part that belongs in a deployment pipeline.

> **Choose the path when you create the database, not later.** `push` writes no migration history, so a database created
> with `push` cannot be migrated afterwards: the first `generate` produces a full `CREATE TABLE` baseline and `migrate`
> then fails against the existing tables. Use `push` for scratch and test databases, and `generate` + `migrate` from the
> very first deployment of anything that holds real data. Moving a pushed database onto migrations means generating the
> baseline and recording it as already applied by hand.

Both PostgreSQL and CockroachDB are supported by the same generated schema, with PostGIS on both. CockroachDB has
spatial support built in, so it needs no extension and never receives `CREATE EXTENSION`.

---

## Generated REST Endpoints

For each model, COG generates:

```
GET    /api/{model}                    # List (paginated)
POST   /api/{model}                    # Create
GET    /api/{model}/:id                # Get by ID
PUT    /api/{model}/:id                # Update
DELETE /api/{model}/:id                # Delete
```

**Many-to-Many Relationships Only:**

```
GET    /api/{model}/:id/{relation}List      # Get related
POST   /api/{model}/:id/{relation}List      # Add multiple
POST   /api/{model}/:id/{relation}          # Add single
PUT    /api/{model}/:id/{relation}List      # Replace all
DELETE /api/{model}/:id/{relation}List      # Remove multiple
DELETE /api/{model}/:id/{relation}/:targetId # Remove single
```

**Note:** oneToMany/manyToOne do NOT generate dedicated endpoints.

**Query Parameters:**

- `limit` - Pagination limit
- `offset` - Pagination offset
- `orderBy` - Sort field
- `order` - Sort direction (`asc`/`desc`)

---

## Model Definition Reference

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

### Naming Conventions

| Type               | Convention              | Example                 |
| ------------------ | ----------------------- | ----------------------- |
| Model names        | PascalCase              | `User`, `UserProfile`   |
| Table names        | snake_case, singular    | `user`, `user_role`     |
| Field/Column names | camelCase / snake_case  | `userId` / `user_id`    |
| Relationship names | camelCase + List suffix | `postList`, `skillList` |

---

## Advanced Features

### Check Constraints

```json
{
  "check": {
    "numNotNulls": [
      {
        "fields": ["field1", "field2", "field3"],
        "num": 2
      }
    ]
  }
}
```

Generates: `CHECK (num_nonnulls(field1, field2, field3) >= 2)`

### Custom Schemas

```json
{
  "name": "Employee",
  "tableName": "employee",
  "schema": "hr"
}
```

A non-default schema is created by the initialization script (`CREATE SCHEMA IF NOT EXISTS "hr"`) and every DDL
statement for the model is qualified with it — `CREATE TABLE "hr"."employee"`, its indexes, and both sides of its
foreign keys. The Drizzle table is wrapped in `pgSchema('hr')` to match.

`"public"` and an omitted `schema` both mean Postgres' default schema and stay unqualified. Junction tables of
many-to-many relationships are always created in the default schema, even when the related models are not.

### Foreign Key Actions

```json
{
  "references": {
    "model": "Department",
    "field": "id",
    "onDelete": "CASCADE",
    "onUpdate": "NO ACTION"
  }
}
```

**Actions:** `CASCADE`, `SET NULL`, `RESTRICT`, `NO ACTION`

These are emitted onto the generated Drizzle column, so drizzle-kit creates the foreign key with them. A many-to-many
relationship can declare `onDelete`/`onUpdate` too; its junction foreign keys cascade by default, because a junction row
is meaningless once either side is gone. A delete refused because the row is still referenced (`RESTRICT` or
`NO ACTION`) answers **409** on both PostgreSQL and CockroachDB; a create or update that references a missing row
answers **400**.

### Field Exposure Control

Control field visibility in API responses:

```json
{
  "name": "apiSecret",
  "type": "string",
  "expose": "create"
}
```

| Value                 | Effect                        |
| --------------------- | ----------------------------- |
| `"default"` (or omit) | Visible in all responses      |
| `"hidden"`            | Never visible in responses    |
| `"create"`            | Visible only in POST response |

Works with `?include=` - included child objects respect their own exposure rules.

For internal domain calls needing hidden fields, use `skipSanitization: true`:

```typescript
const user = await userDomain.findById(id, tx, { skipSanitization: true });
```

### Field Accept Control

Control which fields are accepted as input:

```json
{
  "name": "createdBy",
  "type": "uuid",
  "required": true,
  "accept": "never",
  "defaultValue": "gen_random_uuid()"
}
```

| Value                 | Effect                                    |
| --------------------- | ----------------------------------------- |
| `"default"` (or omit) | Accepted on create and update             |
| `"create"`            | Accepted on create only (immutable after) |
| `"never"`             | Never accepted (server-managed)           |

**Important:** For `required` fields with `accept: "never"` and no `defaultValue`, the `beforeCreate` hook MUST provide
the value before Zod validation runs.

```typescript
// Example: Server-managed createdBy field
const employeeDomainWithHooks = new EmployeeDomain({
  beforeCreate: async (input, context) => ({
    ...input,
    createdBy: context?.userId, // Inject before Zod validation
  }),
});
```

### String Length Validation

`string` and `text` fields support `minLength` and `maxLength`:

```json
{
  "name": "username",
  "type": "string",
  "minLength": 3,
  "maxLength": 32,
  "required": true
}
```

Both bounds are emitted as Zod refinements on the generated insert/update schemas, so they are enforced at the API layer
on **both create and update**. A value outside the bounds throws a `ZodError`, which the REST layer returns as **HTTP
400** with the validation issues in the response body.

> Zod errors are recognized structurally (`name === 'ZodError'` plus an `issues` array) rather than with `instanceof`.
> `drizzle-zod` builds the schemas with the `zod/v4` namespace, which is a different class than the root `zod` export on
> zod 3.25.x — an identity check would silently fail there and turn every validation error into a 500.

A request body that is not valid JSON is also a client error: every generated handler reads the body through
`parseJsonBody`, which answers **HTTP 400** instead of letting the parse failure surface as a 500.

Database constraint violations are mapped by their SQLSTATE too — a unique violation answers **409**, and not-null,
foreign key, check, length and format violations answer **400**, naming the violated constraint. Any other database
error stays a 500, because that is an outage or a bug rather than a client mistake.

- `maxLength` also sets the `varchar` column length for `string` fields; `text` columns stay unbounded but still get the
  Zod `max` check.
- `minLength`/`maxLength` are **not** applied to array fields (`"array": true`) — a length check there would constrain
  the array length, not the element strings.

### Endpoint Configuration

Control which endpoints are generated for each model:

```json
{
  "name": "User",
  "fields": [...],
  "endpoints": {
    "create": true,
    "readOne": true,
    "readMany": true,
    "update": false,
    "delete": false
  }
}
```

Control which many-to-many relationship endpoints are generated:

```json
{
  "type": "manyToMany",
  "name": "roleList",
  "target": "Role",
  "through": "user_role",
  "endpoints": {
    "get": true,
    "add": true,
    "replace": false,
    "remove": false
  }
}
```

**Default:** All endpoints enabled if not specified.

### Soft Delete

Add `"softDelete": true` to any model to enable soft deletion. Records are never physically removed — instead a nullable
`deleted_at` bigint epoch-ms column is set and the row is hidden from all reads.

```json
{
  "name": "User",
  "tableName": "user",
  "fields": [...],
  "timestamps": true,
  "softDelete": true
}
```

Use a custom column name:

```json
{
  "softDelete": { "deletedAt": "removed_at" }
}
```

**What gets generated:**

- A nullable `deleted_at` (`bigint`, epoch-ms) column — hidden from API responses, never accepted as input.
- `DELETE /api/{model}/:id` sets `deletedAt` instead of removing the row. Does not touch `updatedAt`.
- All reads (`GET /api/{model}`, `GET /api/{model}/:id`) automatically exclude soft-deleted rows.
- `PUT /api/{model}/:id` on a soft-deleted record returns **404**.
- `DELETE /api/{model}/:id` on an already-deleted record returns **404**.
- Unique fields become partial unique indexes scoped to live rows, so a soft-deleted record does not block re-creation.

**Relationship behavior:**

- `?include=` of a child collection excludes soft-deleted children.
- `?include=` of a parent/sibling resolves to `null` when the referenced row is soft-deleted.
- Many-to-many `GET /:id/{relation}List` excludes soft-deleted targets. Junction rows themselves are hard-deleted.

**Internal domain access:** Pass `{ withSoftDeleted: true }` as a query option to bypass the filter in server-side code.
This option is not REST-exposed.

```typescript
const user = await userDomain.findById(id, tx, { withSoftDeleted: true });
```

**Note:** Restore is not supported in v1. CockroachDB v20.2+ and all supported PostgreSQL versions are compatible.

**Scope & referential integrity (by design).** Soft delete is honored across COG's own feature surface — reads,
`?include=`, the many-to-many relation-list join, filtering, and the update/delete lock. COG stops at its boundary and
deliberately does **not** enforce cross-aggregate referential integrity:

- It does **not** prevent creating or updating a child that references a soft-deleted parent. The foreign key still
  points at the physically-present row, so the database accepts the write.
- It does **not** cascade soft delete to children — soft-deleting a parent leaves its children untouched.

This is intentional, not an oversight: the right behavior is application-specific (is a soft-deleted parent _archived_
with editable children, or _trashed_ with a frozen subtree? a child shared between a deleted and a live parent has no
universal answer). Enforce whatever your data model needs in the `before*`/`pre*` hooks. For example, to reject
attaching a child to a soft-deleted parent, validate the foreign key in a `preCreate`/`preUpdate` hook:

```typescript
preCreate: async (input, _raw, tx) => {
  const parent = await parentDomain.findById(input.parentId, tx); // null if soft-deleted
  if (!parent) throw new DomainException('Parent is not available');
  return input;
},
```

### OpenAPI Documentation

COG generates an OpenAPI 3.1.0 specification builder that creates runtime specs with your API basePath. You control
where and how to expose documentation:

```typescript
import { buildOpenAPISpec } from './generated/rest/openapi.ts';
import { Scalar } from '@scalar/hono-api-reference';

// Build OpenAPI spec with your API basePath (required)
const openAPISpec = buildOpenAPISpec('/api');

// Expose spec
app.get('/docs/openapi.json', (c) => c.json(openAPISpec));

// Interactive docs
app.get('/docs/reference', Scalar({ url: '/docs/openapi.json' }) as any);
```

**Key Features:**

- `buildOpenAPISpec(basePath)` generates spec at runtime with correct server URLs
- `basePath` parameter is required (throws `DomainException` if missing)
- Merge with custom endpoints using `mergeOpenAPISpec(basePath, customSpec)`

---

## Example

See the `/example` directory for a complete Corporate ORM demonstration featuring:

- 12 interconnected models (Employee, Department, Project, Skill, etc.)
- All relationship types including self-referential
- PostGIS spatial data
- Hook implementations
- Check constraints
- Field exposure and acceptance control

```bash
cd example
deno task cog:psql:generate
deno task drizzle:push
deno run -A src/main.ts
```

Documentation: http://localhost:3000/docs/reference

### Environment Configuration

Copy `.env.template` to `.env` and configure:

```bash
# Database connection string
DB_URL=postgresql://username:password@localhost:5432/example_db

# Server certificate path relative from project root (optional)
DB_SSL_CA_FILE=path/to/ca-cert.pem
```

---

## Development Setup

### Prerequisites

- **Deno** 2.x or higher
- **PostgreSQL** 12+ with PostGIS extension, or **CockroachDB**

### Getting Started

```bash
# Clone and install git hooks
git clone https://github.com/canecomext/cog.git
cd cog
deno task setup:hooks
```

The pre-commit hook automatically:

1. Formats code in root and example directories
2. Regenerates example code from models
3. Runs lint and type checks
4. Stages any formatting changes

### Development Tasks

**Root (`deno.json`):**

| Task          | Description              |
| ------------- | ------------------------ |
| `setup:hooks` | Install pre-commit hook  |
| `fmt`         | Format code              |
| `fmt:check`   | Check formatting         |
| `lint`        | Lint src/                |
| `check`       | Type check src/          |
| `test`        | Run generator unit tests |
| `cov`         | Generate coverage report |

**Example (`example/deno.json`):**

| Task                | Description               |
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
| `cov`               | Generate coverage report  |

### Code Style

Configured in `deno.json`:

- **Indentation:** 2 spaces (no tabs)
- **Line width:** 120 characters
- **Semicolons:** Required
- **Quotes:** Single quotes
- **Linting:** Recommended rules

### IDE Setup (VSCode)

The project includes VSCode configuration in `.vscode/`:

- **Recommended extension:** `denoland.vscode-deno`
- **Format on save:** Enabled
- **Coverage gutters:** Configured for lcov.info

Open the project in VSCode to automatically use these settings.

### CI Pipeline

The GitHub Actions CI pipeline runs on push/PR to `main` and `develop`:

1. **Lint & Type Check Job:**
   - Format check (root + example)
   - Lint (root + example)
   - Type check (root + example)
   - Generate code to verify generators work

2. **Tests Job:**
   - Spins up PostGIS container
   - Generates code and initializes database
   - Runs generator unit tests
   - Runs integration tests
   - Uploads coverage to Codecov

---

## Requirements

- **Deno** 2.x or higher
- **PostgreSQL** 12+ or **CockroachDB**
- **PostGIS** (optional, for spatial data)

### Generated Code Dependencies

Add to your `deno.json`:

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

The generator prints this same list at the end of every run, resolved from the files it actually emitted. These are the
versions `example/deno.json` is built and tested against, and a generator test keeps the two in sync.

The generator groups them for a project that separates dependencies from dev dependencies (in Deno they all go into the
same `imports`):

- **Dependencies** — `@hono/hono`, `drizzle-orm`, `drizzle-zod`, `postgres`, `zod`. `zod` appears only as a type import
  in the generated code, but `drizzle-zod` resolves it as a runtime peer.
- **Dev dependencies** — `openapi-types`, imported as a type by `rest/openapi.ts` and never present at runtime.
- **Optional** — `@scalar/hono-api-reference`, never imported by the generated code; only needed if the application
  serves the API documentation UI.

- **`@hono/hono` 4.13.5+** is a security floor: 4.12.x is affected by advisories that were fixed in 4.12.27, 4.12.34 and
  4.13.5 (query-parser cache-key confusion, CORS middleware ReDoS, `parseBody()` memory exhaustion, and JSX/SSR issues
  that do not apply to a JSON API).
- **`zod` 4.x** is the tested line. `drizzle-zod` builds the schemas with the `zod/v4` namespace and accepts
  `^3.25.0 || ^4.0.0` as a peer, so zod 3.25.x also resolves — but then the root `zod` export is the v3-classic
  namespace, and anything comparing error classes across the two namespaces breaks. The generated code does not rely on
  `instanceof` for this reason, but staying on zod 4 keeps one single namespace in the project.

---

## Documentation

- **[AGENTS.md](./AGENTS.md)** - Complete technical reference for AI agents/developers
- **[example/README.md](./example/README.md)** - Example walkthrough

---

## Important Notes

**Table Naming:** Use singular names (`employee`, not `employees`)

**Numeric Limits:** Default values limited to `Number.MAX_SAFE_INTEGER` (2^53-1)

**Validation:** Zod validation is always enabled and cannot be disabled

**CockroachDB:** GEOGRAPHY types auto-convert to GEOMETRY, HASH indexes to BTREE

---

## License

MIT License - see [LICENSE](./LICENSE) file for details.

---

**Built with TypeScript and Deno for modern backend development.**
