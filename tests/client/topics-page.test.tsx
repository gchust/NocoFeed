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

import TopicDialog from '../../client/pages/topics/form.js';
import TopicsPage from '../../client/pages/topics/index.js';
import type { Catalog, Source, Topic } from '../../client/pages/feed/types.js';
import enUS from '../../client/locales/en-US.js';
import packageMetadata from '../../package.json' with { type: 'json' };

const getSession = vi.fn(async () => ({ data: null }));

const search = (id: number, platform: Source['platform'], target: string) =>
  ({
    id,
    topicId: 1,
    platform,
    operation: 'keyword',
    name: `Vibe · ${target}`,
    target,
    frequency: 360,
    candidateLimit: 20,
    active: true,
    status: 'ok',
    statusMessage: null,
    lastRunAt: '2026-11-03T08:00:00Z',
    lastSuccessAt: '2026-11-03T08:00:00Z',
    nextRunAt: null,
    failureStreak: id === 12 ? 3 : 0,
    emptyStreak: 0,
    health: id === 12 ? 'failing' : 'ok',
  }) satisfies Source;

const topic: Topic = {
  id: 1,
  name: 'Vibe',
  goal: 'vibe coding in practice',
  avoid: null,
  mode: 'learn',
  sourceIds: [],
  searchTerms: ['vibe coding'],
  searchPlatforms: ['bilibili', 'x'],
  searchFrequency: 360,
  searchLimit: 20,
  searches: [
    search(11, 'bilibili', 'vibe coding'),
    search(12, 'x', 'vibe coding'),
  ],
  createdAt: '2026-11-03T00:00:00Z',
};

const keyword = (min: number) => ({
  operation: 'keyword',
  implementation: 'collector' as const,
  input: 'text' as const,
  single: false,
  capabilities: ['searchCandidates'],
  targetLength: { min, max: 100 },
  available: true,
});
const catalog: Catalog = {
  collectorConfigured: true,
  model: { available: true, name: 'm' },
  platforms: [
    {
      platform: 'hn',
      experimental: false,
      needsLogin: false,
      operations: [{ ...keyword(1), operation: 'new', input: 'none' }],
    },
    {
      platform: 'bilibili',
      experimental: true,
      needsLogin: false,
      operations: [keyword(1)],
    },
    {
      platform: 'xiaohongshu',
      experimental: true,
      needsLogin: true,
      operations: [keyword(2)],
    },
  ],
} as unknown as Catalog;

const api = vi.fn(({ method, path }: ApiCall) => {
  if (method === 'GET' && path === 'feedTopics') return { data: [topic] };
  if (method === 'GET' && path === 'feedSources') return { data: [] };
  if (method === 'GET' && path === 'feedCatalog') return { data: catalog };
  if (method === 'POST' && path === 'feedTopics/1/run')
    return new Response(JSON.stringify({ data: { started: 2 } }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  if (method === 'POST' && path === 'feedTopics')
    return new Response(JSON.stringify({ data: { ...topic, id: 2 } }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  return new Response(null, { status: 404 });
});

function renderAt(route: string) {
  return renderWithApp(
    <AuthenticationProvider>
      <Routes>
        <Route path='/topics' element={<TopicsPage />}>
          <Route path='new' element={<TopicDialog />} />
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

describe('topics page', () => {
  beforeEach(() => {
    api.mockClear();
  });

  it('shows what a topic searches for, where, and what is failing', async () => {
    await renderAt('/topics');
    const card = (await screen.findByText('vibe coding in practice')).closest(
      'li',
    )!;
    expect(within(card).getByText('vibe coding')).toBeTruthy();
    expect(within(card).getByText(/2 searches · every 6/)).toBeTruthy();
    expect(within(card).getByText('1 failing')).toBeTruthy();
  });

  it('starts the topic’s searches now', async () => {
    const user = userEvent.setup();
    await renderAt('/topics');
    await user.click(
      await screen.findByRole('button', { name: 'Actions for Vibe' }),
    );
    await user.click(
      await screen.findByRole('menuitem', { name: 'Search now' }),
    );
    await waitFor(() =>
      expect(
        api.mock.calls.some(
          ([call]) =>
            call.method === 'POST' && call.path === 'feedTopics/1/run',
        ),
      ).toBe(true),
    );
  });

  it('creates a topic that searches on every platform', async () => {
    const user = userEvent.setup();
    await renderAt('/topics/new');
    await user.type(await screen.findByLabelText(/^Name/), 'Agents');
    await user.type(screen.getByLabelText(/^Goal/), 'agent engineering');
    await user.type(
      screen.getByLabelText('Search terms'),
      'AI agents{Enter} AI agents {Enter}MCP',
    );
    // Both search platforms start chosen, which is saved as "every platform".
    expect(
      screen
        .getByRole('checkbox', { name: 'Bilibili' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(
        api.mock.calls.some(
          ([call]) => call.method === 'POST' && call.path === 'feedTopics',
        ),
      ).toBe(true),
    );
    const [call] = api.mock.calls.find(
      ([entry]) => entry.method === 'POST' && entry.path === 'feedTopics',
    )!;
    expect(call.json).toMatchObject({
      name: 'Agents',
      searchTerms: ['AI agents', 'MCP'],
      searchPlatforms: [],
      searchFrequency: 360,
      searchLimit: 20,
    });
  });

  it('refuses a term a chosen platform would not accept', async () => {
    const user = userEvent.setup();
    await renderAt('/topics/new');
    await user.type(await screen.findByLabelText(/^Name/), 'Cats');
    await user.type(screen.getByLabelText(/^Goal/), 'cats');
    await user.type(screen.getByLabelText('Search terms'), '猫');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(
      await screen.findByText(/The search term “猫” must be 2–100 characters/),
    ).toBeTruthy();
    expect(
      api.mock.calls.some(
        ([call]) => call.method === 'POST' && call.path === 'feedTopics',
      ),
    ).toBe(false);
  });
});
