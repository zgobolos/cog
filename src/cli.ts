#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env

import { generateFromModels } from './mod.ts';
import { formatDependencyReport } from './utils/dependency.utils.ts';
import denoJson from '../deno.json' with { type: 'json' };

/**
 * CLI argument types
 */
interface CliArgs {
  modelsPath?: string;
  outputPath?: string;
  dbType?: 'postgresql' | 'cockroachdb' | string;
  schema?: string;
  postgis?: boolean;
  verbose?: boolean;
  help?: boolean;
  version?: boolean;
}

/**
 * Main CLI for the CRUD Operations Generator
 */
async function main() {
  // Parse command line arguments
  const args = parseArguments();
  const verbose = args.verbose === true;

  // Set up configuration
  const modelsPath = args.modelsPath || './models';
  const outputPath = args.outputPath || './generated';
  const dbType = (args.dbType || 'postgresql') as 'postgresql' | 'cockroachdb';

  // Call the main generation function - it will handle all output based on verbose flag
  const { dependencies } = await generateFromModels(modelsPath, outputPath, {
    database: {
      type: dbType,
      postgis: args.postgis !== false,
      schema: args.schema,
    },
    verbose,
  });

  // The generator emits no deno.json, so the consuming project has to declare these itself
  console.log(formatDependencyReport(dependencies));
}

/**
 * Parse command line arguments
 */
function parseArguments(): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < Deno.args.length; i++) {
    const arg = Deno.args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);

      // Handle --no- prefixed flags
      if (key.startsWith('no-')) {
        const actualKey = key.slice(3) as keyof CliArgs; // Remove 'no-' prefix
        args[actualKey] = false as never;
      } else {
        const value = Deno.args[i + 1];
        if (value && !value.startsWith('--')) {
          args[key as keyof CliArgs] = value as never;
          i++;
        } else {
          args[key as keyof CliArgs] = true as never;
        }
      }
    }
  }
  if (args.version) {
    console.log(`COG ${denoJson.version}`);
    Deno.exit(0);
  }
  if (args.help) {
    showHelp();
    Deno.exit(0);
  }
  return args;
}

/**
 * Show help message
 */
function showHelp() {
  console.log(`
CRUD Operations Generator (COG)

Usage:
  deno run -A src/cli.ts [options]

Options:
  --modelsPath <path>    Path to models directory (default: ./models)
  --outputPath <path>    Path to output directory (default: ./generated)
  --dbType <type>        Database type: postgresql or cockroachdb (default: postgresql)
  --schema <name>        Database schema name
  --no-postgis           Disable PostGIS entirely: no spatial support in the generated code and
                         no CREATE EXTENSION postgis. Spatial fields are then a model error.
  --verbose              Output the relative paths of generated files
  --version              Show the COG version
  --help                 Show this help message

Example:
  deno run -A src/cli.ts --modelsPath ./my-models --outputPath ./src/generated
  `);
}

// Run the CLI
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    Deno.exit(1);
  }
}
