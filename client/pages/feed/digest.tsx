import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  GraduationCapIcon,
  MessagesSquareIcon,
  SunriseIcon,
} from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';

import { Skeleton } from '#components/ui/skeleton';

import { FeedCard } from './feed-card.js';
import { LoadProblem } from './parts.js';
import type { FeedDigest, FeedListItem } from './types.js';

/**
 * Today's short list: the three best discussions to join and the one best thing to learn from, among what arrived in
 * the last 24 hours. The same list goes out once a day as an in-app message.
 */
export function DigestPanel({
  reloadCount,
  selectedId,
  topicNames,
  onSelect,
  onRetry,
}: {
  readonly reloadCount: number;
  readonly selectedId?: number;
  readonly topicNames: ReadonlyMap<number, string>;
  readonly onSelect: (id: number) => void;
  readonly onRetry: () => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const api = useApiClient();
  const [result, setResult] = useState<{
    readonly key: number;
    readonly digest?: FeedDigest;
    readonly error?: unknown;
  }>();

  useEffect(() => {
    const controller = new AbortController();
    api
      .request<{ data: FeedDigest }>({
        path: 'feedDigest',
        signal: controller.signal,
      })
      .then(
        ({ data }) => {
          if (!controller.signal.aborted)
            setResult({ key: reloadCount, digest: data });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setResult({ key: reloadCount, error });
        },
      );
    return () => controller.abort();
  }, [api, reloadCount]);

  const digest = result?.digest;
  if (result?.error)
    return <LoadProblem error={result.error} onRetry={onRetry} />;
  if (!digest)
    return (
      <div
        className='flex flex-col gap-2'
        role='status'
        aria-label={t('feed.loading')}
      >
        <Skeleton className='h-16 w-full rounded-xl' />
        <Skeleton className='h-28 w-full rounded-xl' />
        <Skeleton className='h-28 w-full rounded-xl' />
      </div>
    );

  const card = (item: FeedListItem): ReactNode => (
    <li key={item.id}>
      <FeedCard
        item={item}
        language={i18n.language}
        topicName={item.topicId ? topicNames.get(item.topicId) : undefined}
        selected={item.id === selectedId}
        onSelect={() => onSelect(item.id)}
      />
    </li>
  );

  return (
    <div className='flex flex-col gap-5'>
      <div className='flex items-start gap-3 rounded-xl border bg-primary/5 p-4'>
        <SunriseIcon className='mt-0.5 size-5 shrink-0 text-primary' />
        <div className='flex min-w-0 flex-col gap-1'>
          <h2 className='font-semibold'>{t('feed.digest.title')}</h2>
          <p className='text-sm text-muted-foreground'>
            {t('feed.digest.description')}{' '}
            <Link to='/preferences' className='text-primary hover:underline'>
              {t('feed.digest.settings')}
            </Link>
          </p>
        </div>
      </div>
      <DigestGroup
        icon={<MessagesSquareIcon className='size-4' />}
        title={t('feed.digest.discuss')}
        empty={t('feed.digest.discussEmpty')}
      >
        {digest.discuss.map(card)}
      </DigestGroup>
      <DigestGroup
        icon={<GraduationCapIcon className='size-4' />}
        title={t('feed.digest.learn')}
        empty={t('feed.digest.learnEmpty')}
      >
        {digest.learn.map(card)}
      </DigestGroup>
    </div>
  );
}

function DigestGroup({
  icon,
  title,
  empty,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly empty: string;
  readonly children: readonly ReactNode[];
}): ReactElement {
  return (
    <section className='flex flex-col gap-2'>
      <h3 className='flex items-center gap-2 text-sm font-semibold text-muted-foreground'>
        {icon}
        {title}
      </h3>
      {children.length ? (
        <ul className='flex flex-col gap-2'>{children}</ul>
      ) : (
        <p className='rounded-xl border border-dashed p-4 text-sm text-muted-foreground'>
          {empty}
        </p>
      )}
    </section>
  );
}
