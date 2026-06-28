import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const ECHO_BIN_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'echo', 'bin');

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
    return true;
  } catch (err) {
    console.error(`[swift-binary] Failed to compile ${binaryName}:`, (err as Error).message);
    return fs.existsSync(binaryPath);
  }
}

export function getBinaryPath(binaryName: string): string {
  return path.join(ECHO_BIN_DIR, binaryName);
}
