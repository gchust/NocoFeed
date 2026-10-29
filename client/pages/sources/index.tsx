import { useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  CpuIcon,
  InfoIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RssIcon,
  Trash2Icon,
} from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router';

import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert';
import { Button, buttonVariants } from '#components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '#components/ui/empty';
import { Skeleton } from '#components/ui/skeleton';
import { Spinner } from '#components/ui/spinner';
import { Switch } from '#components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#components/ui/table';

import { DeleteDialog } from '../feed/delete-dialog.js';
import {
  absoluteTime,
  frequencyText,
  messageText,
  relativeTime,
  requestProblem,
} from '../feed/format.js';
import {
  HealthBadge,
  LoadProblem,
  PlatformBadge,
  RunStatusBadge,
} from '../feed/parts.js';
import type { Catalog, Run, Source, Topic } from '../feed/types.js';
import type { SourcesOutletContext } from './types.js';

export default function SourcesPage(): ReactElement {
  const { t, i18n } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const navigate = useNavigate();
  const [reloadCount, setReloadCount] = useState(0);
  const reload = useCallback(() => setReloadCount((count) => count + 1), []);
  const [result, setResult] = useState<{
    readonly key: number;
    readonly sources?: readonly Source[];
    readonly catalog?: Catalog;
    readonly topics?: readonly Topic[];
    readonly error?: unknown;
  }>();
  const [busy, setBusy] = useState<number>();
  const [deleting, setDeleting] = useState<Source>();
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    void Promise.all([
      api.request<{ data: Source[] }>({ path: 'feedSources', signal }),
      api.request<{ data: Catalog }>({ path: 'feedCatalog', signal }),
      api.request<{ data: Topic[] }>({ path: 'feedTopics', signal }),
    ]).then(
      ([sources, catalog, topics]) => {
        if (!signal.aborted)
          setResult({
            key: reloadCount,
            sources: sources.data,
            catalog: catalog.data,
            topics: topics.data,
          });
      },
      (error: unknown) => {
        if (!signal.aborted) setResult({ key: reloadCount, error });
      },
    );
    return () => controller.abort();
  }, [api, reloadCount]);

  const loading = result?.key !== reloadCount;
  const error = loading ? undefined : result?.error;
  const sources = result?.sources;
  const catalog = result?.catalog;
  const context: SourcesOutletContext = {
    reload,
    sources,
    catalog,
    topics: result?.topics ?? [],
  };

  const failed = (cause: unknown): void => {
    const problem = requestProblem(cause);
    toaster.show({ type: 'error', title: t(`feed.errors.${problem}`) });
    if (problem === 'notFound') reload();
  };

  const run = async (source: Source): Promise<void> => {
    setBusy(source.id);
    const id = toaster.show({
      type: 'loading',
      title: t('sources.running', { name: source.name }),
    });
    try {
      const { data } = await api.request<{ data: Run }>({
        path: `feedSources/${encodeURIComponent(source.id)}/run`,
        method: 'POST',
      });
      // A run ends `succeeded`, or `partial` when the result was cut off before reaching items seen earlier.
      const ok = data.status === 'succeeded' || data.status === 'partial';
      toaster.show({
        id,
        type: ok ? 'success' : 'warning',
        title: ok
          ? t('sources.runDone', {
              name: source.name,
              found: data.found,
              inserted: data.inserted,
            })
          : t('sources.runProblem', {
              name: source.name,
              status: t(`feed.status.${data.status}`, {
                defaultValue: data.status,
              }),
            }),
      });
      reload();
    } catch (cause: unknown) {
      toaster.close(id);
      failed(cause);
    } finally {
      setBusy(undefined);
    }
  };

  const toggle = async (source: Source, active: boolean): Promise<void> => {
    setBusy(source.id);
    try {
      await api.request<{ data: Source }>({
        path: `feedSources/${encodeURIComponent(source.id)}`,
        method: 'PATCH',
        json: { active },
      });
      toaster.show({
        type: 'success',
        title: active
          ? t('sources.resumed', { name: source.name })
          : t('sources.paused', { name: source.name }),
      });
      reload();
    } catch (cause: unknown) {
      failed(cause);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <PageContainer className='max-w-7xl'>
      <PageHeader
        title={t('sources.title')}
        description={t('sources.description')}
        actions={
          <Link to='new' className={buttonVariants()}>
            <PlusIcon data-icon='inline-start' />
            {t('sources.create')}
          </Link>
        }
      />
      {catalog ? <EngineNotice catalog={catalog} /> : null}
      {error ? <LoadProblem error={error} onRetry={reload} /> : null}
      {!sources && !error ? (
        <Skeleton
          className='h-48 w-full'
          role='status'
          aria-label={t('feed.loading')}
        />
      ) : null}
      {sources && sources.length === 0 ? (
        <Empty className='rounded-xl border border-dashed'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <RssIcon />
            </EmptyMedia>
            <EmptyTitle>{t('sources.empty.title')}</EmptyTitle>
            <EmptyDescription>
              {t('sources.empty.description')}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link to='new' className={buttonVariants()}>
              {t('sources.create')}
            </Link>
          </EmptyContent>
        </Empty>
      ) : null}
      {sources && sources.length > 0 ? (
        <div className='overflow-x-auto rounded-xl border bg-card'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('sources.columns.name')}</TableHead>
                <TableHead>{t('sources.columns.frequency')}</TableHead>
                <TableHead>{t('sources.columns.status')}</TableHead>
                <TableHead>{t('sources.columns.lastRun')}</TableHead>
                <TableHead>{t('sources.columns.nextRun')}</TableHead>
                <TableHead>{t('sources.columns.active')}</TableHead>
                <TableHead className='text-right'>
                  <span className='sr-only'>
                    {t('sources.columns.actions')}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map((source) => {
                const message = messageText(t, source.statusMessage);
                return (
                  <TableRow key={source.id}>
                    <TableCell className='max-w-[22rem]'>
                      <div className='flex items-center gap-2'>
                        <PlatformBadge platform={source.platform} />
                        <span className='truncate font-medium'>
                          {source.name}
                        </span>
                      </div>
                      <p className='mt-1 truncate text-xs text-muted-foreground'>
                        {t(
                          `sources.operations.${source.platform}.${source.operation}`,
                          {
                            defaultValue: source.operation,
                          },
                        )}
                        {source.target && !targetless(catalog, source)
                          ? ` · ${source.target}`
                          : ''}
                      </p>
                    </TableCell>
                    <TableCell>{frequencyText(t, source.frequency)}</TableCell>
                    <TableCell className='max-w-[16rem]'>
                      <span className='flex flex-wrap gap-1'>
                        <RunStatusBadge status={source.status} />
                        <HealthBadge source={source} />
                      </span>
                      {message ? (
                        <p className='mt-1 text-xs whitespace-normal text-muted-foreground'>
                          {message}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell
                      title={absoluteTime(source.lastRunAt, i18n.language)}
                    >
                      {relativeTime(source.lastRunAt, i18n.language)}
                    </TableCell>
                    <TableCell
                      title={absoluteTime(source.nextRunAt, i18n.language)}
                    >
                      {source.active
                        ? relativeTime(source.nextRunAt, i18n.language)
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={source.active}
                        disabled={busy === source.id}
                        aria-label={t('sources.activeFor', {
                          name: source.name,
                        })}
                        onCheckedChange={(checked) =>
                          void toggle(source, checked)
                        }
                      />
                    </TableCell>
                    <TableCell className='text-right'>
                      <div className='flex items-center justify-end gap-1'>
                        <Button
                          type='button'
                          size='sm'
                          variant='outline'
                          disabled={busy !== undefined}
                          onClick={() => void run(source)}
                        >
                          {busy === source.id ? (
                            <Spinner data-icon='inline-start' />
                          ) : (
                            <PlayIcon data-icon='inline-start' />
                          )}
                          {t('sources.runNow')}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant='ghost'
                                size='icon-sm'
                                aria-label={t('sources.actionsFor', {
                                  name: source.name,
                                })}
                              />
                            }
                          >
                            <MoreHorizontalIcon />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align='end'>
                            <DropdownMenuItem
                              onClick={() => void navigate(`${source.id}/edit`)}
                            >
                              <PencilIcon />
                              {t('feed.common.edit')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant='destructive'
                              onClick={() => {
                                setDeleting(source);
                                setDeleteOpen(true);
                              }}
                            >
                              <Trash2Icon />
                              {t('feed.common.delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}
      <DeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        target={
          deleting
            ? {
                name: deleting.name,
                path: `feedSources/${encodeURIComponent(deleting.id)}`,
              }
            : undefined
        }
        title={t('sources.delete.title', { name: deleting?.name ?? '' })}
        description={t('sources.delete.description')}
        successTitle={t('sources.delete.success', {
          name: deleting?.name ?? '',
        })}
        onDeleted={() => {
          setDeleteOpen(false);
          reload();
        }}
      />
      <Outlet context={context} />
    </PageContainer>
  );
}

/** Whether the subscription's operation takes no target, so its stored target is an internal value. */
function targetless(catalog: Catalog | undefined, source: Source): boolean {
  return (
    catalog?.platforms
      .find((entry) => entry.platform === source.platform)
      ?.operations.find((entry) => entry.operation === source.operation)
      ?.input === 'none'
  );
}

/** Says plainly what runs without a Collector or a model, so nobody wonders why a platform stays empty. */
function EngineNotice({
  catalog,
}: {
  readonly catalog: Catalog;
}): ReactElement | null {
  const { t } = useTranslation();
  if (catalog.collectorConfigured && catalog.model.available) return null;
  return (
    <div className='grid gap-3 md:grid-cols-2'>
      {!catalog.model.available ? (
        <Alert>
          <CpuIcon />
          <AlertTitle>{t('sources.notice.modelTitle')}</AlertTitle>
          <AlertDescription>
            {t('sources.notice.modelDescription')}
          </AlertDescription>
        </Alert>
      ) : null}
      {!catalog.collectorConfigured ? (
        <Alert>
          <InfoIcon />
          <AlertTitle>{t('sources.notice.collectorTitle')}</AlertTitle>
          <AlertDescription>
            {t('sources.notice.collectorDescription')}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
