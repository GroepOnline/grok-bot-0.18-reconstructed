import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

import { resolve as resolveTypeScriptSpecifier } from "./support/typescript-resolve-hook.mjs";

registerHooks({ resolve: resolveTypeScriptSpecifier });

const { UpdateResponseFormatError, parseUpdateResponse } = await import("../source/electron-main/update/update-feed.ts");
const { parseVersion } = await import("../source/electron-main/update/update-version.ts");

const SHA = "ab".repeat(32);
const FEED_URL = "https://downloads.example.com/sand-update.exe";

test("Windows update versions reject path separators and empty prerelease identifiers", () => {
  assert.deepEqual(parseVersion("1.2.3"), { release: [1, 2, 3], prerelease: [] });
  assert.deepEqual(parseVersion("1.2.3-nightly.1"), { release: [1, 2, 3], prerelease: ["nightly", "1"] });
  for (const version of ["", "1.2", "1.2.3-", "1.2.3-foo/bar", "1.2.3-foo\\bar", "1.2.3-..", "1.2.3-foo..bar", "../1.2.3", "1.2.3-foo_bar"]) {
    assert.equal(parseVersion(version), null, version);
  }
});

test("Windows iupdate feeds require SemVer and a full SHA-256", () => {
  assert.deepEqual(parseUpdateResponse({ version: "1.2.3-nightly.1", url: FEED_URL, sha256hash: SHA.toUpperCase() }, "iupdate"), {
    version: "1.2.3-nightly.1",
    url: FEED_URL,
    sha256: SHA,
  });

  const rejected = [
    [{ version: "1.2.3-foo/../bar", url: FEED_URL, sha256hash: SHA }, "version must be a valid SemVer version"],
    [{ version: "1.2.3", url: FEED_URL }, "sha256hash must be a 64-character SHA-256 hex digest"],
    [{ version: "1.2.3", url: FEED_URL, sha256hash: "abc" }, "sha256hash must be a 64-character SHA-256 hex digest"],
    [{ version: "1.2.3", url: FEED_URL, sha256hash: `${SHA.slice(0, 62)}gg` }, "sha256hash must be a 64-character SHA-256 hex digest"],
    [{ version: "1.2.3", url: "not a url", sha256hash: SHA }, "url must be a valid URL"],
    [null, "expected an object"],
  ];
  for (const [payload, message] of rejected) {
    assert.throws(() => parseUpdateResponse(payload, "iupdate"), (error) => {
      assert.ok(error instanceof UpdateResponseFormatError);
      assert.match(error.message, new RegExp(message));
      return true;
    });
  }
});

test("squirrel update feeds still key off the release name", () => {
  assert.deepEqual(parseUpdateResponse({ name: "1.2.3", url: FEED_URL }), {
    version: "1.2.3",
    url: FEED_URL,
    name: "Grok Bot 1.2.3",
  });
});
