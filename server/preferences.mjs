import fs from 'node:fs/promises';
import path from 'node:path';

export const VALID_LANGUAGES = new Set(['auto', 'ja', 'en']);

export function normalizeLanguagePreference(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (VALID_LANGUAGES.has(trimmed)) {
      return trimmed;
    }
  }
  return 'auto';
}

export class PreferencesStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'preferences.json');
    this.cached = null;
    this.writeChain = Promise.resolve();
  }

  async load() {
    if (this.cached) {
      return this.cached;
    }
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.cached = {
        language: normalizeLanguagePreference(parsed?.language),
      };
    } catch {
      this.cached = { language: 'auto' };
    }
    return this.cached;
  }

  async save(partial) {
    const op = this.writeChain.then(async () => {
      const current = await this.load();
      const next = {
        ...current,
        language:
          partial && 'language' in partial
            ? normalizeLanguagePreference(partial.language)
            : current.language,
      };
      this.cached = next;
      await fs.mkdir(this.dataDir, { recursive: true });
      const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
      await fs.writeFile(tmpPath, JSON.stringify(next, null, 2), 'utf8');
      await fs.rename(tmpPath, this.filePath);
      return next;
    });
    this.writeChain = op.catch(() => {});
    return op;
  }
}
