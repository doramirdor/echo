import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { MemoryEntry } from './memoryEntry';

const MEMORY_FILE = path.join(
  os.homedir(), 'Library', 'Application Support', 'echo', 'memory.json'
);

export class MemoryStore {
  private entries: MemoryEntry[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        const data = fs.readFileSync(MEMORY_FILE, 'utf-8');
        this.entries = JSON.parse(data);
        console.log(`[memory] Loaded ${this.entries.length} entries`);
      }
    } catch (err) {
      console.error('[memory] Failed to load:', err);
      this.entries = [];
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 1000);
  }

  private save(): void {
    try {
      const dir = path.dirname(MEMORY_FILE);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.entries, null, 2));
      console.log(`[memory] Saved ${this.entries.length} entries`);
    } catch (err) {
      console.error('[memory] Failed to save:', err);
    }
  }

  getAll(): MemoryEntry[] {
    return [...this.entries];
  }

  add(entry: Omit<MemoryEntry, 'id' | 'useCount' | 'createdAt' | 'updatedAt'>): MemoryEntry {
    const now = new Date().toISOString();
    const newEntry: MemoryEntry = {
      ...entry,
      id: crypto.randomUUID(),
      useCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(newEntry);
    this.scheduleSave();
    return newEntry;
  }

  update(id: string, updates: Partial<Omit<MemoryEntry, 'id' | 'createdAt'>>): MemoryEntry | null {
    const idx = this.entries.findIndex(e => e.id === id);
    if (idx === -1) return null;

    this.entries[idx] = {
      ...this.entries[idx],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.scheduleSave();
    return this.entries[idx];
  }

  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.id !== id);
    if (this.entries.length < before) {
      this.scheduleSave();
      return true;
    }
    return false;
  }

  /**
   * Find memory entries relevant to a given transcription text.
   * Matches against misrecognitions (case-insensitive).
   */
  findRelevant(text: string): MemoryEntry[] {
    const lower = text.toLowerCase();
    return this.entries.filter(entry => {
      // Check if any misrecognition appears in the text
      for (const mis of entry.misrecognitions) {
        if (lower.includes(mis.toLowerCase())) return true;
      }
      // Also check if the term itself appears (already correct, but include for context)
      if (lower.includes(entry.term.toLowerCase())) return true;
      return false;
    });
  }

  /**
   * Format entries for inclusion in the LLM prompt.
   */
  formatForPrompt(entries?: MemoryEntry[]): string {
    const list = entries ?? this.entries;
    if (list.length === 0) return '';

    return list
      .map(e => {
        const misStr = e.misrecognitions.length > 0
          ? ` (NOT "${e.misrecognitions.join('", "')}")`
          : '';
        return `- "${e.term}" - ${e.context}${misStr}`;
      })
      .join('\n');
  }

  /**
   * Increment use count for entries that were used in refinement.
   */
  markUsed(ids: string[]): void {
    for (const id of ids) {
      const entry = this.entries.find(e => e.id === id);
      if (entry) {
        entry.useCount++;
        entry.updatedAt = new Date().toISOString();
      }
    }
    if (ids.length > 0) this.scheduleSave();
  }

  /**
   * Flush any pending save immediately. Used during app shutdown.
   */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
  }
}
