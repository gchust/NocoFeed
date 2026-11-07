import { copyText, useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  CheckIcon,
  CopyIcon,
  LightbulbIcon,
  RefreshCwIcon,
  SparklesIcon,
  Trash2Icon,
} from 'lucide-react';
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { Link } from 'react-router';

import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '#components/ui/card';
import { Skeleton } from '#components/ui/skeleton';
import { Spinner } from '#components/ui/spinner';

import { DeleteDialog } from './delete-dialog.js';
import { relativeTime, requestProblem } from './format.js';
import {
  IDEAS_POLL_MS,
  ideaText,
  type BilibiliIdea,
  type Idea,
  type IdeaKind,
  type IdeaSet,
  type IdeasState,
  type MemeIdea,
  type ShortVideoIdea,
  type XIdea,
  type XiaohongshuIdea,
} from './ideas-model.js';

const ERROR_CODES = new Set([
  'noModel',
  'ideasFailed',
  'timeout',
  'thinMaterial',
]);

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className='flex flex-col gap-0.5'>
      <span className='text-xs text-muted-foreground'>{label}</span>
      <div className='text-sm whitespace-pre-line'>{children}</div>
    </div>
  );
}

/** One idea, laid out for its kind. */
function IdeaBody({
  kind,
  idea,
}: {
  readonly kind: IdeaKind;
  readonly idea: Idea;
}): ReactElement {
  const { t } = useTranslation();
  switch (kind) {
    case 'xiaohongshu': {
      const note = idea as XiaohongshuIdea;
      return (
        <div className='flex flex-col gap-2'>
          <p className='font-semibold'>{note.title}</p>
          <p className='text-sm whitespace-pre-line'>{note.body}</p>
          {note.tags.length ? (
            <p className='text-sm text-primary'>
              {note.tags.map((tag) => `#${tag}`).join(' ')}
            </p>
          ) : null}
          {note.cover ? (
            <Field label={t('feed.ideas.cover')}>{note.cover}</Field>
          ) : null}
        </div>
      );
    }
    case 'x': {
      const { posts } = idea as XIdea;
      return (
        <ol className='flex flex-col gap-2'>
          {posts.map((post, index) => (
            <li
              // eslint-disable-next-line @eslint-react/no-array-index-key
              key={index}
              className='rounded-md bg-muted/50 p-2 text-sm whitespace-pre-line'
            >
              {posts.length > 1 ? (
                <span className='me-1 text-xs text-muted-foreground'>
                  {index + 1}/{posts.length}
                </span>
              ) : null}
              {post}
              <span className='ms-2 text-xs text-muted-foreground'>
                {t('feed.ideas.characters', {
                  count: Array.from(post).length,
                })}
              </span>
            </li>
          ))}
        </ol>
      );
    }
    case 'shortVideo': {
      const script = idea as ShortVideoIdea;
      return (
        <div className='flex flex-col gap-2'>
          <p className='font-semibold'>
            {script.title}
            <span className='ms-2 text-xs font-normal text-muted-foreground'>
              {t('feed.ideas.seconds', { count: script.seconds })}
            </span>
          </p>
          <ol className='flex flex-col gap-2'>
            {script.shots.map((shot, index) => (
              <li
                // eslint-disable-next-line @eslint-react/no-array-index-key
                key={index}
                className='flex flex-col gap-1 rounded-md bg-muted/50 p-2'
              >
                <span className='text-xs font-medium text-muted-foreground'>
                  {t('feed.ideas.shot', {
                    number: index + 1,
                    seconds: shot.seconds,
                  })}
                </span>
                <Field label={t('feed.ideas.visual')}>{shot.visual}</Field>
                <Field label={t('feed.ideas.line')}>{shot.line}</Field>
                <Field label={t('feed.ideas.caption')}>{shot.caption}</Field>
              </li>
            ))}
          </ol>
        </div>
      );
    }
    case 'bilibili': {
      const plan = idea as BilibiliIdea;
      return (
        <div className='flex flex-col gap-2'>
          <p className='font-semibold'>{plan.title}</p>
          {plan.description ? (
            <Field label={t('feed.ideas.description')}>
              {plan.description}
            </Field>
          ) : null}
          <Field label={t('feed.ideas.outline')}>
            <ol className='list-decimal ps-5'>
              {plan.outline.map((part, index) => (
                // eslint-disable-next-line @eslint-react/no-array-index-key
                <li key={index}>{part}</li>
              ))}
            </ol>
          </Field>
        </div>
      );
    }
    case 'meme': {
      const meme = idea as MemeIdea;
      return (
        <div className='flex flex-col gap-2'>
          <p className='text-sm font-semibold whitespace-pre-line'>
            {meme.caption}
          </p>
          <Field label={t('feed.ideas.image')}>{meme.image}</Field>
          {meme.trend ? (
            <Field label={t('feed.ideas.trend')}>{meme.trend}</Field>
          ) : null}
        </div>
      );
    }
  }
}

function CopyButton({ text }: { readonly text: string }): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      type='button'
      size='sm'
      variant='ghost'
      onClick={() => {
        void copyText(text).then((done) => {
          if (done) setCopied(true);
          else
            toaster.show({ type: 'error', title: t('feed.ideas.copyFailed') });
        });
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? t('feed.ideas.copied') : t('feed.ideas.copy')}
    </Button>
  );
}

function IdeaSetCard({
  set,
  busy,
  onAgain,
}: {
  readonly set: IdeaSet;
  readonly busy: boolean;
  readonly onAgain: (kind: IdeaKind, index: number) => void;
}): ReactElement {
  const { t } = useTranslation();
  const pending = set.status === 'pending';
  return (
    <Card size='sm' data-testid={`feed-ideas-${set.kind}`}>
      <CardHeader>
        <CardTitle className='text-sm'>
          {t(`feed.ideas.kinds.${set.kind}`)}
        </CardTitle>
        {pending ? (
          <CardAction>
            <span className='flex items-center gap-1 text-xs text-muted-foreground'>
              <Spinner />
              {t('feed.ideas.generating')}
            </span>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className='flex flex-col gap-3'>
        {set.status === 'failed' || set.error ? (
          <p
            className={
              // Not enough content is no failure: nothing went wrong, there is just nothing to work from yet.
              set.error === 'thinMaterial'
                ? 'text-sm text-muted-foreground'
                : 'text-sm text-destructive'
            }
          >
            {t(
              `feed.ideas.errors.${set.error && ERROR_CODES.has(set.error) ? set.error : 'ideasFailed'}`,
            )}
          </p>
        ) : null}
        {pending && !set.ideas.length ? (
          <Skeleton className='h-24 w-full' />
        ) : null}
        {set.ideas.map((idea, index) => (
          <div
            // eslint-disable-next-line @eslint-react/no-array-index-key
            key={index}
            className='flex flex-col gap-2 rounded-lg border p-3'
            data-testid='feed-idea'
          >
            <IdeaBody kind={set.kind} idea={idea} />
            <div className='flex flex-wrap justify-end gap-1'>
              <CopyButton text={ideaText(set.kind, idea, t)} />
              <Button
                type='button'
                size='sm'
                variant='ghost'
                disabled={busy || pending}
                onClick={() => onAgain(set.kind, index)}
              >
                <RefreshCwIcon />
                {t('feed.ideas.again')}
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Ideas on the item detail: posts, scripts, outlines and memes the person could make from the item, in their creative
 * style. Generated in the background on request (or automatically when turned on in Preferences); the card polls until
 * every kind is done.
 */
export function IdeasSection({
  itemId,
}: {
  readonly itemId: number;
}): ReactElement | null {
  const { t, i18n } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const [state, setState] = useState<IdeasState>();
  const [failed, setFailed] = useState(false);
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const path = `feedItems/${encodeURIComponent(itemId)}/ideas`;

  const load = useCallback(
    () =>
      api.request<{ data: IdeasState }>({ path }).then(
        ({ data }) => {
          setState(data);
          setFailed(false);
        },
        () => setFailed(true),
      ),
    [api, path],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const pending = state?.sets.some((set) => set.status === 'pending') ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => void load(), IDEAS_POLL_MS);
    return () => clearTimeout(timer);
  }, [pending, state, load]);

  const send = async (
    request: () => Promise<{ data: IdeasState }>,
  ): Promise<void> => {
    setSending(true);
    try {
      setState((await request()).data);
    } catch (cause: unknown) {
      toaster.show({
        type: 'error',
        title: t(`feed.errors.${requestProblem(cause)}`),
      });
      void load();
    } finally {
      setSending(false);
    }
  };

  const generate = () =>
    send(() =>
      api.request<{ data: IdeasState }>({ path, method: 'POST', json: {} }),
    );
  const again = (kind: IdeaKind, index: number) =>
    send(() =>
      api.request<{ data: IdeasState }>({
        path: `${path}/again`,
        method: 'POST',
        json: { kind, index },
      }),
    );

  const heading = (
    <h3
      id='feed-ideas'
      className='flex items-center gap-1.5 text-sm font-semibold'
    >
      <LightbulbIcon className='size-4' aria-hidden />
      {t('feed.ideas.title')}
    </h3>
  );

  if (failed && !state) return null;
  if (!state)
    return (
      <section aria-labelledby='feed-ideas' className='flex flex-col gap-2'>
        {heading}
        <Skeleton className='h-16 w-full' />
      </section>
    );

  const hasSets = state.sets.length > 0;
  const stale = state.sets.some((set) => set.stale);
  const latest = state.sets
    .map((set) => set.generatedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const searched = state.sets.some((set) => set.webSearch);

  return (
    <section
      aria-labelledby='feed-ideas'
      className='flex flex-col gap-3'
      data-testid='feed-ideas'
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        {heading}
        {hasSets ? (
          <div className='flex gap-1'>
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={sending || pending || !state.available}
              onClick={() => void generate()}
            >
              <RefreshCwIcon />
              {t('feed.ideas.regenerate')}
            </Button>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              disabled={sending || pending}
              onClick={() => setDeleting(true)}
            >
              <Trash2Icon />
              {t('feed.ideas.delete')}
            </Button>
          </div>
        ) : null}
      </div>
      {!state.available && !hasSets ? (
        <Alert>
          <AlertTitle>{t('feed.ideas.unavailable.title')}</AlertTitle>
          <AlertDescription className='flex flex-col gap-1'>
            <span>{t('feed.ideas.unavailable.description')}</span>
            <Link
              to='/settings/models'
              className='text-primary hover:underline'
            >
              {t('feed.ideas.unavailable.models')}
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
      {state.available && !hasSets ? (
        <div className='flex flex-col items-start gap-2'>
          <p className='text-sm text-muted-foreground'>
            {t('feed.ideas.hint')}
          </p>
          <Button
            type='button'
            size='sm'
            disabled={sending}
            onClick={() => void generate()}
          >
            {sending ? <Spinner /> : <SparklesIcon />}
            {t('feed.ideas.generate')}
          </Button>
        </div>
      ) : null}
      {state.available ? (
        <p className='text-xs text-muted-foreground'>
          {state.webSearch
            ? t('feed.ideas.webSearch')
            : t('feed.ideas.noWebSearch')}
        </p>
      ) : null}
      {hasSets ? (
        <>
          {latest || stale ? (
            <p className='text-xs text-muted-foreground'>
              {latest
                ? t(
                    searched
                      ? 'feed.ideas.generatedSearched'
                      : 'feed.ideas.generated',
                    { time: relativeTime(latest, i18n.language) },
                  )
                : null}
              {stale ? ` ${t('feed.ideas.stale')}` : null}
            </p>
          ) : null}
          {state.sets.map((set) => (
            <IdeaSetCard
              key={set.kind}
              set={set}
              busy={sending}
              onAgain={(kind, index) => void again(kind, index)}
            />
          ))}
        </>
      ) : null}
      <DeleteDialog
        open={deleting}
        onOpenChange={setDeleting}
        target={{ name: String(itemId), path }}
        title={t('feed.ideas.deleteTitle')}
        description={t('feed.ideas.deleteDescription')}
        successTitle={t('feed.ideas.deleted')}
        onDeleted={() => {
          setDeleting(false);
          void load();
        }}
      />
    </section>
  );
}
