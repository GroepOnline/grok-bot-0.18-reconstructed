import { z } from "zod";

export function preprocessLenientEnumValue<T extends string>(value: unknown, options: readonly T[]): unknown {
  if (typeof value !== "string" || options.includes(value as T)) return value;
  const lower = value.toLowerCase();
  const matches = options.filter((option) => option.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : value;
}
export function lenientEnum<S extends z.ZodEnum>(schema: S) {
  return z.preprocess((value) => preprocessLenientEnumValue(value, schema.options as string[]), schema);
}
