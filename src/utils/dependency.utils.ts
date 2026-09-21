/**
 * Resolves the dependency contract of the generated code
 */

import { type DependencyKind, GENERATED_CODE_DEPENDENCIES } from '../constants.ts';

/**
 * The dependencies a consuming project has to declare for one generation run.
 * Each group maps package name -> import map specifier.
 */
export interface DependencyReport {
  /** Needed while the application runs */
  runtime: Record<string, string>;
  /** Only imported as a type - a dev dependency where that distinction exists */
  types: Record<string, string>;
  /** Not imported by the generated code, offered because applications usually want it */
  optional: Record<string, { specifier: string; reason: string }>;
  /** Imported by the generated code but missing from GENERATED_CODE_DEPENDENCIES */
  unresolved: string[];
}

const IMPORT_SPECIFIER_PATTERN = /\bfrom\s+['"]([^'"]+)['"]/g;

/**
 * Reduces an import specifier to its package name ('@hono/hono/http-exception' -> '@hono/hono')
 */
const toPackageName = (specifier: string): string => {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
};

/**
 * True for bare package specifiers - relative paths and scheme-prefixed built-ins are not
 * declared in the import map
 */
const isBareSpecifier = (specifier: string): boolean => {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':');
};

/**
 * Collects the package names the generated files import
 */
export const collectImportedPackages = (files: Map<string, string>): string[] => {
  const packages = new Set<string>();

  for (const content of files.values()) {
    for (const [, specifier] of content.matchAll(IMPORT_SPECIFIER_PATTERN)) {
      if (isBareSpecifier(specifier)) {
        packages.add(toPackageName(specifier));
      }
    }
  }

  return [...packages].sort();
};

/**
 * Builds the dependency report for a set of generated files.
 * The required packages come from the files themselves, so the report always matches what was
 * generated; the optional ones are suggestions that no generated file imports.
 */
export const resolveDependencies = (files: Map<string, string>): DependencyReport => {
  const report: DependencyReport = { runtime: {}, types: {}, optional: {}, unresolved: [] };
  const grouped: Record<Exclude<DependencyKind, 'optional'>, Record<string, string>> = {
    runtime: report.runtime,
    types: report.types,
  };

  for (const name of collectImportedPackages(files)) {
    const dependency = GENERATED_CODE_DEPENDENCIES[name];
    if (!dependency) {
      report.unresolved.push(name);
    } else if (dependency.kind === 'optional') {
      report.optional[name] = { specifier: dependency.specifier, reason: dependency.reason ?? '' };
    } else {
      grouped[dependency.kind][name] = dependency.specifier;
    }
  }

  for (const [name, dependency] of Object.entries(GENERATED_CODE_DEPENDENCIES)) {
    if (dependency.kind === 'optional') {
      report.optional[name] = { specifier: dependency.specifier, reason: dependency.reason ?? '' };
    }
  }

  return report;
};

const importEntries = (entries: [string, string][]): string => {
  return entries.map(([name, specifier]) => `    "${name}": "${specifier}"`).join(',\n');
};

/**
 * Renders the dependency report as a human readable, copy-pasteable summary
 */
export const formatDependencyReport = (report: DependencyReport): string => {
  const lines = [
    '',
    'The generated code is not self-contained. Add the following packages to your project',
    'before you run it - in Deno they all go into the "imports" of your deno.json, in a setup',
    'that separates dependencies from dev dependencies use the grouping below.',
  ];

  if (Object.keys(report.runtime).length > 0) {
    lines.push('', 'Dependencies - required at runtime:', '', importEntries(Object.entries(report.runtime)));
  }

  if (Object.keys(report.types).length > 0) {
    lines.push(
      '',
      'Dev dependencies - imported as types only, never at runtime:',
      '',
      importEntries(Object.entries(report.types)),
    );
  }

  for (const [name, { specifier, reason }] of Object.entries(report.optional)) {
    lines.push('', `Optional - ${reason}:`, '', importEntries([[name, specifier]]));
  }

  if (report.unresolved.length > 0) {
    lines.push(
      '',
      `Warning: the generated code imports ${report.unresolved.join(', ')} with no known version - ` +
        'add it to GENERATED_CODE_DEPENDENCIES in src/constants.ts',
    );
  }

  return lines.join('\n') + '\n';
};
