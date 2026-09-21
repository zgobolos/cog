# Corporate ORM Example

Complete demonstration of COG features through a 9-model Corporate ORM system.

---

## What This Demonstrates

This example showcases every major COG feature through interconnected business models.

### Models Overview

| Model            | Key Features                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Employee**     | All relationship types, self-referential many-to-many (mentors/mentees), composite indexes                       |
| **Department**   | PostGIS point field, GIST spatial index, one-to-many relationships                                               |
| **Project**      | PostGIS polygon field, GIST spatial index, one-to-many relationships                                             |
| **Assignment**   | Junction-like table, composite unique index, foreign key CASCADE actions                                         |
| **IDCard**       | One-to-one relationship, date fields, unique constraints                                                         |
| **Skill**        | Many-to-many with Employee via `employee_skill` junction table                                                   |
| **DataTypeDemo** | All primitive types (text, bigint, decimal, json, jsonb, boolean), enums, arrays, GIN indexes                    |
| **SpatialDemo**  | All PostGIS types (linestring, multipoint, multilinestring, multipolygon, geometry, geography), custom SRIDs     |
| **AdvancedDemo** | Custom schema (`analytics`), self-referential relationships, check constraints, named indexes with WHERE clauses |

### Relationship Types Demonstrated

```
Employee ──[manyToOne]──→ Department
Employee ──[oneToMany]──→ Assignment
Employee ──[oneToOne]───→ IDCard
Employee ──[manyToMany]─→ Skill (via employee_skill)
Employee ──[manyToMany]─→ Employee (mentors/mentees via employee_mentor)

Department ──[oneToMany]──→ Employee
Project ──[oneToMany]─────→ Assignment
Assignment ──[manyToOne]──→ Employee
Assignment ──[manyToOne]──→ Project
IDCard ──[oneToOne]───────→ Employee
Skill ──[manyToMany]──────→ Employee

AdvancedDemo ──[manyToOne]──→ AdvancedDemo (parent)
AdvancedDemo ──[oneToMany]──→ AdvancedDemo (children)
```

### Features Demonstrated

**Data Types:**

- Primitives: `text`, `string`, `integer`, `bigint`, `decimal`, `boolean`, `date`, `uuid`
- Structured: `json`, `jsonb`, `enum` (Status, Priority)
- Spatial: `point`, `polygon`, `linestring`, `multipoint`, `multilinestring`, `multipolygon`, `geometry`, `geography`
- Arrays: `string[]`, `integer[]`

**Index Types:**

- BTREE (standard, composite, named)
- GIN (for JSONB and arrays)
- GIST (for PostGIS spatial data)
- Partial indexes with WHERE clauses

**Check Constraints:**

- `numNotNulls` - Require N of M fields to be non-null (AdvancedDemo)

**Foreign Key Actions:**

- `CASCADE` (Assignment → Employee/Project)
- `SET NULL` (AdvancedDemo → parent)
- `RESTRICT` (Employee → Department)
- `NO ACTION` (AdvancedDemo → related)

**Hooks System:**

- **Before Hooks** - Auth checks, input transformation (outside transaction, before validation)
- **Pre/Post Hooks** - Employee model (all CRUD operations, within transaction)
- **After Hooks** - Async side effects (outside transaction, after commit)
- **Junction Hooks** - Employee.skillList (many-to-many operations, same hook types)
- **HTTP-layer concerns:** Use Hono middleware (see example/src/main.ts)

**Advanced Features:**

- Custom database schemas (`analytics` for AdvancedDemo)
- Self-referential relationships (Employee mentors, AdvancedDemo hierarchy)
- Named indexes with WHERE clauses
- Composite unique constraints
- Custom SRIDs (4326 for WGS 84, 3857 for Web Mercator)
- Custom Hono context variables (`Env` type)

---

## Quick Start

### 1. Database Setup

Create an empty PostgreSQL database — that is the only manual step:

```sql
CREATE DATABASE corporate_orm;
```

The PostGIS extension is installed by `deno task db:bootstrap`, and the `analytics` schema is created by drizzle-kit
from the generated schema definition (both run as part of `deno task drizzle:push` in step 4).

### 2. Environment Configuration

Create `.env` file:

```bash
DB_URL=postgresql://user:password@localhost:5432/corporate_orm
DB_SSL_CA_FILE=path/to/ca-certificate.crt  # Or leave empty for local dev
```

For local development without SSL, modify `src/main.ts` to remove the `ssl` option.

### 3. Generate Code

**For PostgreSQL:**

```bash
deno task cog:psql:generate
```

**For CockroachDB:**

```bash
deno task cog:crdb:generate
```

### 4. Create the Database Schema

```bash
deno task drizzle:push
```

This runs the bootstrap (PostGIS extension) and lets drizzle-kit create all tables, indexes, relationships and check
constraints from the generated schema. For a production-style flow use `deno task drizzle:generate` followed by
`deno task drizzle:migrate` instead, which writes versioned migration files into `drizzle/`.

### 5. Start Server

```bash
deno task run
```

Server starts at `http://localhost:3000`

---

## Testing

### Comprehensive Test Suite

The example includes a complete test suite (`test/api-demo.ts`) that validates all generated functionality:

```bash
deno task test
```

**What It Tests (13 Sections):**

1. **Creating Departments** - Spatial data (PostGIS Point), GeoJSON handling
2. **Creating Employees** - Foreign key relationships, basic CRUD
3. **Creating Skills** - Simple entity creation
4. **Adding Skills to Employees** - Many-to-many relationships via junction table
5. **Creating ID Cards** - One-to-one relationships
6. **Creating Mentor Relationships** - Self-referential many-to-many
7. **Creating Projects** - Spatial boundaries (PostGIS Polygon)
8. **Creating Assignments** - Junction-like table with additional fields
9. **Querying with Includes** - Loading related entities via `?include=` parameter
10. **Update Operations** - PUT requests, partial updates
11. **Pagination and Ordering** - `limit`, `offset`, `orderBy`, `orderDirection`
12. **List Operations** - GET all endpoints with pagination
13. **Relationship Endpoints** - Querying related entities directly

**Test Coverage:**

- ✅ All CRUD operations (Create, Read, Update, Delete)
- ✅ All relationship types (one-to-many, many-to-one, many-to-many, one-to-one)
- ✅ Self-referential relationships
- ✅ Spatial data (Point, Polygon) with GeoJSON
- ✅ Date fields (EPOCH milliseconds)
- ✅ Pagination and ordering
- ✅ Include queries (eager loading)
- ✅ Foreign key constraints
- ✅ Unique constraints
- ✅ Validation (Zod schemas)

**Expected Output:**

```
Starting API Demo & Test Suite...

============================================================
  1. Creating Departments with Spatial Data
============================================================

> Creating Engineering department in San Francisco
  Created department: Engineering (ID: ...)

> Creating Marketing department in Los Angeles
  Created department: Marketing (ID: ...)
...

============================================================
  All Tests Passed!
============================================================

Summary:
  Departments created: 2
  Employees created: 3
  Skills created: 5
  Projects created: 2
  Assignments created: 3
  ID Cards created: 1

Tip: Run 'deno task db:clean' to remove test data
```

### Database Cleanup

**Quick Cleanup (Fast - Data Only):**

```bash
deno task db:clean
```

Deletes all data from tables in dependency order, but keeps schema intact. Use this between test runs for fast cleanup.

**Schema Sync (after regenerating code):**

```bash
deno task drizzle:push
```

Brings the database in line with the regenerated schema. Use this when:

- Schema has changed (after regenerating code)
- You need a complete fresh start
- Initial setup

**Cleanup Workflow:**

```bash
# Run tests
deno task test

# Quick cleanup (fast)
deno task db:clean

# Run tests again
deno task test

# If the schema changed, sync it first
deno task drizzle:push
deno task test
```

---

## API Endpoints

COG generates REST endpoints for each model:

### Employee Endpoints

```
GET    /api/employee                    # List employees (paginated)
POST   /api/employee                    # Create employee
GET    /api/employee/:id                # Get employee by ID
PUT    /api/employee/:id                # Update employee
DELETE /api/employee/:id                # Delete employee

# Many-to-Many: Skills
GET    /api/employee/:id/skillList      # Get employee's skills
POST   /api/employee/:id/skillList      # Add skills to employee
PUT    /api/employee/:id/skillList      # Replace employee's skills
DELETE /api/employee/:id/skillList      # Remove skills from employee

# Many-to-Many: Mentees
GET    /api/employee/:id/menteeList     # Get employee's mentees
POST   /api/employee/:id/menteeList     # Add mentees to employee
PUT    /api/employee/:id/menteeList     # Replace employee's mentees
DELETE /api/employee/:id/menteeList     # Remove mentees from employee

# Many-to-Many: Mentors
GET    /api/employee/:id/mentorList     # Get employee's mentors
POST   /api/employee/:id/mentorList     # Add mentors to employee
PUT    /api/employee/:id/mentorList     # Replace employee's mentors
DELETE /api/employee/:id/mentorList     # Remove mentors from employee
```

### Department Endpoints

```
GET    /api/department                  # List departments
POST   /api/department                  # Create department
GET    /api/department/:id              # Get department by ID
PUT    /api/department/:id              # Update department
DELETE /api/department/:id              # Delete department
```

### Project Endpoints

```
GET    /api/project                     # List projects
POST   /api/project                     # Create project
GET    /api/project/:id                 # Get project by ID
PUT    /api/project/:id                 # Update project
DELETE /api/project/:id                 # Delete project
```

**Similar patterns apply to all other models.**

### Query Parameters

All `GET` list endpoints support:

- `limit` - Pagination limit (default: 10)
- `offset` - Pagination offset (default: 0)
- `orderBy` - Sort field (e.g., `createdAt`)
- `order` - Sort direction (`asc` or `desc`)

---

## Example API Calls

### Create Department

```bash
curl -X POST http://localhost:3000/api/department \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Engineering",
    "location": {
      "type": "Point",
      "coordinates": [-122.4194, 37.7749]
    }
  }'
```

### Create Employee

```bash
curl -X POST http://localhost:3000/api/employee \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Alice",
    "lastName": "Johnson",
    "email": "alice@example.com",
    "departmentId": "uuid-of-department"
  }'
```

### Create Skill

```bash
curl -X POST http://localhost:3000/api/skill \
  -H "Content-Type: application/json" \
  -d '{ "name": "TypeScript" }'
```

### Add Skill to Employee (Many-to-Many)

```bash
# Add single skill
curl -X POST http://localhost:3000/api/employee/:employeeId/skill \
  -H "Content-Type: application/json" \
  -d '{"id": "skillId"}'

# Add multiple skills
curl -X POST http://localhost:3000/api/employee/:employeeId/skillList \
  -H "Content-Type: application/json" \
  -d '{"ids": ["skillId1", "skillId2"]}'
```

### Create Project

```bash
curl -X POST http://localhost:3000/api/project \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Platform Rewrite",
    "boundary": {
      "type": "Polygon",
      "coordinates": [[
        [-122.5, 37.7],
        [-122.4, 37.7],
        [-122.4, 37.8],
        [-122.5, 37.8],
        [-122.5, 37.7]
      ]]
    }
  }'
```

### Assign Employee to Project

```bash
curl -X POST http://localhost:3000/api/assignment \
  -H "Content-Type: application/json" \
  -d '{
    "employeeId": "uuid-of-employee",
    "projectId": "uuid-of-project",
    "role": "Senior Engineer",
    "hours": 40
  }'
```

### Create Record with Check Constraint

```bash
curl -X POST http://localhost:3000/api/advanceddemo \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Demo Record",
    "optionalField1": "value1",
    "optionalField2": 42,
    "isActive": true
  }'
```

**Note:** At least 2 of the 3 optional fields must be non-null due to check constraint.

### Query with Pagination

```bash
curl "http://localhost:3000/api/employee?limit=20&offset=0&orderBy=lastName&order=asc"
```

---

## Documentation

### OpenAPI Specification

- **JSON Spec**: http://localhost:3000/docs/openapi.json
- **Interactive Docs**: http://localhost:3000/docs/reference

The interactive docs (powered by Scalar) provide:

- All endpoints with request/response schemas
- Try-it-out functionality
- Generated type definitions
- Relationship documentation

---

## Hook Implementations

This example demonstrates domain hooks:

### Domain Hooks (Employee)

```typescript
domainHooks: {
  employee: {
    // Before hooks (outside transaction, before validation)
    beforeCreate: async (rawInput, context) => { /* ... */ },
    beforeUpdate: async (id, rawInput, context) => { /* ... */ },
    beforeDelete: async (id, context) => { /* ... */ },

    // Pre/Post hooks (inside transaction)
    preCreate: async (input, rawInput, tx, context) => { /* ... */ },
    postCreate: async (input, result, rawInput, tx, context) => { /* ... */ },

    // After hooks (outside transaction, async side effects)
    afterCreate: async (result, rawInput, context) => { /* ... */ },

    // Junction table operations (many-to-many)
    skillListJunctionHooks: {
      beforeAddJunction: async (ids, rawInput, context) => { /* ... */ },
      preAddJunction: async (ids, rawInput, tx, context) => { /* ... */ },
      postAddJunction: async (ids, rawInput, tx, context) => { /* ... */ },
      afterAddJunction: async (ids, rawInput, context) => { /* ... */ },
    }
  }
}
```

**Use domain hooks for:**

- **Before hooks**: Auth checks, input transformation (before validation, no transaction)
- **Pre hooks**: Data validation with database access, enforcing business rules (within transaction)
- **Post hooks**: Enriching data with related records (within transaction)
- **After hooks**: Side effects after commit (notifications, logging, external APIs)

**For HTTP-layer concerns (auth, headers, logging):** Use Hono middleware instead (see example/src/main.ts)

### Custom Context Variables

```typescript
// Define custom Env type in context.ts
type Env = {
  Variables: {
    someString: string;
    someDeepStructure: { someOtherString: Date };
  };
};

// Set in middleware
app.use('*', async (c, next) => {
  c.set('someString', crypto.randomUUID());
  c.set('someDeepStructure', { someOtherString: new Date() });
  await next();
});

// Access in domain hooks via context
preCreate: (async (input, tx, context) => {
  const value = context.someString;
  // ...
});
```

---

## Model Files

All model definitions are in `models/` directory:

```
models/
├── employee.json         # Core entity with all relationships
├── department.json       # PostGIS point + one-to-many
├── project.json          # PostGIS polygon + one-to-many
├── assignment.json       # Junction-like table
├── idcard.json          # One-to-one relationship
├── skill.json           # Many-to-many with Employee
├── datatypedemo.json    # Primitive types, enums, arrays
├── spatialdemo.json     # All PostGIS types
└── advanceddemo.json    # Advanced features showcase
```

---

## Database Compatibility

This example works with both PostgreSQL and CockroachDB:

**PostgreSQL:**

- Full PostGIS support (GEOGRAPHY + GEOMETRY)
- All index types (BTREE, GIN, GIST)
- Enums supported (all versions)

**CockroachDB:**

- PostGIS GEOMETRY support (GEOGRAPHY auto-converts)
- All index types (BTREE, GIN, GIST)
- Enums supported (v22.2+)

Generate with appropriate flag:

- PostgreSQL: `deno task cog:psql:generate`
- CockroachDB: `deno task cog:crdb:generate`

---

## Project Structure

```
example/
├── models/                    # JSON model definitions
│   ├── employee.json
│   ├── department.json
│   └── ...
├── src/
│   ├── main.ts               # Server setup with hooks
│   ├── context.ts            # Custom Env type definition
│   └── generated/            # COG-generated code
│       ├── db/               # Database connection
│       ├── schema/           # Drizzle schemas + Zod
│       ├── domain/           # Business logic
│       └── rest/             # REST endpoints + OpenAPI
├── test/
│   ├── api-demo.ts           # Comprehensive test suite (13 sections)
│   └── http-client.ts        # Test utilities and assertions
├── db-bootstrap.ts           # Database bootstrap (PostGIS extension)
├── quick-clean.ts            # Fast database cleanup (data only)
├── deno.json                 # Dependencies + tasks
└── .env                      # Database configuration
```

---

## Key Takeaways

This example demonstrates:

1. **Layered Architecture**: REST → Domain → Schema → Database
2. **Type Safety**: Full TypeScript types generated from JSON models
3. **Hook System**: Four hook types (Before/Pre/Post/After) with transaction control
4. **Spatial Data**: Complete PostGIS integration with multiple SRIDs
5. **Relationships**: All types including self-referential and many-to-many
6. **Validation**: Always-on Zod validation at every layer
7. **Database Compatibility**: Works with PostgreSQL and CockroachDB
8. **Check Constraints**: Database-level validation beyond simple types
9. **OpenAPI**: Auto-generated documentation for all endpoints

**See [../README.md](../README.md) for COG overview and [../WARP.md](../WARP.md) for complete technical reference.**
