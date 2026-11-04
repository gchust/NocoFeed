import { useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TagsIcon,
  Trash2Icon,
} from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router';

import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { StatusBadge } from '#components/status-badge';
import { Button, buttonVariants } from '#components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#components/ui/card';
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

import { DeleteDialog } from '../feed/delete-dialog.js';
import { frequencyText, relativeTime, requestProblem } from '../feed/format.js';
import { LoadProblem, PlatformBadge } from '../feed/parts.js';
import type { Catalog, Platform, Source, Topic } from '../feed/types.js';
import { searchablePlatforms, type TopicsOutletContext } from './types.js';

export default function TopicsPage(): ReactElement {
  const { t, i18n } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const navigate = useNavigate();
  const [starting, setStarting] = useState<number>();
  const [reloadCount, setReloadCount] = useState(0);
  const reload = useCallback(() => setReloadCount((count) => count + 1), []);
  const [result, setResult] = useState<{
    readonly key: number;
    readonly topics?: readonly Topic[];
    readonly sources?: readonly Source[];
    readonly catalog?: Catalog;
    readonly error?: unknown;
  }>();
  const [deleting, setDeleting] = useState<Topic>();
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api.request<{ data: Topic[] }>({
        path: 'feedTopics',
        signal: controller.signal,
      }),
      api.request<{ data: Source[] }>({
        path: 'feedSources',
        signal: controller.signal,
      }),
      api.request<{ data: Catalog }>({
        path: 'feedCatalog',
        signal: controller.signal,
      }),
    ]).then(
      ([topics, sources, catalog]) => {
        if (!controller.signal.aborted)
          setResult({
            key: reloadCount,
            topics: topics.data,
            sources: sources.data,
            catalog: catalog.data,
          });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setResult({ key: reloadCount, error });
      },
    );
    return () => controller.abort();
  }, [api, reloadCount]);

  const loading = result?.key !== reloadCount;
  const error = loading ? undefined : result?.error;
  const topics = result?.topics;
  const sources = result?.sources ?? [];
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const catalog = result?.catalog;
  const searchable = searchablePlatforms(catalog).map(
    (entry) => entry.platform,
  );
  const context: TopicsOutletContext = { reload, sources, topics, catalog };

  const runSearches = async (topic: Topic): Promise<void> => {
    setStarting(topic.id);
    try {
      const { data } = await api.request<{ data: { started: number } }>({
        path: `feedTopics/${encodeURIComponent(topic.id)}/run`,
        method: 'POST',
      });
      toaster.show({
        type: 'success',
        title: t('topics.searchStarted', {
          name: topic.name,
          count: data.started,
        }),
        description: t('topics.searchStartedHint'),
      });
    } catch (cause: unknown) {
      toaster.show({
        type: 'error',
        title: t(`feed.errors.${requestProblem(cause)}`),
      });
    } finally {
      setStarting(undefined);
    }
  };

  return (
    <PageContainer className='max-w-6xl'>
      <PageHeader
        title={t('topics.title')}
        description={t('topics.description')}
        actions={
          <Link to='new' className={buttonVariants()}>
            <PlusIcon data-icon='inline-start' />
            {t('topics.create')}
          </Link>
        }
      />
      {error ? <LoadProblem error={error} onRetry={reload} /> : null}
      {!topics && !error ? (
        <div
          className='grid gap-4 md:grid-cols-2'
          role='status'
          aria-label={t('feed.loading')}
        >
          <Skeleton className='h-40' />
          <Skeleton className='h-40' />
        </div>
      ) : null}
      {topics && topics.length === 0 ? (
        <Empty className='rounded-xl border border-dashed'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <TagsIcon />
            </EmptyMedia>
            <EmptyTitle>{t('topics.empty.title')}</EmptyTitle>
            <EmptyDescription>{t('topics.empty.description')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link to='new' className={buttonVariants()}>
              {t('topics.create')}
            </Link>
          </EmptyContent>
        </Empty>
      ) : null}
      {topics && topics.length > 0 ? (
        <ul className='grid gap-4 md:grid-cols-2'>
          {topics.map((topic) => (
            <li key={topic.id} className='flex'>
              <Card className='w-full'>
                <CardHeader>
                  <CardTitle className='flex items-center gap-2'>
                    {topic.name}
                    <StatusBadge size='sm' tone='info'>
                      {t(`topics.modes.${topic.mode}`)}
                    </StatusBadge>
                  </CardTitle>
                  <CardDescription className='line-clamp-3 whitespace-pre-line'>
                    {topic.goal}
                  </CardDescription>
                  <CardAction>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant='ghost'
                            size='icon-sm'
                            aria-label={t('topics.actionsFor', {
                              name: topic.name,
                            })}
                          />
                        }
                      >
                        <MoreHorizontalIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align='end'>
                        {topic.searches.length > 0 ? (
                          <DropdownMenuItem
                            disabled={starting === topic.id}
                            onClick={() => void runSearches(topic)}
                          >
                            <SearchIcon />
                            {t('topics.searchNow')}
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem
                          onClick={() => void navigate(`${topic.id}/edit`)}
                        >
                          <PencilIcon />
                          {t('feed.common.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant='destructive'
                          onClick={() => {
                            setDeleting(topic);
                            setDeleteOpen(true);
                          }}
                        >
                          <Trash2Icon />
                          {t('feed.common.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </CardAction>
                </CardHeader>
                <CardContent className='flex flex-col gap-3 text-sm'>
                  {topic.avoid ? (
                    <p className='text-muted-foreground'>
                      <span className='font-medium text-foreground'>
                        {t('topics.fields.avoid')}
                      </span>
                      {t('feed.common.colon')}
                      {topic.avoid}
                    </p>
                  ) : null}
                  <TopicSearches
                    topic={topic}
                    platforms={
                      topic.searchPlatforms.length
                        ? topic.searchPlatforms
                        : searchable
                    }
                    language={i18n.language}
                  />
                  <div className='flex flex-wrap items-center gap-1.5'>
                    <span className='text-xs text-muted-foreground'>
                      {t('topics.sources')}
                    </span>
                    {topic.sourceIds.length === 0 ? (
                      <span className='text-xs text-muted-foreground'>
                        {t('topics.allSources')}
                      </span>
                    ) : (
                      topic.sourceIds.map((id) => {
                        const source = sourceById.get(id);
                        return source ? (
                          <span
                            key={id}
                            className='inline-flex items-center gap-1 text-xs'
                          >
                            <PlatformBadge platform={source.platform} />
                            {source.name}
                          </span>
                        ) : null;
                      })
                    )}
                  </div>
                  <Link
                    to={`/?topic=${topic.id}`}
                    className='self-start text-xs text-primary hover:underline'
                  >
                    {t('topics.openFeed')}
                  </Link>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
      <DeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        target={
          deleting
            ? {
                name: deleting.name,
                path: `feedTopics/${encodeURIComponent(deleting.id)}`,
              }
            : undefined
        }
        title={t('topics.delete.title', { name: deleting?.name ?? '' })}
        description={t('topics.delete.description')}
        successTitle={t('topics.delete.success', {
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

/** What the topic searches for, where, and how the searches are doing. */
function TopicSearches({
  topic,
  platforms,
  language,
}: {
  readonly topic: Topic;
  readonly platforms: readonly Platform[];
  readonly language: string;
}): ReactElement {
  const { t } = useTranslation();
  if (topic.searchTerms.length === 0)
    return (
      <p className='text-xs text-muted-foreground'>{t('topics.noSearch')}</p>
    );
  const failing = topic.searches.filter(
    (search) => search.health === 'failing',
  ).length;
  const lastRun = topic.searches
    .map((search) => search.lastRunAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  return (
    <div className='flex flex-col gap-1.5'>
      <div className='flex flex-wrap items-center gap-1.5'>
        <span className='text-xs text-muted-foreground'>
          {t('topics.searchesFor')}
        </span>
        {topic.searchTerms.map((term) => (
          <StatusBadge key={term} size='sm' tone='neutral'>
            {term}
          </StatusBadge>
        ))}
      </div>
      <div className='flex flex-wrap items-center gap-1.5'>
        <span className='text-xs text-muted-foreground'>
          {t('topics.searchesOn')}
        </span>
        {platforms.map((platform) => (
          <PlatformBadge key={platform} platform={platform} />
        ))}
      </div>
      <p className='text-xs text-muted-foreground'>
        {t('topics.searchSummary', {
          count: topic.searches.length,
          frequency: frequencyText(t, topic.searchFrequency),
          lastRun: relativeTime(lastRun, language),
        })}
        {failing > 0 ? (
          <>
            {t('feed.common.listSeparator')}
            <span className='text-destructive'>
              {t('topics.searchesFailing', { count: failing })}
            </span>
          </>
        ) : null}
      </p>
    </div>
  );
}
