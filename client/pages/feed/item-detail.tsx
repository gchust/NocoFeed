import { useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  AlertTriangleIcon,
  BookmarkIcon,
  CheckCheckIcon,
  ClockIcon,
  EyeOffIcon,
  ExternalLinkIcon,
  MessageCircleReplyIcon,
  RotateCwIcon,
  SparklesIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  XIcon,
} from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect, useState } from 'react';

import { SessionExpiredAlert } from '#components/session-expired-alert';
import { StatusBadge } from '#components/status-badge';
import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import { Input } from '#components/ui/input';
import { Label } from '#components/ui/label';
import { Separator } from '#components/ui/separator';
import { Skeleton } from '#components/ui/skeleton';
import { Spinner } from '#components/ui/spinner';
import { Textarea } from '#components/ui/textarea';
import { cn } from 'cn';

import {
  absoluteTime,
  noteText,
  relativeTime,
  requestProblem,
} from './format.js';
import { LoadProblem, PlatformBadge, VerdictBadge } from './parts.js';
import type {
  FeedItem,
  ItemState,
  PartCoverage,
  StateChange,
} from './types.js';

export interface ItemDetailProps {
  readonly itemId: number;
  readonly topicNames: ReadonlyMap<number, string>;
  readonly onClose: () => void;
  /** The person's own marks changed; the list card shows them at once. */
  readonly onStateChange: (id: number, state: ItemState) => void;
  /** The analysis or the counts changed; the list reloads. */
  readonly onChanged: () => void;
}

type Busy =
  | 'analyze'
  | 'enrich'
  | 'favorite'
  | 'later'
  | 'participated'
  | 'dismissed'
  | 'feedback';

/** One item: what the agent concluded, on which material, and the person's own record of it. */
export function ItemDetail({
  itemId,
  topicNames,
  onClose,
  onStateChange,
  onChanged,
}: ItemDetailProps): ReactElement {
  const { t, i18n } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const [reloadCount, setReloadCount] = useState(0);
  const [result, setResult] = useState<{
    readonly key: number;
    readonly item?: FeedItem;
    readonly error?: unknown;
  }>();
  const [busy, setBusy] = useState<Busy>();

  useEffect(() => {
    const controller = new AbortController();
    api
      .request<{ data: FeedItem }>({
        path: `feedItems/${encodeURIComponent(itemId)}`,
        signal: controller.signal,
      })
      .then(
        ({ data }) => {
          if (!controller.signal.aborted)
            setResult({ key: reloadCount, item: data });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setResult({ key: reloadCount, error });
        },
      );
    return () => controller.abort();
  }, [api, itemId, reloadCount]);

  const loading = result?.key !== reloadCount;
  const item = result?.item;
  const error = loading ? undefined : result?.error;

  const replace = (next: FeedItem): void =>
    setResult({ key: reloadCount, item: next });

  const failed = (cause: unknown): void => {
    const problem = requestProblem(cause);
    toaster.show({
      type: 'error',
      title: t(`feed.errors.${problem}`),
      action:
        problem === 'notFound'
          ? undefined
          : {
              label: t('feed.common.retry'),
              onClick: () => setReloadCount((count) => count + 1),
            },
    });
    if (problem === 'notFound') onChanged();
  };

  const patchState = async (
    changes: Partial<ItemState>,
    action: Busy,
  ): Promise<boolean> => {
    if (!item) return false;
    setBusy(action);
    try {
      const { data } = await api.request<{ data: StateChange }>({
        path: `feedItems/${encodeURIComponent(item.id)}/state`,
        method: 'PATCH',
        json: changes,
      });
      const { adjustment, ...state } = data;
      replace({ ...item, ...state, state });
      onStateChange(item.id, state);
      onChanged();
      if (adjustment) {
        toaster.show({
          id: `feed-adjust-${item.id}`,
          type: 'success',
          title:
            adjustment.direction === 'down'
              ? t('feed.feedback.adjustedDown')
              : t('feed.feedback.adjustedUp'),
          description: t('feed.feedback.adjustedDetail', {
            terms: adjustment.terms.slice(0, 6).join(', '),
            count: adjustment.rescored,
          }),
        });
      }
      return true;
    } catch (cause: unknown) {
      failed(cause);
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const analyze = async (): Promise<void> => {
    if (!item) return;
    setBusy('analyze');
    try {
      const { data } = await api.request<{ data: FeedItem }>({
        path: `feedItems/${encodeURIComponent(item.id)}/analyze`,
        method: 'POST',
      });
      replace(data);
      onChanged();
      toaster.show({ type: 'success', title: t('feed.detail.analyzed') });
    } catch (cause: unknown) {
      failed(cause);
    } finally {
      setBusy(undefined);
    }
  };

  const enrich = async (): Promise<void> => {
    if (!item) return;
    const wanted = item.enrichable;
    const parts = wanted
      .map((part) => t(`feed.parts.${part}`))
      .join(t('feed.common.listSeparator'));
    setBusy('enrich');
    try {
      const { data } = await api.request<{ data: FeedItem }>({
        path: `feedItems/${encodeURIComponent(item.id)}/enrich`,
        method: 'POST',
      });
      replace(data);
      onChanged();
      const obtained = wanted.some((part) => {
        const status = data.coverage[part]?.status;
        return status === 'available' || status === 'partial';
      });
      toaster.show(
        obtained
          ? { type: 'success', title: t('feed.detail.enriched', { parts }) }
          : { type: 'warning', title: t('feed.detail.enrichEmpty', { parts }) },
      );
    } catch (cause: unknown) {
      // 503: the platform refused or the Collector is missing; the stored coverage says which after a reload.
      if (requestProblem(cause) === 'unavailable') {
        toaster.show({
          type: 'warning',
          title: t('feed.detail.enrichFailed', { parts }),
        });
        setReloadCount((count) => count + 1);
      } else failed(cause);
    } finally {
      setBusy(undefined);
    }
  };

  const close = (
    <Button
      type='button'
      variant='ghost'
      size='icon-sm'
      onClick={onClose}
      aria-label={t('feed.detail.close')}
    >
      <XIcon />
    </Button>
  );

  if (error)
    return (
      <div className='flex flex-col gap-3 p-5'>
        <div className='flex justify-end'>{close}</div>
        <LoadProblem
          error={error}
          onRetry={() => setReloadCount((count) => count + 1)}
        />
      </div>
    );
  if (!item)
    return (
      <div
        className='flex flex-col gap-3 p-5'
        role='status'
        aria-label={t('feed.loading')}
      >
        <Skeleton className='h-4 w-1/3' />
        <Skeleton className='h-6 w-full' />
        <Skeleton className='h-24 w-full' />
        <Skeleton className='h-40 w-full' />
      </div>
    );

  const analysis = item.analysis;
  const topicName = analysis?.topicId
    ? topicNames.get(analysis.topicId)
    : undefined;
  const parts: [string, PartCoverage | undefined][] = [
    ['body', item.coverage.body],
    ['comments', item.coverage.comments],
    ['transcript', item.coverage.transcript],
    ['media', item.coverage.media],
  ];

  return (
    <article className='flex flex-col gap-5 p-5' aria-busy={loading}>
      <header className='flex flex-col gap-3'>
        <div className='flex items-start gap-2'>
          <div className='flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs text-muted-foreground'>
            <PlatformBadge platform={item.platform} />
            <span className='truncate'>{item.sourceLabel ?? '—'}</span>
            {item.author ? <span>· {item.author}</span> : null}
            <span>·</span>
            <time
              dateTime={item.publishedAt ?? item.createdAt}
              title={absoluteTime(
                item.publishedAt ?? item.createdAt,
                i18n.language,
              )}
            >
              {relativeTime(item.publishedAt ?? item.createdAt, i18n.language)}
            </time>
          </div>
          {close}
        </div>
        <h2 className='text-lg leading-snug font-semibold'>{item.title}</h2>
        <div className='flex flex-wrap gap-2'>
          {item.url ? (
            <a
              href={item.url}
              target='_blank'
              rel='noreferrer noopener'
              className='inline-flex items-center gap-1 text-sm text-primary hover:underline'
            >
              {t('feed.detail.openOriginal')}
              <ExternalLinkIcon className='size-3.5' />
            </a>
          ) : null}
          <Metrics metrics={item.metrics} />
        </div>
        <div className='flex flex-wrap gap-2'>
          <ToggleButton
            pressed={item.state.favorite}
            busy={busy === 'favorite'}
            disabled={Boolean(busy)}
            icon={
              <BookmarkIcon
                className={cn(item.state.favorite && 'fill-current')}
              />
            }
            label={t('feed.state.favorite')}
            onClick={() =>
              void patchState({ favorite: !item.state.favorite }, 'favorite')
            }
          />
          <ToggleButton
            pressed={item.state.later}
            busy={busy === 'later'}
            disabled={Boolean(busy)}
            icon={<ClockIcon />}
            label={t('feed.state.later')}
            onClick={() =>
              void patchState({ later: !item.state.later }, 'later')
            }
          />
          <ToggleButton
            pressed={item.state.participated}
            busy={busy === 'participated'}
            disabled={Boolean(busy)}
            icon={<CheckCheckIcon />}
            label={t('feed.state.participated')}
            onClick={() =>
              void patchState(
                { participated: !item.state.participated },
                'participated',
              )
            }
          />
          <ToggleButton
            pressed={item.state.dismissed}
            busy={busy === 'dismissed'}
            disabled={Boolean(busy)}
            icon={<EyeOffIcon />}
            label={t('feed.state.dismissed')}
            onClick={() =>
              void patchState({ dismissed: !item.state.dismissed }, 'dismissed')
            }
          />
        </div>
      </header>

      <Separator />

      <section aria-labelledby='feed-analysis' className='flex flex-col gap-3'>
        <div className='flex flex-wrap items-center gap-2'>
          <h3 id='feed-analysis' className='text-sm font-semibold'>
            {t('feed.detail.analysis')}
          </h3>
          <VerdictBadge verdict={analysis?.verdict ?? null} />
          {analysis ? (
            <span className='text-xs text-muted-foreground tabular-nums'>
              {t('feed.scoreValue', { score: Math.round(analysis.score) })}
            </span>
          ) : null}
          {topicName ? (
            <span className='text-xs text-muted-foreground'>#{topicName}</span>
          ) : null}
          <Button
            type='button'
            size='xs'
            variant='outline'
            className='ml-auto'
            disabled={Boolean(busy)}
            onClick={() => void analyze()}
          >
            {busy === 'analyze' ? (
              <Spinner data-icon='inline-start' />
            ) : (
              <RotateCwIcon data-icon='inline-start' />
            )}
            {t('feed.detail.reanalyze')}
          </Button>
        </div>
        {item.analysisStale ? (
          <Alert>
            <AlertTriangleIcon />
            <AlertDescription>{t('feed.detail.stale')}</AlertDescription>
          </Alert>
        ) : null}
        {analysis ? (
          <>
            {analysis.lead ? (
              <div className='rounded-lg border border-primary/20 bg-primary/5 p-3'>
                <p className='mb-1 flex items-center gap-1 text-xs font-medium text-primary'>
                  <SparklesIcon className='size-3.5' />
                  {t(`feed.detail.lead.${analysis.verdict}`)}
                </p>
                <p className='text-sm leading-6'>{analysis.lead}</p>
              </div>
            ) : null}
            <dl className='grid gap-3 text-sm sm:grid-cols-2'>
              <Fact
                label={t('feed.detail.interest')}
                value={t(`feed.levels.${analysis.interestLevel}`, {
                  defaultValue: analysis.interestLevel,
                })}
                detail={analysis.interestReason}
              />
              <Fact
                label={t('feed.detail.experience')}
                value={t(`feed.levels.${analysis.experienceLevel}`, {
                  defaultValue: analysis.experienceLevel,
                })}
                detail={analysis.experienceReason}
              />
            </dl>
            {analysis.steps.length > 0 ? (
              <div className='flex flex-col gap-2'>
                <h4 className='text-xs font-medium text-muted-foreground'>
                  {t('feed.detail.steps')}
                </h4>
                <ol className='flex flex-col gap-2'>
                  {/* Steps and comments have no ids and never reorder, so their position is their identity. */}
                  {analysis.steps.map((step, index) => (
                    // eslint-disable-next-line @eslint-react/no-array-index-key
                    <li key={index} className='flex gap-3 text-sm'>
                      <span className='flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs tabular-nums'>
                        {index + 1}
                      </span>
                      <span>
                        <span className='font-medium'>{step.title}</span>
                        {step.detail ? (
                          <span className='block text-muted-foreground'>
                            {step.detail}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            {analysis.evidence ? (
              <TextBlock label={t('feed.detail.evidence')}>
                {analysis.evidence}
              </TextBlock>
            ) : null}
            {analysis.uncertainty ? (
              <TextBlock label={t('feed.detail.uncertainty')}>
                {analysis.uncertainty}
              </TextBlock>
            ) : null}
            <p className='text-xs text-muted-foreground'>
              {analysis.engine === 'model'
                ? t('feed.detail.byModel', { model: analysis.model ?? '—' })
                : t('feed.detail.byRules')}
              {' · '}
              {relativeTime(analysis.createdAt, i18n.language)}
            </p>
            <FeedbackButtons
              value={item.state.feedback}
              busy={busy === 'feedback'}
              disabled={Boolean(busy)}
              onChange={(feedback) => void patchState({ feedback }, 'feedback')}
            />
          </>
        ) : (
          <p className='text-sm text-muted-foreground'>
            {t('feed.detail.noAnalysis')}
          </p>
        )}
      </section>

      <Separator />

      <section aria-labelledby='feed-coverage' className='flex flex-col gap-3'>
        <div className='flex items-center gap-2'>
          <h3 id='feed-coverage' className='text-sm font-semibold'>
            {t('feed.detail.coverage')}
          </h3>
          {item.enrichable.length > 0 ? (
            <Button
              type='button'
              size='xs'
              variant='outline'
              className='ml-auto'
              disabled={Boolean(busy)}
              onClick={() => void enrich()}
            >
              {busy === 'enrich' ? <Spinner data-icon='inline-start' /> : null}
              {t('feed.detail.fetch', {
                parts: item.enrichable
                  .map((part) => t(`feed.parts.${part}`))
                  .join(t('feed.common.listSeparator')),
              })}
            </Button>
          ) : null}
        </div>
        <p className='text-xs text-muted-foreground'>
          {t('feed.detail.coverageHint')}
        </p>
        <ul className='flex flex-col gap-2'>
          {parts.map(([part, coverage]) =>
            coverage ? (
              <li
                key={part}
                className='flex flex-wrap items-center gap-2 text-sm'
              >
                <span className='w-20 shrink-0 text-muted-foreground'>
                  {t(`feed.parts.${part}`)}
                </span>
                <StatusBadge size='sm' tone={coverageTone(coverage.status)}>
                  {t(`feed.coverage.${coverage.status}`, {
                    defaultValue: coverage.status,
                  })}
                </StatusBadge>
                <span className='min-w-0 flex-1 text-xs text-muted-foreground'>
                  {noteText(t, coverage.note)}
                </span>
              </li>
            ) : null,
          )}
        </ul>
      </section>

      {item.body || item.summary ? (
        <>
          <Separator />
          <TextBlock label={t('feed.parts.body')} collapsible>
            {item.body || item.summary}
          </TextBlock>
        </>
      ) : null}

      {item.comments.length > 0 ? (
        <section
          aria-labelledby='feed-comments'
          className='flex flex-col gap-2'
        >
          <h3 id='feed-comments' className='text-sm font-semibold'>
            {t('feed.detail.comments', { count: item.comments.length })}
          </h3>
          <ul className='flex flex-col gap-2'>
            {item.comments.slice(0, 20).map((comment, index) => (
              <li
                // eslint-disable-next-line @eslint-react/no-array-index-key
                key={index}
                className='rounded-lg bg-muted/50 p-3 text-sm'
                style={{
                  marginInlineStart: `${Math.min(comment.depth ?? 0, 3)}rem`,
                }}
              >
                {comment.author ? (
                  <p className='mb-1 text-xs text-muted-foreground'>
                    {comment.author}
                  </p>
                ) : null}
                <p className='line-clamp-6 whitespace-pre-line'>
                  {comment.text}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {item.transcript.length > 0 ? (
        <TextBlock label={t('feed.parts.transcript')} collapsible>
          {item.transcript.map((segment) => segment.text).join('\n')}
        </TextBlock>
      ) : null}

      <Separator />

      <PersonalRecord
        key={`${item.id}:${item.state.notes ?? ''}:${item.state.participationUrl ?? ''}`}
        item={item}
        onSaved={(state) => {
          replace({ ...item, state });
          onStateChange(item.id, state);
        }}
      />
    </article>
  );
}

function coverageTone(status: string): 'neutral' | 'success' | 'warning' {
  if (status === 'available') return 'success';
  if (status === 'partial' || status === 'failed' || status === 'unavailable')
    return 'warning';
  return 'neutral';
}

function Metrics({
  metrics,
}: {
  readonly metrics: Readonly<Record<string, number>>;
}): ReactElement | null {
  const { t, i18n } = useTranslation();
  const entries = Object.entries(metrics);
  if (entries.length === 0) return null;
  const format = new Intl.NumberFormat(i18n.language, { notation: 'compact' });
  return (
    <span className='flex flex-wrap gap-3 text-xs text-muted-foreground'>
      {entries.map(([name, value]) => (
        <span key={name}>
          {t(`feed.metrics.${name}`, { defaultValue: name })}{' '}
          {format.format(value)}
        </span>
      ))}
    </span>
  );
}

function ToggleButton({
  pressed,
  busy,
  disabled,
  icon,
  label,
  onClick,
}: {
  readonly pressed: boolean;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
}): ReactElement {
  return (
    <Button
      type='button'
      size='sm'
      variant='outline'
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className='aria-pressed:border-primary/40 aria-pressed:bg-primary/10 aria-pressed:text-primary'
    >
      {busy ? <Spinner data-icon='inline-start' /> : icon}
      {label}
    </Button>
  );
}

function FeedbackButtons({
  value,
  busy,
  disabled,
  onChange,
}: {
  readonly value: ItemState['feedback'];
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: ItemState['feedback']) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
      <span>{t('feed.detail.feedbackQuestion')}</span>
      <Button
        type='button'
        size='xs'
        variant='ghost'
        aria-pressed={value === 'helpful'}
        disabled={disabled}
        onClick={() => onChange(value === 'helpful' ? null : 'helpful')}
        className='aria-pressed:bg-primary/10 aria-pressed:text-primary'
      >
        <ThumbsUpIcon data-icon='inline-start' />
        {t('feed.feedback.helpful')}
      </Button>
      <Button
        type='button'
        size='xs'
        variant='ghost'
        aria-pressed={value === 'irrelevant'}
        disabled={disabled}
        onClick={() => onChange(value === 'irrelevant' ? null : 'irrelevant')}
        className='aria-pressed:bg-muted aria-pressed:text-foreground'
      >
        <ThumbsDownIcon data-icon='inline-start' />
        {t('feed.feedback.irrelevant')}
      </Button>
      {busy ? <Spinner /> : null}
    </div>
  );
}

function Fact({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string | null;
}): ReactElement {
  return (
    <div className='rounded-lg border p-3'>
      <dt className='text-xs text-muted-foreground'>{label}</dt>
      <dd className='mt-1 font-medium'>{value}</dd>
      {detail ? (
        <dd className='mt-1 text-xs leading-5 text-muted-foreground'>
          {detail}
        </dd>
      ) : null}
    </div>
  );
}

function TextBlock({
  label,
  children,
  collapsible = false,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly collapsible?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return (
    <section className='flex flex-col gap-1.5'>
      <h3 className='text-xs font-medium text-muted-foreground'>{label}</h3>
      <p
        className={cn(
          'text-sm leading-6 whitespace-pre-line',
          collapsible && !expanded && 'line-clamp-8',
        )}
      >
        {children}
      </p>
      {collapsible ? (
        <Button
          type='button'
          size='xs'
          variant='link'
          className='self-start px-0'
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t('feed.detail.showLess') : t('feed.detail.showMore')}
        </Button>
      ) : null}
    </section>
  );
}

/** Notes and the participation record, saved together; the analysis never changes them. */
function PersonalRecord({
  item,
  onSaved,
}: {
  readonly item: FeedItem;
  readonly onSaved: (state: ItemState) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const [notes, setNotes] = useState(item.state.notes ?? '');
  const [url, setUrl] = useState(item.state.participationUrl ?? '');
  const [note, setNote] = useState(item.state.participationNote ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const urlInvalid = url.trim() !== '' && !/^https?:\/\//i.test(url.trim());
  const dirty =
    notes !== (item.state.notes ?? '') ||
    url !== (item.state.participationUrl ?? '') ||
    note !== (item.state.participationNote ?? '');

  const save = async (): Promise<void> => {
    if (urlInvalid || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const { data } = await api.request<{ data: ItemState }>({
        path: `feedItems/${encodeURIComponent(item.id)}/state`,
        method: 'PATCH',
        json: {
          notes: notes.trim() || null,
          participationUrl: url.trim() || null,
          participationNote: note.trim() || null,
        },
      });
      toaster.show({ type: 'success', title: t('feed.record.saved') });
      onSaved(data);
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  };

  const problem = error ? requestProblem(error) : undefined;

  return (
    <section aria-labelledby='feed-record' className='flex flex-col gap-3'>
      <h3 id='feed-record' className='text-sm font-semibold'>
        {t('feed.record.title')}
      </h3>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor={`feed-notes-${item.id}`}>
          {t('feed.record.notes')}
        </Label>
        <Textarea
          id={`feed-notes-${item.id}`}
          value={notes}
          maxLength={20_000}
          rows={3}
          placeholder={t('feed.record.notesPlaceholder')}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor={`feed-url-${item.id}`}>
          {t('feed.record.participationUrl')}
        </Label>
        <Input
          id={`feed-url-${item.id}`}
          type='url'
          value={url}
          maxLength={1_000}
          placeholder='https://'
          aria-invalid={urlInvalid}
          aria-describedby={
            urlInvalid ? `feed-url-error-${item.id}` : undefined
          }
          onChange={(event) => setUrl(event.target.value)}
        />
        {urlInvalid ? (
          <p
            id={`feed-url-error-${item.id}`}
            className='text-xs text-destructive'
          >
            {t('feed.record.urlInvalid')}
          </p>
        ) : null}
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor={`feed-pnote-${item.id}`}>
          {t('feed.record.participationNote')}
        </Label>
        <Textarea
          id={`feed-pnote-${item.id}`}
          value={note}
          maxLength={5_000}
          rows={2}
          placeholder={t('feed.record.participationNotePlaceholder')}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      {item.state.followUp ? (
        <FollowUpStatus item={item} onSaved={onSaved} />
      ) : item.state.participationUrl ? (
        <p className='text-xs text-muted-foreground'>
          {t('feed.followUp.unsupported')}
        </p>
      ) : (
        <p className='text-xs text-muted-foreground'>
          {t('feed.followUp.hint')}
        </p>
      )}
      {problem === 'sessionExpired' ? (
        <SessionExpiredAlert />
      ) : problem ? (
        <p role='alert' className='text-sm text-destructive'>
          {t(`feed.errors.${problem}`)}
        </p>
      ) : null}
      <Button
        type='button'
        className='self-end'
        disabled={!dirty || urlInvalid || saving}
        onClick={() => void save()}
      >
        {saving ? <Spinner data-icon='inline-start' /> : null}
        {saving ? t('feed.common.saving') : t('feed.record.save')}
      </Button>
    </section>
  );
}

/** The reply tracking of the thread the person posted in, with a way to mark new replies as seen. */
function FollowUpStatus({
  item,
  onSaved,
}: {
  readonly item: FeedItem;
  readonly onSaved: (state: ItemState) => void;
}): ReactElement | null {
  const { t, i18n } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const [saving, setSaving] = useState(false);
  const followUp = item.state.followUp;
  if (!followUp) return null;

  const markSeen = async (): Promise<void> => {
    setSaving(true);
    try {
      const { data } = await api.request<{ data: StateChange }>({
        path: `feedItems/${encodeURIComponent(item.id)}/state`,
        method: 'PATCH',
        json: { followUpSeen: true },
      });
      onSaved(data);
    } catch (cause: unknown) {
      toaster.show({
        type: 'error',
        title: t(`feed.errors.${requestProblem(cause)}`),
      });
    } finally {
      setSaving(false);
    }
  };

  const status =
    followUp.replies == null
      ? t('feed.followUp.pending')
      : t('feed.followUp.replies', { count: followUp.replies });
  const when = followUp.checkedAt
    ? t('feed.followUp.checked', {
        time: relativeTime(followUp.checkedAt, i18n.language),
      })
    : null;

  return (
    <Alert
      className={cn(
        followUp.newReplies > 0 && 'border-primary/50 bg-primary/5',
      )}
    >
      <MessageCircleReplyIcon />
      <AlertDescription className='flex flex-col gap-2'>
        <span>
          {followUp.newReplies > 0 ? (
            <strong className='text-foreground'>
              {t('feed.followUp.newReplies', { count: followUp.newReplies })}
            </strong>
          ) : null}{' '}
          {status}
          {when ? ` · ${when}` : ''}
          {followUp.nextCheckAt ? '' : ` · ${t('feed.followUp.ended')}`}
        </span>
        {followUp.newReplies > 0 ? (
          <span className='flex flex-wrap gap-2'>
            {item.state.participationUrl ? (
              <a
                href={item.state.participationUrl}
                target='_blank'
                rel='noreferrer noopener'
                className='inline-flex items-center gap-1 text-primary hover:underline'
              >
                {t('feed.followUp.open')}
                <ExternalLinkIcon className='size-3.5' />
              </a>
            ) : null}
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={saving}
              onClick={() => void markSeen()}
            >
              {saving ? <Spinner data-icon='inline-start' /> : null}
              {t('feed.followUp.markSeen')}
            </Button>
          </span>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
