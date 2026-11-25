export type SupportedLanguage = 'ja' | 'en';
export type LanguagePreference = 'auto' | SupportedLanguage;

export interface ResolvedLocale {
  preference: LanguagePreference;
  lang: SupportedLanguage;
  dateLocale: string;
  detectedLocale: string | null;
  source: 'manual' | 'host' | 'navigator' | 'fallback';
}

const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ['ja', 'en'];

export function normalizeLanguagePreference(value: unknown): LanguagePreference {
  if (value === 'auto' || value === 'ja' || value === 'en') {
    return value;
  }
  return 'auto';
}

function extractPrimaryLanguage(localeTag: string): string {
  const normalized = localeTag.trim().replace(/_/g, '-');
  if (!normalized) return '';
  try {
    return new Intl.Locale(normalized).language.toLowerCase();
  } catch {
    return normalized.split('-')[0].toLowerCase();
  }
}

function matchSupportedLanguage(localeTag: string | null | undefined): SupportedLanguage {
  if (!localeTag) return 'en';
  const primary = extractPrimaryLanguage(localeTag);
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(primary)) {
    return primary as SupportedLanguage;
  }
  return 'en';
}

function sanitizeDateLocale(candidate: string | null | undefined, fallbackLang: SupportedLanguage): string {
  const fallback = fallbackLang === 'ja' ? 'ja-JP' : 'en-US';
  if (!candidate) return fallback;
  const normalized = candidate.trim().replace(/_/g, '-');
  if (!normalized) return fallback;
  try {
    const supported = Intl.DateTimeFormat.supportedLocalesOf([normalized]);
    if (supported.length > 0) {
      return normalized;
    }
  } catch {
    // Fall back to default regional tag for the resolved UI language.
  }
  return fallback;
}

export function resolveLocale(
  preference: LanguagePreference,
  hostLocale?: string | null,
  navigatorLocales?: readonly string[],
): ResolvedLocale {
  const trimmedHost = typeof hostLocale === 'string' ? hostLocale.trim() : '';
  const navFirst = (navigatorLocales ?? [])
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .find((item) => item.length > 0) ?? '';

  if (preference !== 'auto') {
    return {
      preference,
      lang: preference,
      dateLocale: preference === 'ja' ? 'ja-JP' : 'en-US',
      detectedLocale: trimmedHost || navFirst || null,
      source: 'manual',
    };
  }

  if (trimmedHost) {
    const lang = matchSupportedLanguage(trimmedHost);
    return {
      preference: 'auto',
      lang,
      dateLocale: sanitizeDateLocale(trimmedHost, lang),
      detectedLocale: trimmedHost,
      source: 'host',
    };
  }

  if (navFirst) {
    const lang = matchSupportedLanguage(navFirst);
    return {
      preference: 'auto',
      lang,
      dateLocale: sanitizeDateLocale(navFirst, lang),
      detectedLocale: navFirst,
      source: 'navigator',
    };
  }

  return {
    preference: 'auto',
    lang: 'en',
    dateLocale: 'en-US',
    detectedLocale: null,
    source: 'fallback',
  };
}

export interface Messages {
  headerUpdated: (ago: string) => string;
  refreshButton: string;
  refreshingButton: string;
  languageAriaLabel: string;
  languageTooltipAuto: (resolved: ResolvedLocale) => string;
  languageTooltipManual: string;
  quotaSectionTitle: string;
  quotaFetchingSub: string;
  quotaErrorPrefix: (err: string) => string;
  quotaCooldownNotice: (seconds: number) => string;
  quotaEmptyFetching: string;
  quotaEmptyIdle: string;
  thirdPartyBadge: string;
  windowWeekly: string;
  relativeNotFetched: string;
  relativeJustNow: string;
  relativeSecondsAgo: (n: number) => string;
  relativeMinutesAgo: (n: number) => string;
  relativeHoursAgo: (n: number) => string;
  relativeDaysAgo: (n: number) => string;
  resetUnknown: string;
  resetPassed: string;
  resetCountdown: (days: number, hours: number, mins: number, localTime: string) => string;
  contextSectionTitle: string;
  localLogsSub: string;
  localLogsLoading: string;
  compactSending: string;
  compactTooltip: string;
  compactSentNotice: string;
  compactErrorNotice: (err: string) => string;
  prefErrorNotice: (err: string) => string;
  gitClean: (branch: string, syncText: string) => string;
  gitChanged: (branch: string, count: number, syncText: string) => string;
  cacheWindowLabel: string;
  cacheSessionLabel: string;
  cacheReadFreshSub: (read: string, fresh: string) => string;
  noData: string;
  windowTotalLabel: string;
  latestSessionLabel: (source: string) => string;
  tokenSummaryValue: (total: string, output: string, turns: number) => string;
  footerText: string;
  initError: (err: string) => string;
  runtimeError: (err: string) => string;
}

export const MESSAGES: Record<SupportedLanguage, Messages> = {
  ja: {
    headerUpdated: (ago) => `更新: ${ago}`,
    refreshButton: 'クォータ更新',
    refreshingButton: '取得中...',
    languageAriaLabel: '表示言語',
    languageTooltipAuto: (resolved) => {
      const origin =
        resolved.source === 'host'
          ? `ホスト ${resolved.detectedLocale}`
          : resolved.source === 'navigator'
            ? `環境 ${resolved.detectedLocale}`
            : '既定';
      return `表示言語: Auto（${origin} → ${resolved.lang.toUpperCase()}）`;
    },
    languageTooltipManual: '表示言語: 日本語（手動設定）',
    quotaSectionTitle: 'クォータ残量',
    quotaFetchingSub: 'agy /usage 取得中...',
    quotaErrorPrefix: (err) => `取得エラー: ${err}`,
    quotaCooldownNotice: (seconds) => `連続更新の保護中（あと ${seconds} 秒）`,
    quotaEmptyFetching: '公式 CLI (agy /usage) から残量を取得中（約7〜8秒）...',
    quotaEmptyIdle: 'まだ取得されていません。右上の「クォータ更新」で取得できます。',
    thirdPartyBadge: 'AGY内 3P枠',
    windowWeekly: '週',
    relativeNotFetched: '未取得',
    relativeJustNow: 'たった今',
    relativeSecondsAgo: (n) => `${n}秒前`,
    relativeMinutesAgo: (n) => `${n}分前`,
    relativeHoursAgo: (n) => `${n}時間前`,
    relativeDaysAgo: (n) => `${n}日前`,
    resetUnknown: 'リセット時刻不明',
    resetPassed: 'リセット済み（更新で再取得）',
    resetCountdown: (days, hours, mins, localTime) => {
      const parts: string[] = [];
      if (days > 0) parts.push(`${days}日`);
      if (hours > 0) parts.push(`${hours}時間`);
      if (days === 0 && mins > 0) parts.push(`${mins}分`);
      if (parts.length === 0) parts.push('1分未満');
      return `あと ${parts.join('')} (${localTime})`;
    },
    contextSectionTitle: 'コンテキスト & キャッシュ',
    localLogsSub: 'ローカルログ',
    localLogsLoading: 'ローカルログ集計を読み込み中...',
    compactSending: '送信中...',
    compactTooltip: '現在の会話に /compact（コンテキスト圧縮）を送信',
    compactSentNotice: '/compact を会話へ送信しました',
    compactErrorNotice: (err) => `送信失敗: ${err}`,
    prefErrorNotice: (err) => `言語設定の保存失敗: ${err}`,
    gitClean: (branch, syncText) => `${branch} ✓ クリーン${syncText}`,
    gitChanged: (branch, count, syncText) => `${branch} ● ${count}件変更${syncText}`,
    cacheWindowLabel: 'cache 直近60分',
    cacheSessionLabel: 'cache セッション',
    cacheReadFreshSub: (read, fresh) => `読 ${read} / 新 ${fresh}`,
    noData: '記録なし',
    windowTotalLabel: '直近60分 合計',
    latestSessionLabel: (source) => `最新セッション (${source})`,
    tokenSummaryValue: (total, output, turns) => `${total} (出 ${output} / ${turns}t)`,
    footerText:
      'ローカルログは通信なしで10秒ごとに更新。クォータは開いたとき（2分以上経過時）と手動更新ボタン時のみ公式 agy CLI を単発実行します（定期ポーリングなし）。',
    initError: (err) => `UI 初期化エラー: ${err}`,
    runtimeError: (err) => `UI 実行エラー: ${err}`,
  },
  en: {
    headerUpdated: (ago) => `Updated: ${ago}`,
    refreshButton: 'Refresh',
    refreshingButton: 'Refreshing...',
    languageAriaLabel: 'Display language',
    languageTooltipAuto: (resolved) => {
      const origin =
        resolved.source === 'host'
          ? `host ${resolved.detectedLocale}`
          : resolved.source === 'navigator'
            ? `browser ${resolved.detectedLocale}`
            : 'default';
      return `Language: Auto (${origin} -> ${resolved.lang.toUpperCase()})`;
    },
    languageTooltipManual: 'Language: English (manual)',
    quotaSectionTitle: 'Quota Remaining',
    quotaFetchingSub: 'Fetching agy /usage...',
    quotaErrorPrefix: (err) => `Fetch error: ${err}`,
    quotaCooldownNotice: (seconds) => `Refresh cooldown (${seconds}s remaining)`,
    quotaEmptyFetching: 'Fetching quotas via official agy CLI (~7-8s)...',
    quotaEmptyIdle: 'Not fetched yet. Click "Refresh" in the top right.',
    thirdPartyBadge: '3P Pool in AGY',
    windowWeekly: 'Wk',
    relativeNotFetched: 'Not fetched',
    relativeJustNow: 'Just now',
    relativeSecondsAgo: (n) => `${n}s ago`,
    relativeMinutesAgo: (n) => `${n}m ago`,
    relativeHoursAgo: (n) => `${n}h ago`,
    relativeDaysAgo: (n) => `${n}d ago`,
    resetUnknown: 'Reset time unknown',
    resetPassed: 'Reset passed (refresh to update)',
    resetCountdown: (days, hours, mins, localTime) => {
      const parts: string[] = [];
      if (days > 0) parts.push(`${days}d`);
      if (hours > 0) parts.push(`${hours}h`);
      if (days === 0 && mins > 0) parts.push(`${mins}m`);
      if (parts.length === 0) parts.push('<1m');
      return `in ${parts.join(' ')} (${localTime})`;
    },
    contextSectionTitle: 'Context & Cache',
    localLogsSub: 'Local logs',
    localLogsLoading: 'Loading local log stats...',
    compactSending: 'Sending...',
    compactTooltip: 'Send /compact to the current conversation',
    compactSentNotice: 'Sent /compact to conversation',
    compactErrorNotice: (err) => `Failed to send: ${err}`,
    prefErrorNotice: (err) => `Failed to save language preference: ${err}`,
    gitClean: (branch, syncText) => `${branch} ✓ clean${syncText}`,
    gitChanged: (branch, count, syncText) => `${branch} ● ${count} changed${syncText}`,
    cacheWindowLabel: 'Cache (last 60m)',
    cacheSessionLabel: 'Cache (session)',
    cacheReadFreshSub: (read, fresh) => `hit ${read} / new ${fresh}`,
    noData: 'No data',
    windowTotalLabel: 'Last 60m total',
    latestSessionLabel: (source) => `Latest session (${source})`,
    tokenSummaryValue: (total, output, turns) => `${total} (out ${output} / ${turns}t)`,
    footerText:
      'Local logs refresh offline every 10s. Quotas run the official agy CLI once on open (if >2m stale) or on manual refresh (no background polling).',
    initError: (err) => `UI initialization error: ${err}`,
    runtimeError: (err) => `UI runtime error: ${err}`,
  },
};
