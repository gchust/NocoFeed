import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { HistoryIcon, RefreshCwIcon } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';

import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { Button } from '#components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '#components/ui/empty';
import { Skeleton } from '#components/ui/skeleton';
import { Spinner } from '#components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#components/ui/table';

import { absoluteTime, messageText, relativeTime } from '../feed/format.js';
import { LoadProblem, PlatformBadge, RunStatusBadge } from '../feed/parts.js';
import type { Run, RunStats } from '../feed/types.js';

const STATS = ['found', 'inserted', 'analyzed', 'failed'] as const;

export default function RunsPage(): ReactElement {
  const { t, i18n } = useTranslation();
  const api = useApiClient();
  const [reloadCount, setReloadCount] = useState(0);
  const reload = useCallback(() => setReloadCount((count) => count + 1), []);
  const [result, setResult] = useState<{
    readonly key: number;
    readonly runs?: readonly Run[];
    readonly stats?: RunStats;
    readonly error?: unknown;
  }>();

  useEffect(() => {
    const controller = new AbortController();
    api
      .request<{ data: Run[]; meta: { stats: RunStats } }>({
        path: 'feedRuns',
        query: { pageSize: 100 },
        signal: controller.signal,
      })
      .then(
        ({ data, meta }) => {
          if (!controller.signal.aborted)
            setResult({ key: reloadCount, runs: data, stats: meta.stats });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setResult({ key: reloadCount, error });
        },
      );
    return () => controller.abort();
  }, [api, reloadCount]);

  const loading = result?.key !== reloadCount;
  const error = loading ? undefined : result?.error;
  const runs = result?.runs;
  const stats = result?.stats;

  return (
    <PageContainer className='max-w-7xl'>
      <PageHeader
        title={t('runs.title')}
        description={t('runs.description')}
        actions={
          <Button
            type='button'
            variant='outline'
            disabled={loading}
            onClick={reload}
          >
            {loading && runs ? (
              <Spinner data-icon='inline-start' />
            ) : (
              <RefreshCwIcon data-icon='inline-start' />
            )}
            {t('feed.refresh')}
          </Button>
        }
      />
      <section
        aria-label={t('runs.statsLabel')}
        className='grid grid-cols-2 gap-3 md:grid-cols-4'
      >
        {STATS.map((name) => (
          <div key={name} className='rounded-xl border bg-card p-4'>
            <p className='text-xs text-muted-foreground'>
              {t(`runs.stats.${name}`)}
            </p>
            <p className='mt-1 text-2xl font-semibold tabular-nums'>
              {stats ? stats[name] : '—'}
            </p>
          </div>
        ))}
      </section>
      {error ? <LoadProblem error={error} onRetry={reload} /> : null}
      {!runs && !error ? (
        <Skeleton
          className='h-64 w-full'
          role='status'
          aria-label={t('feed.loading')}
        />
      ) : null}
      {runs && runs.length === 0 ? (
        <Empty className='rounded-xl border border-dashed'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <HistoryIcon />
            </EmptyMedia>
            <EmptyTitle>{t('runs.empty.title')}</EmptyTitle>
            <EmptyDescription>{t('runs.empty.description')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {runs && runs.length > 0 ? (
        <div className='overflow-x-auto rounded-xl border bg-card'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('runs.columns.startedAt')}</TableHead>
                <TableHead>{t('runs.columns.source')}</TableHead>
                <TableHead>{t('runs.columns.stage')}</TableHead>
                <TableHead>{t('runs.columns.status')}</TableHead>
                <TableHead className='text-right'>
                  {t('runs.columns.found')}
                </TableHead>
                <TableHead className='text-right'>
                  {t('runs.columns.inserted')}
                </TableHead>
                <TableHead className='text-right'>
                  {t('runs.columns.analyzed')}
                </TableHead>
                <TableHead>{t('runs.columns.coverage')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const message = messageText(t, run.error);
                return (
                  <TableRow key={run.id}>
                    <TableCell
                      title={absoluteTime(run.startedAt, i18n.language)}
                    >
                      {relativeTime(run.startedAt, i18n.language)}
                    </TableCell>
                    <TableCell className='max-w-[18rem]'>
                      <div className='flex items-center gap-2'>
                        <PlatformBadge platform={run.platform} />
                        <span className='truncate'>
                          {run.sourceName ?? '—'}
                        </span>
                      </div>
                      {run.itemId ? (
                        <Link
                          to={`/?item=${run.itemId}`}
                          className='text-xs text-primary hover:underline'
                        >
                          {t('runs.openItem')}
                        </Link>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {t(`runs.stages.${run.stage}`)}
                      <span className='block text-xs text-muted-foreground'>
                        {t(`runs.triggers.${run.trigger}`)}
                      </span>
                    </TableCell>
                    <TableCell className='max-w-[16rem]'>
                      <RunStatusBadge status={run.status} />
                      {message ? (
                        <p className='mt-1 text-xs whitespace-normal text-muted-foreground'>
                          {message}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {run.found}
                    </TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {run.inserted}
                    </TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {run.analyzed}
                    </TableCell>
                    <TableCell className='max-w-[16rem] text-xs whitespace-normal'>
                      {run.coverage ? t(`runs.coverage.${run.coverage}`) : '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </PageContainer>
  );
}
