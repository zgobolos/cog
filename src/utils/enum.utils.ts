/**
 * Enum utilities shared by the parser and the generators
 *
 * An enum is a database type, so its name is global: a field may use an enum declared on any
 * model, and models that declare the same enum must declare it identically.
 */

import { EnumDefinition, ModelDefinition } from '../types/model.types.ts';

/**
 * True when two declarations of an enum describe the same type (values in the same order -
 * Postgres orders enum values by declaration - and the same storage)
 */
export const enumsAgree = (a: EnumDefinition, b: EnumDefinition): boolean => {
  return a.values.length === b.values.length &&
    a.values.every((value, index) => value === b.values[index]) &&
    (a.useBitwise === true) === (b.useBitwise === true);
};

const throwOnConflict = (model: ModelDefinition, enumDef: EnumDefinition): never => {
  throw new Error(`Enum '${enumDef.name}' is declared differently in model '${model.name}'`);
};

/**
 * The enums of all models by name, each once (the first declaration).
 * onConflict is called for a declaration that disagrees with an earlier one; by default it throws.
 */
export const collectEnums = (
  models: ModelDefinition[],
  onConflict: (model: ModelDefinition, enumDef: EnumDefinition) => void = throwOnConflict,
): Map<string, EnumDefinition> => {
  const enums = new Map<string, EnumDefinition>();
  for (const model of models) {
    for (const enumDef of model.enums ?? []) {
      const known = enums.get(enumDef.name);
      if (known && !enumsAgree(known, enumDef)) {
        onConflict(model, enumDef);
      }
      enums.set(enumDef.name, known ?? enumDef);
    }
  }
  return enums;
};

/**
 * The variable name of an enum's pgEnum in the generated schema/enums.ts
 */
export const enumVariableName = (enumDef: EnumDefinition): string => {
  return `${enumDef.name.toLowerCase()}Enum`;
};
