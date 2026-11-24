# Changelog

Releases are git tags (`2.4.0`, no `v` prefix). Versions before 2.3.0 are described in their commit messages.

## 2.4.0

### Added

- **Trusted writes.** `QueryOptions.trusted` on the generated `create()` and `update()`. `accept` guards outside input;
  server code that writes its own value into an `accept: "never"` field — or into an `accept: "create"` field on update
  — passes `{ trusted: true }` and writes through the domain API, so every hook runs, instead of a direct Drizzle write
  that skips them. The columns COG manages stay stripped even then: `createdAt`, `updatedAt`, the soft-delete column
  and, on update, the primary key. Validation and the hook order are unchanged. The generated REST layer never sets the
  option; never build it from request input, and never pass it while forwarding a caller's input.
- `FieldMeta.acceptTrustedCreate` / `acceptTrustedUpdate`, with `getTrustedCreateUnacceptedFields` /
  `getTrustedUpdateUnacceptedFields` in the generated `utils/field-meta.utils.ts`.

Without `trusted`, behavior is exactly as in 2.3.0.

## 2.3.0

### Fixed

- **Filters** (`where`) are decoded as UTF-8, from standard base64 or base64url (padding optional); invalid UTF-8 is a
  400. `atob()` returned latin-1, so every non-ASCII value was garbled and silently matched nothing. `encodeFilter`
  emits unpadded base64url; `btoa()` threw on characters outside latin-1 (`ő`, `ű`).
- **Array columns** keep their modifiers: `.array()` comes right after the base type. It used to follow `.notNull()`,
  `.default()` and `.references()`, which drizzle's array builder drops — a required array column was nullable.
- **Shared enums**: every enum is declared once in the generated `schema/enums.ts`. Two models declaring the same enum
  exported the same name twice and the schema index did not compile. A field may use an enum declared on any model;
  conflicting declarations or an unknown `enumName` stop generation.
- String defaults are escaped in the generated code.

### Added

- `defaultValue` takes JSON values: `[]` for an array field, any JSON value for `json`/`jsonb` (written as
  `'[]'::jsonb`). `defaultSql` holds SQL expression defaults; a `defaultValue` string with `()` is still read as SQL.
- A warning for a function-call default on a `json`/`jsonb` field, which breaks every later `drizzle-kit push`. Parser
  warnings are printed now.

### Changed (breaking)

- `beforeCreate` / `beforeUpdate` return `Promise<Record<string, unknown>>` (was `Promise<unknown>`): a hook that
  forgets to return no longer compiles.
- A client that encodes filters with latin-1 `btoa()` gets no match for `á`/`é` any more; encode the UTF-8 bytes.
- pgEnums are exported from `schema/enums.ts` (and the schema index), not from the model's schema file.
- An array field's `defaultValue` must be an array (`[]`), not `'{}'`.
- The next `drizzle-kit push` sets `NOT NULL` on required array columns; clean up their `NULL` rows first.
