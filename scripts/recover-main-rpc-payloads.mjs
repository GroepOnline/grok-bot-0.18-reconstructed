#!/usr/bin/env node
// Recover sand-rpc:main request payload shapes from the checksum-pinned 0.18.0
// upstream payload produced by the documented bootstrap flow (`npm run
// bootstrap`, which fills the ignored `src/app/dist` tree).
//
// The script is evidence-only: it records what shipped code provably does at
// each `sand-rpc:main:m:<method>` callsite (argument kind and top-level object
// keys) and never invents shapes. Raw output lands under the ignored
// `recovered/frontend/reports/` directory; reviewed contracts stay in
// frontend/src/recovered/contracts/main-rpc.ts.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "acorn";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
export const DEFAULT_PAYLOAD_DIR = path.join(REPO_ROOT, "src", "app", "dist");
export const REPORT_PATH = path.join(REPO_ROOT, "recovered", "frontend", "reports", "main-rpc-payloads.json");

export const CHANNEL_PREFIX = "sand-rpc:main:m:";
const SCANNED_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const PRELOAD_SUBDIR = "electron-preload";

function slash(value) {
  return value.split(path.sep).join("/");
}

async function collectScripts(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) files.push(target);
    }
  }
  await walk(directory);
  return files.sort();
}

async function selectSources(payloadDir) {
  const preferred = path.join(payloadDir, PRELOAD_SUBDIR);
  try {
    const entries = await stat(preferred);
    if (entries.isDirectory()) {
      const files = await collectScripts(preferred);
      if (files.length > 0) return { root: preferred, scope: PRELOAD_SUBDIR, files };
    }
  } catch {
    // Fall through to a full payload scan.
  }
  return { root: payloadDir, scope: ".", files: await collectScripts(payloadDir) };
}

/** Evaluate an AST node as a static string, or return null. */
export function staticString(node) {
  if (node == null) return null;
  if (node.type === "ParenthesizedExpression") return staticString(node.expression);
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticString(node.left);
    if (left == null) return null;
    const right = staticString(node.right);
    return right == null ? null : left + right;
  }
  return null;
}

/**
 * Provable top-level string keys of an object literal. Stops at the first
 * spread element: anything after it may be overridden.
 */
export function objectLiteralKeys(node) {
  if (node.type !== "ObjectExpression") return null;
  const keys = [];
  for (const property of node.properties) {
    if (property.type !== "Property") break;
    if (property.computed) break;
    if (property.key.type === "Identifier") keys.push(property.key.name);
    else if (property.key.type === "Literal" && typeof property.key.value === "string") keys.push(property.key.value);
    else break;
  }
  return keys;
}

function parseSource(source) {
  const options = { ecmaVersion: "latest", allowReturnOutsideFunction: true, locations: true };
  try {
    return parse(source, { ...options, sourceType: "module" });
  } catch {
    return parse(source, { ...options, sourceType: "script" });
  }
}

function visitCalls(ast, visit) {
  const stack = [ast];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node == null || typeof node.type !== "string") continue;
    if (node.type === "CallExpression") visit(node);
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "loc") continue;
      const value = node[key];
      if (Array.isArray(value)) stack.push(...value);
      else if (value != null && typeof value === "object") stack.push(value);
    }
  }
}

export function recoverFromSource(source) {
  const methods = Object.create(null);
  const dynamicChannels = [];
  let ast;
  try {
    ast = parseSource(source);
  } catch {
    return { methods, dynamicChannels, parseError: true };
  }
  visitCalls(ast, (call) => {
    const channel = staticString(call.arguments[0]);
    if (channel != null) {
      if (!channel.startsWith(CHANNEL_PREFIX)) return;
      const method = channel.slice(CHANNEL_PREFIX.length);
      if (method.length === 0) return;
      const argument = call.arguments[1];
      const record = { line: call.loc?.start.line ?? null, confidence: "high" };
      if (argument == null) {
        record.argumentKind = "none";
        record.confidence = "medium"; // shipped call sites that pass no payload
      } else {
        const keys = objectLiteralKeys(argument);
        if (keys != null && argument.properties.every((property) => property.type === "Property")) {
          record.argumentKind = "object";
          record.keys = [...new Set(keys)].sort();
        } else if (keys != null) {
          // Partially literal (spread present): keep only the provable prefix.
          record.argumentKind = "object";
          record.keys = [...new Set(keys)].sort();
          record.confidence = "medium";
        } else {
          record.argumentKind = "nonliteral";
          record.confidence = "low";
        }
      }
      (methods[method] ??= []).push(record);
      return;
    }
    const first = call.arguments[0];
    if (first == null) return;
    const text = source.slice(first.start, first.end);
    if (text.includes("sand-rpc") && text.includes(":m:")) {
      dynamicChannels.push({ line: call.loc?.start.line ?? null });
    }
  });
  return { methods, dynamicChannels, parseError: false };
}

export async function recoverMainRpcPayloads(payloadDir = DEFAULT_PAYLOAD_DIR) {
  const resolved = path.resolve(payloadDir);
  let root;
  let scope;
  let files;
  try {
    ({ root, scope, files } = await selectSources(resolved));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Payload directory ${resolved} does not exist. Run \`npm run bootstrap\` first to extract the pinned 0.18.0 payload.`);
    }
    throw error;
  }
  if (files.length === 0) {
    throw new Error(`No scannable scripts under ${resolved}. Run \`npm run bootstrap\` first to extract the pinned 0.18.0 payload.`);
  }
  const sources = [];
  const methods = Object.create(null);
  const dynamicChannels = [];
  const unparseable = [];
  for (const file of files) {
    const contents = await readFile(file);
    sources.push({
      path: slash(path.relative(REPO_ROOT, file)),
      bytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
    const recovered = recoverFromSource(contents.toString("utf8"));
    if (recovered.parseError) unparseable.push(slash(path.relative(REPO_ROOT, file)));
    const relative = slash(path.relative(REPO_ROOT, file));
    for (const [method, records] of Object.entries(recovered.methods)) {
      for (const record of records) (methods[method] ??= []).push({ file: relative, ...record });
    }
    for (const entry of recovered.dynamicChannels) {
      dynamicChannels.push({ file: relative, ...entry });
    }
  }
  for (const method of Object.keys(methods)) methods[method].sort(byLine);
  dynamicChannels.sort((left, right) => left.file.localeCompare(right.file) || (left.line ?? 0) - (right.line ?? 0));
  return {
    schemaVersion: 1,
    edge: "main",
    channelPrefix: CHANNEL_PREFIX,
    payloadDir: slash(path.relative(REPO_ROOT, resolved)),
    scanScope: scope,
    sources,
    unparseable,
    methods,
    unresolvedDynamicChannels: dynamicChannels,
  };
}

function byLine(left, right) {
  return (left.line ?? 0) - (right.line ?? 0) || left.file.localeCompare(right.file);
}

async function main() {
  const payloadDir = process.argv[2] ?? process.env.GROK_BOT_PAYLOAD_DIR?.trim() ?? DEFAULT_PAYLOAD_DIR;
  const report = await recoverMainRpcPayloads(payloadDir);
  const methodCount = Object.keys(report.methods).length;
  console.log(`Scanned ${report.sources.length} script(s) in ${report.scanScope}; found ${methodCount} main RPC method(s).`);
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report written to ${slash(path.relative(REPO_ROOT, REPORT_PATH))}`);
  if (methodCount === 0) process.exitCode = 1;
}

if (process.argv[1] != null && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
