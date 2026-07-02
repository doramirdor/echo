import * as fs from 'fs';
import * as path from 'path';

/**
 * Deterministic, LLM-free project-jargon extraction.
 *
 * The richer {@link CodebaseAnalyzer} scan asks an LLM to write a terminology
 * document, which is great but requires the `claude` CLI, a network round-trip,
 * and an explicit user action. This module instead mines identifiers directly
 * from a repo — dependency names from manifests, exported symbol names, and
 * source file names — so jargon biasing works with **zero setup** and even when
 * `llmProvider` is `none`. The result feeds {@link buildSpeechBiasPrompt}.
 */

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'target', 'dist', 'build', '.next', 'out', 'vendor',
  '.venv', 'venv', '__pycache__', 'coverage', '.turbo', 'Pods', 'DerivedData',
  '.cache', '.idea', '.vscode',
]);

const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.rs', '.py', '.go', '.java',
  '.kt', '.swift', '.rb', '.php', '.cs', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.scala', '.ex', '.exs', '.dart',
]);

// Declarations whose name is a term a developer would say out loud. Language
// agnostic on purpose — one sweep covers JS/TS, Rust, Python, Go, Swift, etc.
const SYMBOL_PATTERNS: RegExp[] = [
  /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]+)/g,
  /\bexport\s+(?:const|let|var|class|type|interface|enum|abstract\s+class)\s+([A-Za-z_$][\w$]+)/g,
  /\b(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]+)/g,
  /\bdef\s+([A-Za-z_][\w]+)/g,                              // python
  /\bfunc\s+([A-Za-z_][\w]+)/g,                             // go / swift
  /\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]+)/g,       // rust
  /\b(?:pub\s+)?(?:struct|enum|trait|mod)\s+([A-Za-z_][\w]+)/g, // rust
];

export interface JargonOptions {
  /** Stop after scanning this many source files. */
  maxFiles?: number;
  /** Return at most this many terms (dependency + symbol + filename, in priority order). */
  maxTerms?: number;
  /** Read at most this many bytes per source file. */
  maxBytesPerFile?: number;
}

/** True for tokens worth biasing on: multi-char and identifier-shaped. */
function isUsefulTerm(tok: string): boolean {
  return tok.length >= 3 && tok.length <= 40 && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(tok);
}

/** True for a filename base that reads like a symbol (not "index"/"main"/"utils"). */
function looksTechnical(tok: string): boolean {
  return /[a-z][A-Z]/.test(tok) || tok.includes('_') || tok.includes('-') || /^[A-Z]{2,}/.test(tok);
}

function readManifestDeps(projectPath: string): string[] {
  const out: string[] = [];
  const tryRead = (file: string): string | null => {
    try { return fs.readFileSync(path.join(projectPath, file), 'utf-8'); } catch { return null; }
  };

  // package.json — name + all dependency keys.
  const pkg = tryRead('package.json');
  if (pkg) {
    try {
      const json = JSON.parse(pkg);
      if (typeof json.name === 'string') out.push(json.name.replace(/^@[^/]+\//, ''));
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        if (json[field] && typeof json[field] === 'object') {
          for (const dep of Object.keys(json[field])) out.push(dep.replace(/^@[^/]+\//, ''));
        }
      }
    } catch { /* malformed package.json — skip */ }
  }

  // Cargo.toml — package name + dependency keys (simple section parse).
  const cargo = tryRead('Cargo.toml');
  if (cargo) {
    let section = '';
    for (const raw of cargo.split('\n')) {
      const line = raw.trim();
      const sec = line.match(/^\[([^\]]+)\]/);
      if (sec) { section = sec[1]; continue; }
      const nameMatch = line.match(/^name\s*=\s*"([^"]+)"/);
      if (section === 'package' && nameMatch) { out.push(nameMatch[1]); continue; }
      if (/dependencies$/.test(section)) {
        const dep = line.match(/^([A-Za-z0-9_-]+)\s*=/);
        if (dep) out.push(dep[1]);
      }
    }
  }

  // requirements.txt — python package names before any version specifier.
  const reqs = tryRead('requirements.txt');
  if (reqs) {
    for (const raw of reqs.split('\n')) {
      const m = raw.trim().match(/^([A-Za-z0-9_.-]+)/);
      if (m && !raw.trim().startsWith('#')) out.push(m[1]);
    }
  }

  // go.mod — module name + required module last path segments.
  const gomod = tryRead('go.mod');
  if (gomod) {
    for (const raw of gomod.split('\n')) {
      const m = raw.trim().match(/(?:module|require)?\s*[\w./-]*?([A-Za-z0-9_-]+)(?:\s+v[\d.]+)?\s*$/);
      if (m && m[1].length >= 3) out.push(m[1]);
    }
  }

  return out;
}

function collectSymbolsAndNames(projectPath: string, maxFiles: number, maxBytesPerFile: number): string[] {
  const out: string[] = [];
  const stack: string[] = [projectPath];
  let scanned = 0;

  while (stack.length && scanned < maxFiles) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      if (scanned >= maxFiles) break;
      const name = entry.name;
      if (name.startsWith('.') && name !== '.') continue;
      const full = path.join(dir, name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(name)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(name);
      if (!SOURCE_EXT.has(ext)) continue;
      scanned++;

      const base = path.basename(name, ext);
      if (looksTechnical(base)) out.push(base);

      let content: string;
      try {
        const fd = fs.openSync(full, 'r');
        const buf = Buffer.alloc(maxBytesPerFile);
        const bytes = fs.readSync(fd, buf, 0, maxBytesPerFile, 0);
        fs.closeSync(fd);
        content = buf.toString('utf-8', 0, bytes);
      } catch { continue; }

      for (const pattern of SYMBOL_PATTERNS) {
        pattern.lastIndex = 0;
        for (const m of content.matchAll(pattern)) {
          if (m[1]) out.push(m[1]);
        }
      }
    }
  }

  return out;
}

/**
 * Extract jargon terms from a project directory without any LLM call.
 * Priority order: manifest dependency names → exported symbols/filenames.
 */
export function extractProjectJargon(projectPath: string, opts: JargonOptions = {}): string[] {
  const maxFiles = opts.maxFiles ?? 300;
  const maxTerms = opts.maxTerms ?? 400;
  const maxBytesPerFile = opts.maxBytesPerFile ?? 200_000;

  let resolved = projectPath;
  if (resolved.startsWith('~')) resolved = resolved.replace(/^~/, process.env.HOME || '');

  const ordered = [
    ...readManifestDeps(resolved),
    ...collectSymbolsAndNames(resolved, maxFiles, maxBytesPerFile),
  ];

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of ordered) {
    const tok = raw.trim();
    if (!isUsefulTerm(tok)) continue;
    const key = tok.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(tok);
    if (terms.length >= maxTerms) break;
  }
  return terms;
}
