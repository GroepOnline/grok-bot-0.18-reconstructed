import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { REPORT_PATH, recoverFromSource, recoverMainRpcPayloads, staticString } from "../scripts/recover-main-rpc-payloads.mjs";
const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("static string evaluation covers literals, templates and concatenation", () => {
  assert.equal(staticString({ type: "Literal", value: "sand-rpc" }), "sand-rpc");
  assert.equal(
    staticString({
      type: "BinaryExpression",
      operator: "+",
      left: { type: "Literal", value: "a" },
      right: {
        type: "TemplateLiteral",
        expressions: [],
        quasis: [{ type: "TemplateElement", value: { cooked: "b" } }],
      },
    }),
    "ab",
  );
  assert.equal(staticString({ type: "Identifier", name: "method" }), null);
});

test("recovery records method, argument kind and provable top-level keys", () => {
  const source = [
    "invoke('sand-rpc:main:m:openExternal', { url: nextUrl, feature: 'x' });",
    "invoke('sand-rpc:main:m:getUpdateStatus');",
    "invoke(`sand-rpc:main:m:setTimeZoneOverride`, { timeZone: value });",
    "invoke(edge + ':m:' + method, payload);",
    "invoke('sand-rpc:main:m:invokeCursorDashboardAction', request);",
    "invoke('sand-rpc:main:m:commitStagedAttachments', { paths, filenames });",
  ].join("\n");
  const recovered = recoverFromSource(source);
  assert.equal(recovered.parseError, false);

  assert.deepEqual(recovered.methods.openExternal, [
    { line: 1, argumentKind: "object", keys: ["feature", "url"], confidence: "high" },
  ]);
  assert.deepEqual(recovered.methods.getUpdateStatus, [
    { line: 2, argumentKind: "none", confidence: "medium" },
  ]);
  assert.deepEqual(recovered.methods.setTimeZoneOverride, [
    { line: 3, argumentKind: "object", keys: ["timeZone"], confidence: "high" },
  ]);
  assert.deepEqual(recovered.methods.invokeCursorDashboardAction, [
    { line: 5, argumentKind: "nonliteral", confidence: "low" },
  ]);
  // Object literals record their sorted, deduplicated top-level keys.
  assert.deepEqual(recovered.methods.commitStagedAttachments, [
    { line: 6, argumentKind: "object", keys: ["filenames", "paths"], confidence: "high" },
  ]);
  assert.equal(recovered.dynamicChannels.length, 0);

  const dynamic = recoverFromSource("call(`sand-rpc:${edge}:m:${name}`, {});");
  assert.equal(dynamic.dynamicChannels.length, 1);
});

test("spread arguments are recorded with reduced confidence and prefix keys", () => {
  const recovered = recoverFromSource("invoke('sand-rpc:main:m:updatePluginInstall', { pluginId, ...rest });");
  assert.deepEqual(recovered.methods.updatePluginInstall[0].keys, ["pluginId"]);
  assert.equal(recovered.methods.updatePluginInstall[0].confidence, "medium");
});

test("shipped preload shapes: MAIN_METHOD_TABLE declarator and mainEdge member calls", () => {
  const source = [
    "var MAIN_METHOD_TABLE = {",
    "  openExternal: { args: \"object\" },",
    "  getThemeState: { args: \"none\" },",
    "};",
    "var bridge = bridgeEdge(contract, MAIN_METHOD_TABLE, transport);",
    "async function wrapper(url) { await mainEdge.openExternal({ url }); }",
    "async function reader() { return await desktop.mainEdge.getThemeState(); }",
    "mainEdge.subscribe({ 'theme-changed': listener });",
  ].join("\n");
  const recovered = recoverFromSource(source);
  assert.deepEqual(recovered.methodTable, { openExternal: "object", getThemeState: "none" });
  assert.deepEqual(recovered.methods.openExternal, [
    { line: 6, argumentKind: "object", keys: ["url"], confidence: "high" },
  ]);
  assert.deepEqual(recovered.methods.getThemeState, [
    { line: 7, argumentKind: "none", confidence: "medium" },
  ]);
  // Event-handler maps are not RPC method payloads.
  assert.equal(recovered.methods.subscribe, undefined);
});

test("end-to-end recovery over a fixture payload directory", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "main-rpc-recovery-"));
  try {
    const preloadDir = path.join(scratch, "dist", "electron-preload");
    await mkdir(preloadDir, { recursive: true });
    await writeFile(
      path.join(preloadDir, "preload.cjs"),
      "invoke('sand-rpc:main:m:openExternal',{url:a});invoke('sand-rpc:main:m:getThemeState');\n",
    );
    const report = await recoverMainRpcPayloads(path.join(scratch, "dist"));
    assert.equal(Object.keys(report.methods).length, 2);
    assert.ok(report.methods.openExternal[0].keys.includes("url"));
    assert.equal(report.scanScope, "electron-preload");
    assert.match(report.sources[0].path, /preload\.cjs$/);
    assert.match(report.sources[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.edge, "main");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("missing payload produces an actionable error instead of an empty report", async () => {
  await assert.rejects(
    () => recoverMainRpcPayloads(path.join(os.tmpdir(), "main-rpc-does-not-exist-018")),
    /npm run bootstrap/,
  );
});

// ---------------------------------------------------------------------------
// Contract drift checks against reviewed evidence.
//
// The raw recovery report lives under the ignored
// recovered/frontend/reports/ directory and exists only where the pinned
// 0.18.0 payload was bootstrapped (macOS flow). When present, these tests
// fail on any drift between the reviewed frontend contracts and the shipped
// artifact evidence.

function extractFrontendMethodTable(source) {
  const match = source.match(/export const MAIN_METHOD_TABLE = \{([\s\S]*?)\} as const;/);
  assert.ok(match, "frontend main-rpc.ts must contain MAIN_METHOD_TABLE");
  const table = {};
  for (const entry of match[1].matchAll(/(\w+):\s*"(none|object)"/g)) table[entry[1]] = entry[2];
  assert.ok(Object.keys(table).length > 100, "frontend MAIN_METHOD_TABLE extraction looks broken");
  return table;
}

function extractKnownArgumentInterfaces(source) {
  const match = source.match(/export interface KnownMainRpcArguments \{([\s\S]*?)\n\}/);
  assert.ok(match, "frontend main-rpc.ts must contain KnownMainRpcArguments");
  const interfaces = {};
  for (const entry of match[1].matchAll(/^\s{2}(\w+):\s*\{\s*([^}]*?)\s*\};?\s*$/gm)) {
    interfaces[entry[1]] = entry[2];
  }
  return interfaces;
}

test("reviewed payload contracts stay backed by recovered 0.18.0 evidence", async () => {
  const frontendContract = await readFile(
    path.join(repositoryRoot, "frontend/src/recovered/contracts/main-rpc.ts"),
    "utf8",
  );
  const frontendTable = extractFrontendMethodTable(frontendContract);
  const knownArguments = extractKnownArgumentInterfaces(frontendContract);

  let report;
  try {
    report = JSON.parse(await readFile(REPORT_PATH, "utf8"));
  } catch {
    console.log("skipping evidence drift check: no bootstrap recovery report present (run npm run bootstrap + npm run recover:main-rpc)");
    return;
  }
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.edge, "main");

  // The reviewed method table must be byte-for-byte equivalent in content to
  // the registry bundled into the shipped preload.
  if (report.shippedMethodTable?.length > 0) {
    const [primary, ...rest] = report.shippedMethodTable;
    for (const copy of rest) {
      assert.deepEqual(
        copy.entries,
        primary.entries,
        `Shipped MAIN_METHOD_TABLE copies disagree: ${primary.file} vs ${copy.file}`,
      );
    }
    assert.deepEqual(
      frontendTable,
      primary.entries,
      "frontend MAIN_METHOD_TABLE drifted from the shipped 0.18.0 registry",
    );
  }

  // Every recovered method must be part of the reviewed method table.
  for (const method of Object.keys(report.methods)) {
    assert.ok(
      method in frontendTable,
      `Recovered RPC "${method}" is absent from MAIN_METHOD_TABLE; promote or reject it explicitly.`,
    );
  }

  // Argument-kind claims in the reviewed table must not contradict evidence.
  for (const [method, records] of Object.entries(report.methods)) {
    const claimedKind = frontendTable[method];
    const evidenceKinds = new Set(records.map((record) => record.argumentKind));
    if (claimedKind === "none") {
      assert.ok(
        !evidenceKinds.has("object") && !evidenceKinds.has("nonliteral"),
        `${method} is declared argless but shipped callsites pass payloads.`,
      );
      continue;
    }
    assert.equal(
      claimedKind,
      "object",
      `${method} must declare "object" when shipped callsites pass payload objects.`,
    );

    // Promoted interfaces may only use top-level keys proven by high-confidence
    // evidence.
    const provenKeys = new Set();
    for (const record of records) {
      if (record.confidence === "high" && Array.isArray(record.keys)) {
        for (const key of record.keys) provenKeys.add(key);
      }
    }
    if (!(method in knownArguments)) continue;
    const declaredKeys = knownArguments[method]
      .split(",")
      .map((part) => part.trim().split(/[:?]/)[0])
      .filter((key) => key.length > 0);
    for (const key of declaredKeys) {
      assert.ok(
        provenKeys.has(key),
        `Promoted key "${key}" of ${method} has no high-confidence shipped evidence.`,
      );
    }
  }
});
