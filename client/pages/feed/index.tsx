import { useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  AlertTriangleIcon,
  BookmarkIcon,
  ClockIcon,
  InboxIcon,
  KeyboardIcon,
  ListIcon,
  MessagesSquareIcon,
  GraduationCapIcon,
  CheckCheckIcon,
  LayersIcon,
  RefreshCwIcon,
  Rows3Icon,
  SearchIcon,
  SunriseIcon,
} from 'lucide-react';
import {
  type FormEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { Link, useSearchParams } from 'react-router';

import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { Alert, AlertAction, AlertDescription } from '#components/ui/alert';
import { Button, buttonVariants } from '#components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '#components/ui/empty';
import { Input } from '#components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '#components/ui/sheet';
import { Skeleton } from '#components/ui/skeleton';
import { Spinner } from '#components/ui/spinner';
import { cn } from 'cn';

import { DigestPanel } from './digest.js';
import { type Density, FeedCard } from './feed-card.js';
import { requestProblem } from './format.js';
import { ItemDetail } from './item-detail.js';
import { LoadProblem } from './parts.js';
import { ShortcutHelp } from './shortcuts.js';
import { type ShortcutAction, useFeedShortcuts } from './use-feed-shortcuts.js';
import {
  type FeedListItem,
  type FeedSummary,
  type FeedView,
  type ItemState,
  PLATFORMS,
  type Platform,
  type Topic,
  VIEWS,
} from './types.js';
import { useMediaQuery } from './use-media-query.js';

const VIEW_ICONS = {
  digest: SunriseIcon,
  all: LayersIcon,
  discuss: MessagesSquareIcon,
  learn: GraduationCapIcon,
  saved: BookmarkIcon,
  later: ClockIcon,
  participated: CheckCheckIcon,
} as const;

const PAGE_SIZE = 30;
const ALL = '__all';
const DENSITY_KEY = 'nocofeed:feed-density';

function storedDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === 'compact'
      ? 'compact'
      : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

interface ListResult {
  readonly key: string;
  readonly items?: readonly FeedListItem[];
  readonly nextPageToken?: string | null;
  readonly error?: unknown;
}

export default function FeedPage(): ReactElement {
  const { t, i18n } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const [params, setParams] = useSearchParams();
  const wide = useMediaQuery('(min-width: 1280px)');

  const view = (VIEWS as readonly string[]).includes(params.get('view') ?? '')
    ? (params.get('view') as FeedView)
    : 'all';
  const platform = (PLATFORMS as readonly string[]).includes(
    params.get('platform') ?? '',
  )
    ? (params.get('platform') as Platform)
    : undefined;
  const topicId = Number(params.get('topic')) || undefined;
  const q = params.get('q') ?? '';
  const selectedId = Number(params.get('item')) || undefined;

  const update = (changes: Record<string, string | undefined>): void => {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined || value === '') next.delete(name);
      else next.set(name, value);
    }
    setParams(next);
  };

  // Lists, counts and topics reload together after the page's own writes and on "Refresh".
  const [reloadCount, setReloadCount] = useState(0);
  const reload = useCallback(() => setReloadCount((count) => count + 1), []);

  const filterKey = JSON.stringify([view, platform, topicId, q]);
  const requestKey = `${filterKey}:${reloadCount}`;
  const [list, setList] = useState<ListResult>();
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (view === 'digest') return;
    const controller = new AbortController();
    const key = `${filterKey}:${reloadCount}`;
    api
      .request<{
        data: FeedListItem[];
        meta: { nextPageToken: string | null };
      }>({
        path: 'feedItems',
        query: {
          view,
          platform,
          topicId,
          q: q || undefined,
          pageSize: PAGE_SIZE,
        },
        signal: controller.signal,
      })
      .then(
        ({ data, meta }) => {
          if (!controller.signal.aborted)
            setList({ key, items: data, nextPageToken: meta.nextPageToken });
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setList({ key, error });
        },
      );
    return () => controller.abort();
  }, [api, filterKey, reloadCount, view, platform, topicId, q]);

  // Counts alone reload after a keyboard action, so the list keeps its place.
  const [countsVersion, setCountsVersion] = useState(0);
  const [summary, setSummary] = useState<FeedSummary>();
  const [topics, setTopics] = useState<readonly Topic[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api.request<{ data: FeedSummary }>({
        path: 'feedItems/summary',
        signal: controller.signal,
      }),
      api.request<{ data: Topic[] }>({
        path: 'feedTopics',
        signal: controller.signal,
      }),
    ]).then(
      ([summaryResponse, topicsResponse]) => {
        if (controller.signal.aborted) return;
        setSummary(summaryResponse.data);
        setTopics(topicsResponse.data);
      },
      // The counts and topic names are decoration; the list shows the load error.
      () => undefined,
    );
    return () => controller.abort();
  }, [api, reloadCount, countsVersion]);

  const loading = view !== 'digest' && list?.key !== requestKey;
  const sameFilter = list?.key.startsWith(`${filterKey}:`) ?? false;
  const items = sameFilter ? list?.items : undefined;
  const error = loading ? undefined : list?.error;

  const loadMore = (): void => {
    const token = list?.nextPageToken;
    if (!token || !list) return;
    const key = list.key;
    setLoadingMore(true);
    api
      .request<{
        data: FeedListItem[];
        meta: { nextPageToken: string | null };
      }>({
        path: 'feedItems',
        query: {
          view,
          platform,
          topicId,
          q: q || undefined,
          pageSize: PAGE_SIZE,
          pageToken: token,
        },
      })
      .then(
        ({ data, meta }) => {
          setList((current) =>
            current?.key === key
              ? {
                  key,
                  items: [...(current.items ?? []), ...data],
                  nextPageToken: meta.nextPageToken,
                }
              : current,
          );
          setLoadingMore(false);
        },
        (loadError: unknown) => {
          setList((current) =>
            current?.key === key ? { ...current, error: loadError } : current,
          );
          setLoadingMore(false);
        },
      );
  };

  // A change made in the detail shows on the card at once; the counts follow with the next reload.
  const onStateChange = (id: number, state: ItemState): void => {
    setList((current) =>
      current?.items
        ? {
            ...current,
            items: current.items.map((item) =>
              item.id === id
                ? {
                    ...item,
                    favorite: state.favorite,
                    later: state.later,
                    participated: state.participated,
                    newReplies: state.followUp?.newReplies ?? 0,
                  }
                : item,
            ),
          }
        : current,
    );
  };

  const [density, setDensity] = useState<Density>(storedDensity);
  const changeDensity = (next: Density): void => {
    setDensity(next);
    try {
      localStorage.setItem(DENSITY_KEY, next);
    } catch {
      // Remembering the choice is a convenience; the page works without it.
    }
  };

  // A keyboard change remounts the open detail so it shows the new state.
  const [detailVersion, setDetailVersion] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);

  const patchState = async (
    item: FeedListItem,
    changes: Partial<Pick<ItemState, 'favorite' | 'later' | 'dismissed'>>,
  ): Promise<ItemState | undefined> => {
    try {
      const { data } = await api.request<{ data: ItemState }>({
        path: `feedItems/${encodeURIComponent(item.id)}/state`,
        method: 'PATCH',
        json: changes,
      });
      setCountsVersion((count) => count + 1);
      if (item.id === selectedId) setDetailVersion((count) => count + 1);
      return data;
    } catch (cause: unknown) {
      toaster.show({
        type: 'error',
        title: t(`feed.errors.${requestProblem(cause)}`),
      });
      return undefined;
    }
  };

  const dismiss = async (item: FeedListItem): Promise<void> => {
    const visible = items ?? [];
    const index = visible.findIndex((entry) => entry.id === item.id);
    const next = visible[index + 1] ?? visible[index - 1];
    const state = await patchState(item, { dismissed: true });
    if (!state) return;
    if (['all', 'discuss', 'learn'].includes(view)) {
      setList((current) =>
        current?.items
          ? {
              ...current,
              items: current.items.filter((entry) => entry.id !== item.id),
            }
          : current,
      );
      update({
        item: next && next.id !== item.id ? String(next.id) : undefined,
      });
    }
    toaster.show({
      id: `feed-dismissed-${item.id}`,
      type: 'success',
      title: t('feed.shortcuts.dismissed'),
      description: item.title,
      action: {
        label: t('feed.shortcuts.undo'),
        onClick: () => {
          void patchState(item, { dismissed: false }).then(
            (restored) => restored && reload(),
          );
        },
      },
    });
  };

  const runShortcut = (action: ShortcutAction): void => {
    if (action === 'help') {
      setHelpOpen((open) => !open);
      return;
    }
    if (action === 'close') {
      update({ item: undefined });
      return;
    }
    const visible = items ?? [];
    if (!visible.length) return;
    const index = visible.findIndex((item) => item.id === selectedId);
    if (action === 'next' || action === 'previous') {
      const target =
        index < 0
          ? 0
          : Math.min(
              visible.length - 1,
              Math.max(0, index + (action === 'next' ? 1 : -1)),
            );
      update({ item: String(visible[target].id) });
      return;
    }
    const current = visible[index];
    if (!current) return;
    if (action === 'open') {
      if (current.url)
        window.open(current.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (action === 'dismiss') {
      void dismiss(current);
      return;
    }
    const key = action === 'favorite' ? 'favorite' : 'later';
    void patchState(current, { [key]: !current[key] }).then((state) => {
      if (!state) return;
      onStateChange(current.id, state);
      toaster.show({
        id: `feed-${key}-${current.id}`,
        type: 'success',
        title: t(`feed.shortcuts.${key}${state[key] ? 'On' : 'Off'}`),
      });
    });
  };
  useFeedShortcuts(view !== 'digest' || Boolean(selectedId), runShortcut);

  // Keep the selected card in sight while moving with the keyboard.
  useEffect(() => {
    if (!selectedId) return;
    document
      .querySelector(`[data-item-id="${selectedId}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);

  const topicNames = new Map(topics.map((topic) => [topic.id, topic.name]));
  const filtered = Boolean(platform || topicId || q || view !== 'all');

  const detail = selectedId ? (
    <ItemDetail
      key={`${selectedId}:${detailVersion}`}
      itemId={selectedId}
      topicNames={topicNames}
      onClose={() => update({ item: undefined })}
      onStateChange={onStateChange}
      onChanged={reload}
    />
  ) : null;

  return (
    <PageContainer className='max-w-[1600px]'>
      <PageHeader
        title={t('feed.title')}
        description={t('feed.description')}
        actions={
          <>
            <Button
              type='button'
              variant='ghost'
              size='icon'
              className='hidden md:inline-flex'
              aria-label={t('feed.shortcuts.title')}
              title={t('feed.shortcuts.title')}
              onClick={() => setHelpOpen(true)}
            >
              <KeyboardIcon />
            </Button>
            <Button
              type='button'
              variant='outline'
              disabled={loading}
              onClick={reload}
            >
              {loading && items ? (
                <Spinner data-icon='inline-start' />
              ) : (
                <RefreshCwIcon data-icon='inline-start' />
              )}
              {t('feed.refresh')}
            </Button>
          </>
        }
      />
      <ShortcutHelp open={helpOpen} onOpenChange={setHelpOpen} />

      <div className='grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[13rem_minmax(0,1fr)_minmax(0,28rem)]'>
        <FeedRail
          view={view}
          summary={summary}
          platform={platform}
          topicId={topicId}
          topics={topics}
          onChange={update}
        />

        <section
          aria-label={t('feed.listLabel')}
          className='flex min-w-0 flex-col gap-3'
        >
          {summary && summary.unhealthySources > 0 ? (
            <Alert>
              <AlertTriangleIcon />
              <AlertDescription>
                {t('feed.health.banner', { count: summary.unhealthySources })}
              </AlertDescription>
              <AlertAction>
                <Link
                  to='/sources'
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  {t('feed.health.review')}
                </Link>
              </AlertAction>
            </Alert>
          ) : null}
          {view === 'digest' ? (
            <DigestPanel
              reloadCount={reloadCount}
              selectedId={selectedId}
              topicNames={topicNames}
              onSelect={(id) => update({ item: String(id) })}
              onRetry={reload}
            />
          ) : (
            <>
              <div className='flex items-center gap-2'>
                <div className='min-w-0 flex-1'>
                  <SearchBox
                    key={q}
                    initial={q}
                    onSearch={(value) => update({ q: value, item: undefined })}
                  />
                </div>
                <div
                  role='group'
                  aria-label={t('feed.density.label')}
                  className='flex shrink-0 rounded-md border p-0.5'
                >
                  {(
                    [
                      ['comfortable', Rows3Icon],
                      ['compact', ListIcon],
                    ] as const
                  ).map(([value, Icon]) => (
                    <Button
                      key={value}
                      type='button'
                      size='icon-sm'
                      variant='ghost'
                      aria-pressed={density === value}
                      aria-label={t(`feed.density.${value}`)}
                      title={t(`feed.density.${value}`)}
                      className='aria-pressed:bg-muted aria-pressed:text-foreground'
                      onClick={() => changeDensity(value)}
                    >
                      <Icon />
                    </Button>
                  ))}
                </div>
              </div>
              {error ? <LoadProblem error={error} onRetry={reload} /> : null}
              {!items && !error ? <ListSkeleton /> : null}
              {items && items.length === 0 ? (
                <EmptyFeed
                  filtered={filtered}
                  onClear={() =>
                    update({
                      view: undefined,
                      platform: undefined,
                      topic: undefined,
                      q: undefined,
                    })
                  }
                />
              ) : null}
              {items && items.length > 0 ? (
                <ul
                  className={cn(
                    'flex flex-col',
                    density === 'compact'
                      ? 'gap-0.5 rounded-xl border bg-card p-1'
                      : 'gap-2',
                  )}
                >
                  {items.map((item) => (
                    <li key={item.id}>
                      <FeedCard
                        density={density}
                        item={item}
                        language={i18n.language}
                        topicName={
                          item.topicId
                            ? topicNames.get(item.topicId)
                            : undefined
                        }
                        selected={item.id === selectedId}
                        onSelect={() => update({ item: String(item.id) })}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              {items && list?.nextPageToken ? (
                <Button
                  type='button'
                  variant='outline'
                  className='self-center'
                  disabled={loadingMore}
                  onClick={loadMore}
                >
                  {loadingMore ? <Spinner data-icon='inline-start' /> : null}
                  {t('feed.loadMore')}
                </Button>
              ) : null}
              {items && items.length > 0 ? (
                <p className='hidden text-center text-xs text-muted-foreground md:block'>
                  {t('feed.shortcuts.hint')}
                </p>
              ) : null}
            </>
          )}
        </section>

        {wide ? (
          <aside
            aria-label={t('feed.detail.label')}
            data-feed-detail=''
            data-feed-detail-open={selectedId ? '' : undefined}
            className='sticky top-4 hidden max-h-[calc(100svh-6rem)] min-w-0 overflow-y-auto rounded-xl border bg-card xl:block'
          >
            {detail ?? (
              <p className='p-6 text-sm text-muted-foreground'>
                {t('feed.detail.placeholder')}
              </p>
            )}
          </aside>
        ) : (
          <Sheet
            open={Boolean(selectedId)}
            onOpenChange={(open) => {
              if (!open) update({ item: undefined });
            }}
          >
            <SheetContent
              data-feed-detail=''
              showCloseButton={false}
              className='overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl'
            >
              <SheetHeader className='sr-only'>
                <SheetTitle>{t('feed.detail.label')}</SheetTitle>
                <SheetDescription>
                  {t('feed.detail.placeholder')}
                </SheetDescription>
              </SheetHeader>
              {detail}
            </SheetContent>
          </Sheet>
        )}
      </div>
    </PageContainer>
  );
}

function FeedRail({
  view,
  summary,
  platform,
  topicId,
  topics,
  onChange,
}: {
  readonly view: FeedView;
  readonly summary?: FeedSummary;
  readonly platform?: Platform;
  readonly topicId?: number;
  readonly topics: readonly Topic[];
  readonly onChange: (changes: Record<string, string | undefined>) => void;
}): ReactElement {
  const { t } = useTranslation();
  const platformItems = [
    { value: ALL, label: t('feed.filters.allPlatforms') },
    ...PLATFORMS.map((value) => ({
      value,
      label: t(`feed.platforms.${value}`),
    })),
  ];
  const topicItems = [
    { value: ALL, label: t('feed.filters.allTopics') },
    ...topics.map((topic) => ({ value: String(topic.id), label: topic.name })),
  ];
  return (
    <nav
      aria-label={t('feed.views.label')}
      className='flex min-w-0 flex-col gap-4'
    >
      <ul className='flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible'>
        {VIEWS.map((value) => {
          const Icon = VIEW_ICONS[value];
          const current = value === view;
          return (
            <li key={value} className='shrink-0'>
              <button
                type='button'
                aria-current={current ? 'page' : undefined}
                onClick={() =>
                  onChange({
                    view: value === 'all' ? undefined : value,
                    item: undefined,
                  })
                }
                className={cn(
                  buttonVariants({ variant: 'ghost' }),
                  'w-full justify-start gap-2 text-muted-foreground aria-[current=page]:bg-primary/10 aria-[current=page]:text-primary',
                )}
              >
                <Icon />
                <span className='flex-1 text-left'>
                  {t(`feed.views.${value}`)}
                </span>
                {value === 'participated' && summary?.newReplies ? (
                  <span
                    className='rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums'
                    title={t('feed.followUp.newReplies', {
                      count: summary.newReplies,
                    })}
                  >
                    +{summary.newReplies}
                  </span>
                ) : null}
                <span className='text-xs tabular-nums'>
                  {summary && value !== 'digest' ? summary[value] : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className='grid grid-cols-2 gap-2 lg:grid-cols-1'>
        <Select
          items={platformItems}
          value={platform ?? ALL}
          onValueChange={(value) =>
            onChange({
              platform: !value || value === ALL ? undefined : String(value),
              item: undefined,
            })
          }
        >
          <SelectTrigger
            className='w-full'
            aria-label={t('feed.filters.platform')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {platformItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          items={topicItems}
          value={topicId ? String(topicId) : ALL}
          onValueChange={(value) =>
            onChange({
              topic: !value || value === ALL ? undefined : String(value),
              item: undefined,
            })
          }
        >
          <SelectTrigger
            className='w-full'
            aria-label={t('feed.filters.topic')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {topicItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </nav>
  );
}

function SearchBox({
  initial,
  onSearch,
}: {
  readonly initial: string;
  readonly onSearch: (value: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSearch(value.trim());
  };
  return (
    <form role='search' onSubmit={submit} className='relative'>
      <SearchIcon className='pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground' />
      <Input
        type='search'
        value={value}
        maxLength={200}
        onChange={(event) => setValue(event.target.value)}
        placeholder={t('feed.searchPlaceholder')}
        aria-label={t('feed.searchLabel')}
        className='pl-8'
      />
    </form>
  );
}

function ListSkeleton(): ReactElement {
  const { t } = useTranslation();
  return (
    <div
      className='flex flex-col gap-2'
      role='status'
      aria-label={t('feed.loading')}
    >
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} className='h-28 w-full rounded-xl' />
      ))}
    </div>
  );
}

function EmptyFeed({
  filtered,
  onClear,
}: {
  readonly filtered: boolean;
  readonly onClear: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Empty className='rounded-xl border border-dashed'>
      <EmptyHeader>
        <EmptyMedia variant='icon'>
          <InboxIcon />
        </EmptyMedia>
        <EmptyTitle>
          {filtered ? t('feed.empty.filteredTitle') : t('feed.empty.title')}
        </EmptyTitle>
        <EmptyDescription>
          {filtered
            ? t('feed.empty.filteredDescription')
            : t('feed.empty.description')}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {filtered ? (
          <Button type='button' variant='outline' onClick={onClear}>
            {t('feed.empty.clear')}
          </Button>
        ) : (
          <Link to='/sources/new' className={buttonVariants()}>
            {t('feed.empty.addSource')}
          </Link>
        )}
      </EmptyContent>
    </Empty>
  );
}
