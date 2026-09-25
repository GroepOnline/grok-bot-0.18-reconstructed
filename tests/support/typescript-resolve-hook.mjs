import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  if (relative && specifier.endsWith(".js") && context.parentURL != null) {
    const candidate = path.resolve(path.dirname(fileURLToPath(context.parentURL)), `${specifier.slice(0, -3)}.ts`);
    if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
  }
  return nextResolve(specifier, context);
}
