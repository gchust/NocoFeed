import { useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  AlertTriangleIcon,
  BookmarkIcon,
  CheckCheckIcon,
  ChevronDownIcon,
  CircleDotIcon,
  ClockIcon,
  DownloadIcon,
  LanguagesIcon,
  EyeOffIcon,
  ExternalLinkIcon,
  MessageCircleReplyIcon,
  RotateCwIcon,
  SparklesIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  XIcon,
} from 'lucide-react';
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';

import { SessionExpiredAlert } from '#components/session-expired-alert';
import { StatusBadge } from '#components/status-badge';
import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '#components/ui/collapsible';
import { Input } from '#components/ui/input';
import { Label } from '#components/ui/label';
import { Separator } from '#components/ui/separator';
import { Skeleton } from '#components/ui/skeleton';
import { Spinner } from '#components/ui/spinner';
import { Textarea } from '#components/ui/textarea';
import { cn } from 'cn';

import { AskSection } from './ask.js';
import { BriefMarkdown } from './brief.js';
import { ArticleText, MediaGallery } from './content.js';
import { IdeasSection } from './ideas.js';
import { noteText, relativeTime, requestProblem } from './format.js';
import { ItemTime, LoadProblem, PlatformBadge, VerdictBadge } from './parts.js';
import { ReplyDrafts } from './replies.js';
import type {
  FeedItem,
  ItemState,
  PartCoverage,
  StateChange,
} from './types.js';
import { MARKS, type MarkWriter, type Marks } from './use-item-state.js';
import { youTubeVideoOf } from './youtube.js';

export interface ItemDetailProps {
  readonly itemId: number;
  readonly topicNames: ReadonlyMap<number, string>;
  readonly onClose: () => void;
  /** Notes or the participation record were saved; the list card follows. */
  readonly onStateChange: (id: number, state: ItemState) => void;
  /**
   * Saves the one-click marks (save, later, joined, read, dismiss, feedback): they show at once, the request follows
   * in the background, and a failure puts them back.
   */
  readonly marks: MarkWriter;
  /** The analysis or the counts changed; the list reloads. */
  readonly onChanged: () => void;
  /**
   * Opening the item marks it read. False when the page has already done so for this opening, so a detail shown again
   * after the person marked it unread does not read it again.
   */
  readonly autoRead?: boolean;
  /** Called once when the opened item has been taken as read. */
  readonly onAutoRead?: () => void;
}

type Busy = 'brief' | 'translate' | 'analyze' | 'enrich';

/** The one-click marks of an item as the detail shows them. */
const marksOf = (state: ItemState): Marks =>
  Object.fromEntries(MARKS.map((mark) => [mark, state[mark]])) as Marks;

/** One item: what the agent concluded, on which material, and the person's own record of it. */
export function ItemDetail({
  itemId,
  topicNames,
  onClose,
  onStateChange,
  marks,
  onChanged,
  autoRead = true,
  onAutoRead,
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
  const [analysisOpen, setAnalysisOpen] = useState(false);
  /** The original text is folded under the brief; null follows whether there is a brief. */
  const [originalOpen, setOriginalOpen] = useState<boolean | null>(null);
  /** Show the translation of the full text rather than the original, once there is one. */
  const [showTranslation, setShowTranslation] = useState(true);
  // The item whose brief could not be written on its own; it is not tried again until the person asks.
  const [briefFailed, setBriefFailed] = useState<number>();

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

  const toasterRef = useRef(toaster);
  const tRef = useRef(t);
  useEffect(() => {
    toasterRef.current = toaster;
    tRef.current = t;
  });

  // A mark changed here, by a shortcut or by the server's answer shows at once, without loading the item again.
  useEffect(
    () =>
      marks.subscribe((event) => {
        if (event.id !== itemId) return;
        setResult((current) =>
          current?.item?.id === event.id
            ? {
                ...current,
                item: {
                  ...current.item,
                  ...('read' in event.changes
                    ? { read: event.after.read }
                    : {}),
                  state: { ...current.item.state, ...event.changes },
                },
              }
            : current,
        );
        const adjustment =
          event.kind === 'confirmed' ? event.state?.adjustment : undefined;
        if (adjustment)
          toasterRef.current.show({
            id: `feed-adjust-${event.id}`,
            type: 'success',
            title:
              adjustment.direction === 'down'
                ? tRef.current('feed.feedback.adjustedDown')
                : tRef.current('feed.feedback.adjustedUp'),
            description: tRef.current('feed.feedback.adjustedDetail', {
              terms: adjustment.terms.slice(0, 6).join(', '),
            }),
          });
      }),
    [marks, itemId],
  );

  // Opening an item reads it: once, quietly, without reloading the list. A failure leaves it unread and says nothing.
  const autoReadRef = useRef({
    enabled: autoRead,
    onAutoRead,
    marks: {} as Marks,
  });
  const loadedItem = result?.item;
  useEffect(() => {
    autoReadRef.current = {
      enabled: autoRead,
      onAutoRead,
      marks: loadedItem ? marksOf(loadedItem.state) : ({} as Marks),
    };
  });
  const readOnOpen =
    loadedItem && !loadedItem.state.read ? loadedItem.id : undefined;
  const loadedId = loadedItem?.id;
  useEffect(() => {
    const { enabled, onAutoRead: done, marks: shown } = autoReadRef.current;
    if (loadedId === undefined || !enabled) return;
    done?.();
    if (readOnOpen === undefined) return;
    marks.set(readOnOpen, { read: true }, shown, { quiet: true });
  }, [marks, loadedId, readOnOpen]);

  // An item opened without a brief gets one at once, so that what it says is the first thing on the page.
  const needsBrief =
    loadedItem && !loadedItem.brief ? loadedItem.id : undefined;
  const briefing = needsBrief !== briefFailed ? needsBrief : undefined;
  useEffect(() => {
    if (briefing === undefined) return;
    const controller = new AbortController();
    api
      .request<{ data: FeedItem }>({
        path: `feedItems/${encodeURIComponent(briefing)}/brief`,
        method: 'POST',
        signal: controller.signal,
      })
      .then(
        ({ data }) => {
          if (controller.signal.aborted) return;
          setResult((current) =>
            current?.item?.id === briefing
              ? { ...current, item: data }
              : current,
          );
        },
        () => {
          if (!controller.signal.aborted) setBriefFailed(briefing);
        },
      );
    return () => controller.abort();
  }, [api, briefing]);

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

  // No waiting and no reload: the writer shows the mark now and saves it behind the person's back.
  const mark = (changes: Partial<Marks>): void => {
    if (item) marks.set(item.id, changes, marksOf(item.state));
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
      toaster.show({
        type: 'success',
        title: data.agentReading
          ? t('feed.detail.handedToAgent')
          : t('feed.detail.analyzed'),
      });
    } catch (cause: unknown) {
      failed(cause);
    } finally {
      setBusy(undefined);
    }
  };

  const rewriteBrief = async (): Promise<void> => {
    if (!item) return;
    setBusy('brief');
    try {
      const { data } = await api.request<{ data: FeedItem }>({
        path: `feedItems/${encodeURIComponent(item.id)}/brief`,
        method: 'POST',
      });
      replace(data);
      onChanged();
    } catch (cause: unknown) {
      if (requestProblem(cause) === 'unavailable')
        toaster.show({ type: 'warning', title: t('feed.brief.failed') });
      else failed(cause);
    } finally {
      setBusy(undefined);
    }
  };

  const translateText = async (): Promise<void> => {
    if (!item) return;
    setBusy('translate');
    try {
      const { data } = await api.request<{ data: FeedItem }>({
        path: `feedItems/${encodeURIComponent(item.id)}/translate`,
        method: 'POST',
      });
      replace(data);
      setShowTranslation(true);
      setOriginalOpen(true);
      onChanged();
    } catch (cause: unknown) {
      if (requestProblem(cause) === 'unavailable')
        toaster.show({
          type: 'warning',
          title: t('feed.brief.translateFailed'),
        });
      else failed(cause);
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
  // A YouTube video plays here; without a recognisable id the link to the original stays the way to watch it.
  const youtube = youTubeVideoOf(item);
  // The post's own words: its body, else a summary that says more than the title.
  const text =
    item.body?.trim() ||
    (item.summary?.trim() && item.summary.trim() !== item.title.trim()
      ? item.summary.trim()
      : '');
  const brief = item.brief;
  const briefPending = !brief && briefFailed !== item.id;
  const translation = brief?.body && showTranslation ? brief.body.trim() : '';
  const canTranslate =
    Boolean(text) &&
    item.readingLanguage !== 'original' &&
    !sameLanguage(brief?.sourceLanguage ?? null, item.readingLanguage) &&
    (!brief?.body || brief.bodyStale);
  const originalShown = originalOpen ?? !brief;

  return (
    <article className='flex flex-col gap-5 p-5' aria-busy={loading}>
      <header className='flex flex-col gap-3'>
        <div className='flex items-start gap-2'>
          <div className='flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs text-muted-foreground'>
            <PlatformBadge platform={item.platform} />
            <span className='truncate'>{item.sourceLabel ?? '—'}</span>
            {item.author ? <span>· {item.author}</span> : null}
            <span>·</span>
            <ItemTime item={item} language={i18n.language} />
          </div>
          {close}
        </div>
        <h2 className='text-lg leading-snug font-semibold'>
          {brief?.title ?? item.title}
        </h2>
        {brief?.title ? (
          <p className='-mt-2 text-sm text-muted-foreground'>{item.title}</p>
        ) : null}
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
            icon={
              <BookmarkIcon
                className={cn(item.state.favorite && 'fill-current')}
              />
            }
            label={t('feed.state.favorite')}
            onClick={() => mark({ favorite: !item.state.favorite })}
          />
          <ToggleButton
            pressed={item.state.later}
            icon={<ClockIcon />}
            label={t('feed.state.later')}
            onClick={() => mark({ later: !item.state.later })}
          />
          <ToggleButton
            pressed={item.state.participated}
            icon={<CheckCheckIcon />}
            label={t('feed.state.participated')}
            onClick={() => mark({ participated: !item.state.participated })}
          />
          <ToggleButton
            pressed={!item.state.read}
            icon={<CircleDotIcon />}
            label={t('feed.state.unread')}
            onClick={() => mark({ read: !item.state.read })}
          />
          <ToggleButton
            pressed={item.state.dismissed}
            icon={<EyeOffIcon />}
            label={t('feed.state.dismissed')}
            onClick={() => mark({ dismissed: !item.state.dismissed })}
          />
        </div>
      </header>

      {item.agentReading ? (
        <Alert>
          <Spinner />
          <AlertDescription>
            {t('feed.detail.agentReading', {
              time: relativeTime(item.agentReading.startedAt, i18n.language),
            })}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* What the post says comes first: the model's brief in the reading language. */}
      <section
        aria-labelledby='feed-brief'
        className='flex flex-col gap-2 rounded-lg bg-muted/40 p-4'
      >
        <h3
          id='feed-brief'
          className='flex items-center gap-1.5 text-xs font-medium text-muted-foreground'
        >
          <SparklesIcon className='size-3.5' aria-hidden='true' />
          {t('feed.brief.heading')}
        </h3>
        {brief ? (
          <BriefMarkdown text={brief.brief} media={item.media} />
        ) : briefPending ? (
          <div
            className='flex flex-col gap-2'
            role='status'
            aria-label={t('feed.brief.writing')}
          >
            <Skeleton className='h-4 w-full' />
            <Skeleton className='h-4 w-5/6' />
            <Skeleton className='h-4 w-2/3' />
          </div>
        ) : (
          <p className='text-sm text-muted-foreground'>
            {t('feed.brief.none')}
          </p>
        )}
        <div className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
          {brief?.stale ? <span>{t('feed.brief.stale')}</span> : null}
          {brief?.model ? <span>{brief.model}</span> : null}
          {briefPending ? null : (
            <Button
              type='button'
              size='xs'
              variant='ghost'
              disabled={Boolean(busy)}
              onClick={() => void rewriteBrief()}
            >
              {busy === 'brief' ? (
                <Spinner data-icon='inline-start' />
              ) : (
                <RotateCwIcon data-icon='inline-start' />
              )}
              {brief ? t('feed.brief.rewrite') : t('feed.brief.write')}
            </Button>
          )}
        </div>
      </section>

      {/* The analysis is one line until asked for; the post itself is what the page shows. */}
      <Collapsible
        open={analysisOpen}
        onOpenChange={setAnalysisOpen}
        className='rounded-lg border'
      >
        <CollapsibleTrigger
          id='feed-analysis'
          className='flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-muted-foreground outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50'
        >
          <SparklesIcon className='size-3.5 shrink-0' aria-hidden='true' />
          <span className='sr-only'>{t('feed.detail.analysis')}</span>
          <VerdictBadge verdict={analysis?.verdict ?? null} />
          {analysis ? (
            <span className='shrink-0 tabular-nums'>
              {t('feed.scoreValue', { score: Math.round(analysis.score) })}
            </span>
          ) : null}
          {analysis?.quality != null ? (
            <span className='shrink-0 tabular-nums'>
              {t('feed.qualityValue', {
                quality: Math.round(analysis.quality),
              })}
            </span>
          ) : null}
          {analysis?.gate ? (
            <span className='shrink-0'>{t(`feed.gate.${analysis.gate}`)}</span>
          ) : null}
          {topicName ? <span className='shrink-0'>#{topicName}</span> : null}
          <span className='min-w-0 flex-1 truncate text-foreground'>
            {analysis?.lead ?? ''}
          </span>
          {item.analysisStale ? (
            <AlertTriangleIcon
              className='size-3.5 shrink-0 text-(--status-warning)'
              aria-label={t('feed.detail.stale')}
            />
          ) : null}
          <ChevronDownIcon
            className={cn(
              'size-4 shrink-0 transition-transform',
              analysisOpen && 'rotate-180',
            )}
            aria-hidden='true'
          />
        </CollapsibleTrigger>
        <CollapsibleContent className='flex flex-col gap-3 border-t p-3'>
          <div className='flex flex-wrap items-center gap-2'>
            <h3 className='text-sm font-semibold'>
              {t('feed.detail.analysis')}
            </h3>
            <Button
              type='button'
              size='xs'
              variant='outline'
              className='ml-auto'
              disabled={Boolean(busy) || Boolean(item.agentReading)}
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
              {analysis.qualityDetail ? (
                <TextBlock label={t('feed.detail.quality')}>
                  {t('feed.detail.qualityAxes', analysis.qualityDetail)}
                  {analysis.qualityDetail.noise !== 'none'
                    ? ` · ${t(`feed.noise.${analysis.qualityDetail.noise}`)}`
                    : ''}
                </TextBlock>
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
                {analysis.engine === 'agent'
                  ? t('feed.detail.byAgent', { agent: analysis.model ?? '—' })
                  : analysis.engine === 'model'
                    ? t('feed.detail.byModel', { model: analysis.model ?? '—' })
                    : t('feed.detail.byRules')}
                {' · '}
                {relativeTime(analysis.createdAt, i18n.language)}
              </p>
              <FeedbackButtons
                value={item.state.feedback}
                onChange={(feedback) => mark({ feedback })}
              />
            </>
          ) : (
            <p className='text-sm text-muted-foreground'>
              {t('feed.detail.noAnalysis')}
            </p>
          )}

          <Separator />

          <section
            aria-labelledby='feed-coverage'
            className='flex flex-col gap-2'
          >
            <h4
              id='feed-coverage'
              className='text-xs font-medium text-muted-foreground'
            >
              {t('feed.detail.coverage')}
            </h4>
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
        </CollapsibleContent>
      </Collapsible>

      {/* Replies to copy, in the post's own language (issue #15). */}
      <ReplyDrafts
        key={`replies-${item.id}`}
        itemId={item.id}
        worthJoining={
          analysis?.verdict === 'discuss' ||
          Boolean(item.state.participationUrl)
        }
        participated={item.state.participated}
        onMarkJoined={() => mark({ participated: true })}
      />

      {/* The original follows, folded while a brief says what it says. */}
      <Collapsible
        open={originalShown}
        onOpenChange={setOriginalOpen}
        className='flex flex-col gap-4'
      >
        <div className='flex flex-wrap items-center gap-2'>
          <CollapsibleTrigger className='flex items-center gap-1.5 rounded-md text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50'>
            <ChevronDownIcon
              className={cn(
                'size-4 transition-transform',
                !originalShown && '-rotate-90',
              )}
              aria-hidden='true'
            />
            {t('feed.detail.content')}
          </CollapsibleTrigger>
          {brief?.body ? (
            <Button
              type='button'
              size='xs'
              variant='outline'
              aria-pressed={showTranslation}
              onClick={() => {
                setShowTranslation((shown) => !shown);
                setOriginalOpen(true);
              }}
            >
              <LanguagesIcon data-icon='inline-start' />
              {showTranslation
                ? t('feed.brief.showOriginal')
                : t('feed.brief.showTranslation')}
            </Button>
          ) : null}
          {canTranslate ? (
            <Button
              type='button'
              size='xs'
              variant='outline'
              disabled={Boolean(busy)}
              onClick={() => void translateText()}
            >
              {busy === 'translate' ? (
                <Spinner data-icon='inline-start' />
              ) : (
                <LanguagesIcon data-icon='inline-start' />
              )}
              {brief?.bodyStale
                ? t('feed.brief.translateAgain')
                : t('feed.brief.translate')}
            </Button>
          ) : null}
        </div>
        <CollapsibleContent
          role='region'
          aria-label={t('feed.detail.content')}
          className='flex flex-col gap-4'
        >
          <MediaGallery
            media={item.media}
            youtube={youtube}
            title={item.title}
          />
          {translation ? (
            <ArticleText text={translation} />
          ) : text ? (
            <ArticleText text={text} />
          ) : (
            <p className='text-sm text-muted-foreground'>
              {item.media.length || youtube
                ? t('feed.detail.mediaOnly')
                : t('feed.detail.titleOnly')}
            </p>
          )}
          {item.enrichable.length > 0 ? (
            <Button
              type='button'
              size='xs'
              variant='outline'
              className='self-start'
              disabled={Boolean(busy)}
              onClick={() => void enrich()}
            >
              {busy === 'enrich' ? (
                <Spinner data-icon='inline-start' />
              ) : (
                <DownloadIcon data-icon='inline-start' />
              )}
              {t('feed.detail.fetch', {
                parts: item.enrichable
                  .map((part) => t(`feed.parts.${part}`))
                  .join(t('feed.common.listSeparator')),
              })}
            </Button>
          ) : null}
        </CollapsibleContent>
      </Collapsible>

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

      <AskSection key={item.id} itemId={item.id} />

      <Separator />

      <IdeasSection key={item.id} itemId={item.id} />

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
  icon,
  label,
  onClick,
}: {
  readonly pressed: boolean;
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
      onClick={onClick}
      className='aria-pressed:border-primary/40 aria-pressed:bg-primary/10 aria-pressed:text-primary'
    >
      {icon}
      {label}
    </Button>
  );
}

function FeedbackButtons({
  value,
  onChange,
}: {
  readonly value: ItemState['feedback'];
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
        onClick={() => onChange(value === 'irrelevant' ? null : 'irrelevant')}
        className='aria-pressed:bg-muted aria-pressed:text-foreground'
      >
        <ThumbsDownIcon data-icon='inline-start' />
        {t('feed.feedback.irrelevant')}
      </Button>
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

/** Whether a language tag names the reading language: Chinese scripts apart, the primary language alone decides. */
function sameLanguage(tag: string | null, reading: string): boolean {
  if (!tag) return false;
  const a = tag.toLowerCase();
  const b = reading.toLowerCase();
  if (a.startsWith('zh') || b.startsWith('zh')) {
    const script = (value: string) =>
      /^zh(-hant|-tw|-hk|-mo)/.test(value)
        ? 'zh-hant'
        : value.startsWith('zh')
          ? 'zh-hans'
          : value;
    return script(a) === script(b);
  }
  return a.split('-')[0] === b.split('-')[0];
}
