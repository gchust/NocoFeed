import {
  type ApiClient,
  SubmissionController,
  useApiClient,
  useToaster,
} from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useEffect, useState } from 'react';

import { requestProblem } from './format.js';
import {
  type FeedListItem,
  type FeedSummary,
  type ItemState,
  type ListView,
  type StateChange,
  VIEWS,
} from './types.js';

/** From here an analysis counts as in depth, as the server's `SOLID_QUALITY`. */
const SOLID_QUALITY = 60;
const LIST_VIEWS = VIEWS.filter((view): view is ListView => view !== 'digest');

/** The person's marks that one click changes: they show at once and are saved behind it. */
export const MARKS = [
  'favorite',
  'later',
  'participated',
  'dismissed',
  'read',
  'feedback',
] as const;
export type Mark = (typeof MARKS)[number];
export type Marks = Pick<ItemState, Mark>;

/** What changed on the screen for one item. */
export interface MarkEvent {
  readonly id: number;
  /**
   * `optimistic`: the person changed a mark and it shows before it is saved. `rollback`: saving failed and the screen
   * returns to what the server holds. `confirmed`: the server answered; `changes` holds only marks that agree with
   * what is shown, so a later click is never undone by an earlier answer.
   */
  readonly kind: 'optimistic' | 'rollback' | 'confirmed';
  readonly changes: Partial<Marks>;
  /** Every mark as shown before and after this event; equal for `confirmed`. */
  readonly before: Marks;
  readonly after: Marks;
  /** The server's answer, for `confirmed`. */
  readonly state?: StateChange;
}

export interface MarkWriter {
  /**
   * Shows the change at once and saves it in the background. `shown` is the item's marks as the caller displays them.
   * Clicking the same mark again while it is being saved only changes what is sent next: the last value wins.
   * `quiet` leaves a failure unannounced (reading an item on opening it).
   */
  set(
    id: number,
    changes: Partial<Marks>,
    shown: Marks,
    options?: { readonly quiet?: boolean },
  ): void;
  subscribe(listener: (event: MarkEvent) => void): () => void;
  /** Called whenever the last unsaved mark has been saved or rolled back. */
  onIdle(listener: () => void): () => void;
}

interface Entry {
  readonly id: number;
  readonly mark: Mark;
  /** The value the server holds as far as this page knows. */
  confirmed: Marks[Mark];
  /** The value shown, which the queue is working towards. */
  desired: Marks[Mark];
  running: boolean;
  quiet: boolean;
  /**
   * The value of a request whose outcome is unknown (lost response, timeout). Its operation key is kept by the
   * controller, and it is sent again, unchanged, before anything else: a submission is never replaced by another.
   */
  uncertain?: { readonly value: Marks[Mark] };
  /** One operation at a time per mark of an item, each with its own operation key. */
  readonly submission: SubmissionController;
}

interface WriterContext {
  readonly api: ApiClient;
  /** Announces a failed save; `retry` asks for the same change again. */
  readonly failed: (
    id: number,
    mark: Mark,
    error: unknown,
    retry: () => void,
  ) => void;
}

/** Saves marks one request at a time per item and mark, coalescing quick clicks; never reloads the list. */
export function createMarkWriter(): MarkWriter & {
  /** Gives the writer the page's latest API client and failure announcement. */
  configure(next: WriterContext): void;
} {
  let current: WriterContext | undefined;
  const context = (): WriterContext => {
    if (!current) throw new Error('The mark writer is not configured.');
    return current;
  };
  const entries = new Map<string, Entry>();
  const shownMarks = new Map<number, Marks>();
  const listeners = new Set<(event: MarkEvent) => void>();
  const idleListeners = new Set<() => void>();
  const keyOf = (id: number, mark: Mark) => `${id}:${mark}`;

  const emit = (event: MarkEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const show = (
    id: number,
    kind: MarkEvent['kind'],
    changes: Partial<Marks>,
    state?: StateChange,
  ): void => {
    const before = shownMarks.get(id);
    if (!before) return;
    const after = { ...before, ...changes };
    shownMarks.set(id, after);
    emit({ id, kind, changes, before, after, state });
  };
  const settle = (entry: Entry): void => {
    if (!entry.uncertain && !entry.running)
      entries.delete(keyOf(entry.id, entry.mark));
    if ([...entries.values()].every((each) => !each.running))
      for (const listener of idleListeners) listener();
  };

  const send = async (entry: Entry, value: Marks[Mark]) => {
    const { api } = context();
    const result = await entry.submission.run(
      { [entry.mark]: value },
      async (key, signal, input) =>
        (
          await api.request<{ data: StateChange }>({
            path: `feedItems/${encodeURIComponent(entry.id)}/state`,
            method: 'PATCH',
            json: input,
            headers: { 'Idempotency-Key': key },
            signal,
          })
        ).data,
    );
    // Undefined only while another attempt holds the controller, which the queue never allows.
    if (!result) throw new Error('The previous change is still being saved.');
    return result;
  };

  const drain = async (entry: Entry): Promise<void> => {
    if (entry.running) return;
    entry.running = true;
    let value = entry.desired;
    try {
      for (;;) {
        const retrying = entry.uncertain;
        value = retrying ? retrying.value : entry.desired;
        if (!retrying && value === entry.confirmed) break;
        const state = await send(entry, value);
        entry.uncertain = undefined;
        entry.confirmed = state[entry.mark];
        const agreed: Partial<Marks> = {};
        for (const mark of MARKS) {
          const other = entries.get(keyOf(entry.id, mark));
          if (!other || other.desired === state[mark])
            Object.assign(agreed, { [mark]: state[mark] });
        }
        show(entry.id, 'confirmed', agreed, state);
      }
    } catch (error) {
      // The outcome of a lost or timed-out request is unknown: its key stays with the controller and is retried first.
      if (entry.submission.getPendingSnapshot()) entry.uncertain = { value };
      const wanted = entry.desired;
      entry.desired = entry.confirmed;
      show(entry.id, 'rollback', { [entry.mark]: entry.confirmed });
      if (!entry.quiet)
        context().failed(entry.id, entry.mark, error, () => {
          const shown = shownMarks.get(entry.id);
          if (shown) writer.set(entry.id, { [entry.mark]: wanted }, shown);
        });
    } finally {
      entry.running = false;
      settle(entry);
    }
  };

  const writer = {
    configure(next: WriterContext) {
      current = next;
    },
    set(
      id: number,
      changes: Partial<Marks>,
      shown: Marks,
      options?: { readonly quiet?: boolean },
    ) {
      // What the caller shows, except marks still being saved, which the queue knows better.
      const display = { ...shown };
      for (const mark of MARKS) {
        const entry = entries.get(keyOf(id, mark));
        if (entry) Object.assign(display, { [mark]: entry.desired });
      }
      shownMarks.set(id, display);
      const started: Entry[] = [];
      for (const mark of MARKS) {
        if (!(mark in changes)) continue;
        const value = changes[mark] as Marks[Mark];
        let entry = entries.get(keyOf(id, mark));
        if (!entry) {
          entry = {
            id,
            mark,
            confirmed: shown[mark],
            desired: shown[mark],
            running: false,
            quiet: Boolean(options?.quiet),
            submission: new SubmissionController(),
          };
          entries.set(keyOf(id, mark), entry);
        } else entry.quiet = Boolean(options?.quiet);
        entry.desired = value;
        started.push(entry);
      }
      show(id, 'optimistic', changes);
      for (const entry of started) void drain(entry);
    },
    subscribe(listener: (event: MarkEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onIdle(listener: () => void) {
      idleListeners.add(listener);
      return () => idleListeners.delete(listener);
    },
  };
  return writer;
}

/**
 * The page's mark writer. A failed save is undone on the screen and announced with a way to try again; a missing item
 * calls `onNotFound`, which reloads the list.
 */
export function useMarkWriter(onNotFound: () => void): MarkWriter {
  const api = useApiClient();
  const toaster = useToaster();
  const { t } = useTranslation();
  const context = (): WriterContext => ({
    api,
    failed: (id, mark, error, retry) => {
      const problem = requestProblem(error);
      toaster.show({
        id: `feed-mark-failed-${id}-${mark}`,
        type: 'error',
        title: t('feed.state.saveFailed'),
        description: t(`feed.errors.${problem}`),
        action:
          problem === 'notFound' || problem === 'sessionExpired'
            ? undefined
            : { label: t('feed.common.retry'), onClick: retry },
      });
      if (problem === 'notFound') onNotFound();
    },
  });
  // The writer lives as long as the page and uses the latest callbacks when it needs them.
  const [writer] = useState(() => {
    const created = createMarkWriter();
    created.configure(context());
    return created;
  });
  useEffect(() => writer.configure(context()));
  return writer;
}

/** Whether an item counts in a view with these marks; undefined when the page cannot tell (Trending's time window). */
function inView(
  view: ListView,
  item: Pick<FeedListItem, 'verdict' | 'quality'>,
  marks: Marks,
): boolean | undefined {
  const recommended =
    (item.verdict === 'discuss' || item.verdict === 'learn') &&
    !marks.dismissed;
  switch (view) {
    case 'saved':
      return marks.favorite;
    case 'later':
      return marks.later;
    case 'participated':
      return marks.participated;
    case 'all':
      return recommended;
    case 'discuss':
    case 'learn':
      return recommended && item.verdict === view;
    case 'solid':
      return recommended && (item.quality ?? 0) >= SOLID_QUALITY;
    default:
      return undefined;
  }
}

/**
 * The view counts after one item's marks changed, so the rail follows a click at once. Only for an item of the list
 * shown, which matches the same filters as the counts; the counts are loaded again quietly once every mark is saved.
 * `unreadOnly`: the counts already count unread items only.
 */
export function countsAfter(
  summary: FeedSummary,
  item: Pick<FeedListItem, 'verdict' | 'quality'>,
  before: Marks,
  after: Marks,
  unreadOnly: boolean,
): FeedSummary {
  const { unread: _unread, ...rest } = summary;
  const counts: Record<string, number> = { ...rest };
  const unread: Record<string, number> = { ...summary.unread };
  const step = (yes: boolean) => (yes ? 1 : 0);
  for (const view of LIST_VIEWS) {
    const was = inView(view, item, before);
    const now = inView(view, item, after);
    if (was === undefined || now === undefined) continue;
    const unreadDelta = step(now && !after.read) - step(was && !before.read);
    unread[view] = Math.max(0, unread[view] + unreadDelta);
    counts[view] = Math.max(
      0,
      counts[view] + (unreadOnly ? unreadDelta : step(now) - step(was)),
    );
  }
  return {
    ...(counts as unknown as FeedSummary),
    unread: unread as FeedSummary['unread'],
  };
}
