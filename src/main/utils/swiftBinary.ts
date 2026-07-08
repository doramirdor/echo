import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const ECHO_BIN_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'echo', 'bin');

/**
 * Re-sign a freshly compiled helper with an explicit, stable ad-hoc identity.
 *
 * `swiftc` emits a *linker-signed* ad-hoc signature; macOS treats those as
 * second-class for TCC, so the `fn-monitor` Input Monitoring grant (keyed by
 * cdhash) keeps drifting back to "denied" and the fn hotkey silently stops
 * receiving events. Re-signing with `codesign --sign -` and a deterministic
 * identifier produces a normal ad-hoc signature whose cdhash is stable across
 * identical rebuilds, so the grant persists once the user approves it.
 *
 * Best-effort: a codesign failure is logged but never blocks using the binary.
 */
function codesignStable(binaryPath: string, binaryName: string): void {
  try {
    execFileSync('codesign', ['--force', '--sign', '-', '--identifier', `com.echo.${binaryName}`, binaryPath], {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: 'pipe',
    });
    console.log(`[swift-binary] ${binaryName} re-signed as com.echo.${binaryName}`);
  } catch (err) {
    console.warn(`[swift-binary] codesign of ${binaryName} failed:`, (err as Error).message);
  }
}

function needsRecompile(binaryPath: string, sourcePath: string): boolean {
  try {
    const binStat = fs.statSync(binaryPath);
    const srcStat = fs.statSync(sourcePath);
    return srcStat.mtimeMs > binStat.mtimeMs;
  } catch {
    return true;
  }
}

export function ensureSwiftBinary(binaryName: string, sourceRelativePath: string): boolean {
  const binaryPath = path.join(ECHO_BIN_DIR, binaryName);
  const sourcePath = path.join(__dirname, '..', '..', '..', sourceRelativePath);

  if (fs.existsSync(binaryPath) && !needsRecompile(binaryPath, sourcePath)) {
    return true;
  }

  if (!fs.existsSync(sourcePath)) {
    if (fs.existsSync(binaryPath)) return true;
    console.warn(`[swift-binary] Source not found at ${sourcePath}`);
    return false;
  }

  try {
    fs.mkdirSync(ECHO_BIN_DIR, { recursive: true });
    const action = fs.existsSync(binaryPath) ? 'Recompiling' : 'Compiling';
    console.log(`[swift-binary] ${action} ${binaryName}...`);
    execFileSync('swiftc', ['-O', '-o', binaryPath, sourcePath], {
      encoding: 'utf-8',
      timeout: 60000,
      stdio: 'pipe',
    });
    console.log(`[swift-binary] ${binaryName} compiled successfully`);
    codesignStable(binaryPath, binaryName);
    return true;
  } catch (err) {
    console.error(`[swift-binary] Failed to compile ${binaryName}:`, (err as Error).message);
    return fs.existsSync(binaryPath);
  }
}

// In-flight async compiles, deduped by binary name so a startup pre-compile
// and a stale-triggered recompile can never run two swiftc processes writing
// the same output path.
const inFlightCompiles = new Map<string, Promise<boolean>>();

/**
 * Async variant of ensureSwiftBinary for startup pre-compilation — compiling
 * five helpers with execFileSync freezes the main process for seconds.
 */
export function ensureSwiftBinaryAsync(binaryName: string, sourceRelativePath: string): Promise<boolean> {
  const existing = inFlightCompiles.get(binaryName);
  if (existing) return existing;

  const binaryPath = path.join(ECHO_BIN_DIR, binaryName);
  const sourcePath = path.join(__dirname, '..', '..', '..', sourceRelativePath);

  if (fs.existsSync(binaryPath) && !needsRecompile(binaryPath, sourcePath)) {
    return Promise.resolve(true);
  }
  if (!fs.existsSync(sourcePath)) {
    if (fs.existsSync(binaryPath)) return Promise.resolve(true);
    console.warn(`[swift-binary] Source not found at ${sourcePath}`);
    return Promise.resolve(false);
  }

  const compile = (async () => {
    try {
      fs.mkdirSync(ECHO_BIN_DIR, { recursive: true });
      const action = fs.existsSync(binaryPath) ? 'Recompiling' : 'Compiling';
      console.log(`[swift-binary] ${action} ${binaryName}...`);
      await new Promise<void>((resolve, reject) => {
        execFile('swiftc', ['-O', '-o', binaryPath, sourcePath], { timeout: 60000 }, (err) =>
          err ? reject(err) : resolve(),
        );
      });
      console.log(`[swift-binary] ${binaryName} compiled successfully`);
      codesignStable(binaryPath, binaryName);
      return true;
    } catch (err) {
      console.error(`[swift-binary] Failed to compile ${binaryName}:`, (err as Error).message);
      return fs.existsSync(binaryPath);
    } finally {
      inFlightCompiles.delete(binaryName);
    }
  })();

  inFlightCompiles.set(binaryName, compile);
  return compile;
}

export function getBinaryPath(binaryName: string): string {
  return path.join(ECHO_BIN_DIR, binaryName);
}
