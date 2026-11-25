import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { collectLocalUsage } from './local-usage.mjs';
import { PreferencesStore } from './preferences.mjs';
import { QuotaStore } from './quota.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

const APP_URI = 'ui://agy-usage-pane/app.html';
const APP_MIME_TYPE = 'text/html;profile=mcp-app';

function parseDataDir(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--data-dir=')) {
      const val = arg.slice('--data-dir='.length).trim();
      if (val) return val;
    } else if (arg === '--data-dir' && argv[i + 1]) {
      return argv[i + 1].trim();
    }
  }
  return path.join(os.homedir(), '.gemini', 'config', 'plugin-data', 'agy-usage-pane');
}

function getAppHtmlPath() {
  if (process.env.AGY_USAGE_PANE_HTML) {
    return process.env.AGY_USAGE_PANE_HTML;
  }
  return path.join(PLUGIN_ROOT, 'ui', 'dist', 'app.html');
}

function formatSummaryText(localUsage, quota) {
  const parts = [];
  if (quota?.groups?.length) {
    for (const g of quota.groups) {
      const bText = g.buckets
        .map((b) => `${b.window}:${b.remainingPercent ?? '--'}%`)
        .join(' ');
      parts.push(`${g.name} [${bText}]`);
    }
  } else {
    parts.push('Quota: not fetched yet');
  }
  const hit =
    localUsage.window.cacheHitRate === null
      ? '--'
      : `${Math.round(localUsage.window.cacheHitRate * 100)}%`;
  parts.push(`Local 60m cache=${hit} turns=${localUsage.window.turns}`);
  return parts.join(' | ');
}

const dataDir = parseDataDir(process.argv.slice(2));
const quotaStore = new QuotaStore(dataDir);
const preferencesStore = new PreferencesStore(dataDir);

const server = new McpServer({
  name: 'agy-usage-pane',
  version: '0.1.0',
});

server.registerResource(
  'usage_monitor_app',
  APP_URI,
  {
    title: 'Antigravity Usage Monitor',
    description: 'Compact usage monitor for Antigravity quotas, context size, and cache hit rates.',
    mimeType: APP_MIME_TYPE,
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
  async () => {
    const htmlPath = getAppHtmlPath();
    const html = await fs.readFile(htmlPath, 'utf8');
    return {
      contents: [
        {
          uri: APP_URI,
          mimeType: APP_MIME_TYPE,
          text: html,
        },
      ],
    };
  },
);

server.registerTool(
  'open_usage_monitor',
  {
    title: 'Usage',
    description:
      'Open the Antigravity Usage Monitor showing 5h/weekly quotas, context size, and local cache hit rates.',
    _meta: {
      ui: {
        resourceUri: APP_URI,
      },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'Usage' },
          { type: 'global', title: 'Usage' },
        ],
      },
    },
  },
  async () => {
    const [localUsage, cachedQuota, preferences] = await Promise.all([
      collectLocalUsage(),
      quotaStore.loadCache(),
      preferencesStore.load(),
    ]);
    const quotaStale = quotaStore.isStale();
    const structuredContent = {
      localUsage,
      quota: cachedQuota,
      quotaStale,
      quotaSource: cachedQuota ? 'cache' : 'none',
      quotaError: null,
      preferences,
    };
    return {
      content: [
        {
          type: 'text',
          text: formatSummaryText(localUsage, cachedQuota),
        },
      ],
      structuredContent,
    };
  },
);

server.registerTool(
  'get_local_usage',
  {
    title: 'Get Local Usage',
    description: 'Read local Antigravity transcript token and cache statistics without network calls.',
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  async () => {
    const [localUsage, cachedQuota, preferences] = await Promise.all([
      collectLocalUsage(),
      quotaStore.loadCache(),
      preferencesStore.load(),
    ]);
    const structuredContent = {
      localUsage,
      quota: cachedQuota,
      quotaStale: quotaStore.isStale(),
      preferences,
    };
    return {
      content: [
        {
          type: 'text',
          text: formatSummaryText(localUsage, cachedQuota),
        },
      ],
      structuredContent,
    };
  },
);

server.registerTool(
  'set_preferences',
  {
    title: 'Set Preferences',
    description: 'Persist Usage Monitor UI preferences (such as display language) in plugin data.',
    inputSchema: {
      language: z.enum(['auto', 'ja', 'en']),
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  async ({ language }) => {
    const preferences = await preferencesStore.save({ language });
    return {
      content: [
        {
          type: 'text',
          text: `Preferences updated: language=${preferences.language}`,
        },
      ],
      structuredContent: {
        preferences,
      },
    };
  },
);

server.registerTool(
  'refresh_quota',
  {
    title: 'Refresh Quota',
    description: 'Run official agy CLI once to refresh 5h and weekly quota balances.',
    inputSchema: {
      force: z.boolean().optional(),
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  async ({ force = false } = {}) => {
    const [result, localUsage, preferences] = await Promise.all([
      quotaStore.refresh({ force }),
      collectLocalUsage(),
      preferencesStore.load(),
    ]);
    const structuredContent = {
      localUsage,
      quota: result.quota,
      quotaStale: quotaStore.isStale(),
      quotaSource: result.source,
      quotaError: result.error,
      cooldownSeconds: result.cooldownSeconds ?? null,
      preferences,
    };
    return {
      content: [
        {
          type: 'text',
          text: result.error
            ? `Quota refresh failed: ${result.error}`
            : formatSummaryText(localUsage, result.quota),
        },
      ],
      structuredContent,
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
