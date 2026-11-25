import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WINDOW_MS = 60 * 60 * 1000;

function getTranscriptRoots() {
  const home = os.homedir();
  return [
    { source: 'app', root: path.join(home, '.gemini', 'antigravity', 'brain') },
    { source: 'cli', root: path.join(home, '.gemini', 'antigravity-cli', 'brain') },
  ];
}

function emptyTotals() {
  return {
    freshInputTokens: 0,
    cacheReadTokens: 0,
    totalInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    turns: 0,
  };
}

function addToTotals(totals, freshInput, cacheRead, output) {
  totals.freshInputTokens += freshInput;
  totals.cacheReadTokens += cacheRead;
  totals.totalInputTokens += freshInput + cacheRead;
  totals.outputTokens += output;
  totals.totalTokens += freshInput + cacheRead + output;
  totals.turns += 1;
}

function finalizeTotals(totals) {
  const cacheHitRate =
    totals.totalInputTokens > 0
      ? totals.cacheReadTokens / totals.totalInputTokens
      : null;
  return {
    ...totals,
    cacheHitRate,
  };
}

async function listTranscriptFiles() {
  const files = [];
  for (const { source, root } of getTranscriptRoots()) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const filePath = path.join(
            root,
            entry.name,
            '.system_generated',
            'logs',
            'transcript.jsonl',
          );
          try {
            const stat = await fs.stat(filePath);
            if (stat.isFile()) {
              files.push({
                source,
                conversationId: entry.name,
                filePath,
                mtimeMs: stat.mtimeMs,
              });
            }
          } catch {
            // Transcript does not exist for this conversation directory.
          }
        }),
    );
  }
  return files;
}

async function parseTranscript(filePath, cutoffMs) {
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split('\n');
  const session = emptyTotals();
  const recent = emptyTotals();
  const byModel = new Map();
  let latestContextTokens = 0;
  let latestModel = null;
  let latestAtMs = 0;
  let sessionCwd = null;

  for (const line of lines) {
    if (!line) {
      continue;
    }
    if (!sessionCwd && line.includes('cwd=')) {
      try {
        const metaRow = JSON.parse(line);
        const content = typeof metaRow.content === 'string' ? metaRow.content : '';
        for (const textLine of content.split('\n')) {
          if (textLine.startsWith('cwd=')) {
            const candidate = textLine.slice(4).trim();
            if (candidate) {
              sessionCwd = candidate;
              break;
            }
          }
        }
      } catch {
        // Ignore malformed metadata rows.
      }
    }
    if (!line.includes('"PLANNER_RESPONSE"')) {
      continue;
    }
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== 'PLANNER_RESPONSE') {
      continue;
    }
    const freshInput = Number(row.input_tokens) || 0;
    const cacheRead = Number(row.cache_read_tokens) || 0;
    const output = Number(row.output_tokens) || 0;
    const model = typeof row.model === 'string' && row.model ? row.model : 'unknown';
    const createdAtMs = row.created_at ? Date.parse(row.created_at) : NaN;

    addToTotals(session, freshInput, cacheRead, output);

    if (Number.isFinite(createdAtMs) && createdAtMs >= latestAtMs) {
      latestAtMs = createdAtMs;
      latestContextTokens = freshInput + cacheRead;
      latestModel = model;
    }

    if (Number.isFinite(createdAtMs) && createdAtMs > cutoffMs) {
      addToTotals(recent, freshInput, cacheRead, output);
      let modelTotals = byModel.get(model);
      if (!modelTotals) {
        modelTotals = emptyTotals();
        byModel.set(model, modelTotals);
      }
      addToTotals(modelTotals, freshInput, cacheRead, output);
    }
  }

  return {
    session,
    recent,
    byModel,
    latestContextTokens,
    latestModel,
    latestAtMs,
    sessionCwd,
  };
}

async function readGitStatus(cwd) {
  if (!cwd) return null;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', cwd, 'status', '--porcelain=v1', '--branch'],
      { timeout: 2000, maxBuffer: 512 * 1024 },
    );
    const lines = stdout.split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    const header = lines[0];
    let branch = 'HEAD';
    let ahead = 0;
    let behind = 0;
    if (header.startsWith('## ')) {
      const rest = header.slice(3);
      const bracketMatch = rest.match(/\[(.+)\]$/);
      if (bracketMatch) {
        const meta = bracketMatch[1];
        const aheadMatch = meta.match(/ahead (\d+)/);
        const behindMatch = meta.match(/behind (\d+)/);
        if (aheadMatch) ahead = Number(aheadMatch[1]) || 0;
        if (behindMatch) behind = Number(behindMatch[1]) || 0;
      }
      const branchPart = rest.replace(/\s*\[.+\]$/, '');
      if (branchPart.startsWith('No commits yet on ')) {
        branch = branchPart.slice('No commits yet on '.length).trim();
      } else if (branchPart.includes('...')) {
        branch = branchPart.split('...')[0].trim();
      } else {
        branch = branchPart.trim();
      }
    }
    const changedFiles = Math.max(0, lines.length - 1);
    return {
      cwd,
      branch,
      clean: changedFiles === 0,
      changedFiles,
      ahead,
      behind,
    };
  } catch {
    return null;
  }
}

export async function collectLocalUsage(nowMs = Date.now()) {
  const cutoffMs = nowMs - WINDOW_MS;
  const files = await listTranscriptFiles();
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const windowTotals = emptyTotals();
  const windowByModel = new Map();
  let latestSession = null;
  let scannedFiles = 0;
  let failedFiles = 0;

  // Read all files touched within the last 60 minutes, plus the newest file overall for active session stats.
  const targets = files.filter((file, index) => index === 0 || file.mtimeMs > cutoffMs);

  const results = await Promise.all(
    targets.map(async (file) => {
      try {
        const parsed = await parseTranscript(file.filePath, cutoffMs);
        return { file, parsed, ok: true };
      } catch {
        return { file, parsed: null, ok: false };
      }
    }),
  );

  for (const item of results) {
    if (!item.ok || !item.parsed) {
      failedFiles += 1;
      continue;
    }
    scannedFiles += 1;
    const { file, parsed } = item;

    windowTotals.freshInputTokens += parsed.recent.freshInputTokens;
    windowTotals.cacheReadTokens += parsed.recent.cacheReadTokens;
    windowTotals.totalInputTokens += parsed.recent.totalInputTokens;
    windowTotals.outputTokens += parsed.recent.outputTokens;
    windowTotals.totalTokens += parsed.recent.totalTokens;
    windowTotals.turns += parsed.recent.turns;

    for (const [model, modelTotals] of parsed.byModel.entries()) {
      let agg = windowByModel.get(model);
      if (!agg) {
        agg = emptyTotals();
        windowByModel.set(model, agg);
      }
      agg.freshInputTokens += modelTotals.freshInputTokens;
      agg.cacheReadTokens += modelTotals.cacheReadTokens;
      agg.totalInputTokens += modelTotals.totalInputTokens;
      agg.outputTokens += modelTotals.outputTokens;
      agg.totalTokens += modelTotals.totalTokens;
      agg.turns += modelTotals.turns;
    }

    if (
      parsed.session.turns > 0 &&
      (!latestSession || parsed.latestAtMs > latestSession.updatedAtMs)
    ) {
      latestSession = {
        conversationId: file.conversationId,
        source: file.source,
        model: parsed.latestModel,
        cwd: parsed.sessionCwd,
        latestContextTokens: parsed.latestContextTokens,
        updatedAt: parsed.latestAtMs > 0 ? new Date(parsed.latestAtMs).toISOString() : null,
        updatedAtMs: parsed.latestAtMs,
        ...finalizeTotals(parsed.session),
      };
    }
  }

  const byModel = Array.from(windowByModel.entries())
    .map(([model, totals]) => ({
      model,
      ...finalizeTotals(totals),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  if (latestSession) {
    delete latestSession.updatedAtMs;
  }

  const gitTargetCwd = latestSession?.cwd || null;
  const gitStatus = await readGitStatus(gitTargetCwd);

  return {
    collectedAt: new Date(nowMs).toISOString(),
    windowMinutes: 60,
    window: finalizeTotals(windowTotals),
    byModel,
    latestSession,
    gitStatus,
    scannedFiles,
    failedFiles,
  };
}
