# COG - CRUD Operations Generator

[![CI](https://github.com/zgobolos/cog/actions/workflows/ci.yml/badge.svg)](https://github.com/zgobolos/cog/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/zgobolos/cog/graph/badge.svg)](https://codecov.io/gh/zgobolos/cog)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)
![Deno](https://img.shields.io/badge/Deno-000000?style=flat&logo=deno&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=flat&logo=postgresql&logoColor=white)
![PostGIS](https://img.shields.io/badge/PostGIS-478FCA?style=flat)
![MIT License](https://img.shields.io/badge/License-MIT-green.svg)

**Transform JSON models into production-ready TypeScript backends**

COG is a code generator for Deno. You describe your data as JSON models; COG generates a Drizzle schema for PostgreSQL
or CockroachDB, a domain layer with validation, transactions and hooks, a Hono REST API with filtering, pagination and
relation loading, and an OpenAPI 3.1 description of that API. drizzle-kit then creates and migrates the database from
the generated schema.

```
models/*.json ──► COG ──► generated/    Drizzle schema · domain layer · REST API · OpenAPI
                              │
                              └──► drizzle-kit ──► your database (push, or versioned migrations)
```

---

## Contents

- [Getting Started](#getting-started)
- [The Generated Code](#the-generated-code) — architecture, capabilities, files
- [Model Definition](#model-definition) — fields, types, relationships, indexes, soft delete
- [Domain API](#domain-api) — methods, transactions, hooks, errors
- [REST API](#rest-api) — endpoints, query parameters, filtering, status codes, OpenAPI
- [Everyday Development Tasks](#everyday-development-tasks) — creating and migrating the database, upgrades, testing
- [Reference](#reference) — CLI, database compatibility, dependencies, limitations
- [Example Project](#example-project)
- [Developing COG](#developing-cog)

---

## Getting Started

This walk-through builds a small bookshop API: authors, their books, and an interactive API reference.

### Requirements

| Software                  | Version       | Notes                                                                            |
| ------------------------- | ------------- | -------------------------------------------------------------------------------- |
| Deno                      | 2.x           | tested with 2.9                                                                  |
| PostgreSQL                | 13 or newer   | tested with 18; `gen_random_uuid()`, used for the ids below, is built in from 13 |
| PostGIS                   | 3.x           | only when a model has spatial fields                                             |
| CockroachDB (alternative) | 22.2 or newer | tested with 26.3; spatial support is built in                                    |

### 1. Get COG

COG runs straight from its repository; there is no package to install.

```bash
git clone https://github.com/zgobolos/cog.git
git -C cog checkout 2.1.0              # pin a release tag
deno run -A cog/src/cli.ts --version   # COG 2.1.0
```

### 2. Create a project

```
bookshop/
├── deno.json
├── .env
├── main.ts
└── models/
    ├── author.json
    └── book.json
```

The generated code is not self-contained: add the packages listed under
[Generated Code Dependencies](#generated-code-dependencies) to the `imports` of `deno.json` — the generator prints the
same list after every run. Then add these tasks (the paths assume `cog/` and `bookshop/` side by side):

```json
{
  "tasks": {
    "cog:generate": "deno run -A ../cog/src/cli.ts --modelsPath ./models --outputPath ./generated",
    "db:bootstrap": "deno run -A --env-file=.env ./generated/db/bootstrap.ts",
    "drizzle:push": "deno task db:bootstrap && deno run -A --env-file=.env npm:drizzle-kit push --config=./generated/drizzle.config.ts",
    "drizzle:generate": "deno run -A --env-file=.env npm:drizzle-kit generate --config=./generated/drizzle.config.ts",
    "drizzle:migrate": "deno task db:bootstrap && deno run -A --env-file=.env npm:drizzle-kit migrate --config=./generated/drizzle.config.ts",
    "dev": "deno run -A --env-file=.env --watch main.ts"
  }
}
```

`.env` holds the connection string. The bootstrap script, drizzle-kit and `main.ts` all read it:

```bash
DB_URL=postgresql://postgres:postgres@localhost:5432/bookshop
# CockroachDB: DB_URL=postgresql://root@localhost:26257/bookshop?sslmode=disable
```

### 3. Describe the data

`models/author.json`:

```json
{
  "name": "Author",
  "tableName": "author",
  "fields": [
    { "name": "id", "type": "uuid", "primaryKey": true, "defaultValue": "gen_random_uuid()", "required": true },
    { "name": "name", "type": "string", "maxLength": 100, "required": true },
    { "name": "email", "type": "string", "maxLength": 255, "required": true, "unique": true }
  ],
  "relationships": [
    { "type": "oneToMany", "name": "bookList", "target": "Book", "foreignKey": "authorId" }
  ],
  "timestamps": true
}
```

`models/book.json`:

```json
{
  "name": "Book",
  "tableName": "book",
  "fields": [
    { "name": "id", "type": "uuid", "primaryKey": true, "defaultValue": "gen_random_uuid()", "required": true },
    { "name": "title", "type": "string", "minLength": 1, "maxLength": 200, "required": true },
    { "name": "publishedAt", "type": "date" },
    {
      "name": "authorId",
      "type": "uuid",
      "required": true,
      "references": { "model": "Author", "field": "id", "onDelete": "CASCADE" }
    }
  ],
  "relationships": [
    { "type": "manyToOne", "name": "author", "target": "Author", "foreignKey": "authorId" }
  ],
  "timestamps": true
}
```

A book belongs to one author through its `authorId` foreign key, an author has many books, and deleting an author
deletes their books. [Model Definition](#model-definition) lists everything a model can declare.

### 4. Generate the code

```bash
deno task cog:generate
```

This writes `generated/` and prints the packages the generated code imports. Regenerate after every model change, and
never edit the generated files — see [Working with generated code](#working-with-generated-code).

### 5. Create the database

```bash
createdb bookshop          # CockroachDB: cockroach sql --insecure -e "CREATE DATABASE bookshop"
deno task drizzle:push     # installs PostGIS where needed, then creates the tables
```

`push` suits a development database. A database that will hold real data should use versioned migrations from the start
— see [Creating a database](#creating-a-database).

### 6. Start the API

`main.ts`:

```typescript
import { Hono, type MiddlewareHandler } from '@hono/hono';
import { HTTPException } from '@hono/hono/http-exception';
import { Scalar } from '@scalar/hono-api-reference';
import { type DefaultEnv, initializeGenerated } from './generated/index.ts';
import { buildOpenAPISpec } from './generated/rest/openapi.ts';

const app = new Hono<DefaultEnv>();

// Connects to the database and registers the REST routes under /api
await initializeGenerated({
  database: { connectionString: Deno.env.get('DB_URL')! },
  app,
});

// OpenAPI description and an interactive reference
const spec = buildOpenAPISpec('/api');
app.get('/docs/openapi.json', (c) => c.json(spec));
// Scalar is built on the npm build of Hono, the app on the JSR one: the handler types differ
app.get('/docs', Scalar({ url: '/docs/openapi.json' }) as unknown as MiddlewareHandler<DefaultEnv>);

// The generated handlers report errors as HTTPExceptions - answer them as JSON
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
});

Deno.serve({ port: 3000 }, app.fetch);
```

```bash
deno task dev
```

The interactive API reference is at http://localhost:3000/docs.

### 7. Try it

```bash
# Create an author, then one of their books
curl -X POST localhost:3000/api/author -H 'Content-Type: application/json' \
  -d '{"name": "Ursula K. Le Guin", "email": "ursula@example.com"}'
# 201 {"data":{"id":"6f1c…","name":"Ursula K. Le Guin","email":"ursula@example.com","createdAt":1758620000000,…}}

curl -X POST localhost:3000/api/book -H 'Content-Type: application/json' \
  -d '{"title": "The Dispossessed", "publishedAt": 136598400000, "authorId": "6f1c…"}'

# The author with their books
curl 'localhost:3000/api/author/6f1c…?include=bookList'

# Books whose title contains "dis", newest first
curl -G localhost:3000/api/book \
  --data-urlencode "where=$(printf '%s' '{"field":"title","op":"ilike","value":"%dis%"}' | base64 | tr -d '\n')" \
  --data-urlencode 'orderBy=publishedAt' --data-urlencode 'orderDirection=desc'
# 200 {"data":[…],"pagination":{"total":1,"limit":10,"offset":0}}
```

Dates travel as epoch milliseconds (`136598400000` is 1974-05-01). Next steps: [hooks](#hooks) for business rules,
[middleware](#authentication-and-request-context) for authentication, and
[Everyday Development Tasks](#everyday-development-tasks) for evolving the models and the database.

---

## The Generated Code

### Architecture

```
HTTP request
   │
   ▼
REST layer ─────── rest/*.rest.ts, rest/crud.factory.ts
   │   routes, JSON bodies, query parameters, filter validation, errors → status codes
   ▼
Domain layer ───── domain/*.domain.ts
   │   hooks, Zod validation, field sanitization, relation loading, soft delete
   ▼
Schema layer ───── schema/*.schema.ts
   │   Drizzle tables, TypeScript types, Zod schemas, field metadata, relations
   ▼
Database layer ─── db/database.ts
       connection pool, transactions with retries, after-commit queue
```

Each layer only calls the one below it. The REST layer is thin — every endpoint is one domain call inside a transaction
— so whatever the API does, your own code can do through the domain as well: from a custom route, a scheduled job or a
script.

### What you get

- **CRUD** for every model — create, read one, read many, update, delete — as REST endpoints and as domain methods
- **Relationships** — one-to-many, many-to-one, one-to-one and many-to-many (junction table and endpoints generated),
  self-references included, loaded on demand with `include`
- **Querying** — pagination, ordering, and nested `and`/`or` filters with operators checked against the field type
- **Validation** — Zod schemas derived from the tables: required fields, types, enums, string lengths; check constraints
  and foreign keys in the database
- **Hooks** — `before`, `pre`, `post` and `after` hooks around every operation, with the request context
- **Transactions** — automatic retry of serialization failures, savepoints, and after-hooks that start only once the
  data is committed
- **Field control** — hidden fields, fields visible only in the create response, immutable and server-managed fields
- **Soft delete** — per model, honored by reads, relation loading, filters and unique indexes
- **Spatial data** — PostGIS geometry and geography columns, exchanged as GeoJSON
- **OpenAPI 3.1** — built from the models at runtime, ready for an interactive reference
- **Error mapping** — validation errors, missing rows and constraint violations answer 400, 404 or 409 instead of 500
- **PostgreSQL and CockroachDB** — one schema for both
- **Migrations** — a plain Drizzle schema and a `drizzle.config.ts`, so drizzle-kit's `push`, `generate` and `migrate`
  work as documented

### A request, step by step

`POST /api/book` with a JSON body:

1. The route reads the body — malformed JSON answers 400 — and opens a transaction with `withTransaction`.
2. `bookDomain.create()` removes the fields the model does not accept on create, runs `beforeCreate`, validates with the
   Zod insert schema, runs `preCreate` and validates its output again.
3. It inserts the row, runs `postCreate`, removes the fields the model does not expose, and queues `afterCreate` on the
   transaction.
4. The transaction commits. Only then does `afterCreate` start — without being awaited.
5. The response is `201 {"data": {…}}`. A serialization failure (SQLSTATE 40001) before the commit retries the whole
   transaction.

### Generated files

```
generated/
├── index.ts                 initializeGenerated(), re-exports of everything below
├── drizzle.config.ts        drizzle-kit configuration: schema path, schema filter, PostGIS filter, DB_URL
├── db/
│   ├── database.ts          connect, withTransaction, withNestedTransaction, runAfterCommit, getSQL
│   └── bootstrap.ts         installs PostGIS (PostgreSQL with spatial fields only); runnable on its own
├── schema/
│   ├── <model>.schema.ts    Drizzle table, types (Book, NewBook), Zod schemas, field metadata
│   ├── <junction>.schema.ts junction tables of many-to-many relationships
│   ├── relations.ts         Drizzle relations
│   └── spatial-utils.ts     GeoJSON ⇄ WKT/EWKB conversion
├── domain/
│   ├── <model>.domain.ts    <Model>Domain class and its <model>Domain instance
│   ├── hooks.types.ts       DomainHooks, JunctionTableHooks, QueryOptions
│   ├── junction.utils.ts    many-to-many operations (only with many-to-many relations)
│   └── exceptions.ts        DomainException, NotFoundException, InvalidFilterException
├── rest/
│   ├── <model>.rest.ts      routes of one model, including its many-to-many endpoints
│   ├── crud.factory.ts      the shared CRUD handlers
│   ├── helpers.ts           parseJsonBody, handleDomainException, convertBigIntToNumber
│   ├── openapi.ts           buildOpenAPISpec, mergeOpenAPISpec, getOpenAPIJSON
│   ├── openapi-metadata.ts  the model metadata the OpenAPI document is built from
│   ├── types.ts             DefaultEnv
│   └── index.ts             registerRestRoutes, extractRoutes
└── utils/
    ├── filter.utils.ts      filter parsing, validation, SQL building and helpers
    └── field-meta.utils.ts  exposure and acceptance metadata of the fields
```

### Working with generated code

- **Do not edit generated files.** Change the models and regenerate; COG overwrites `generated/` on every run. Behavior
  beyond the models belongs in [hooks](#hooks), Hono middleware, your own routes, and your own modules that call the
  domain.
- **Generation is deterministic.** The same models and the same COG version produce the same code.
- **Delete `generated/` after removing or renaming a model.** Generation overwrites files but deletes none, so the files
  of a model that no longer exists would stay behind.
- **Version control is your choice.** The example keeps `generated/` out of git and regenerates it; committing it lets
  you review what a model change or a COG upgrade changed. Either way, the deployed application needs `generated/`, and
  the migrations in `drizzle/` are always committed.

---

## Model Definition

Every `.json` file in the models directory defines one model. COG validates all of them before it writes anything and
stops with a list of errors: duplicate or missing names, a model without a primary key, an unknown type, an identifier
longer than 63 bytes, a spatial field while PostGIS is off.

### Model properties

| Property        | Required | Description                                                                                                                                                    |
| --------------- | :------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          |   yes    | PascalCase model name. It names the types (`Book`, `NewBook`), the domain (`BookDomain`, `bookDomain`), the hooks key (`book`) and the REST path (`/api/book`) |
| `tableName`     |   yes    | Table name — snake_case, singular                                                                                                                              |
| `fields`        |   yes    | The columns; at least one, with at least one `primaryKey`                                                                                                      |
| `schema`        |    no    | PostgreSQL schema; omitted or `"public"` means the default one — see [Database schemas](#database-schemas)                                                     |
| `relationships` |    no    | [Relationships](#relationships) to other models                                                                                                                |
| `enums`         |    no    | [Enums](#enums) used by the fields of this model                                                                                                               |
| `indexes`       |    no    | Additional [indexes](#indexes)                                                                                                                                 |
| `check`         |    no    | [Check constraints](#check-constraints)                                                                                                                        |
| `timestamps`    |    no    | `createdAt`/`updatedAt` columns — see [Timestamps](#timestamps)                                                                                                |
| `softDelete`    |    no    | [Soft delete](#soft-delete) instead of physical deletion                                                                                                       |
| `endpoints`     |    no    | Which REST endpoints to generate — see [Endpoint configuration](#endpoint-configuration)                                                                       |
| `description`   |    no    | Description in the OpenAPI document                                                                                                                            |

### Field properties

| Property             | Applies to       | Description                                                                                    |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| `name`               | all              | camelCase field name; the column is its snake_case form (`authorId` → `author_id`)             |
| `type`               | all              | one of the [data types](#data-types)                                                           |
| `primaryKey`         | all              | part of the primary key                                                                        |
| `required`           | all              | `NOT NULL`, and required in the create input                                                   |
| `unique`             | all              | unique constraint; a partial unique index on a soft-delete model                               |
| `index`              | all              | an index on the column                                                                         |
| `defaultValue`       | all              | see [Default values](#default-values)                                                          |
| `array`              | all              | an array of `type`                                                                             |
| `references`         | all              | foreign key `{ "model", "field", "onDelete", "onUpdate" }` — see [Foreign keys](#foreign-keys) |
| `expose`             | all              | visibility in responses — see [Field exposure and acceptance](#field-exposure-and-acceptance)  |
| `accept`             | all              | whether the API accepts the field as input                                                     |
| `description`        | all              | description in the OpenAPI document                                                            |
| `maxLength`          | `string`, `text` | maximum length, checked on create and update; also the `varchar` length of a `string` column   |
| `minLength`          | `string`, `text` | minimum length, checked on create and update                                                   |
| `precision`, `scale` | `decimal`        | `numeric(precision, scale)`                                                                    |
| `enumName`           | `enum`           | the name of an enum from the model's `enums`                                                   |
| `srid`               | spatial          | spatial reference id, e.g. `4326`                                                              |
| `geometryType`       | `geometry`       | geometry type of a generic `geometry` column, e.g. `"POINT"`                                   |

### Data types

| `type`                                                                                        | Column                                     | In the API                                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| `string`                                                                                      | `varchar(maxLength)`, unbounded without it | string                                          |
| `text`                                                                                        | `text`                                     | string                                          |
| `integer`                                                                                     | `integer`                                  | number                                          |
| `bigint`                                                                                      | `bigint`                                   | number — exact up to 2^53−1                     |
| `decimal`                                                                                     | `numeric(precision, scale)`                | string, e.g. `"12.50"`, so no precision is lost |
| `boolean`                                                                                     | `boolean`                                  | boolean                                         |
| `uuid`                                                                                        | `uuid`                                     | string                                          |
| `date`                                                                                        | `bigint`                                   | number: epoch milliseconds (`Date.getTime()`)   |
| `json`, `jsonb`                                                                               | `json`, `jsonb`                            | any JSON value                                  |
| `enum`                                                                                        | an enum type, or `integer` with bitwise    | string (the integer with bitwise storage)       |
| `point`, `linestring`, `polygon`, `multipoint`, `multilinestring`, `multipolygon`, `geometry` | `geometry(<type>, <srid>)`                 | GeoJSON                                         |
| `geography`                                                                                   | `geography`                                | GeoJSON                                         |

Any type becomes an array with `"array": true` (`text[]`, `integer[]`, …). Spatial types need PostGIS on PostgreSQL —
`db/bootstrap.ts` installs it — and are built into CockroachDB. With `--no-postgis` there is no spatial support, and a
spatial field makes generation fail.

### Default values

```json
{ "name": "id", "type": "uuid", "primaryKey": true, "defaultValue": "gen_random_uuid()" }
{ "name": "status", "type": "string", "maxLength": 20, "defaultValue": "draft" }
{ "name": "stock", "type": "integer", "defaultValue": 0 }
{ "name": "isActive", "type": "boolean", "defaultValue": true }
```

A string containing `()` is a SQL expression, any other string a literal. Numeric defaults are limited to
`Number.MAX_SAFE_INTEGER` (2^53−1).

### Enums

Define the enum on the model and point the field at it:

```json
{
  "name": "Book",
  "tableName": "book",
  "enums": [{ "name": "BookFormat", "values": ["hardcover", "paperback", "ebook"] }],
  "fields": [
    { "name": "id", "type": "uuid", "primaryKey": true, "defaultValue": "gen_random_uuid()", "required": true },
    { "name": "format", "type": "enum", "enumName": "BookFormat", "required": true }
  ]
}
```

This creates a database enum type (`book_format`), and the API accepts only the listed values. `"useBitwise": true` on
the enum stores the field as a plain `integer` instead, for flag sets combined with bitwise operators; the application
encodes those numbers itself. Inline `enumValues` on a field are not supported — generation stops and asks for a
model-level enum.

### Relationships

| `type`       | Meaning                                        | The foreign key                                                          |
| ------------ | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `manyToOne`  | this row points to one target row              | a field of this model, named by `foreignKey`                             |
| `oneToMany`  | many target rows point to this one             | a field of the target, named by `foreignKey`                             |
| `oneToOne`   | one row on each side                           | a field of this model (owning side) or of the target (inverse side)      |
| `manyToMany` | rows on both sides, linked by a junction table | the junction columns `foreignKey` (to this model) and `targetForeignKey` |

| Property           | Description                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `type`             | one of the types above                                                                                               |
| `name`             | relation name, used by `include`; camelCase, collections end in `List` (`bookList`)                                  |
| `target`           | name of the target model                                                                                             |
| `foreignKey`       | the foreign-key field (camelCase); for `manyToMany` the junction column pointing to this model, default `<model>_id` |
| `targetForeignKey` | `manyToMany`: the junction column pointing to the target, default `<target>_id`                                      |
| `through`          | `manyToMany`: the name of the junction table                                                                         |
| `onDelete`         | `manyToMany`: action of the junction foreign keys, default `CASCADE`; `onUpdate` likewise                            |
| `endpoints`        | `manyToMany`: which relation endpoints to generate — see [Endpoint configuration](#endpoint-configuration)           |

A relationship tells COG how to load related rows; the foreign key itself is declared on the field with `references`.
The bookshop pair from [Getting Started](#3-describe-the-data) shows both sides: `Book.authorId` references `Author.id`,
`Book` declares `manyToOne` `author`, and `Author` declares `oneToMany` `bookList`, both with
`"foreignKey": "authorId"`. A `oneToOne` is declared the same way; the side that has the foreign-key field owns it.

**Many-to-many.** COG generates the junction table (`schema/<through>.schema.ts`, with a composite primary key), and
drizzle-kit creates it:

```json
{
  "type": "manyToMany",
  "name": "genreList",
  "target": "Genre",
  "through": "book_genre",
  "foreignKey": "book_id",
  "targetForeignKey": "genre_id"
}
```

Declare it on both models, with the same `through` and the keys swapped, to load and edit it from both sides. A
self-reference works the same way; the example's employees have mentors and mentees over one `employee_mentor` table:

```json
[
  {
    "type": "manyToMany",
    "name": "menteeList",
    "target": "Employee",
    "through": "employee_mentor",
    "foreignKey": "mentor_id",
    "targetForeignKey": "mentee_id"
  },
  {
    "type": "manyToMany",
    "name": "mentorList",
    "target": "Employee",
    "through": "employee_mentor",
    "foreignKey": "mentee_id",
    "targetForeignKey": "mentor_id"
  }
]
```

Junction tables always live in the default schema.

#### Foreign keys

`references` creates the foreign key. `onDelete` and `onUpdate` take `CASCADE`, `SET NULL`, `RESTRICT` or `NO ACTION`,
the default:

| `onDelete`              | Deleting a parent that still has children | Answer  |
| ----------------------- | ----------------------------------------- | ------- |
| `CASCADE`               | deletes the children too                  | 200     |
| `SET NULL`              | sets the children's foreign key to `NULL` | 200     |
| `RESTRICT`, `NO ACTION` | refused by the database                   | **409** |

A create or update that references a missing row answers **400**.

### Indexes

```json
"indexes": [
  { "fields": ["authorId", "publishedAt"] },
  { "name": "idx_book_isbn", "fields": ["isbn"], "unique": true },
  { "fields": ["tags"], "type": "gin" },
  { "fields": ["isActive"], "where": "is_active = true" }
]
```

| Property | Description                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| `fields` | field names (camelCase)                                                                                    |
| `name`   | index name; generated when omitted                                                                         |
| `unique` | a unique index; partial (`deleted_at IS NULL`) on a soft-delete model                                      |
| `type`   | `btree` (default), `hash`, `gist`, `gin`, `spgist`, `brin`; CockroachDB supports `btree`, `gin` and `gist` |
| `where`  | the condition of a partial index, in SQL with column names                                                 |

`"index": true` on a field is the shorthand for a single-column index. An index whose first field is spatial uses GiST
automatically.

### Check constraints

```json
"check": {
  "numNotNulls": [{ "fields": ["email", "phone", "postalAddress"], "num": 1 }]
}
```

This generates `CHECK (num_nonnulls(email, phone, postal_address) = 1)`: exactly `num` of the listed fields must be set
— here exactly one contact channel. A violation answers **400**.

### Timestamps

`"timestamps": true` adds `createdAt` and `updatedAt` (columns `created_at` and `updated_at`): epoch milliseconds, set
by the database on insert, with `updatedAt` refreshed by every update. The API never accepts them as input. The columns
can be renamed:

```json
"timestamps": { "createdAt": "inserted_at", "updatedAt": "modified_at" }
```

### Field exposure and acceptance

`expose` controls where a field appears in responses:

| `expose`              | Effect                                             |
| --------------------- | -------------------------------------------------- |
| `"default"` (or omit) | in every response                                  |
| `"hidden"`            | never in a response, and not filterable            |
| `"create"`            | only in the response of the create; not filterable |

`accept` controls whether the API takes the field as input:

| `accept`              | Effect                                         |
| --------------------- | ---------------------------------------------- |
| `"default"` (or omit) | accepted on create and update                  |
| `"create"`            | accepted on create only — immutable afterwards |
| `"never"`             | never accepted — server-managed, see below     |

```json
{ "name": "passwordHash", "type": "string", "required": true, "expose": "hidden", "accept": "never" }
{ "name": "apiToken", "type": "uuid", "defaultValue": "gen_random_uuid()", "expose": "create", "accept": "never" }
{ "name": "isbn", "type": "string", "maxLength": 17, "accept": "create" }
```

Fields that are not accepted are removed from the input before any hook runs. A `required` field with
`"accept": "never"` and no `defaultValue` therefore needs a `beforeCreate` hook that supplies the value before
validation — here the required `createdBy` of an `Account` model, taken from the request context:

```typescript
const accountHooks: DomainHooks<Account, NewAccount, Partial<NewAccount>, AppVariables> = {
  beforeCreate: (rawInput, context) =>
    Promise.resolve({ ...(rawInput as Record<string, unknown>), createdBy: context?.userId }),
};
```

Related objects loaded with `include` follow their own model's rules. Server-side callers can get every field back with
the domain option `skipSanitization: true`.

### String length validation

`minLength` and `maxLength` on `string` and `text` fields are Zod checks on both create and update; a value outside the
bounds answers **400** with the validation issues. `maxLength` is also the `varchar` length of a `string` column, while
`text` columns stay unbounded. Neither applies to array fields, where it would constrain the array instead of its
elements.

### Endpoint configuration

All endpoints are generated unless switched off. A disabled endpoint has no route and no entry in the OpenAPI document.

```json
{
  "name": "AuditEntry",
  "endpoints": { "create": true, "readOne": true, "readMany": true, "update": false, "delete": false }
}
```

For a many-to-many relationship:

```json
{
  "type": "manyToMany",
  "name": "genreList",
  "target": "Genre",
  "through": "book_genre",
  "endpoints": { "get": true, "add": true, "replace": false, "remove": false }
}
```

`add` covers adding one and many, `remove` removing one and many — see
[Many-to-many endpoints](#many-to-many-endpoints).

### Soft delete

`"softDelete": true` keeps deleted rows: a delete sets a nullable `deleted_at` column (epoch milliseconds) instead of
removing the row, and the row disappears from every read. `{ "deletedAt": "removed_at" }` renames the column.

| Operation                          | On a soft-delete model                                                  |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `DELETE /api/<model>/:id`          | sets `deletedAt`; `updatedAt` stays untouched                           |
| reads, filters, pagination counts  | exclude deleted rows                                                    |
| update or delete of a deleted row  | **404**                                                                 |
| `unique` fields and unique indexes | partial indexes over live rows, so a deleted row does not block a value |
| `include` of a collection          | excludes deleted children                                               |
| `include` of a single related row  | `null` when that row is deleted                                         |
| many-to-many relation list         | excludes deleted targets; junction rows themselves are hard-deleted     |

The column is hidden and never accepted as input. Server-side code can read deleted rows with the domain option
`withSoftDeleted: true`, which the REST API does not expose. Restoring a deleted row is not supported.

**Referential integrity is your policy.** COG does not stop you from creating a child of a soft-deleted parent — the
parent row still exists, so the foreign key accepts it — and it does not cascade a soft delete to children. Whether a
deleted parent is archived with editable children or trashed with a frozen subtree depends on the application, so
enforce it in a hook:

```typescript
preCreate: async (input, _rawInput, tx) => {
  const author = await authorDomain.findById(input.authorId, tx); // null when soft-deleted
  if (!author) {
    throw new HTTPException(409, { message: 'The author is not available' });
  }
  return input;
},
```

### Database schemas

```json
{ "name": "Report", "tableName": "report", "schema": "analytics" }
```

The table lives in the `analytics` schema. drizzle-kit creates the schema itself: the generated `pgSchema('analytics')`
is exported for that purpose, and `drizzle.config.ts` lists the schema in its `schemaFilter`. `"public"` or no `schema`
means the default schema. Junction tables always live in the default schema. The CLI option `--schema <name>` puts every
model into one schema, overriding the models' own `schema`.

### Naming rules

| Item           | Convention                               | Example                        |
| -------------- | ---------------------------------------- | ------------------------------ |
| Model name     | PascalCase                               | `Book`, `BookReview`           |
| Table name     | snake_case, singular                     | `book`, `book_review`          |
| Field / column | camelCase / snake_case                   | `publishedAt` / `published_at` |
| Relation name  | camelCase, `List` suffix for collections | `author`, `bookList`           |
| REST path      | model name in lower case                 | `/api/bookreview`              |
| Hooks key      | model name in lower case                 | `domainHooks.bookreview`       |

Table, column, index and constraint names are PostgreSQL identifiers of at most 63 bytes. COG stops with an error naming
the offender instead of letting the database truncate it — derived names such as index and constraint names count too.

---

## Domain API

For every model COG generates a class `<Model>Domain` and a ready instance `<model>Domain`, named after the lower-case
model name: `bookDomain`, `authorDomain`, `idcardDomain`. The REST layer uses these instances, and so can your code. The
domain classes and instances, the model types, the hook types, the exceptions, the transaction functions and the filter
helpers are all exported from `generated/index.ts`.

### Methods

| Method                                      | Returns            | Notes                                                                            |
| ------------------------------------------- | ------------------ | -------------------------------------------------------------------------------- |
| `create(input, tx, options?, context?)`     | the created row    | `tx` is required                                                                 |
| `findById(id, tx?, options?, context?)`     | the row, or `null` |                                                                                  |
| `findMany(tx?, options?, context?)`         | `{ data, total }`  | `total` counts every match, regardless of `limit` and `offset`                   |
| `update(id, input, tx, options?, context?)` | the updated row    | `input` is partial; throws `NotFoundException` for a missing or soft-deleted row |
| `delete(id, tx, options?, context?)`        | the deleted row    | soft-deletes on a soft-delete model; throws `NotFoundException`                  |

A many-to-many relation adds methods named after it. For `skillList` on `Employee`, targeting `Skill`:

| Method                                                  | Returns   | Effect                                                                                                            |
| ------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `getSkillList(id, tx?, options?, context?)`             | `Skill[]` | the linked skills, read through the Skill domain; `NotFoundException` when the employee is missing or not visible |
| `hasSkill(id, skillId, tx?)`                            | `boolean` | whether the link exists                                                                                           |
| `addSkill(id, skillId, rawInput, tx, context?)`         | —         | adds one link                                                                                                     |
| `addSkillList(id, skillIds, rawInput, tx, context?)`    | —         | adds several links                                                                                                |
| `removeSkill(id, skillId, rawInput, tx, context?)`      | —         | removes one link                                                                                                  |
| `removeSkillList(id, skillIds, rawInput, tx, context?)` | —         | removes several links                                                                                             |
| `setSkillList(id, skillIds, rawInput, tx, context?)`    | —         | replaces all links                                                                                                |

The singular name is the relation name without its `List` suffix. `rawInput` is handed to the junction hooks.

```typescript
import { authorDomain, bookDomain, withTransaction } from './generated/index.ts';

const author = await withTransaction((tx) =>
  authorDomain.create({ name: 'Octavia E. Butler', email: 'octavia@example.com' }, tx)
);

const { data, total } = await bookDomain.findMany(undefined, {
  where: {
    and: [
      { field: 'authorId', op: 'eq', value: author.id },
      { field: 'publishedAt', op: 'gte', value: Date.UTC(1990, 0, 1) },
    ],
  },
  orderBy: 'publishedAt',
  orderDirection: 'desc',
  limit: 20,
});

const withBooks = await authorDomain.findById(author.id, undefined, { include: ['bookList'] });
```

### Query options

| Option             | Methods                | Meaning                                                       |
| ------------------ | ---------------------- | ------------------------------------------------------------- |
| `where`            | `findMany`             | a [filter](#filtering) object, or a drizzle `SQL` condition   |
| `limit`, `offset`  | `findMany`             | pagination; no limit by default (the REST API defaults to 10) |
| `orderBy`          | `findMany`             | a field name (camelCase); an unknown field is ignored         |
| `orderDirection`   | `findMany`             | `'asc'` (default) or `'desc'`                                 |
| `include`          | `findById`, `findMany` | relation names to load                                        |
| `skipSanitization` | all                    | return hidden and create-only fields too                      |
| `withSoftDeleted`  | `findById`, `findMany` | include soft-deleted rows                                     |

- **Includes go through the related model's domain.** Its find hooks run with the same `context` — so a hook that scopes
  reads, by tenant for instance, scopes included rows as well — and its exposure and soft-delete rules apply.
- **Included relations are not in the static type.** They are added to the returned object under the relation name —
  describe them with your own type, e.g. `Author & { bookList?: Book[] }`.
- **Filter objects are validated like in the REST API.** An unknown or hidden field, an operator the field's type does
  not support, or a value of the wrong shape throws an `InvalidFilterException` — answered with **400** over REST —
  instead of being dropped, which would widen the result. To filter on a hidden column, pass SQL:
  `where: eq(bookTable.internalCode, code)`.

### Transactions

Writes take a transaction; reads accept one. Open transactions with `withTransaction`:

```typescript
const book = await withTransaction(
  async (tx) => {
    const author = await authorDomain.create({ name: 'N. K. Jemisin', email: 'nk@example.com' }, tx);
    return await bookDomain.create({ title: 'The Fifth Season', authorId: author.id }, tx);
  },
  { isolationLevel: 'serializable' },
);
```

| Option           | Default          | Meaning                                                     |
| ---------------- | ---------------- | ----------------------------------------------------------- |
| `isolationLevel` | database default | `'read committed'`, `'repeatable read'` or `'serializable'` |
| `accessMode`     | `'read write'`   | or `'read only'`                                            |
| `deferrable`     | —                | `DEFERRABLE` for serializable read-only transactions        |
| `enableRetry`    | `true`           | retry on serialization failures (SQLSTATE 40001)            |
| `maxRetries`     | `5`              |                                                             |
| `initialDelayMs` | `50`             | exponential backoff with jitter between attempts            |
| `maxDelayMs`     | `5000`           |                                                             |

**A retried transaction runs its callback again**, hooks included. Keep side effects that must not repeat — emails,
calls to other systems — in [after-hooks](#after-hooks-and-transactions), which start once per committed transaction.

`withNestedTransaction(tx, callback)` opens a savepoint inside an open transaction. A failure rolls back the savepoint
only; the caller can catch it and carry on:

```typescript
await withTransaction(async (tx) => {
  await orderDomain.create(order, tx);
  try {
    await withNestedTransaction(tx, async (nested) => {
      await auditDomain.create(entry, nested);
    });
  } catch {
    // the audit entry and its after-hooks are gone, the order stays
  }
});
```

Raw access: `withoutTransaction()` returns the Drizzle database, `getSQL()` the postgres.js client, and
`initializeGenerated()` returns both as `{ db, sql }`, together with `domain` and `schema`.

### Hooks

Hooks add behavior around every domain operation without touching generated code. For a create:

```
withTransaction opens the transaction            (the REST API does this before calling the domain)
  create()
    remove the fields the model does not accept on create
    beforeCreate(rawInput)                        no transaction handle, before validation
    validate with the Zod insert schema
    preCreate(input, rawInput, tx)                its output is validated again
    INSERT … RETURNING
    postCreate(input, result, rawInput, tx)
    remove the fields the model does not expose
    queue afterCreate on the transaction
COMMIT
afterCreate(result, rawInput)                     starts after COMMIT, not awaited
```

Update, delete, find by id and find many follow the same pattern.

#### Registering hooks

Pass them to `initializeGenerated`, keyed by the lower-case model name. `domainHooks` is typed per model, so hooks
written inline get their parameter types from it; a hooks object declared on its own needs a `DomainHooks` annotation:

```typescript
import { HTTPException } from '@hono/hono/http-exception';
import { type Book, bookDomain, type DomainHooks, initializeGenerated, type NewBook } from './generated/index.ts';

type AppVariables = { userId?: string };

const bookHooks: DomainHooks<Book, NewBook, Partial<NewBook>, AppVariables> = {
  preCreate: async (input, _rawInput, tx) => {
    const { total } = await bookDomain.findMany(tx, {
      where: {
        and: [{ field: 'authorId', op: 'eq', value: input.authorId }, { field: 'title', op: 'eq', value: input.title }],
      },
    });
    if (total > 0) {
      throw new HTTPException(409, { message: `"${input.title}" is already listed for this author` });
    }
    return input;
  },
  afterCreate: async (book, _rawInput, context) => {
    await searchIndex.add(book, context?.userId); // your own code
  },
};

await initializeGenerated({
  database: { connectionString: Deno.env.get('DB_URL')! },
  app,
  domainHooks: { book: bookHooks },
});
```

#### Hook reference

Every hook returns a promise. `context` is the request context — see
[Authentication and request context](#authentication-and-request-context).

| Hook             | Arguments                                  | Returns                                   |
| ---------------- | ------------------------------------------ | ----------------------------------------- |
| `beforeCreate`   | `rawInput, context`                        | the input to validate                     |
| `preCreate`      | `input, rawInput, tx, context`             | the input to insert — validated again     |
| `postCreate`     | `input, result, rawInput, tx, context`     | the result                                |
| `afterCreate`    | `result, rawInput, context`                | —                                         |
| `beforeUpdate`   | `id, rawInput, context`                    | the input to validate                     |
| `preUpdate`      | `id, input, rawInput, tx, context`         | the changes to apply — validated again    |
| `postUpdate`     | `id, input, result, rawInput, tx, context` | the result                                |
| `afterUpdate`    | `result, rawInput, context`                | —                                         |
| `beforeDelete`   | `id, context`                              | —                                         |
| `preDelete`      | `id, tx, context`                          | `{ id }`                                  |
| `postDelete`     | `id, result, tx, context`                  | the result                                |
| `afterDelete`    | `result, context`                          | —                                         |
| `beforeFindById` | `id, context`                              | the id                                    |
| `preFindById`    | `id, tx, context`                          | `{ id }`                                  |
| `postFindById`   | `id, result, tx, context`                  | the result — called only when a row found |
| `afterFindById`  | `result, context`                          | —                                         |
| `beforeFindMany` | `options, context`                         | the options — `where` is already `SQL`    |
| `preFindMany`    | `tx, options, context`                     | the options                               |
| `postFindMany`   | `options, results, tx, context`            | the results                               |
| `afterFindMany`  | `results, context`                         | —                                         |

- `before*` hooks get no transaction handle and see the raw input before validation: authorization checks, input
  transformation, server-managed values. Through the REST API the transaction is already open when they run, so keep
  them quick.
- `pre*` and `post*` hooks run in the transaction and receive `tx` — pass it to every domain call they make, so the work
  commits or rolls back together.
- `after*` hooks start once the transaction has committed and are not awaited; a failure is logged, never thrown.
- A throw from a `before*`, `pre*` or `post*` hook aborts the operation and rolls the transaction back. See
  [Errors](#errors) for what the client receives.
- Reads without a transaction (the REST `GET` endpoints) pass `tx` as `undefined` to the find hooks.

**Junction hooks** wrap the many-to-many operations. They are registered next to the model's hooks, under
`<relation>JunctionHooks`:

```typescript
const skillListJunctionHooks: JunctionTableHooks<AppVariables> = {
  afterAddJunction: async ({ employeeId, skillId }) => {
    await notifications.skillAdded(employeeId, skillId);
  },
};

await initializeGenerated({ /* … */ domainHooks: { employee: { ...employeeHooks, skillListJunctionHooks } } });
```

| Hook                                        | Arguments                    | Returns          |
| ------------------------------------------- | ---------------------------- | ---------------- |
| `beforeAddJunction`, `beforeRemoveJunction` | `ids, rawInput, context`     | the ids          |
| `preAddJunction`, `preRemoveJunction`       | `ids, rawInput, tx, context` | `{ ids }`        |
| `postAddJunction`, `postRemoveJunction`     | `ids, rawInput, tx, context` | —                |
| `afterAddJunction`, `afterRemoveJunction`   | `ids, rawInput, context`     | — (after COMMIT) |

`ids` holds both keys, named after the junction columns in camelCase: `{ employeeId, skillId }`. Adding or removing
several targets calls the hooks once per link. Replacing the list removes the existing links without remove hooks, then
adds the new ones with add hooks. Over REST, junction hooks receive the request context like every other hook.

#### After-hooks and transactions

An after-hook starts only once the transaction it ran in has committed. The domain method queues it on the transaction,
and `withTransaction` starts the queue after a successful `COMMIT`, in scheduling order and without awaiting it. A
rollback drops the queue, and so does a failed attempt before a retry: every attempt is a transaction of its own. A read
without a transaction starts its after-hook right away.

- **Open transactions through COG.** `withTransaction`, and `withNestedTransaction` for a savepoint. A savepoint is not
  a commit, so its after-hooks move to the parent and start with the outermost `COMMIT`. A domain method that receives a
  transaction COG did not open — a plain `db.transaction()` or `tx.transaction()` — throws instead of losing its
  after-hook silently.
- **Your own post-commit work.** `runAfterCommit(tx, task)` queues any task the same way, e.g. from a `post*` hook.
- **What they receive.** The same result the caller gets, sanitized unless `skipSanitization` is set.
- **At most once.** If the process stops right after `COMMIT`, or the connection breaks during it, the after-hook does
  not run. For a side effect that must never be missed, write an outbox row in the same transaction and process it
  separately.

### Errors

| Thrown                      | Typically by                                 | The REST API answers                                   |
| --------------------------- | -------------------------------------------- | ------------------------------------------------------ |
| `ZodError`                  | input validation                             | **400**, the validation issues as the message          |
| `NotFoundException`         | update or delete of a missing or deleted row | **404**                                                |
| `InvalidFilterException`    | a filter the domain cannot apply             | **400**                                                |
| a database constraint error | the database                                 | **400** or **409** — see [Status codes](#status-codes) |
| `HTTPException` (Hono)      | your hooks                                   | its own status, passed through unchanged               |
| `DomainException`           | your code                                    | **500**                                                |
| anything else               |                                              | re-thrown to the app's `onError`, typically **500**    |

To reject a request from a hook with a client status — 403, 409, 422 — throw Hono's `HTTPException`. Import the
exceptions from `./generated/index.ts`.

### Using the domain outside HTTP

Scripts, scheduled jobs and message consumers call the domain like the REST layer does. `connect()` is enough when no
hooks are needed; construct the domain with its hooks when they are:

```typescript
// scripts/seed.ts - deno run -A --env-file=.env scripts/seed.ts
import { authorDomain, BookDomain, connect, disconnect, withTransaction } from '../generated/index.ts';

await connect({ connectionString: Deno.env.get('DB_URL')! });
try {
  const books = new BookDomain(bookHooks); // with hooks; bookDomain has only those registered by initializeGenerated
  await withTransaction(async (tx) => {
    const author = await authorDomain.create({ name: 'Ted Chiang', email: 'ted@example.com' }, tx);
    await books.create({ title: 'Exhalation', publishedAt: Date.UTC(2019, 4, 7), authorId: author.id }, tx);
  });
} finally {
  await disconnect();
}
```

`connect()` takes the same `database` settings as `initializeGenerated` — a `connectionString`, or `host`, `port`,
`database`, `user` and `password`, plus `ssl`, the pool size `max` (default 10) and `idle_timeout` in seconds (default
20) — and an optional logger. `healthCheck()` runs `SELECT 1`.

---

## REST API

`initializeGenerated` registers the routes of every model on the Hono app, under `/api` or the `api.basePath` you pass.
A model's path is its name in lower case: `/api/book`, `/api/bookreview`, `/api/idcard`. `GET /api` lists the model
paths, and `extractRoutes(app)` returns every registered route — handy for logging at startup.

### CRUD endpoints

| Endpoint               | Domain call | Success                                  | Other answers |
| ---------------------- | ----------- | ---------------------------------------- | ------------- |
| `GET /api/book`        | `findMany`  | 200 `{ "data": […], "pagination": {…} }` | 400           |
| `GET /api/book/:id`    | `findById`  | 200 `{ "data": {…} }`                    | 404           |
| `POST /api/book`       | `create`    | 201 `{ "data": {…} }`                    | 400, 409      |
| `PUT /api/book/:id`    | `update`    | 200 `{ "data": {…} }`                    | 400, 404, 409 |
| `DELETE /api/book/:id` | `delete`    | 200 `{ "data": {…} }` — the deleted row  | 404, 409      |

`PUT` is a partial update: only the fields in the body change. `pagination` is `{ "total", "limit", "offset" }`, where
`total` counts every match.

### Many-to-many endpoints

For the relation `skillList` of `Employee`:

| Endpoint                             | Body               | Success                    | Switch    |
| ------------------------------------ | ------------------ | -------------------------- | --------- |
| `GET /api/employee/:id/skillList`    | —                  | 200 `{ "data": [Skill…] }` | `get`     |
| `POST /api/employee/:id/skillList`   | `{ "ids": ["…"] }` | 201                        | `add`     |
| `POST /api/employee/:id/skill`       | `{ "id": "…" }`    | 201                        | `add`     |
| `PUT /api/employee/:id/skillList`    | `{ "ids": ["…"] }` | 200 — replaces all links   | `replace` |
| `DELETE /api/employee/:id/skillList` | `{ "ids": ["…"] }` | 200                        | `remove`  |
| `DELETE /api/employee/:id/skill`     | `{ "id": "…" }`    | 200                        | `remove`  |

The list endpoint reads the employee through its own find hooks first — **404** when it is missing, soft-deleted or
hidden by a hook — and the skills through the Skill domain, so its hooks run with the request context and its exposure
and soft-delete rules apply. The two `DELETE` endpoints take a JSON body. Linking a pair that is already linked answers
**409**, linking a missing target **400**. One-to-many, many-to-one and one-to-one relations have no endpoints of their
own: write the foreign-key field, and read with `include`.

### Query parameters

| Parameter        | Default | Endpoints       | Meaning                                                    |
| ---------------- | ------- | --------------- | ---------------------------------------------------------- |
| `limit`          | `10`    | list            | page size                                                  |
| `offset`         | `0`     | list            | rows to skip                                               |
| `orderBy`        | —       | list            | field name (camelCase); an unknown field is ignored        |
| `orderDirection` | `asc`   | list            | `asc` or `desc`                                            |
| `include`        | —       | list, get by id | comma-separated relation names: `include=author,genreList` |
| `where`          | —       | list            | a [filter](#filtering), JSON encoded as base64             |

### Filtering

A filter is a condition, or an `and`/`or` group of conditions and groups:

```json
{ "field": "title", "op": "ilike", "value": "%dis%" }
```

```json
{
  "and": [
    { "field": "publishedAt", "op": "gte", "value": 0 },
    { "or": [{ "field": "format", "op": "eq", "value": "ebook" }, { "field": "price", "op": "lt", "value": 10 }] }
  ]
}
```

| Field type                             | Operators                                                    |
| -------------------------------------- | ------------------------------------------------------------ |
| `string`, `text`                       | `eq`, `neq`, `like`, `ilike`, `in`, `nin`, `isNull`          |
| `integer`, `bigint`, `decimal`, `date` | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `isNull` |
| `boolean`                              | `eq`, `isNull`                                               |
| `uuid`, `enum`                         | `eq`, `neq`, `in`, `nin`, `isNull`                           |
| `json`, `jsonb`, spatial               | `isNull`                                                     |
| any array field                        | `contains`, `overlaps`, `isNull`                             |

`in`, `nin`, `contains` and `overlaps` take an array; `like` and `ilike` take a SQL pattern with `%` and `_`;
`isNull: true` matches `NULL` and `isNull: false` everything else; dates compare as epoch milliseconds.

The `where` parameter is the filter's JSON, base64-encoded, then URL-encoded:

```typescript
import { andFilters, encodeFilter, eqFilter, ilikeFilter } from './generated/index.ts';

const where = encodeFilter(andFilters(eqFilter('format', 'ebook'), ilikeFilter('title', '%season%')));
await fetch(`/api/book?where=${encodeURIComponent(where)}`);
// the same by hand: encodeURIComponent(btoa(JSON.stringify(filter)))
```

`eqFilter`, `inFilter`, `likeFilter`, `ilikeFilter`, `rangeFilter`, `andFilters` and `orFilters` build filters. A
malformed filter, a hidden or create-only field, or an operator the field type does not support answers **400**.

### Request and response format

- Bodies are JSON; every response wraps its payload in `data`.
- `date` fields and timestamps are epoch milliseconds, `decimal` values strings, `bigint` values numbers.
- Spatial fields are GeoJSON in both directions: `{ "type": "Point", "coordinates": [19.04, 47.49] }`.
- Hidden fields never appear; create-only fields appear in the create response only.
- Relations loaded with `include` appear under their name — an object or `null`, or an array; soft-deleted rows are left
  out.

### Status codes

| Status | When                                                                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200    | read, update, delete; many-to-many replace and remove                                                                                                       |
| 201    | create; many-to-many add                                                                                                                                    |
| 400    | malformed JSON; validation error (the Zod issues as the message); invalid filter; not-null, check, length or format violation; a reference to a missing row |
| 404    | get, update or delete of a missing or soft-deleted row                                                                                                      |
| 409    | unique violation; delete of a row that is still referenced (`RESTRICT` or `NO ACTION`)                                                                      |
| 500    | `DomainException`, any other error                                                                                                                          |

An `HTTPException` thrown by a hook passes through with its own status. Database errors are mapped by SQLSTATE and the
message names the violated constraint; errors not listed stay 500 — they are an outage or a bug, not the client's
mistake. The error body is up to your `app.onError`; the one in [Getting Started](#6-start-the-api) answers
`{ "error": "<message>" }`. Without an `onError`, Hono answers with the same status and the message as plain text.

### Authentication and request context

Authentication, rate limiting and logging are Hono middleware. Register middleware **before** `initializeGenerated`, so
it runs in front of the generated routes. Every variable the middleware sets with `c.set()` reaches the domain as
`context`, and from there every hook:

```typescript
type AppEnv = { Variables: { userId?: string } };
const app = new Hono<AppEnv>();

app.use('/api/*', async (c, next) => {
  const userId = await verifyToken(c.req.header('Authorization')); // your own code
  if (!userId) {
    throw new HTTPException(401, { message: 'Unauthorized' });
  }
  c.set('userId', userId);
  await next();
});

// bookHooks now see context.userId
await initializeGenerated({
  database: { connectionString: Deno.env.get('DB_URL')! },
  app,
  domainHooks: { book: bookHooks },
});
```

Type the hooks with `DomainHooks<…, AppEnv['Variables']>` to get `context.userId` typed.

### Custom endpoints

Add your own routes to the same app and call the domain; `handleDomainException` maps errors the way the generated
handlers do:

```typescript
import { bookDomain, withTransaction } from './generated/index.ts';
import { handleDomainException } from './generated/rest/helpers.ts';

app.post('/api/book/:id/publish', async (c) => {
  try {
    const book = await withTransaction((tx) =>
      bookDomain.update(c.req.param('id'), { publishedAt: Date.now() }, tx, {}, c.var)
    );
    return c.json({ data: book });
  } catch (error) {
    handleDomainException(error);
  }
});
```

Passing `c.var` as the context lets the hooks see the request's variables here too.

### OpenAPI and the API reference

`buildOpenAPISpec(basePath)` builds an OpenAPI 3.1 document of the generated endpoints at runtime; pass the same base
path as `api.basePath`. `mergeOpenAPISpec(basePath, customSpec)` adds your own paths, schemas, tags and security
schemes, and `getOpenAPIJSON(basePath, customSpec?)` returns the result as a string:

```typescript
import { mergeOpenAPISpec } from './generated/rest/openapi.ts';

const spec = mergeOpenAPISpec('/api', {
  info: { title: 'Bookshop API', version: '1.0.0' },
  paths: {
    '/api/book/{id}/publish': {
      post: { summary: 'Publish a book', responses: { '200': { description: 'The published book' } } },
    },
  },
});
app.get('/docs/openapi.json', (c) => c.json(spec));
```

Serve an interactive reference from it with `@scalar/hono-api-reference`, as in [Getting Started](#6-start-the-api). The
`description` of models and fields ends up in the document.

---

## Everyday Development Tasks

The commands below use the tasks from [Getting Started](#2-create-a-project).

| Task               | Does                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `cog:generate`     | regenerates `generated/` from the models                              |
| `db:bootstrap`     | installs what drizzle-kit cannot create: PostGIS, on PostgreSQL       |
| `drizzle:push`     | makes the database match the schema, without migration files          |
| `drizzle:generate` | writes a migration: the difference between the schema and its history |
| `drizzle:migrate`  | applies the migrations the database has not seen yet                  |

"Generate" means two things here: `cog:generate` produces the current **schema** from the models, `drizzle:generate`
produces a **migration** by comparing that schema with the migrations so far. COG writes no SQL; drizzle-kit owns the
database structure.

### Creating a database

**Development and test databases — push.**

```bash
createdb bookshop_dev
deno task drizzle:push       # bootstrap + create everything the schema describes
```

**Databases that hold real data — migrations, from the very first deployment.**

```bash
createdb bookshop
deno task drizzle:generate   # drizzle/0000_….sql: the baseline, CREATE TABLE for everything
deno task drizzle:migrate    # bootstrap + apply it
```

Commit the whole `drizzle/` directory, `meta/` included: the journal and the snapshots under it are the history
drizzle-kit compares against. Without them the next `generate` starts from an empty baseline again.

> **Pick one path per database, when you create it.** `push` writes no history, so a pushed database cannot move to
> migrations later: the first `generate` produces the full `CREATE TABLE` baseline, and `migrate` fails against the
> tables that already exist. Moving a pushed database onto migrations means generating the baseline and recording it as
> applied by hand.

### Changing a model

1. Edit the model JSON.
2. `deno task cog:generate`
3. Development database: `deno task drizzle:push`. It asks before a statement that loses data — `--force` skips the
   question, which only a throwaway database should get.
4. Real database: `deno task drizzle:generate`, **read the SQL it wrote**, commit it together with the model change, and
   let the deployment run `drizzle:migrate`.

drizzle-kit sees the difference between two schemas, not your intention, so some changes need a decision:

| Change                           | drizzle-kit generates                  | Watch out                                                                                                                    |
| -------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| new optional field               | `ADD COLUMN`                           | —                                                                                                                            |
| new required field               | `ADD COLUMN … NOT NULL`                | fails on a table with rows unless the field has a `defaultValue`; otherwise add it optional, backfill, then make it required |
| renamed field                    | asks: rename, or drop and create       | answer rename, or the column's data is dropped; run `drizzle:generate` in a terminal, not in CI                              |
| removed field                    | `DROP COLUMN`                          | the data is gone                                                                                                             |
| changed type                     | `ALTER COLUMN … SET DATA TYPE`         | a conversion the database cannot do implicitly needs a `USING` clause — edit the migration                                   |
| `unique` or a unique index added | `CREATE UNIQUE INDEX`                  | fails while duplicates exist                                                                                                 |
| `softDelete` switched on         | `ADD COLUMN deleted_at`, index changes | unique indexes become partial ones                                                                                           |
| `onDelete` changed               | foreign key dropped and re-created     | —                                                                                                                            |
| model moved to another `schema`  | drop and create                        | loses the data: write `ALTER TABLE … SET SCHEMA` into the migration instead                                                  |

A migration file is plain SQL; edit it when the generated one is not what you meant.

### Deploying

The application imports `generated/` at runtime, so the build either contains the committed `generated/` or runs
`cog:generate` with the pinned COG version. Before starting a new version, run the pending migrations:

```bash
deno task drizzle:migrate    # bootstrap (idempotent), then every migration not applied yet
```

`drizzle:migrate` is the only database step that belongs in a pipeline; `drizzle:generate` and `drizzle:push` are
development tools.

### Upgrading COG

```bash
git -C ../cog fetch --tags
git -C ../cog log --format='%h %s' <current tag>..<new tag>   # what changed; the commit messages explain why
git -C ../cog checkout <new tag>
deno task cog:generate
deno task drizzle:generate                                   # writes a migration only if the schema changed
```

Compare the dependency list the generator prints with your `deno.json`, run your tests, and read any migration the
upgrade produced — 2.0.1, for example, started emitting the declared `onDelete` actions onto foreign keys.

### Using CockroachDB

Generate with `--dbType cockroachdb` — add it to the `cog:generate` task — and point `DB_URL` at the cluster. The schema
is the same; `db/bootstrap.ts` installs nothing, since spatial support is built in. Mind the
[differences](#database-compatibility): index types, enums from 22.2, and serialization retries, which CockroachDB
causes more often and `withTransaction` handles.

### Seeding and scripts

Seed data, imports and maintenance jobs are Deno scripts that call the domain — see
[Using the domain outside HTTP](#using-the-domain-outside-http). They run through the same validation and, when the
domain is constructed with them, the same hooks as the API.

### Testing

- **Hooks** are plain async functions: test them directly with the arguments from the [reference](#hook-reference).
- **The API** is best tested in-process against a test database created with `drizzle:push`: start the app, call it with
  `fetch`, clean up afterwards. `example/test/integration.test.ts` does exactly that.
- **After-hooks** are not awaited by the call that triggered them; wait for their effect instead of asserting right
  after the request.

### Troubleshooting

| Symptom                                                   | Cause and fix                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `migrate` fails: relation already exists                  | the database was created with `push` — see [Creating a database](#creating-a-database)                              |
| `type "geometry" does not exist`                          | PostGIS is missing on PostgreSQL: run `db:bootstrap` (the `drizzle:*` tasks do)                                     |
| `push` offers to drop `spatial_ref_sys`                   | a PostGIS table drizzle-kit should ignore; regenerate — `drizzle.config.ts` carries `extensionsFilters` for PostGIS |
| generation stops: an identifier is longer than 63 bytes   | shorten the table, field or index name it names                                                                     |
| generation stops: spatial fields with PostGIS disabled    | drop `--no-postgis`, or remove the spatial fields                                                                   |
| generation stops: inline `enumValues`                     | move the values into the model's `enums` and use `enumName`                                                         |
| "The transaction was not opened by withTransaction()"     | an after-hook ran on a transaction COG did not open; use `withTransaction` / `withNestedTransaction`                |
| `InvalidFilterException` from a domain `findMany`         | the filter names an unknown or hidden field, or an operator the field type lacks — fix it, or use SQL               |
| a hook's side effect happened twice                       | the transaction was retried; move it into an after-hook                                                             |
| error responses are plain text, not JSON                  | the app has no `app.onError` — add the one from [Getting Started](#6-start-the-api)                                 |
| `deno check generated/` fails in files of a removed model | generation deletes no files: delete `generated/` and regenerate                                                     |

---

## Reference

### CLI

```bash
deno run -A cog/src/cli.ts [options]
```

| Option                | Default       | Description                                                           |
| --------------------- | ------------- | --------------------------------------------------------------------- |
| `--modelsPath <path>` | `./models`    | directory of the model JSON files                                     |
| `--outputPath <path>` | `./generated` | output directory; files are overwritten, never deleted                |
| `--dbType <type>`     | `postgresql`  | `postgresql` or `cockroachdb`                                         |
| `--schema <name>`     | —             | put every model into this schema, overriding the models' own `schema` |
| `--no-postgis`        | PostGIS on    | no spatial support; a spatial field is then an error                  |
| `--verbose`           | off           | list the generated files                                              |
| `--version`           |               | print the COG version                                                 |
| `--help`              |               | print the options                                                     |

`CREATE EXTENSION IF NOT EXISTS postgis` ends up in `db/bootstrap.ts` only for PostgreSQL, and only when a model has a
spatial field — a project without spatial fields runs on a PostgreSQL without PostGIS. Every run ends with the list of
packages the generated code imports. Programmatically, `generateFromModels(modelsPath, outputPath, options)` from
`src/mod.ts` does the same and returns that list as `dependencies`.

### Database compatibility

| Feature                       | PostgreSQL                                | CockroachDB                                 |
| ----------------------------- | ----------------------------------------- | ------------------------------------------- |
| Versions                      | 13 or newer                               | 22.2 or newer                               |
| Index types                   | btree, hash, gist, gin, spgist, brin      | btree, gin, gist — use btree for the others |
| Enums                         | yes                                       | yes, from 22.2                              |
| `geometry`, `geography`       | PostGIS 3, installed by `db/bootstrap.ts` | built in                                    |
| JSON, JSONB, arrays           | yes                                       | yes                                         |
| Partial indexes (soft delete) | yes                                       | yes                                         |
| Serialization retries (40001) | under `serializable`                      | common; retried by `withTransaction`        |

COG does not translate index types: a `hash`, `spgist` or `brin` index works on PostgreSQL only.

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
- **Dev dependencies** — `drizzle-kit` for the database tasks, and `openapi-types`, imported as a type by
  `rest/openapi.ts` and never present at runtime.
- **Optional** — `@scalar/hono-api-reference`, never imported by the generated code; only needed if the application
  serves the API documentation UI.

Notes on the versions:

- **`@hono/hono` 4.13.5+** is a security floor: 4.12.x is affected by advisories that were fixed in 4.12.27, 4.12.34 and
  4.13.5 (query-parser cache-key confusion, CORS middleware ReDoS, `parseBody()` memory exhaustion, and JSX/SSR issues
  that do not apply to a JSON API).
- **`zod` 4.x** is the tested line. `drizzle-zod` builds the schemas with the `zod/v4` namespace and accepts
  `^3.25.0 || ^4.0.0` as a peer, so zod 3.25.x also resolves — but then the root `zod` export is the v3-classic
  namespace, and anything comparing error classes across the two namespaces breaks. The generated code does not rely on
  `instanceof` for this reason, but staying on zod 4 keeps one single namespace in the project.

### Limitations

- `bigint` fields and numeric defaults are JavaScript numbers: exact up to 2^53−1.
- `PUT` is a partial update; there is no separate `PATCH`.
- The many-to-many `DELETE` endpoints take a JSON body.
- Soft-deleted rows cannot be restored through COG; soft delete does not cascade.
- Enums must be declared on the model (`enums` + `enumName`).
- After-hooks run at most once; use an outbox for side effects that must not be lost.

---

## Example Project

`example/` is a complete application that exercises every feature: 16 models (employees, departments, projects, skills,
ID cards, assignments, spatial and data type demos, soft delete fixtures and more), every relationship type including
self-references, PostGIS data, hooks with their full signatures, check constraints, field exposure and acceptance, a
non-default schema, and an integration test suite.

```bash
cd example
cp .env.template .env        # set DB_URL
deno task cog:psql:generate  # or cog:crdb:generate
deno task drizzle:push
deno run -A --env-file=.env src/main.ts
```

The API reference is at http://localhost:3000/docs/reference. `deno task test:integration` runs the integration tests
against the database in `.env`. See [example/README.md](./example/README.md) for a walk-through.

---

## Developing COG

### Prerequisites

- **Deno** 2.x
- **PostgreSQL** 13+ with PostGIS, and optionally **CockroachDB**, for the integration tests

### Setup

```bash
git clone https://github.com/zgobolos/cog.git
cd cog
deno task setup:hooks
```

The pre-commit hook checks exactly what is being committed. It runs on a temporary checkout of the index, so an unstaged
change neither hides a problem nor causes one:

1. Checks formatting in the root and example directories
2. Regenerates the example code from the models
3. Runs lint and type checks

It never modifies the commit or the working tree. When formatting is off the commit fails: run `deno task fmt`, stage
the result and commit again.

### Development tasks

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

### Code style

Configured in `deno.json`: 2-space indentation, 120-character lines, semicolons, single quotes, and the recommended lint
rules.

### IDE setup (VSCode)

`.vscode/` recommends the `denoland.vscode-deno` extension, formats on save, and configures coverage gutters for
`lcov.info`.

### CI pipeline

GitHub Actions runs on push and pull request to `main` and `develop`:

1. **Lint & type check** — format check, lint and type check of the root and the example, and a generation run
2. **Tests** — a PostGIS container, generation and database setup, the generator unit tests, the integration tests, and
   a coverage upload to Codecov

### Documentation

- **[AGENTS.md](./AGENTS.md)** — the technical reference of the generator and the generated code
- **[example/README.md](./example/README.md)** — the example walk-through

---

## License

MIT License - see [LICENSE](./LICENSE) file for details.
