import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

interface QuotaBucket {
  id: string;
  name: string;
  window: string;
  description: string;
  remainingFraction: number | null;
  remainingPercent: number | null;
  resetTime: string | null;
}

interface QuotaGroup {
  name: string;
  description: string;
  buckets: QuotaBucket[];
}

interface QuotaRecord {
  fetchedAt: string;
  description: string;
  groups: QuotaGroup[];
}

interface TokenTotals {
  freshInputTokens: number;
  cacheReadTokens: number;
  totalInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number;
  cacheHitRate: number | null;
}

interface ModelUsage extends TokenTotals {
  model: string;
}

interface LatestSession extends TokenTotals {
  conversationId: string;
  source: string;
  model: string | null;
  cwd: string | null;
  latestContextTokens: number;
  updatedAt: string | null;
}

interface GitStatus {
  cwd: string;
  branch: string;
  clean: boolean;
  changedFiles: number;
  ahead: number;
  behind: number;
}

interface LocalUsage {
  collectedAt: string;
  windowMinutes: number;
  window: TokenTotals;
  byModel: ModelUsage[];
  latestSession: LatestSession | null;
  gitStatus: GitStatus | null;
  scannedFiles: number;
  failedFiles: number;
}

interface Payload {
  localUsage?: LocalUsage;
  quota?: QuotaRecord | null;
  quotaStale?: boolean;
  quotaSource?: string;
  quotaError?: string | null;
  cooldownSeconds?: number | null;
}

const CONTEXT_LIMIT_ASSUMED = 1_000_000;
const LOCAL_REFRESH_MS = 10_000;
const COUNTDOWN_TICK_MS = 15_000;

const state: {
  localUsage: LocalUsage | null;
  quota: QuotaRecord | null;
  quotaSource: string;
  quotaError: string | null;
  notice: string | null;
  refreshingQuota: boolean;
  didInitialAutoFetch: boolean;
  canSendMessage: boolean;
  sendingCompact: boolean;
} = {
  localUsage: null,
  quota: null,
  quotaSource: 'none',
  quotaError: null,
  notice: null,
  refreshingQuota: false,
  didInitialAutoFetch: false,
  canSendMessage: false,
  sendingCompact: false,
};

const app = new App({ name: 'Usage Monitor', version: '0.1.0' }, {});

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatCompactNum(n: number): string {
  if (!Number.isFinite(n)) return '--';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

function formatPercent(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return '--';
  return `${Math.round(rate * 100)}%`;
}

function toneForRemaining(pct: number | null): 'ok' | 'warn' | 'danger' {
  if (pct === null) return 'warn';
  if (pct >= 50) return 'ok';
  if (pct >= 20) return 'warn';
  return 'danger';
}

function toneForCache(rate: number | null): 'ok' | 'warn' | 'danger' {
  if (rate === null) return 'warn';
  const pct = rate * 100;
  if (pct >= 80) return 'ok';
  if (pct >= 50) return 'warn';
  return 'danger';
}

function toneForContext(pct: number): 'ok' | 'warn' | 'danger' {
  if (pct < 60) return 'ok';
  if (pct < 85) return 'warn';
  return 'danger';
}

function formatRelativeAgo(iso: string | null): string {
  if (!iso) return '未取得';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '未取得';
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 15) return 'たった今';
  if (diffSec < 60) return `${diffSec}秒前`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}分前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  return `${days}日前`;
}

function formatResetCountdown(iso: string | null): string {
  if (!iso) return 'リセット時刻不明';
  const targetMs = Date.parse(iso);
  if (!Number.isFinite(targetMs)) return 'リセット時刻不明';
  const diffSec = Math.floor((targetMs - Date.now()) / 1000);
  if (diffSec <= 0) return 'リセット済み（更新で再取得）';

  const days = Math.floor(diffSec / 86_400);
  const hours = Math.floor((diffSec % 86_400) / 3_600);
  const mins = Math.floor((diffSec % 3_600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}日`);
  if (hours > 0) parts.push(`${hours}時間`);
  if (days === 0 && mins > 0) parts.push(`${mins}分`);
  if (parts.length === 0) parts.push('1分未満');

  const localTime = new Date(targetMs).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `あと ${parts.join('')} (${localTime})`;
}

function windowLabel(windowKey: string): string {
  if (windowKey === '5h') return '5h';
  if (windowKey === 'weekly') return '週';
  return windowKey || '--';
}

function shortGroupName(name: string): string {
  if (name === 'Gemini Models') return 'Gemini';
  if (name === 'Claude and GPT models') return 'Claude / GPT';
  return name;
}

function sortBuckets(buckets: QuotaBucket[]): QuotaBucket[] {
  const rank = (w: string) => (w === '5h' ? 0 : w === 'weekly' ? 1 : 2);
  return [...buckets].sort((a, b) => rank(a.window) - rank(b.window));
}

function applyPayload(payload: Payload | undefined): void {
  if (!payload) return;
  if (payload.localUsage) {
    state.localUsage = payload.localUsage;
  }
  if ('quota' in payload && payload.quota !== undefined) {
    state.quota = payload.quota;
  }
  if (payload.quotaSource) {
    state.quotaSource = payload.quotaSource;
  }
  if ('quotaError' in payload) {
    state.quotaError = payload.quotaError ?? null;
  }
  if (payload.cooldownSeconds) {
    state.notice = `連続更新の保護中（あと ${payload.cooldownSeconds} 秒）`;
  } else {
    state.notice = null;
  }
}

async function triggerQuotaRefresh(force: boolean): Promise<void> {
  if (state.refreshingQuota) return;
  state.refreshingQuota = true;
  state.quotaError = null;
  state.notice = null;
  render();
  try {
    const res = await app.callServerTool({
      name: 'refresh_quota',
      arguments: { force },
    });
    applyPayload(res.structuredContent as Payload | undefined);
  } catch (err) {
    state.quotaError = err instanceof Error ? err.message : String(err);
  } finally {
    state.refreshingQuota = false;
    render();
  }
}

async function pollLocalUsage(): Promise<void> {
  try {
    const res = await app.callServerTool({
      name: 'get_local_usage',
      arguments: {},
    });
    const payload = res.structuredContent as Payload | undefined;
    if (payload?.localUsage) {
      state.localUsage = payload.localUsage;
    }
    if (payload?.quota && !state.quota) {
      state.quota = payload.quota;
    }
    render();
  } catch {
    // Ignore transient polling errors when view is closing or reloading.
  }
}

async function handleCompactClick(): Promise<void> {
  if (state.sendingCompact) return;
  state.sendingCompact = true;
  state.notice = null;
  render();
  try {
    await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: '/compact' }],
    });
    state.notice = '/compact を会話へ送信しました';
  } catch (err) {
    state.notice = `送信失敗: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    state.sendingCompact = false;
    render();
  }
}

function renderQuotaCard(): HTMLElement {
  const card = el('section', 'card');

  const head = el('div', 'section-head');
  head.append(
    el('span', 'section-title', 'クォータ残量'),
    el(
      'span',
      'section-sub',
      state.refreshingQuota
        ? 'agy /usage 取得中...'
        : formatRelativeAgo(state.quota?.fetchedAt ?? null),
    ),
  );
  card.append(head);

  if (state.quotaError) {
    card.append(el('div', 'banner error', `取得エラー: ${state.quotaError}`));
  }
  if (state.notice) {
    card.append(el('div', 'banner', state.notice));
  }

  if (!state.quota || state.quota.groups.length === 0) {
    card.append(
      el(
        'div',
        'empty',
        state.refreshingQuota
          ? '公式 CLI (agy /usage) から残量を取得中（約7〜8秒）...'
          : 'まだ取得されていません。右上の「更新」で取得できます。',
      ),
    );
    return card;
  }

  for (const group of state.quota.groups) {
    const groupEl = el('div', 'group');
    const nameRow = el('div', 'group-name');
    nameRow.append(el('span', undefined, shortGroupName(group.name)));
    if (group.name === 'Claude and GPT models') {
      nameRow.append(el('span', 'group-badge', 'AGY内 3P枠'));
    }
    groupEl.append(nameRow);

    for (const bucket of sortBuckets(group.buckets)) {
      const pct = bucket.remainingPercent;
      const tone = toneForRemaining(pct);
      const row = el('div', 'bucket-row');
      row.append(el('span', 'bucket-label', windowLabel(bucket.window)));

      const barWrap = el('div', 'bar-wrap');
      const track = el('div', 'track');
      const fill = el('div', `fill ${tone}`);
      fill.style.width = `${pct ?? 0}%`;
      track.append(fill);
      barWrap.append(track);
      row.append(barWrap);

      row.append(el('span', `pct ${tone}`, pct === null ? '--' : `${pct}%`));
      row.append(el('div', 'reset-line', formatResetCountdown(bucket.resetTime)));
      groupEl.append(row);
    }

    card.append(groupEl);
  }

  return card;
}

function renderContextAndCacheCard(): HTMLElement {
  const card = el('section', 'card');
  const local = state.localUsage;
  const session = local?.latestSession ?? null;

  const head = el('div', 'section-head');
  head.append(
    el('span', 'section-title', 'コンテキスト & キャッシュ'),
    el('span', 'section-sub', 'ローカルログ'),
  );
  card.append(head);

  if (!local) {
    card.append(el('div', 'empty', 'ローカルログ集計を読み込み中...'));
    return card;
  }

  // Context bar (latest session)
  const ctxTokens = session?.latestContextTokens ?? 0;
  const ctxPct = Math.min(100, Math.round((ctxTokens / CONTEXT_LIMIT_ASSUMED) * 100));
  const ctxTone = toneForContext(ctxPct);

  const ctxRow = el('div', 'context-row');
  const ctxMain = el('div', 'context-main');
  const pctSpan = el('span', `context-pct pct ${ctxTone}`, `${ctxPct}%`);
  const detailSpan = el(
    'span',
    'context-detail',
    `(${formatCompactNum(ctxTokens)} / 1M)`,
  );
  ctxMain.append(pctSpan, detailSpan);
  ctxRow.append(ctxMain);

  const rightControls = el('div', 'context-row');
  if (session?.model) {
    rightControls.append(el('span', 'model-pill', session.model));
  }
  if (state.canSendMessage) {
    const compBtn = el(
      'button',
      'btn',
      state.sendingCompact ? '送信中...' : 'comp',
    );
    compBtn.disabled = state.sendingCompact;
    compBtn.title = '現在の会話に /compact（コンテキスト圧縮）を送信';
    compBtn.addEventListener('click', () => {
      void handleCompactClick();
    });
    rightControls.append(compBtn);
  }
  ctxRow.append(rightControls);
  card.append(ctxRow);

  const ctxTrack = el('div', 'track');
  const ctxFill = el('div', `fill ${ctxTone}`);
  ctxFill.style.width = `${ctxPct}%`;
  ctxTrack.append(ctxFill);
  card.append(ctxTrack);

  // Git branch & working tree status (from active session cwd)
  if (local.gitStatus) {
    const g = local.gitStatus;
    const syncParts: string[] = [];
    if (g.ahead > 0) syncParts.push(`↑${g.ahead}`);
    if (g.behind > 0) syncParts.push(`↓${g.behind}`);
    const syncText = syncParts.length > 0 ? ` ${syncParts.join(' ')}` : '';
    const statusText = g.clean
      ? `${g.branch} ✓ クリーン${syncText}`
      : `${g.branch} ● ${g.changedFiles}件変更${syncText}`;
    const gitRow = el('div', 'kv-row');
    const statusSpan = el('strong', g.clean ? 'pct ok' : 'pct warn', statusText);
    gitRow.append(el('span', undefined, 'Git'), statusSpan);
    const gitWrap = el('div', 'kv-list');
    gitWrap.append(gitRow);
    card.append(gitWrap);
  }

  // Cache hit rate boxes (60m rolling + latest session)
  const cacheGrid = el('div', 'cache-grid');

  const winBox = el('div', 'stat-box');
  const winTone = toneForCache(local.window.cacheHitRate);
  winBox.append(
    el('span', 'stat-label', 'cache 直近60分'),
    el('span', `stat-value pct ${winTone}`, formatPercent(local.window.cacheHitRate)),
    el(
      'span',
      'stat-sub',
      `読 ${formatCompactNum(local.window.cacheReadTokens)} / 新 ${formatCompactNum(local.window.freshInputTokens)}`,
    ),
  );
  cacheGrid.append(winBox);

  const sessBox = el('div', 'stat-box');
  const sessTone = toneForCache(session?.cacheHitRate ?? null);
  sessBox.append(
    el('span', 'stat-label', 'cache セッション'),
    el('span', `stat-value pct ${sessTone}`, formatPercent(session?.cacheHitRate ?? null)),
    el(
      'span',
      'stat-sub',
      session
        ? `読 ${formatCompactNum(session.cacheReadTokens)} / 新 ${formatCompactNum(session.freshInputTokens)}`
        : '記録なし',
    ),
  );
  cacheGrid.append(sessBox);

  card.append(cacheGrid);

  // Compact numeric breakdown
  const kv = el('div', 'kv-list');
  const r1 = el('div', 'kv-row');
  r1.append(
    el('span', undefined, '直近60分 合計'),
    el(
      'strong',
      undefined,
      `${formatCompactNum(local.window.totalTokens)} (出 ${formatCompactNum(local.window.outputTokens)} / ${local.window.turns}t)`,
    ),
  );
  kv.append(r1);

  if (session) {
    const r2 = el('div', 'kv-row');
    r2.append(
      el('span', undefined, `最新セッション (${session.source})`),
      el(
        'strong',
        undefined,
        `${formatCompactNum(session.totalTokens)} (出 ${formatCompactNum(session.outputTokens)} / ${session.turns}t)`,
      ),
    );
    kv.append(r2);
  }
  card.append(kv);

  if (local.byModel.length > 0) {
    const table = el('div', 'model-table');
    for (const item of local.byModel.slice(0, 4)) {
      const line = el('div', 'model-line');
      line.append(
        el('span', 'model-line-name', item.model),
        el(
          'span',
          undefined,
          `${formatCompactNum(item.totalTokens)} · cache ${formatPercent(item.cacheHitRate)}`,
        ),
      );
      table.append(line);
    }
    card.append(table);
  }

  return card;
}

function render(): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.replaceChildren();

  const header = el('header', 'header');
  const headerLeft = el('div', 'header-left');
  const dotClass = state.refreshingQuota
    ? 'dot loading'
    : state.quotaError
      ? 'dot error'
      : state.quota
        ? 'dot ok'
        : 'dot';
  headerLeft.append(
    el('span', dotClass),
    el('span', 'title', 'Usage'),
    el(
      'span',
      'meta-time',
      state.quota ? `更新: ${formatRelativeAgo(state.quota.fetchedAt)}` : '',
    ),
  );

  const refreshBtn = el(
    'button',
    'btn',
    state.refreshingQuota ? '取得中...' : 'クォータ更新',
  );
  refreshBtn.disabled = state.refreshingQuota;
  refreshBtn.addEventListener('click', () => {
    void triggerQuotaRefresh(true);
  });

  header.append(headerLeft, refreshBtn);
  root.append(header);

  root.append(renderQuotaCard());
  root.append(renderContextAndCacheCard());

  root.append(
    el(
      'footer',
      'footer',
      'ローカルログは通信なしで10秒ごとに更新。クォータは開いたとき（2分以上経過時）と手動更新ボタン時のみ公式 agy CLI を単発実行します（定期ポーリングなし）。',
    ),
  );
}

app.ontoolresult = (result) => {
  const payload = result.structuredContent as Payload | undefined;
  applyPayload(payload);
  render();

  if (payload?.quotaStale && !state.didInitialAutoFetch) {
    state.didInitialAutoFetch = true;
    void triggerQuotaRefresh(false);
  }
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

async function init(): Promise<void> {
  try {
    await app.connect();
    const ctx = app.getHostContext();
    if (ctx?.theme) applyDocumentTheme(ctx.theme);
    if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);

    const caps = app.getHostCapabilities();
    state.canSendMessage = Boolean(caps?.message);

    // If the host opened the view without an initial tool result yet, fetch local usage immediately.
    if (!state.localUsage) {
      await pollLocalUsage();
    }
    render();

    setInterval(() => {
      void pollLocalUsage();
    }, LOCAL_REFRESH_MS);

    setInterval(() => {
      render();
    }, COUNTDOWN_TICK_MS);
  } catch (err) {
    const root = document.getElementById('root');
    if (root) {
      root.replaceChildren(
        el(
          'div',
          'banner error',
          `UI 初期化エラー: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
}

window.addEventListener('error', (event) => {
  const root = document.getElementById('root');
  if (root && !state.localUsage && !state.quota) {
    root.replaceChildren(
      el('div', 'banner error', `UI 実行エラー: ${event.message || 'unknown error'}`),
    );
  }
});

void init();
