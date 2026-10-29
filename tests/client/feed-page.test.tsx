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

import FeedPage from '../../client/pages/feed/index.js';
import type {
  FeedItem,
  FeedListItem,
  ItemState,
} from '../../client/pages/feed/types.js';
import enUS from '../../client/locales/en-US.js';
import packageMetadata from '../../package.json' with { type: 'json' };

const getSession = vi.fn(async () => ({ data: null }));

const listItem: FeedListItem = {
  id: 7,
  platform: 'hn',
  sourceLabel: 'HN new',
  title: 'Ask HN: How do you evaluate agent tool use?',
  summary: null,
  url: 'https://news.ycombinator.com/item?id=7',
  publishedAt: '2026-10-28T10:00:00Z',
  createdAt: '2026-10-28T10:05:00Z',
  verdict: 'discuss',
  score: 72,
  topicId: 1,
  lead: 'An open discussion where your experience applies.',
  favorite: false,
  later: false,
  participated: false,
  newReplies: 0,
};

const state: ItemState = {
  favorite: false,
  later: false,
  participated: false,
  feedback: null,
  notes: null,
  participationUrl: null,
  participationNote: null,
  dismissed: false,
  followUp: null,
};

const detail: FeedItem = {
  ...listItem,
  externalId: '7',
  author: 'someone',
  body: 'We struggle to evaluate tool calls.',
  comments: [],
  transcript: [],
  metrics: { points: 12 },
  coverage: {
    body: { status: 'available' },
    comments: { status: 'notRequested' },
  },
  contentVersion: 1,
  fetchedAt: '2026-10-28T10:05:00Z',
  analysis: {
    id: 1,
    topicId: 1,
    verdict: 'discuss',
    score: 72,
    interestLevel: 'high',
    interestReason: null,
    experienceLevel: 'strong',
    experienceReason: null,
    lead: 'An open discussion where your experience applies.',
    steps: [{ title: 'Check the original first', detail: '' }],
    evidence: null,
    uncertainty: null,
    engine: 'rules',
    model: null,
    contentVersion: 1,
    createdAt: '2026-10-28T10:05:00Z',
  },
  analysisStale: false,
  state,
  enrichable: ['comments'],
};

let itemsResponse: unknown;
let summaryUnhealthy = 0;
const api = vi.fn(({ method, path }: ApiCall) => {
  if (method === 'GET' && path === 'feedItems') return itemsResponse;
  if (method === 'GET' && path === 'feedItems/summary')
    return {
      data: {
        all: 1,
        discuss: 1,
        learn: 0,
        saved: 0,
        later: 0,
        participated: 0,
        newReplies: 0,
        unhealthySources: summaryUnhealthy,
      },
    };
  if (method === 'GET' && path === 'feedDigest')
    return {
      data: { since: '2026-10-27T10:00:00Z', discuss: [listItem], learn: [] },
    };
  if (method === 'GET' && path === 'feedTopics')
    return {
      data: [
        {
          id: 1,
          name: 'Agents',
          goal: 'agents',
          avoid: null,
          mode: 'both',
          sourceIds: [],
          createdAt: '2026-10-28T00:00:00Z',
        },
      ],
    };
  if (method === 'GET' && path === 'feedItems/7') return { data: detail };
  if (method === 'PATCH' && path === 'feedItems/7/state')
    return { data: { ...state, favorite: true } };
  if (method === 'GET' && path === 'feedItems/8')
    return { data: { ...detail, id: 8, title: 'Second item' } };
  if (method === 'PATCH' && path === 'feedItems/8/state')
    return { data: { ...state, dismissed: true } };
  return new Response(null, { status: 404 });
});

async function renderAt(route: string) {
  return renderWithApp(
    <AuthenticationProvider>
      <Routes>
        <Route path='/' element={<FeedPage />} />
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

describe('feed page', () => {
  beforeEach(() => {
    // jsdom has no layout: answer as a wide desktop, where the detail sits beside the list.
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: true,
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    api.mockClear();
    summaryUnhealthy = 0;
    itemsResponse = { data: [listItem], meta: {} };
  });

  it('lists items with their verdict, score and topic', async () => {
    await renderAt('/?view=discuss');

    const list = await screen.findByRole('region', {
      name: enUS.feed.listLabel,
    });
    const card = await within(list).findByRole('button', {
      name: /evaluate agent tool use/,
    });
    expect(card).toHaveTextContent('Match 72');
    expect(card).toHaveTextContent('#Agents');
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: 'feedItems',
        query: expect.objectContaining({ view: 'discuss' }),
      }),
    );
  });

  it('opens the detail from the URL and saves a mark', async () => {
    await renderAt('/?item=7');

    const save = await screen.findByRole('button', {
      name: enUS.feed.state.favorite,
      pressed: false,
    });
    expect(screen.getByText(enUS.feed.detail.lead.discuss)).toBeInTheDocument();
    await userEvent.click(save);

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'PATCH',
          path: 'feedItems/7/state',
          json: { favorite: true },
        }),
      ),
    );
    expect(
      await screen.findByRole('button', {
        name: enUS.feed.state.favorite,
        pressed: true,
      }),
    ).toBeInTheDocument();
  });

  it('offers to sign in again when the session has ended', async () => {
    itemsResponse = Response.json(
      { error: { message: 'Unauthorized' } },
      { status: 401 },
    );
    await renderAt('/');

    expect(
      await screen.findByRole('button', { name: enUS.feed.common.signInAgain }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: enUS.feed.common.retry }),
    ).not.toBeInTheDocument();
  });

  it('explains an empty feed and points to subscriptions', async () => {
    itemsResponse = { data: [], meta: {} };
    await renderAt('/');

    expect(await screen.findByText(enUS.feed.empty.title)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: enUS.feed.empty.addSource }),
    ).toHaveAttribute('href', '/sources/new');
  });

  it('shows today’s digest in its own view', async () => {
    await renderAt('/?view=digest');

    expect(
      await screen.findByRole('heading', { name: enUS.feed.digest.title }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /evaluate agent tool use/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(enUS.feed.digest.learnEmpty)).toBeInTheDocument();
    expect(api).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: 'feedItems' }),
    );
  });

  it('triages with the keyboard: move, save and dismiss', async () => {
    itemsResponse = {
      data: [listItem, { ...listItem, id: 8, title: 'Second item' }],
      meta: {},
    };
    await renderAt('/');
    const list = await screen.findByRole('region', {
      name: enUS.feed.listLabel,
    });
    await within(list).findByRole('button', { name: /Second item/ });

    await userEvent.keyboard('j');
    expect(
      await within(list).findByRole('button', {
        name: /evaluate agent tool use/,
        current: true,
      }),
    ).toBeInTheDocument();

    await userEvent.keyboard('s');
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'PATCH',
          path: 'feedItems/7/state',
          json: { favorite: true },
        }),
      ),
    );

    await userEvent.keyboard('j');
    await within(list).findByRole('button', {
      name: /Second item/,
      current: true,
    });
    await userEvent.keyboard('x');
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'PATCH',
          path: 'feedItems/8/state',
          json: { dismissed: true },
        }),
      ),
    );
    await waitFor(() =>
      expect(
        within(list).queryByRole('button', { name: /Second item/ }),
      ).not.toBeInTheDocument(),
    );
  });

  it('leaves keys typed into the search box alone', async () => {
    await renderAt('/');
    const search = await screen.findByRole('searchbox', {
      name: enUS.feed.searchLabel,
    });
    await userEvent.type(search, 'js');
    expect(search).toHaveValue('js');
    expect(api).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('switches to the compact list and warns about failing subscriptions', async () => {
    summaryUnhealthy = 2;
    await renderAt('/');
    expect(
      await screen.findByRole('link', { name: enUS.feed.health.review }),
    ).toHaveAttribute('href', '/sources');

    await userEvent.click(
      screen.getByRole('button', { name: enUS.feed.density.compact }),
    );
    expect(
      screen.getByRole('button', {
        name: enUS.feed.density.compact,
        pressed: true,
      }),
    ).toBeInTheDocument();
  });
});
