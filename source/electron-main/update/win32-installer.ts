import { execFile, spawn } from "node:child_process";
import { isAbsolute, win32 } from "node:path";
import { promisify } from "node:util";

export const WINDOWS_INSTALLER_SIGNER_ALLOWLIST = ["Anysphere, Inc.", "Anysphere"] as const;
export const POWERSHELL_TIMEOUT_MS = 30_000;
export class SandInstallerSignatureError extends Error {}
const execFileAsync = promisify(execFile);
async function runPowershellDefault(args: readonly string[]): Promise<{ stdout: string }> { return await execFileAsync("powershell.exe", [...args], { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true }); }
function spawnDetachedDefault(command: string, args: readonly string[], onError?: (error: Error) => void): void { const child = spawn(command, [...args], { detached: true, stdio: "ignore", shell: false, windowsHide: true }); child.on("error", (error) => onError?.(error)); child.unref(); }
type WindowsInstallerOptions = { readonly quit: () => void; readonly log?: (message: string) => void; readonly signerAllowlist?: readonly string[]; readonly runPowershell?: (args: readonly string[]) => Promise<{ stdout: string }>; readonly spawnDetached?: (command: string, args: readonly string[], onError?: (error: Error) => void) => void };

export class SandWindowsInstaller {
  private readonly verifiedInstallerPaths = new Set<string>();
  private readonly options: WindowsInstallerOptions;
  constructor(options: WindowsInstallerOptions) { this.options = options; }
  async verifySignature(installerPath: string): Promise<void> {
    this.verifiedInstallerPaths.delete(installerPath);
    if (!installerPath.toLowerCase().endsWith(".exe") ||
        (!isAbsolute(installerPath) && !win32.isAbsolute(installerPath)) ||
        installerPath.startsWith("\\") || installerPath.startsWith("//")) {
      throw new SandInstallerSignatureError("expected an absolute local Windows installer path");
    }
    const escapedPath = installerPath.replace(/'/g, "''");
    const script = ["$ErrorActionPreference = 'Stop'", `$sig = Get-AuthenticodeSignature -LiteralPath '${escapedPath}'`, "$cn = if ($sig.SignerCertificate) { $sig.SignerCertificate.GetNameInfo('SimpleName', $false) } else { '' }", "[pscustomobject]@{ status = $sig.Status.ToString(); signerCommonName = $cn } | ConvertTo-Json -Compress"].join("; ");
    const { stdout } = await (this.options.runPowershell ?? runPowershellDefault)(["-NoProfile", "-NonInteractive", "-Command", script]);
    let probe: unknown; try { probe = JSON.parse(stdout.trim()); } catch { throw new SandInstallerSignatureError("unreadable signature probe output"); }
    if (typeof probe !== "object" || probe === null || typeof (probe as any).status !== "string" || typeof (probe as any).signerCommonName !== "string") throw new SandInstallerSignatureError("unreadable signature probe output");
    if ((probe as any).status !== "Valid") throw new SandInstallerSignatureError(`signature status ${(probe as any).status}`);
    if (!(this.options.signerAllowlist ?? WINDOWS_INSTALLER_SIGNER_ALLOWLIST).includes((probe as any).signerCommonName)) throw new SandInstallerSignatureError(`unexpected signer "${(probe as any).signerCommonName}"`);
    this.verifiedInstallerPaths.add(installerPath);
  }
  installOnQuit(installerPath: string, options: { readonly forceRun: boolean; readonly onSpawnError?: (error: unknown) => void }): void {
    if (!this.verifiedInstallerPaths.delete(installerPath)) {
      options.onSpawnError?.(new SandInstallerSignatureError("installer was not signature verified"));
      return;
    }
    this.runInstaller(installerPath, options.forceRun ? ["--updated", "/S", "--force-run"] : ["--updated", "/S"], options.onSpawnError);
  }
  quit(): void { this.options.quit(); }
  private runInstaller(installerPath: string, args: readonly string[], onSpawnError?: (error: unknown) => void): void { this.options.log?.(`Running installer: ${installerPath} ${args.join(" ")}`); try { (this.options.spawnDetached ?? spawnDetachedDefault)(installerPath, args, onSpawnError); } catch (error) { this.options.log?.(`Installer spawn failed: ${error instanceof Error ? error.message : String(error)}`); onSpawnError?.(error); } }
}
