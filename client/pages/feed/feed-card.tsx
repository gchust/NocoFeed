import { useTranslation } from '@nocobase/i18n/client';
import {
  BookmarkIcon,
  CheckCheckIcon,
  ClockIcon,
  MessageCircleReplyIcon,
} from 'lucide-react';
import type { ReactElement } from 'react';

import { cn } from 'cn';

import { CoverThumbnail } from './content.js';
import { ItemTime, PlatformBadge, VerdictBadge } from './parts.js';
import type { FeedListItem } from './types.js';
import { youTubeThumbnail, youTubeVideoOf } from './youtube.js';

export type Density = 'comfortable' | 'compact';

interface CardProps {
  readonly item: FeedListItem;
  readonly language: string;
  readonly topicName?: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

/** One feed item; `compact` fits it on one line for triage with the keyboard. */
export function FeedCard({
  density = 'comfortable',
  ...props
}: CardProps & { readonly density?: Density }): ReactElement {
  return density === 'compact' ? (
    <CompactRow {...props} />
  ) : (
    <ComfortableCard {...props} />
  );
}

function ComfortableCard({
  item,
  language,
  topicName,
  selected,
  onSelect,
}: CardProps): ReactElement {
  const { t } = useTranslation();
  // A YouTube video has no stored media: its thumbnail is derived from the video id.
  const youtube = item.cover ? null : youTubeVideoOf(item);
  const cover = item.cover ?? (youtube ? youTubeThumbnail(youtube.id) : null);
  return (
    <button
      type='button'
      onClick={onSelect}
      data-item-id={item.id}
      data-read={item.read ? 'true' : 'false'}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full flex-col gap-2 rounded-xl border bg-card p-4 text-left transition-colors outline-none hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50',
        selected && 'border-primary/60 bg-primary/5',
        item.verdict === 'ignore' && 'opacity-70',
      )}
    >
      <span className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
        <UnreadDot read={item.read} />
        <PlatformBadge platform={item.platform} />
        <span className='max-w-[16rem] truncate'>
          {item.sourceLabel ?? '—'}
        </span>
        <span aria-hidden='true'>·</span>
        <ItemTime item={item} language={language} />
        <NewReplies count={item.newReplies} className='ml-auto' />
      </span>
      {/* The post first: its title, the opening of its text and its picture; the analysis is one line under it. */}
      <span className='flex w-full items-start gap-3'>
        <span className='flex min-w-0 flex-1 flex-col gap-1'>
          <span
            className={cn(
              'line-clamp-2 text-[0.95rem] leading-snug',
              item.read ? 'font-normal text-foreground/80' : 'font-semibold',
            )}
          >
            {item.brief?.title ?? item.title}
          </span>
          {/* The model's gist first: what the post says, in the reading language; its own opening otherwise. */}
          {item.brief?.gist ? (
            <span className='line-clamp-3 text-sm leading-6 text-muted-foreground'>
              {item.brief.gist}
            </span>
          ) : item.excerpt ? (
            <span className='line-clamp-3 text-sm leading-6 whitespace-pre-line text-muted-foreground'>
              {item.excerpt}
            </span>
          ) : item.lead ? (
            <span className='line-clamp-2 text-sm text-muted-foreground'>
              {item.lead}
            </span>
          ) : null}
        </span>
        {cover ? (
          <CoverThumbnail src={cover} video={item.video || Boolean(youtube)} />
        ) : null}
      </span>
      <span className='flex w-full flex-wrap items-center gap-2 text-xs text-muted-foreground'>
        <VerdictBadge verdict={item.verdict} />
        {item.verdict ? (
          <span className='tabular-nums'>
            {t('feed.scoreValue', { score: Math.round(item.score) })}
          </span>
        ) : null}
        {item.quality !== null ? (
          <span className='tabular-nums'>
            {t('feed.qualityValue', { quality: Math.round(item.quality) })}
          </span>
        ) : null}
        {item.noise !== 'none' ? (
          <span>{t(`feed.noise.${item.noise}`)}</span>
        ) : null}
        {item.gate === 'awaitingMaterial' ? (
          <span>{t('feed.gate.awaitingMaterial')}</span>
        ) : null}
        {topicName ? <span>#{topicName}</span> : null}
        <StateIcons item={item} className='ml-auto' />
      </span>
    </button>
  );
}

function CompactRow({
  item,
  language,
  selected,
  onSelect,
}: CardProps): ReactElement {
  const { t } = useTranslation();
  return (
    <button
      type='button'
      onClick={onSelect}
      data-item-id={item.id}
      data-read={item.read ? 'true' : 'false'}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
        selected && 'bg-primary/10',
      )}
    >
      <span
        aria-hidden='true'
        className={cn(
          'size-2 shrink-0 rounded-full',
          item.verdict === 'discuss'
            ? 'bg-primary'
            : item.verdict === 'learn'
              ? 'bg-(--status-success)'
              : 'bg-muted-foreground/40',
        )}
      />
      <span className='sr-only'>
        {item.verdict
          ? t(`feed.verdict.${item.verdict}`)
          : t('feed.verdict.pending')}
      </span>
      <span className='w-20 shrink-0 truncate text-xs text-muted-foreground'>
        {t(`feed.platforms.${item.platform}`)}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          item.read ? 'text-muted-foreground' : 'font-semibold text-foreground',
          selected && 'text-foreground',
        )}
      >
        {item.read ? null : (
          <span className='sr-only'>{t('feed.read.unread')} </span>
        )}
        {item.brief?.title ?? item.title}
      </span>
      <NewReplies count={item.newReplies} />
      <StateIcons item={item} />
      <span className='w-8 shrink-0 text-right text-xs text-muted-foreground tabular-nums'>
        {item.verdict ? Math.round(item.score) : '—'}
      </span>
      <ItemTime
        item={item}
        language={language}
        className='hidden w-28 shrink-0 truncate text-right text-xs whitespace-nowrap text-muted-foreground sm:block'
      />
    </button>
  );
}

/** Marks an item the person has not opened yet; read items show nothing. */
function UnreadDot({ read }: { readonly read: boolean }): ReactElement | null {
  const { t } = useTranslation();
  if (read) return null;
  return (
    <span className='inline-flex items-center' title={t('feed.read.unread')}>
      <span aria-hidden='true' className='size-2 rounded-full bg-primary' />
      <span className='sr-only'>{t('feed.read.unread')}</span>
    </span>
  );
}

function NewReplies({
  count,
  className,
}: {
  readonly count: number;
  readonly className?: string;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!count) return null;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary',
        className,
      )}
    >
      <MessageCircleReplyIcon className='size-3' aria-hidden='true' />
      {t('feed.followUp.newReplies', { count })}
    </span>
  );
}

function StateIcons({
  item,
  className,
}: {
  readonly item: FeedListItem;
  readonly className?: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1.5 text-muted-foreground',
        className,
      )}
    >
      {item.favorite ? (
        <BookmarkIcon
          className='size-3.5 fill-current text-primary'
          aria-label={t('feed.state.favorite')}
        />
      ) : null}
      {item.later ? (
        <ClockIcon className='size-3.5' aria-label={t('feed.state.later')} />
      ) : null}
      {item.participated ? (
        <CheckCheckIcon
          className='size-3.5'
          aria-label={t('feed.state.participated')}
        />
      ) : null}
    </span>
  );
}
