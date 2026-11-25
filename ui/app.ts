import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import {
  MESSAGES,
  normalizeLanguagePreference,
  resolveLocale,
  type LanguagePreference,
  type Messages,
  type ResolvedLocale,
} from './i18n';

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

interface Preferences {
  language?: string;
}

interface Payload {
  localUsage?: LocalUsage;
  quota?: QuotaRecord | null;
  quotaStale?: boolean;
  quotaSource?: string;
  quotaError?: string | null;
  cooldownSeconds?: number | null;
  preferences?: Preferences;
}

type Notice =
  | { kind: 'cooldown'; seconds: number }
  | { kind: 'compactSent' }
  | { kind: 'compactError'; detail: string }
  | { kind: 'prefError'; detail: string };

const CONTEXT_LIMIT_ASSUMED = 1_000_000;
const LOCAL_REFRESH_MS = 10_000;
const COUNTDOWN_TICK_MS = 15_000;

const state: {
  localUsage: LocalUsage | null;
  quota: QuotaRecord | null;
  quotaSource: string;
  quotaError: string | null;
  notice: Notice | null;
  refreshingQuota: boolean;
  didInitialAutoFetch: boolean;
  canSendMessage: boolean;
  sendingCompact: boolean;
  languagePref: LanguagePreference;
  hostLocale: string | null;
  hostTimeZone: string | null;
  prefSaveInFlight: number;
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
  languagePref: 'auto',
  hostLocale: null,
  hostTimeZone: null,
  prefSaveInFlight: 0,
};

const app = new App({ name: 'Usage Monitor', version: '0.1.0' }, {});

function getNavigatorLocales(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    return navigator.languages;
  }
  return navigator.language ? [navigator.language] : [];
}

function getLocaleContext(): { resolved: ResolvedLocale; msg: Messages } {
  const resolved = resolveLocale(
    state.languagePref,
    state.hostLocale,
    getNavigatorLocales(),
  );
  return { resolved, msg: MESSAGES[resolved.lang] };
}

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

function formatRelativeAgo(iso: string | null, msg: Messages): string {
  if (!iso) return msg.relativeNotFetched;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return msg.relativeNotFetched;
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 15) return msg.relativeJustNow;
  if (diffSec < 60) return msg.relativeSecondsAgo(diffSec);
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return msg.relativeMinutesAgo(mins);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return msg.relativeHoursAgo(hours);
  const days = Math.floor(hours / 24);
  return msg.relativeDaysAgo(days);
}

function formatLocalDateTime(targetMs: number, dateLocale: string): string {
  const options: Intl.DateTimeFormatOptions = {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  };
  if (state.hostTimeZone) {
    try {
      return new Date(targetMs).toLocaleString(dateLocale, {
        ...options,
        timeZone: state.hostTimeZone,
      });
    } catch {
      // Ignore invalid host timeZone and fall back to browser timezone.
    }
  }
  return new Date(targetMs).toLocaleString(dateLocale, options);
}

function formatResetCountdown(
  iso: string | null,
  msg: Messages,
  dateLocale: string,
): string {
  if (!iso) return msg.resetUnknown;
  const targetMs = Date.parse(iso);
  if (!Number.isFinite(targetMs)) return msg.resetUnknown;
  const diffSec = Math.floor((targetMs - Date.now()) / 1000);
  if (diffSec <= 0) return msg.resetPassed;

  const days = Math.floor(diffSec / 86_400);
  const hours = Math.floor((diffSec % 86_400) / 3_600);
  const mins = Math.floor((diffSec % 3_600) / 60);
  const localTime = formatLocalDateTime(targetMs, dateLocale);
  return msg.resetCountdown(days, hours, mins, localTime);
}

function windowLabel(windowKey: string, msg: Messages): string {
  if (windowKey === '5h') return '5h';
  if (windowKey === 'weekly') return msg.windowWeekly;
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

function formatNotice(notice: Notice, msg: Messages): string {
  switch (notice.kind) {
    case 'cooldown':
      return msg.quotaCooldownNotice(notice.seconds);
    case 'compactSent':
      return msg.compactSentNotice;
    case 'compactError':
      return msg.compactErrorNotice(notice.detail);
    case 'prefError':
      return msg.prefErrorNotice(notice.detail);
  }
}

function applyPreferences(prefs: Preferences | undefined): void {
  if (!prefs || state.prefSaveInFlight > 0) return;
  if ('language' in prefs) {
    state.languagePref = normalizeLanguagePreference(prefs.language);
  }
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
  applyPreferences(payload.preferences);
  if (payload.cooldownSeconds) {
    state.notice = { kind: 'cooldown', seconds: payload.cooldownSeconds };
  } else if (state.notice?.kind === 'cooldown') {
    state.notice = null;
  }
}

async function handleLanguageChange(nextPref: LanguagePreference): Promise<void> {
  state.languagePref = nextPref;
  if (state.notice?.kind === 'prefError') {
    state.notice = null;
  }
  state.prefSaveInFlight += 1;
  render();
  try {
    const res = await app.callServerTool({
      name: 'set_preferences',
      arguments: { language: nextPref },
    });
    if (res.isError) {
      const errText =
        res.content
          ?.map((item) => ('text' in item && typeof item.text === 'string' ? item.text : ''))
          .filter(Boolean)
          .join(' ') || 'tool returned error';
      throw new Error(errText);
    }
    const payload = res.structuredContent as Payload | undefined;
    if (state.prefSaveInFlight === 1 && payload?.preferences?.language) {
      state.languagePref = normalizeLanguagePreference(payload.preferences.language);
    }
  } catch (err) {
    state.notice = {
      kind: 'prefError',
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    state.prefSaveInFlight = Math.max(0, state.prefSaveInFlight - 1);
    render();
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
    applyPreferences(payload?.preferences);
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
    state.notice = { kind: 'compactSent' };
  } catch (err) {
    state.notice = {
      kind: 'compactError',
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    state.sendingCompact = false;
    render();
  }
}

function renderQuotaCard(msg: Messages, dateLocale: string): HTMLElement {
  const card = el('section', 'card');

  const head = el('div', 'section-head');
  head.append(
    el('span', 'section-title', msg.quotaSectionTitle),
    el(
      'span',
      'section-sub',
      state.refreshingQuota
        ? msg.quotaFetchingSub
        : formatRelativeAgo(state.quota?.fetchedAt ?? null, msg),
    ),
  );
  card.append(head);

  if (state.quotaError) {
    card.append(el('div', 'banner error', msg.quotaErrorPrefix(state.quotaError)));
  }
  if (state.notice) {
    const bannerClass =
      state.notice.kind === 'compactError' || state.notice.kind === 'prefError'
        ? 'banner error'
        : 'banner';
    card.append(el('div', bannerClass, formatNotice(state.notice, msg)));
  }

  if (!state.quota || state.quota.groups.length === 0) {
    card.append(
      el(
        'div',
        'empty',
        state.refreshingQuota ? msg.quotaEmptyFetching : msg.quotaEmptyIdle,
      ),
    );
    return card;
  }

  for (const group of state.quota.groups) {
    const groupEl = el('div', 'group');
    const nameRow = el('div', 'group-name');
    nameRow.append(el('span', undefined, shortGroupName(group.name)));
    if (group.name === 'Claude and GPT models') {
      nameRow.append(el('span', 'group-badge', msg.thirdPartyBadge));
    }
    groupEl.append(nameRow);

    for (const bucket of sortBuckets(group.buckets)) {
      const pct = bucket.remainingPercent;
      const tone = toneForRemaining(pct);
      const row = el('div', 'bucket-row');
      row.append(el('span', 'bucket-label', windowLabel(bucket.window, msg)));

      const barWrap = el('div', 'bar-wrap');
      const track = el('div', 'track');
      const fill = el('div', `fill ${tone}`);
      fill.style.width = `${pct ?? 0}%`;
      track.append(fill);
      barWrap.append(track);
      row.append(barWrap);

      row.append(el('span', `pct ${tone}`, pct === null ? '--' : `${pct}%`));
      row.append(
        el('div', 'reset-line', formatResetCountdown(bucket.resetTime, msg, dateLocale)),
      );
      groupEl.append(row);
    }

    card.append(groupEl);
  }

  return card;
}

function renderContextAndCacheCard(msg: Messages): HTMLElement {
  const card = el('section', 'card');
  const local = state.localUsage;
  const session = local?.latestSession ?? null;

  const head = el('div', 'section-head');
  head.append(
    el('span', 'section-title', msg.contextSectionTitle),
    el('span', 'section-sub', msg.localLogsSub),
  );
  card.append(head);

  if (!local) {
    card.append(el('div', 'empty', msg.localLogsLoading));
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
      state.sendingCompact ? msg.compactSending : 'comp',
    );
    compBtn.disabled = state.sendingCompact;
    compBtn.title = msg.compactTooltip;
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
      ? msg.gitClean(g.branch, syncText)
      : msg.gitChanged(g.branch, g.changedFiles, syncText);
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
    el('span', 'stat-label', msg.cacheWindowLabel),
    el('span', `stat-value pct ${winTone}`, formatPercent(local.window.cacheHitRate)),
    el(
      'span',
      'stat-sub',
      msg.cacheReadFreshSub(
        formatCompactNum(local.window.cacheReadTokens),
        formatCompactNum(local.window.freshInputTokens),
      ),
    ),
  );
  cacheGrid.append(winBox);

  const sessBox = el('div', 'stat-box');
  const sessTone = toneForCache(session?.cacheHitRate ?? null);
  sessBox.append(
    el('span', 'stat-label', msg.cacheSessionLabel),
    el('span', `stat-value pct ${sessTone}`, formatPercent(session?.cacheHitRate ?? null)),
    el(
      'span',
      'stat-sub',
      session
        ? msg.cacheReadFreshSub(
            formatCompactNum(session.cacheReadTokens),
            formatCompactNum(session.freshInputTokens),
          )
        : msg.noData,
    ),
  );
  cacheGrid.append(sessBox);

  card.append(cacheGrid);

  // Compact numeric breakdown
  const kv = el('div', 'kv-list');
  const r1 = el('div', 'kv-row');
  r1.append(
    el('span', undefined, msg.windowTotalLabel),
    el(
      'strong',
      undefined,
      msg.tokenSummaryValue(
        formatCompactNum(local.window.totalTokens),
        formatCompactNum(local.window.outputTokens),
        local.window.turns,
      ),
    ),
  );
  kv.append(r1);

  if (session) {
    const r2 = el('div', 'kv-row');
    r2.append(
      el('span', undefined, msg.latestSessionLabel(session.source)),
      el(
        'strong',
        undefined,
        msg.tokenSummaryValue(
          formatCompactNum(session.totalTokens),
          formatCompactNum(session.outputTokens),
          session.turns,
        ),
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

function renderLanguageSelect(resolved: ResolvedLocale, msg: Messages): HTMLSelectElement {
  const select = el('select', 'lang-select');
  select.setAttribute('aria-label', msg.languageAriaLabel);
  select.title =
    resolved.preference === 'auto'
      ? msg.languageTooltipAuto(resolved)
      : msg.languageTooltipManual;

  const options: Array<{ value: LanguagePreference; label: string }> = [
    { value: 'auto', label: 'Auto' },
    { value: 'ja', label: 'JA' },
    { value: 'en', label: 'EN' },
  ];
  for (const item of options) {
    const opt = document.createElement('option');
    opt.value = item.value;
    opt.textContent = item.label;
    select.append(opt);
  }
  select.value = state.languagePref;
  select.addEventListener('change', () => {
    void handleLanguageChange(normalizeLanguagePreference(select.value));
  });
  return select;
}

function render(): void {
  const root = document.getElementById('root');
  if (!root) return;
  const { resolved, msg } = getLocaleContext();
  if (document.documentElement.lang !== resolved.lang) {
    document.documentElement.lang = resolved.lang;
  }

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
      state.quota ? msg.headerUpdated(formatRelativeAgo(state.quota.fetchedAt, msg)) : '',
    ),
  );

  const headerActions = el('div', 'header-actions');
  headerActions.append(renderLanguageSelect(resolved, msg));

  const refreshBtn = el(
    'button',
    'btn',
    state.refreshingQuota ? msg.refreshingButton : msg.refreshButton,
  );
  refreshBtn.disabled = state.refreshingQuota;
  refreshBtn.addEventListener('click', () => {
    void triggerQuotaRefresh(true);
  });
  headerActions.append(refreshBtn);

  header.append(headerLeft, headerActions);
  root.append(header);

  root.append(renderQuotaCard(msg, resolved.dateLocale));
  root.append(renderContextAndCacheCard(msg));
  root.append(el('footer', 'footer', msg.footerText));
}

function applyHostContext(ctx: {
  theme?: 'light' | 'dark';
  styles?: { variables?: Record<string, string | undefined> };
  locale?: string;
  timeZone?: string;
} | undefined): boolean {
  if (!ctx) return false;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);

  let localeChanged = false;
  if (typeof ctx.locale === 'string' && ctx.locale.trim() !== (state.hostLocale ?? '')) {
    state.hostLocale = ctx.locale.trim() || null;
    localeChanged = true;
  }
  if (typeof ctx.timeZone === 'string' && ctx.timeZone.trim() !== (state.hostTimeZone ?? '')) {
    state.hostTimeZone = ctx.timeZone.trim() || null;
    localeChanged = true;
  }
  return localeChanged;
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
  if (applyHostContext(ctx)) {
    render();
  }
};

async function init(): Promise<void> {
  try {
    await app.connect();
    applyHostContext(app.getHostContext());

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
      const { msg } = getLocaleContext();
      root.replaceChildren(
        el(
          'div',
          'banner error',
          msg.initError(err instanceof Error ? err.message : String(err)),
        ),
      );
    }
  }
}

window.addEventListener('error', (event) => {
  const root = document.getElementById('root');
  if (root && !state.localUsage && !state.quota) {
    const { msg } = getLocaleContext();
    root.replaceChildren(
      el('div', 'banner error', msg.runtimeError(event.message || 'unknown error')),
    );
  }
});

void init();
