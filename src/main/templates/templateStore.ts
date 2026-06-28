import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface DictationTemplate {
  id: string;
  name: string;
  trigger: string;
  content: string;
}

const TEMPLATES_FILE = path.join(
  os.homedir(), 'Library', 'Application Support', 'echo', 'templates.json',
);

export class TemplateStore {
  private templates: DictationTemplate[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(TEMPLATES_FILE)) {
        this.templates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf-8'));
      }
    } catch {
      this.templates = [];
    }
  }

  private save(): void {
    const dir = path.dirname(TEMPLATES_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(this.templates, null, 2));
  }

  getAll(): DictationTemplate[] {
    return [...this.templates];
  }

  add(template: Omit<DictationTemplate, 'id'>): DictationTemplate {
    const entry: DictationTemplate = {
      ...template,
      id: Date.now().toString(36),
    };
    this.templates.push(entry);
    this.save();
    return entry;
  }

  remove(id: string): boolean {
    const before = this.templates.length;
    this.templates = this.templates.filter(t => t.id !== id);
    if (this.templates.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Match spoken text against template triggers.
   * e.g. "type my email signature" -> template content
   */
  match(spokenText: string): DictationTemplate | null {
    const lower = spokenText.toLowerCase().trim();
    for (const template of this.templates) {
      if (lower.includes(template.trigger.toLowerCase())) {
        return template;
      }
    }
    return null;
  }
}
