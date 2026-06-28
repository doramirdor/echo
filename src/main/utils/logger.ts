import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const LOG_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'echo', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'echo.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function ensureLogDir(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // best effort
  }
}

function rotateIfNeeded(): void {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_SIZE) {
      const rotated = LOG_FILE + '.1';
      if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
      fs.renameSync(LOG_FILE, rotated);
    }
  } catch {
    // best effort
  }
}

function write(level: LogLevel, tag: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${tag}] ${message}\n`;
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn(`[${tag}] ${message}`);

  try {
    ensureLogDir();
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // logging must not crash the app
  }
}

export const logger = {
  debug: (tag: string, message: string) => write('debug', tag, message),
  info: (tag: string, message: string) => write('info', tag, message),
  warn: (tag: string, message: string) => write('warn', tag, message),
  error: (tag: string, message: string) => write('error', tag, message),
  getLogPath: () => LOG_FILE,
  readRecentLogs: (maxBytes = 50000): string => {
    try {
      if (!fs.existsSync(LOG_FILE)) return '';
      const stat = fs.statSync(LOG_FILE);
      const start = Math.max(0, stat.size - maxBytes);
      const fd = fs.openSync(LOG_FILE, 'r');
      const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      return buf.toString('utf-8');
    } catch {
      return '';
    }
  },
};
