import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { extractProjectJargon } from './projectJargon';

const EXTRA_PATH = [
  os.homedir() + '/.local/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
].join(':');

const CONTEXT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'echo');
const CONTEXT_FILE = path.join(CONTEXT_DIR, 'project-context.md');
const JARGON_FILE = path.join(CONTEXT_DIR, 'project-jargon.json');

export class CodebaseAnalyzer {
  /**
   * Use `claude` CLI to scan a project directory and generate a context document.
   * This is like asking Claude to generate a CLAUDE.md — a rich understanding of
   * the project's naming, architecture, terminology, and conventions.
   */
  async analyze(projectPath: string, projectName: string, onChunk?: (text: string) => void): Promise<string> {
    const prompt = `You are scanning the codebase at "${projectPath}" for a project called "${projectName}".

Your goal is to generate a voice-to-text context document. This document will be used as context when refining speech-to-text transcriptions from a developer working on this codebase.

Scan the project and produce a document with these sections:

## Project Overview
Brief description of what this project is and does.

## Key Terminology
List every important term, name, and identifier that someone would say out loud when discussing this code. For each term include:
- The exact spelling/casing (e.g., "EchoState", "runPipeline", "GroqTranscriber")
- What it is (class, function, type, config, etc.)
- How it might be misheard by speech-to-text (e.g., "echo state" instead of "EchoState")

## Naming Conventions
Describe the naming patterns used (camelCase, PascalCase, etc.) and any project-specific conventions.

## Architecture
Brief overview of how the code is organized — folders, modules, key files.

## Domain Language
Any domain-specific words, acronyms, product names, or jargon that a speech-to-text system would likely get wrong.

Be thorough. Include class names, function names, type names, config keys, CLI flags, file names, and any proper nouns. The more terms you capture, the better the voice-to-text will be.

Output the document in markdown format.`;

    // Expand ~ to home directory (Node doesn't do this automatically)
    if (projectPath.startsWith('~')) {
      projectPath = projectPath.replace(/^~/, os.homedir());
    }
    console.log(`[analyzer] Scanning ${projectPath} with claude...`);

    return new Promise((resolve, reject) => {
      const env = { ...process.env, PATH: (process.env.PATH || '') + ':' + EXTRA_PATH };

      const proc = spawn('claude -p --model sonnet', [], {
        cwd: projectPath,
        env,
        shell: true,
        timeout: 180000,
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => {
        const chunk = d.toString();
        stdout += chunk;
        if (onChunk) onChunk(stdout);
      });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('error', (err) => {
        console.error('[analyzer] spawn error:', err);
        reject(new Error(`Analysis failed: ${err.message}`));
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          console.error('[analyzer] claude error:', stderr);
          reject(new Error(`Analysis failed (exit ${code}): ${stderr.slice(0, 200)}`));
          return;
        }

        const context = stdout.trim();
        console.log(`[analyzer] Generated context: ${context.length} chars`);

        try {
          fs.mkdirSync(CONTEXT_DIR, { recursive: true });
          fs.writeFileSync(CONTEXT_FILE, context);
          console.log(`[analyzer] Saved context to ${CONTEXT_FILE}`);
        } catch (err) {
          console.error('[analyzer] Failed to save context:', err);
        }

        // Also refresh the deterministic (LLM-free) jargon cache from the same
        // path, so STT biasing has exact identifiers even before the LLM doc.
        try {
          CodebaseAnalyzer.quickScan(projectPath);
        } catch (err) {
          console.error('[analyzer] Quick jargon scan failed:', err);
        }

        resolve(context);
      });

      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  }

  /**
   * Load the saved project context.
   */
  static loadContext(): string | null {
    try {
      if (fs.existsSync(CONTEXT_FILE)) {
        return fs.readFileSync(CONTEXT_FILE, 'utf-8');
      }
    } catch (err) {
      console.error('[analyzer] Failed to load context:', err);
    }
    return null;
  }

  /**
   * Check if a project context exists.
   */
  static hasContext(): boolean {
    return fs.existsSync(CONTEXT_FILE);
  }

  static getContextPath(): string {
    return CONTEXT_FILE;
  }

  /**
   * Deterministic, LLM-free jargon scan: extract dependency and symbol names
   * from a project and cache them for STT biasing. Fast enough to run on demand
   * and works with no LLM configured.
   */
  static quickScan(projectPath: string): string[] {
    let resolved = projectPath;
    if (resolved.startsWith('~')) resolved = resolved.replace(/^~/, os.homedir());
    const terms = extractProjectJargon(resolved);
    try {
      fs.mkdirSync(CONTEXT_DIR, { recursive: true });
      fs.writeFileSync(JARGON_FILE, JSON.stringify(terms));
      console.log(`[analyzer] Cached ${terms.length} jargon terms to ${JARGON_FILE}`);
    } catch (err) {
      console.error('[analyzer] Failed to save jargon:', err);
    }
    return terms;
  }

  /** Load the cached deterministic jargon terms (empty if none). */
  static loadJargonTerms(): string[] {
    try {
      if (fs.existsSync(JARGON_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(JARGON_FILE, 'utf-8'));
        if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === 'string');
      }
    } catch (err) {
      console.error('[analyzer] Failed to load jargon:', err);
    }
    return [];
  }
}
