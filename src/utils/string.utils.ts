/**
 * Shared string utility functions for code generators
 */

/**
 * Capitalize first letter of a string
 */
export const capitalize = (str: string): string => {
  return str.charAt(0).toUpperCase() + str.slice(1);
};

/**
 * Convert camelCase or PascalCase string to snake_case
 */
export const toSnakeCase = (str: string): string => {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    .replace(/^_/, '');
};

/**
 * Convert snake_case string to camelCase
 */
export const toCamelCase = (str: string): string => {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
};

/**
 * Quote a string as a single-quoted TypeScript string literal for generated code
 */
export const toSingleQuotedLiteral = (str: string): string => {
  return `'${str.replace(/[\\']/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
};

/**
 * Escape a string for the body of a template literal (e.g. sql`...`) in generated code
 */
export const escapeTemplateLiteral = (str: string): string => {
  return str.replace(/[\\`]/g, '\\$&').replace(/\$\{/g, '\\${');
};
