import assert from "node:assert/strict";
import test from "node:test";
import { SandInstallerSignatureError, SandWindowsInstaller } from "../source/electron-main/update/win32-installer.ts";

test("relative update paths are rejected before signature verification", async () => {
  const installer = new SandWindowsInstaller({ quit() {} });
  await assert.rejects(
    installer.verifySignature("relative-update.exe"),
    SandInstallerSignatureError,
  );
});
