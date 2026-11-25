import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const AGY_TIMEOUT_MS = 20_000;
const MANUAL_COOLDOWN_MS = 10_000;
const AUTO_STALE_MS = 120_000;

function resolveAgyCandidates() {
  const candidates = [];
  if (process.env.ANTIGRAVITY_CLI_PATH) {
    candidates.push(process.env.ANTIGRAVITY_CLI_PATH);
  }
  candidates.push(
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
    'agy',
  );
  return [...new Set(candidates)];
}

async function resolveAgyBinary() {
  for (const candidate of resolveAgyCandidates()) {
    if (candidate === 'agy') {
      return candidate;
    }
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  return 'agy';
}

export function parseAgyUsageJson(rawStdout) {
  const trimmed = rawStdout.trim();
  const jsonStart = trimmed.indexOf('{');
  const jsonEnd = trimmed.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error('agy /usage output did not contain JSON');
  }
  const payload = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
  if (payload.status !== 'SUCCESS') {
    throw new Error(`agy /usage returned status=${payload.status ?? 'unknown'}`);
  }
  const data = payload.command?.data;
  if (!data || !Array.isArray(data.groups)) {
    throw new Error('agy /usage JSON missing command.data.groups');
  }

  const groups = data.groups.map((group) => ({
    name: String(group.name ?? ''),
    description: String(group.description ?? ''),
    buckets: Array.isArray(group.buckets)
      ? group.buckets.map((bucket) => {
          const rawFraction = Number(bucket.remaining_fraction);
          const remainingFraction = Number.isFinite(rawFraction)
            ? Math.max(0, Math.min(1, rawFraction))
            : null;
          return {
            id: String(bucket.id ?? ''),
            name: String(bucket.name ?? ''),
            window: String(bucket.window ?? ''),
            description: String(bucket.description ?? ''),
            remainingFraction,
            remainingPercent:
              remainingFraction === null ? null : Math.round(remainingFraction * 100),
            resetTime: typeof bucket.reset_time === 'string' ? bucket.reset_time : null,
          };
        })
      : [],
  }));

  return {
    description: String(data.description ?? ''),
    groups,
  };
}

export class QuotaStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.cachePath = path.join(dataDir, 'quota-cache.json');
    this.cached = null;
    this.loaded = false;
    this.inFlight = null;
    this.lastAttemptMs = 0;
  }

  async loadCache() {
    if (this.loaded) {
      return this.cached;
    }
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.cachePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.groups) && typeof parsed.fetchedAt === 'string') {
        this.cached = parsed;
      }
    } catch {
      this.cached = null;
    }
    return this.cached;
  }

  async saveCache(record) {
    this.cached = record;
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmpPath = `${this.cachePath}.tmp.${process.pid}`;
    await fs.writeFile(tmpPath, JSON.stringify(record, null, 2), 'utf8');
    await fs.rename(tmpPath, this.cachePath);
  }

  isStale(nowMs = Date.now()) {
    if (!this.cached?.fetchedAt) {
      return true;
    }
    const fetchedMs = Date.parse(this.cached.fetchedAt);
    if (!Number.isFinite(fetchedMs)) {
      return true;
    }
    return nowMs - fetchedMs >= AUTO_STALE_MS;
  }

  async refresh({ force = false } = {}) {
    await this.loadCache();
    const nowMs = Date.now();

    if (this.inFlight) {
      return this.inFlight;
    }

    if (!force && !this.isStale(nowMs) && this.cached) {
      return {
        ok: true,
        source: 'cache',
        quota: this.cached,
        error: null,
      };
    }

    if (force && nowMs - this.lastAttemptMs < MANUAL_COOLDOWN_MS && this.cached) {
      const waitSecs = Math.ceil((MANUAL_COOLDOWN_MS - (nowMs - this.lastAttemptMs)) / 1000);
      return {
        ok: true,
        source: 'cooldown',
        quota: this.cached,
        error: null,
        cooldownSeconds: waitSecs,
      };
    }

    this.lastAttemptMs = nowMs;
    this.inFlight = this.#runRefresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  async #runRefresh() {
    const agyBin = await resolveAgyBinary();
    try {
      const { stdout } = await execFileAsync(
        agyBin,
        ['--print', '/usage', '--output-format', 'json', '--print-timeout', '15s'],
        {
          timeout: AGY_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
          env: {
            ...process.env,
            NO_COLOR: '1',
          },
        },
      );
      const parsed = parseAgyUsageJson(stdout);
      const record = {
        fetchedAt: new Date().toISOString(),
        ...parsed,
      };
      await this.saveCache(record);
      return {
        ok: true,
        source: 'live',
        quota: record,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        source: this.cached ? 'stale-cache' : 'error',
        quota: this.cached,
        error: message,
      };
    }
  }
}
