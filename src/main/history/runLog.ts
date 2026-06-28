import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export interface RunLogEntry {
  id: string;
  timestamp: string;
  rawTranscription: string;
  refinedText: string;
  context: string;
  sourceApp?: string;
  sttEngine: string;
  llmProvider: string;
  durationMs: number;
  error?: string;
}

const MAX_ENTRIES = 100;

export class RunLog {
  private entries: RunLogEntry[] = [];
  private filePath: string;
  private dirty = false;

  constructor() {
    const userDataPath = app.getPath('userData');
    this.filePath = path.join(userDataPath, 'run-log.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        this.entries = Array.isArray(data) ? data : [];
      }
    } catch (err) {
      console.warn('[run-log] Failed to load:', (err as Error).message);
      this.entries = [];
    }
  }

  private save(): void {
    if (!this.dirty) return;
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
      this.dirty = false;
    } catch (err) {
      console.warn('[run-log] Failed to save:', (err as Error).message);
    }
  }

  add(entry: Omit<RunLogEntry, 'id' | 'timestamp'>): RunLogEntry {
    const logEntry: RunLogEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      ...entry,
    };

    this.entries.unshift(logEntry);

    // Cap at MAX_ENTRIES
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(0, MAX_ENTRIES);
    }

    this.dirty = true;
    this.save();
    return logEntry;
  }

  getAll(): RunLogEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
    this.dirty = true;
    this.save();
  }

  search(query: string): RunLogEntry[] {
    const lower = query.toLowerCase();
    return this.entries.filter(e =>
      e.rawTranscription.toLowerCase().includes(lower) ||
      e.refinedText.toLowerCase().includes(lower),
    );
  }

  flush(): void {
    this.save();
  }
}
