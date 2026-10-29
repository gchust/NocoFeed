import { useTranslation } from '@nocobase/i18n/client';
import {
  BookmarkIcon,
  CheckCheckIcon,
  ClockIcon,
  MessageCircleReplyIcon,
} from 'lucide-react';
import type { ReactElement } from 'react';

import { cn } from 'cn';

import { relativeTime } from './format.js';
import { PlatformBadge, VerdictBadge } from './parts.js';
import type { FeedListItem } from './types.js';

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
  return (
    <button
      type='button'
      onClick={onSelect}
      data-item-id={item.id}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full flex-col gap-2 rounded-xl border bg-card p-4 text-left transition-colors outline-none hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50',
        selected && 'border-primary/60 bg-primary/5',
        item.verdict === 'ignore' && 'opacity-70',
      )}
    >
      <span className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
        <PlatformBadge platform={item.platform} />
        <span className='max-w-[16rem] truncate'>
          {item.sourceLabel ?? '—'}
        </span>
        <span aria-hidden='true'>·</span>
        <time dateTime={item.publishedAt ?? item.createdAt}>
          {relativeTime(item.publishedAt ?? item.createdAt, language)}
        </time>
        <NewReplies count={item.newReplies} className='ml-auto' />
      </span>
      <span className='line-clamp-2 text-[0.95rem] leading-snug font-medium'>
        {item.title}
      </span>
      {item.lead ? (
        <span className='line-clamp-2 text-sm text-muted-foreground'>
          {item.lead}
        </span>
      ) : null}
      <span className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
        <VerdictBadge verdict={item.verdict} />
        {item.verdict ? (
          <span className='tabular-nums'>
            {t('feed.scoreValue', { score: Math.round(item.score) })}
          </span>
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
          selected ? 'font-medium text-foreground' : 'text-foreground',
        )}
      >
        {item.title}
      </span>
      <NewReplies count={item.newReplies} />
      <StateIcons item={item} />
      <span className='w-8 shrink-0 text-right text-xs text-muted-foreground tabular-nums'>
        {item.verdict ? Math.round(item.score) : '—'}
      </span>
      <time
        dateTime={item.publishedAt ?? item.createdAt}
        className='hidden w-24 shrink-0 truncate text-right text-xs whitespace-nowrap text-muted-foreground sm:block'
      >
        {relativeTime(item.publishedAt ?? item.createdAt, language)}
      </time>
    </button>
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
