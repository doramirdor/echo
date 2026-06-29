import { spawn } from 'child_process';
import * as os from 'os';
import { LLMRefiner, RefinementContext, buildSystemPrompt } from './refiner';
import { CodebaseAnalyzer } from '../codebase/analyzer';

const EXTRA_PATH = [
  os.homedir() + '/.local/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
].join(':');

export class CLIRefiner implements LLMRefiner {
  private command: string;
  private args: string[];

  constructor(command: 'claude' | 'codex' = 'claude') {
    this.command = command;
    this.args = command === 'claude' ? ['-p', '--model', 'haiku'] : ['-q'];
  }

  async refine(rawTranscription: string, context: RefinementContext): Promise<string> {
    // Project context is normally supplied by the pipeline; fall back to disk.
    const projectContext = context.projectContext ?? CodebaseAnalyzer.loadContext() ?? undefined;

    const systemPrompt = buildSystemPrompt(context.memoryFormatted, {
      appProfilePrompt: context.appProfilePrompt,
      contentType: context.contentType,
      customPrompt: context.customPrompt,
      windowContext: context.windowContext,
      vocabularyList: context.vocabularyList,
      existingFieldText: context.existingFieldText,
      existingFieldTextAfter: context.existingFieldTextAfter,
      projectContext,
      tone: context.tone,
    });

    const fullPrompt = `${systemPrompt}
Raw transcription:
${rawTranscription}`;

    console.log(`[${this.command}] Sending ${fullPrompt.length} chars (project context: ${projectContext ? 'yes' : 'no'})`);

    return new Promise((resolve, reject) => {
      const env = { ...process.env, PATH: (process.env.PATH || '') + ':' + EXTRA_PATH };

      const cmdLine = [this.command, ...this.args].join(' ');
      const proc = spawn(cmdLine, [], {
        env,
        shell: true,
        timeout: 120000,
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('error', (err) => {
        reject(new Error(`${this.command} failed: ${err.message}`));
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          console.error(`[${this.command}] stderr:`, stderr);
          reject(new Error(`${this.command} failed (exit ${code}): ${stderr.slice(0, 200)}`));
          return;
        }

        const text = stdout.trim();
        console.log(`[${this.command}] Refined: "${text}"`);
        resolve(text);
      });

      proc.stdin.write(fullPrompt);
      proc.stdin.end();
    });
  }
}
