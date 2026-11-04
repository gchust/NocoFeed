import { useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { CheckIcon, PlusIcon, SearchIcon } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router';

import { RouteDialog } from '#components/route-dialog';
import { StatusBadge } from '#components/status-badge';
import { Button } from '#components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '#components/ui/empty';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '#components/ui/input-group';
import { Skeleton } from '#components/ui/skeleton';
import { Spinner } from '#components/ui/spinner';
import { useRouteOverlay } from '#components/use-route-overlay';

import { requestProblem } from '../feed/format.js';
import { PlatformBadge } from '../feed/parts.js';
import type { Catalog, Source } from '../feed/types.js';
import {
  filterPresets,
  PRESET_CATEGORIES,
  type PresetCategory,
  SOURCE_PRESETS,
  type SourcePreset,
  subscribedPresetIds,
} from './presets.js';
import type { SourcesOutletContext } from './types.js';

/** `/sources/recommended`: pick subscriptions from a curated list and add each with one click. */
export default function RecommendedSourcesDialog(): ReactElement {
  const { t } = useTranslation();
  const { sources, catalog } = useOutletContext<SourcesOutletContext>();

  return (
    <RouteDialog
      title={t('sources.presets.title')}
      description={t('sources.presets.description')}
      className='sm:max-w-3xl'
      footer={<Footer />}
    >
      {!sources || !catalog ? (
        <Skeleton className='h-80' />
      ) : (
        <Body sources={sources} catalog={catalog} />
      )}
    </RouteDialog>
  );
}

function Body({
  sources,
  catalog,
}: {
  readonly sources: readonly Source[];
  readonly catalog: Catalog;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const { reload } = useOutletContext<SourcesOutletContext>();
  const [category, setCategory] = useState<PresetCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState<ReadonlySet<string>>(() => new Set());
  // Added here before the page's list has reloaded, so the button does not flicker back to "Subscribe".
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set());

  const subscribed = useMemo(() => subscribedPresetIds(sources), [sources]);
  const describe = (preset: SourcePreset): string =>
    t(`sources.presets.items.${preset.id}`);
  const shown = filterPresets(SOURCE_PRESETS, { category, query, describe });

  const subscribe = async (preset: SourcePreset): Promise<void> => {
    if (adding.has(preset.id)) return;
    setAdding((current) => new Set(current).add(preset.id));
    try {
      const { data } = await api.request<{ data: Source }>({
        path: 'feedSources',
        method: 'POST',
        json: {
          platform: preset.platform,
          operation: preset.operation,
          name: preset.name,
          target: preset.target,
          frequency: preset.frequency,
          candidateLimit: 20,
        },
      });
      setAdded((current) => new Set(current).add(preset.id));
      toaster.show({
        type: 'success',
        title: t('sources.created', { name: data.name }),
        description: t('sources.createdHint'),
      });
      reload();
    } catch (cause: unknown) {
      const problem = requestProblem(cause);
      toaster.show({
        type: 'error',
        title:
          problem === 'invalid'
            ? t('sources.validation.rejected')
            : t(`feed.errors.${problem}`),
      });
    } finally {
      setAdding((current) => {
        const next = new Set(current);
        next.delete(preset.id);
        return next;
      });
    }
  };

  return (
    <div className='flex flex-col gap-4'>
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          type='search'
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('sources.presets.search')}
          aria-label={t('sources.presets.search')}
        />
      </InputGroup>
      <div
        role='group'
        aria-label={t('sources.presets.categoryLabel')}
        className='flex flex-wrap gap-1.5'
      >
        {(['all', ...PRESET_CATEGORIES] as const).map((value) => (
          <Button
            key={value}
            type='button'
            size='sm'
            variant={category === value ? 'secondary' : 'ghost'}
            aria-pressed={category === value}
            onClick={() => setCategory(value)}
          >
            {t(`sources.presets.categories.${value}`)}
          </Button>
        ))}
      </div>
      <p className='text-xs text-muted-foreground' aria-live='polite'>
        {t('sources.presets.count', { count: shown.length })}
      </p>
      {shown.length === 0 ? (
        <Empty className='rounded-xl border border-dashed'>
          <EmptyHeader>
            <EmptyTitle>{t('sources.presets.empty.title')}</EmptyTitle>
            <EmptyDescription>
              {t('sources.presets.empty.description')}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className='divide-y rounded-xl border'>
          {shown.map((preset) => {
            const operation = catalog.platforms
              .find((entry) => entry.platform === preset.platform)
              ?.operations.find(
                (entry) => entry.operation === preset.operation,
              );
            const isAdded = subscribed.has(preset.id) || added.has(preset.id);
            const busy = adding.has(preset.id);
            return (
              <li
                key={preset.id}
                className='flex items-start gap-3 p-3'
                data-preset={preset.id}
              >
                <div className='min-w-0 flex-1'>
                  <div className='flex flex-wrap items-center gap-1.5'>
                    <span className='font-medium'>{preset.name}</span>
                    <PlatformBadge platform={preset.platform} />
                    {operation?.implementation === 'collector' ? (
                      <StatusBadge size='sm' tone='neutral'>
                        {t('sources.implementation.collector')}
                      </StatusBadge>
                    ) : null}
                    {operation && !operation.available ? (
                      <StatusBadge size='sm' tone='warning'>
                        {t('sources.unavailable')}
                      </StatusBadge>
                    ) : null}
                  </div>
                  <p className='mt-1 text-sm text-muted-foreground'>
                    {describe(preset)}
                  </p>
                  <p className='mt-1 truncate text-xs text-muted-foreground'>
                    {t(
                      `sources.operations.${preset.platform}.${preset.operation}`,
                      { defaultValue: preset.operation },
                    )}
                    {preset.target ? ` · ${preset.target}` : ''}
                  </p>
                </div>
                {isAdded ? (
                  <Button type='button' size='sm' variant='ghost' disabled>
                    <CheckIcon data-icon='inline-start' />
                    {t('sources.presets.added')}
                  </Button>
                ) : (
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    disabled={busy}
                    aria-label={t('sources.presets.subscribeTo', {
                      name: preset.name,
                    })}
                    onClick={() => void subscribe(preset)}
                  >
                    {busy ? (
                      <Spinner data-icon='inline-start' />
                    ) : (
                      <PlusIcon data-icon='inline-start' />
                    )}
                    {t('sources.presets.subscribe')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Footer(): ReactElement {
  const { t } = useTranslation();
  const { close } = useRouteOverlay();
  return (
    <Button type='button' variant='outline' onClick={() => void close()}>
      {t('sources.presets.done')}
    </Button>
  );
}
