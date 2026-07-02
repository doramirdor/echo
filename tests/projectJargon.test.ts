import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractProjectJargon } from '../src/main/codebase/projectJargon';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-jargon-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: '@acme/rocket-widget',
    dependencies: { 'react': '^18', '@tanstack/query-core': '^5' },
    devDependencies: { vitest: '^3' },
  }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'speechBias.ts'),
    'export function buildSpeechBiasPrompt() {}\nexport const MAX_TOKENS = 224;\nclass GroqTranscriber {}\n');
  fs.writeFileSync(path.join(dir, 'src', 'analyzer.py'),
    'def analyze_codebase():\n    pass\n');
  // A directory that must be skipped entirely.
  fs.mkdirSync(path.join(dir, 'node_modules', 'leftpad'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'leftpad', 'index.js'),
    'export function shouldNotAppear() {}\n');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('extractProjectJargon', () => {
  it('extracts dependency names from package.json (scope stripped)', () => {
    const terms = extractProjectJargon(dir);
    expect(terms).toContain('react');
    expect(terms).toContain('vitest');
    expect(terms).toContain('query-core');       // @tanstack/query-core -> query-core
    expect(terms).toContain('rocket-widget');    // @acme/rocket-widget -> rocket-widget
  });

  it('extracts exported symbols and technical file names', () => {
    const terms = extractProjectJargon(dir);
    expect(terms).toContain('buildSpeechBiasPrompt');
    expect(terms).toContain('MAX_TOKENS');
    expect(terms).toContain('GroqTranscriber');
    expect(terms).toContain('speechBias');       // filename base (camelCase)
    expect(terms).toContain('analyze_codebase'); // python def
  });

  it('skips node_modules and other ignored directories', () => {
    const terms = extractProjectJargon(dir);
    expect(terms).not.toContain('shouldNotAppear');
  });

  it('deduplicates case-insensitively and respects the term cap', () => {
    const terms = extractProjectJargon(dir, { maxTerms: 3 });
    expect(terms.length).toBe(3);
    expect(new Set(terms.map(t => t.toLowerCase())).size).toBe(terms.length);
  });

  it('returns an empty list for a nonexistent path', () => {
    expect(extractProjectJargon(path.join(dir, 'does-not-exist'))).toEqual([]);
  });
});
