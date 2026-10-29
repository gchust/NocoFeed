import { ApiClientError } from '@nocobase/app-client';
import type { UseTranslationResponse } from '@nocobase/i18n/client';

type TFunction = UseTranslationResponse<never, undefined>['t'];

/** What a failed request means for the person, in the order `api.md` checks it. */
export type RequestProblem =
  | 'sessionExpired'
  | 'notFound'
  | 'forbidden'
  | 'invalid'
  | 'busy'
  | 'unavailable'
  | 'failed';

export function requestProblem(error: unknown): RequestProblem {
  if (!(error instanceof ApiClientError)) return 'failed';
  if (error.status === 401) return 'sessionExpired';
  if (error.status === 404) return 'notFound';
  if (error.status === 403) return 'forbidden';
  if (error.status === 400) return 'invalid';
  if (error.status === 409) return 'busy';
  if (error.status === 503) return 'unavailable';
  return 'failed';
}

// Codes the server stores in a source's status message, a run's error or a part's coverage note. Anything else is
// raw upstream text, which is never shown (guideline I3).
const MESSAGE_CODES = new Set([
  'channelNotResolved',
  'notAFeed',
  'collectorNotConfigured',
  'invalidChannel',
  'invalidSubreddit',
  'invalidVideo',
  'missingUrl',
  'redditRssFallback',
]);

const NOTE_CODES = new Set([
  'commentsNotSupported',
  'countsUnknown',
  'descriptionOnly',
  'feedContent',
  'feedHasNoComments',
  'feedSummaryOnly',
  'linkedArticleNotFetched',
  'mediaNotAnalyzed',
  'noComments',
  'redditRss',
  'titleOnly',
  'titleOnlyPost',
  'needsLogin',
  'blocked',
  'rateLimited',
  'unconfigured',
  'unsupported',
  'failed',
]);

/** A translated status message, or `undefined` when the server stored free text that must not be shown. */
export function messageText(
  t: TFunction,
  message: string | null | undefined,
): string | undefined {
  if (!message) return undefined;
  return MESSAGE_CODES.has(message) ? t(`feed.messages.${message}`) : undefined;
}

export function noteText(
  t: TFunction,
  note: string | undefined,
): string | undefined {
  if (!note) return undefined;
  const topLevel = /^topLevel:(\d+)\/(\d+)$/.exec(note);
  if (topLevel)
    return t('feed.notes.topLevel', { shown: topLevel[1], total: topLevel[2] });
  return NOTE_CODES.has(note) ? t(`feed.notes.${note}`) : undefined;
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "3 hours ago" / "in 20 minutes" in the current language; "—" when absent. */
export function relativeTime(
  value: string | null | undefined,
  language: string,
  now = Date.now(),
): string {
  if (!value) return '—';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '—';
  const seconds = Math.round((time - now) / 1000);
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size)
      return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, 'minute');
}

export function absoluteTime(
  value: string | null | undefined,
  language: string,
): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** Minutes as "15 min", "2 h", "1 d" in the current language. */
export function frequencyText(t: TFunction, minutes: number): string {
  if (minutes % 1440 === 0)
    return t('sources.frequency.days', { count: minutes / 1440 });
  if (minutes % 60 === 0)
    return t('sources.frequency.hours', { count: minutes / 60 });
  return t('sources.frequency.minutes', { count: minutes });
}

/** The tone a source or run status shows with. */
export function statusTone(
  status: string,
): 'neutral' | 'info' | 'warning' | 'success' {
  if (status === 'ok' || status === 'succeeded') return 'success';
  if (status === 'pending' || status === 'running') return 'info';
  if (status === 'partial') return 'warning';
  if (
    status === 'needsLogin' ||
    status === 'unconfigured' ||
    status === 'unsupported'
  )
    return 'neutral';
  return 'warning';
}
