import {
  AuthenticationProvider,
  authenticationClientToken,
} from '@nocobase/app-plugin-authentication/client';
import {
  answerApi,
  renderWithApp,
  type ApiCall,
} from '@nocobase/app-testing/client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import type { Catalog, Source } from '../../client/pages/feed/types.js';
import SourcesPage from '../../client/pages/sources/index.js';
import RecommendedSourcesDialog from '../../client/pages/sources/recommended.js';
import packageMetadata from '../../package.json' with { type: 'json' };

const getSession = vi.fn(async () => ({ data: null }));

const subscription = (
  id: number,
  platform: Source['platform'],
  operation: string,
  name: string,
  target: string,
): Source => ({
  id,
  topicId: null,
  platform,
  operation,
  name,
  target,
  frequency: 60,
  candidateLimit: 20,
  active: true,
  status: 'ok',
  statusMessage: null,
  lastRunAt: null,
  lastSuccessAt: null,
  nextRunAt: null,
  failureStreak: 0,
  emptyStreak: 0,
  health: 'ok',
});

const op = (
  operation: string,
  input: 'text' | 'url' | 'none',
  implementation: 'native' | 'collector' = 'native',
) => ({
  operation,
  implementation,
  input,
  single: false,
  capabilities: [],
  available: implementation === 'native',
});

const catalog = {
  collectorConfigured: false,
  model: { available: true, name: 'm' },
  platforms: [
    { platform: 'hn', operations: [op('new', 'none'), op('show', 'none')] },
    { platform: 'reddit', operations: [op('community', 'text')] },
    { platform: 'rss', operations: [op('feed', 'url')] },
    { platform: 'youtube', operations: [op('channel', 'text')] },
    { platform: 'x', operations: [op('account', 'text', 'collector')] },
  ].map((entry) => ({ experimental: false, needsLogin: false, ...entry })),
} as unknown as Catalog;

let sources: Source[] = [];

const api = vi.fn(({ method, path, json }: ApiCall) => {
  if (method === 'GET' && path === 'feedSources') return { data: sources };
  if (method === 'GET' && path === 'feedCatalog') return { data: catalog };
  if (method === 'POST' && path === 'feedSources') {
    const body = json as Omit<Source, 'id'>;
    const created = subscription(
      100 + sources.length,
      body.platform,
      body.operation,
      body.name,
      body.target,
    );
    sources = [...sources, created];
    return new Response(JSON.stringify({ data: created }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(null, { status: 404 });
});

function renderAt(route: string) {
  return renderWithApp(
    <AuthenticationProvider>
      <Routes>
        <Route path='/sources' element={<SourcesPage />}>
          <Route path='recommended' element={<RecommendedSourcesDialog />} />
        </Route>
      </Routes>
    </AuthenticationProvider>,
    {
      route,
      namespace: packageMetadata.name,
      namespaces: { [packageMetadata.name]: enUS },
      fetch: answerApi(api),
      services: (app) => {
        app.container.instance(authenticationClientToken, { getSession });
      },
    },
  );
}

const row = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-preset="${id}"]`)!;

describe('recommended subscriptions dialog', () => {
  beforeEach(() => {
    api.mockClear();
    sources = [
      subscription(1, 'reddit', 'community', 'Rust', 'rust'),
      subscription(2, 'hn', 'new', 'HN', 'hn:new'),
    ];
  });

  it('is offered from the subscriptions page', async () => {
    await renderAt('/sources');
    const link = await screen.findByRole('link', {
      name: 'Browse recommended',
    });
    expect(link.getAttribute('href')).toBe('/sources/recommended');
  });

  it('lists sources by category and search, marking what is already followed', async () => {
    const user = userEvent.setup();
    await renderAt('/sources/recommended');
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(row('simonWillison')).toBeTruthy());

    // Already subscribed under another spelling of the target.
    expect(
      within(row('rust')).getByRole('button', { name: 'Added' }),
    ).toBeTruthy();
    expect(
      within(row('hnNew')).getByRole('button', { name: 'Added' }),
    ).toBeTruthy();
    expect(
      within(row('hnShow')).getByRole('button', {
        name: 'Subscribe to Show HN',
      }),
    ).toBeTruthy();
    // Account posts on X need the Collector, which is not configured here.
    expect(within(row('karpathyX')).getByText('Collector')).toBeTruthy();
    expect(within(row('karpathyX')).getByText('Unavailable')).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Security' }));
    expect(
      within(dialog)
        .getByRole('button', { name: 'Security' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(row('krebs')).toBeTruthy();
    expect(row('simonWillison')).toBeNull();

    await user.type(
      within(dialog).getByRole('searchbox', {
        name: 'Search by name, address or description',
      }),
      'cybercrime',
    );
    expect(
      [...dialog.querySelectorAll('[data-preset]')].map((node) =>
        node.getAttribute('data-preset'),
      ),
    ).toEqual(['krebs']);

    await user.clear(within(dialog).getByRole('searchbox'));
    await user.type(within(dialog).getByRole('searchbox'), 'zzzz-nothing');
    expect(within(dialog).getByText('Nothing matches')).toBeTruthy();
  });

  it('subscribes with one click through the existing create endpoint', async () => {
    const user = userEvent.setup();
    await renderAt('/sources/recommended');
    await screen.findByRole('dialog');
    await user.click(
      await screen.findByRole('button', { name: 'Subscribe to Lobsters' }),
    );
    await waitFor(() =>
      expect(
        within(row('lobsters')).getByRole('button', { name: 'Added' }),
      ).toBeTruthy(),
    );
    const posts = api.mock.calls.filter(
      ([call]) => call.method === 'POST' && call.path === 'feedSources',
    );
    expect(posts).toHaveLength(1);
    expect(posts[0][0].json).toEqual({
      platform: 'rss',
      operation: 'feed',
      name: 'Lobsters',
      target: 'https://lobste.rs/rss',
      frequency: 60,
      candidateLimit: 20,
    });
    // The page reloads its list, so the new subscription appears behind the dialog.
    await waitFor(() =>
      expect(
        api.mock.calls.filter(
          ([call]) => call.method === 'GET' && call.path === 'feedSources',
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );
  });
});
