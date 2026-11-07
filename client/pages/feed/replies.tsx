import { copyText, useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  CopyIcon,
  ImageIcon,
  MessageSquareQuoteIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

import { StatusBadge } from '#components/status-badge';
import { Button } from '#components/ui/button';
import { Skeleton } from '#components/ui/skeleton';
import { Spinner } from '#components/ui/spinner';

import { requestProblem } from './format.js';
import { SteerApplied, SteerPanel } from './steer.js';
import { rememberedSteer, rememberSteer, type Steer } from './steer-model.js';

/** One reply the person can copy (`server/providers/feed/replies.ts`). */
export interface ReplyDraft {
  /** In the post's own language, never the reading language. */
  readonly text: string;
  readonly tone: string;
  readonly emoji: string;
  /** A picture or meme idea, in words; empty when none. */
  readonly image: string;
}

/** `GET /feedItems/:id/replies`. */
export interface ReplyState {
  readonly status: 'none' | 'pending' | 'ready' | 'failed';
  readonly drafts: readonly ReplyDraft[];
  readonly language: string | null;
  readonly trigger: 'auto' | 'asked' | null;
  readonly guidelinesVersion: string | null;
  readonly currentGuidelinesVersion: string;
  readonly guidelinesChanged: boolean;
  readonly stale: boolean;
  readonly available: boolean;
  readonly model: string | null;
  readonly updatedAt: string | null;
  /** What the person asked for when these drafts were written; null when nothing. */
  readonly steer: Steer | null;
}

const POLL_MS = 2_000;

function languageName(tag: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/**
 * "Join the discussion": replies to copy, written in the post's language and the platform's style under the person's
 * own rules (Preferences). Discussions get them without being asked; any item gets them on "Write replies". Writing
 * runs in the background and this section polls until it ends. Copying never marks the item joined; the toast offers it.
 * "New batch" first opens the steer panel (issue #20): directions and a note for this batch, or a batch without them.
 */
export function ReplyDrafts({
  itemId,
  worthJoining,
  participated,
  onMarkJoined,
}: {
  readonly itemId: number;
  /** A discussion, or an item the person already joined: drafts are shown up front. */
  readonly worthJoining: boolean;
  readonly participated: boolean;
  readonly onMarkJoined: () => void;
}): ReactElement | null {
  const { t, i18n } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const [state, setState] = useState<ReplyState>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [poll, setPoll] = useState(0);
  const [steering, setSteering] = useState(false);
  const participatedRef = useRef(participated);
  useEffect(() => {
    participatedRef.current = participated;
  });

  useEffect(() => {
    const controller = new AbortController();
    api
      .request<{ data: ReplyState }>({
        path: `feedItems/${encodeURIComponent(itemId)}/replies`,
        signal: controller.signal,
      })
      .then(
        ({ data }) => {
          if (!controller.signal.aborted) {
            setState(data);
            setLoadFailed(false);
          }
        },
        () => {
          if (!controller.signal.aborted) setLoadFailed(true);
        },
      );
    return () => controller.abort();
  }, [api, itemId, poll]);

  const pending = state?.status === 'pending';
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPoll((count) => count + 1), POLL_MS);
    return () => clearTimeout(timer);
  }, [pending, state]);

  const write = async (steer?: Steer): Promise<void> => {
    setRequesting(true);
    setSteering(false);
    if (steer) rememberSteer('replies', steer);
    try {
      const { data } = await api.request<{ data: ReplyState }>({
        path: `feedItems/${encodeURIComponent(itemId)}/replies`,
        method: 'POST',
        json: steer ? { angles: steer.angles, note: steer.note } : {},
      });
      setState(data);
    } catch (error: unknown) {
      const problem = requestProblem(error);
      toaster.show({
        type: 'error',
        title:
          problem === 'unavailable'
            ? t('feed.replies.noModel')
            : t(`feed.errors.${problem}`),
      });
    } finally {
      setRequesting(false);
    }
  };

  const copy = async (draft: ReplyDraft): Promise<void> => {
    if (!(await copyText(draft.text))) {
      toaster.show({ type: 'error', title: t('feed.replies.copyFailed') });
      return;
    }
    toaster.show({
      id: `feed-reply-copied-${itemId}`,
      type: 'success',
      title: t('feed.replies.copied'),
      description: participatedRef.current
        ? undefined
        : t('feed.replies.copiedHint'),
      action: participatedRef.current
        ? undefined
        : { label: t('feed.replies.markJoined'), onClick: onMarkJoined },
    });
  };

  if (loadFailed && !state) return null;
  if (!state) return worthJoining ? <Skeleton className='h-24' /> : null;

  const drafts = state.drafts;
  const busy = requesting || pending;
  // An item that is not a discussion shows only the button until the person asks.
  if (!worthJoining && state.status === 'none' && !state.available) return null;

  return (
    <section
      aria-labelledby='feed-replies'
      aria-busy={pending}
      className='flex flex-col gap-3 rounded-lg border p-3'
    >
      <div className='flex flex-wrap items-center gap-2'>
        <MessageSquareQuoteIcon
          className='size-4 text-muted-foreground'
          aria-hidden='true'
        />
        <h3 id='feed-replies' className='text-sm font-semibold'>
          {t('feed.replies.title')}
        </h3>
        {state.language && drafts.length ? (
          <StatusBadge>
            {t('feed.replies.language', {
              language: languageName(state.language, i18n.language),
            })}
          </StatusBadge>
        ) : null}
        {state.available ? (
          <Button
            type='button'
            size='xs'
            variant='outline'
            className='ml-auto'
            disabled={busy}
            aria-expanded={drafts.length ? steering : undefined}
            onClick={() =>
              // The first drafts are written at once; another batch asks what should change first.
              drafts.length ? setSteering((open) => !open) : void write()
            }
          >
            {busy ? (
              <Spinner data-icon='inline-start' />
            ) : (
              <RefreshCwIcon data-icon='inline-start' />
            )}
            {drafts.length ? t('feed.replies.again') : t('feed.replies.write')}
          </Button>
        ) : null}
      </div>

      {steering && !busy ? (
        <SteerPanel
          kind='replies'
          initial={state.steer ?? rememberedSteer('replies')}
          title={t('feed.steer.title.replies')}
          submitLabel={t('feed.steer.submit.replies')}
          plainLabel={t('feed.steer.plain.replies')}
          onSubmit={(steer) => void write(steer)}
          onPlain={() => void write()}
          onCancel={() => setSteering(false)}
        />
      ) : null}
      {pending ? (
        <p role='status' className='text-xs text-muted-foreground'>
          {t('feed.replies.writing')}
        </p>
      ) : null}
      {state.status === 'failed' && !pending ? (
        <p role='alert' className='text-xs text-(--status-warning)'>
          {t('feed.replies.failed')}
        </p>
      ) : null}
      {!state.available && !drafts.length ? (
        <p className='text-xs text-muted-foreground'>
          {t('feed.replies.noModel')}
        </p>
      ) : null}
      {state.status === 'none' && state.available && !pending ? (
        <p className='text-xs text-muted-foreground'>
          {worthJoining
            ? t('feed.replies.noneDiscussion')
            : t('feed.replies.noneOther')}
        </p>
      ) : null}
      {drafts.length && (state.guidelinesChanged || state.stale) ? (
        <p className='text-xs text-muted-foreground'>
          {state.guidelinesChanged
            ? t('feed.replies.guidelinesChanged')
            : t('feed.replies.stale')}
        </p>
      ) : null}

      {drafts.length && !pending ? (
        <SteerApplied kind='replies' steer={state.steer} />
      ) : null}
      {drafts.length ? (
        <ol className='flex flex-col gap-2'>
          {drafts.map((draft, index) => (
            <li
              // Drafts have no id; they are replaced as a whole.
              // eslint-disable-next-line @eslint-react/no-array-index-key
              key={index}
              className='flex flex-col gap-2 rounded-md bg-muted/50 p-3'
            >
              <div className='flex items-center gap-2'>
                {draft.tone ? (
                  <span className='text-xs font-medium text-muted-foreground'>
                    {draft.tone}
                  </span>
                ) : null}
                <Button
                  type='button'
                  size='xs'
                  variant='ghost'
                  className='ml-auto'
                  aria-label={t('feed.replies.copyNumber', {
                    number: index + 1,
                  })}
                  onClick={() => void copy(draft)}
                >
                  <CopyIcon data-icon='inline-start' />
                  {t('feed.replies.copy')}
                </Button>
              </div>
              <p
                lang={state.language ?? undefined}
                className='text-sm leading-6 break-words whitespace-pre-wrap text-foreground'
              >
                {draft.text}
              </p>
              {draft.emoji ? (
                <p className='text-xs text-muted-foreground'>
                  {t('feed.replies.emoji', { emoji: draft.emoji })}
                </p>
              ) : null}
              {draft.image ? (
                <p className='flex items-start gap-1.5 text-xs text-muted-foreground'>
                  <ImageIcon
                    className='mt-0.5 size-3.5 shrink-0'
                    aria-hidden='true'
                  />
                  <span>{t('feed.replies.image', { idea: draft.image })}</span>
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      <p className='text-xs text-muted-foreground'>
        {t('feed.replies.rulesHint')}{' '}
        <Link to='/preferences' className='text-primary hover:underline'>
          {t('feed.replies.editRules')}
        </Link>
      </p>
    </section>
  );
}
