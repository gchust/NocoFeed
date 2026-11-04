import {
  AuthenticationProvider,
  authenticationClientToken,
} from '@nocobase/app-plugin-authentication/client';
import {
  answerApi,
  renderWithApp,
  type ApiCall,
} from '@nocobase/app-testing/client';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
  quality: null,
  noise: 'none',
  gate: null,
  topicId: 1,
  lead: 'An open discussion where your experience applies.',
  excerpt: null,
  cover: null,
  video: false,
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
  media: [],
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
    quality: null,
    noise: 'none',
    gate: null,
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

const CDN = 'https://sns-webpic-qc.xhscdn.com/202611040000/abc';

/** A Xiaohongshu note: text in paragraphs, three pictures and nothing else to say about it than the analysis. */
const noteDetail: FeedItem = {
  ...detail,
  id: 9,
  platform: 'xiaohongshu',
  sourceLabel: '手冲咖啡',
  title: '在家做手冲的三个坑',
  url: 'https://www.xiaohongshu.com/explore/0123456789abcdef01234567',
  excerpt: '第一段：磨豆要均匀。',
  cover: `${CDN}/1`,
  body: '第一段：磨豆要均匀。\n还要称重。\n\n第二段：水温 92 度。',
  media: [
    { type: 'image', url: `${CDN}/1`, width: 1080, height: 1440 },
    { type: 'image', url: `${CDN}/2` },
    { type: 'image', url: `${CDN}/3` },
  ],
  enrichable: ['body', 'comments'],
};

const videoDetail: FeedItem = {
  ...noteDetail,
  id: 11,
  video: true,
  media: [
    {
      type: 'video',
      url: 'https://sns-video-bd.xhscdn.com/stream/v.mp4',
      cover: `${CDN}/cover`,
    },
  ],
};

let itemsResponse: unknown;
let summaryUnhealthy = 0;
const api = vi.fn(({ method, path, query }: ApiCall) => {
  if (method === 'GET' && path === 'feedItems') return itemsResponse;
  if (method === 'GET' && path === 'feedItems/summary')
    return {
      data: {
        // A search narrows the counts the way it narrows the list.
        all: query?.q ? 4 : 12,
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
  if (method === 'GET' && path === 'feedItems/9') return { data: noteDetail };
  if (method === 'GET' && path === 'feedItems/11') return { data: videoDetail };
  if (method === 'GET' && path === 'feedItems/10')
    return {
      data: {
        ...noteDetail,
        id: 10,
        body: null,
        media: [],
        coverage: {
          body: { status: 'missing', note: 'titleOnly' },
          comments: { status: 'notRequested' },
        },
        enrichable: ['body', 'comments'],
      },
    };
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

  it('counts what the current filters show and follows a new search', async () => {
    await renderAt('/?platform=hn&topic=1');

    const rail = await screen.findByRole('navigation', {
      name: enUS.feed.views.label,
    });
    const all = within(rail).getByRole('button', {
      name: new RegExp(enUS.feed.views.all),
    });
    await waitFor(() => expect(all).toHaveTextContent('12'));
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: 'feedItems/summary',
        query: expect.objectContaining({ platform: 'hn', topicId: '1' }),
      }),
    );

    await userEvent.type(
      screen.getByRole('searchbox', { name: enUS.feed.searchLabel }),
      'agent{Enter}',
    );

    await waitFor(() => expect(all).toHaveTextContent('4'));
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: 'feedItems/summary',
        query: expect.objectContaining({
          platform: 'hn',
          topicId: '1',
          q: 'agent',
        }),
      }),
    );
  });

  it('narrows the list to a publication period and sorts it newest first', async () => {
    const user = userEvent.setup();
    await renderAt('/');
    const rail = await screen.findByRole('navigation', {
      name: enUS.feed.views.label,
    });

    await user.click(
      within(rail).getByRole('combobox', { name: enUS.feed.filters.period }),
    );
    await user.click(
      await screen.findByRole('option', {
        name: enUS.feed.filters.periods.week,
      }),
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          path: 'feedItems',
          query: expect.objectContaining({ period: 'week', sort: 'priority' }),
        }),
      ),
    );
    // The counts follow the period as the list does.
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: 'feedItems/summary',
        query: expect.objectContaining({ period: 'week' }),
      }),
    );

    await user.click(
      within(rail).getByRole('combobox', { name: enUS.feed.filters.sort }),
    );
    await user.click(
      await screen.findByRole('option', {
        name: enUS.feed.filters.sorts.newest,
      }),
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          path: 'feedItems',
          query: expect.objectContaining({ period: 'week', sort: 'newest' }),
        }),
      ),
    );
  });

  it('opens the detail from the URL and saves a mark', async () => {
    await renderAt('/?item=7');

    const save = await screen.findByRole('button', {
      name: enUS.feed.state.favorite,
      pressed: false,
    });
    // The analysis is one line until opened.
    expect(
      screen.queryByText(enUS.feed.detail.lead.discuss),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', {
        name: new RegExp(enUS.feed.detail.analysis),
      }),
    );
    expect(screen.getByText(enUS.feed.detail.lead.discuss)).toBeInTheDocument();
    expect(screen.getByText(enUS.feed.detail.coverage)).toBeInTheDocument();
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

  it('shows a note’s opening and picture on its card', async () => {
    // The density is remembered per browser; an earlier test chose the compact list.
    localStorage.clear();
    itemsResponse = {
      data: [{ ...listItem, ...noteDetail, id: 9 }],
      meta: {},
    };
    await renderAt('/');
    const list = await screen.findByRole('region', {
      name: enUS.feed.listLabel,
    });
    const card = await within(list).findByRole('button', {
      name: /在家做手冲的三个坑/,
    });
    expect(card).toHaveTextContent('第一段：磨豆要均匀。');
    // The opening of the post replaces the analysis' lead on the card.
    expect(card).not.toHaveTextContent(listItem.lead!);
    const cover = within(card).getByRole('img', {
      name: enUS.feed.media.cover,
    });
    expect(cover).toHaveAttribute('src', `${CDN}/1`);
    expect(cover).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('puts the original first: pictures, then the text in its paragraphs', async () => {
    await renderAt('/?item=9');
    const content = await screen.findByRole('region', {
      name: enUS.feed.detail.content,
    });
    const paragraphs = within(content)
      .getByTestId('feed-article-text')
      .querySelectorAll('p');
    expect([...paragraphs].map((p) => p.textContent)).toEqual([
      '第一段：磨豆要均匀。\n还要称重。',
      '第二段：水温 92 度。',
    ]);

    const gallery = within(content).getByRole('region', {
      name: enUS.feed.parts.media,
    });
    const main = within(gallery).getByRole('img', { name: 'Image 1 of 3' });
    expect(main).toHaveAttribute('src', `${CDN}/1`);
    expect(main).toHaveAttribute('referrerpolicy', 'no-referrer');
    await userEvent.click(
      within(gallery).getByRole('button', { name: 'Image 3 of 3' }),
    );
    expect(
      within(gallery).getByRole('img', { name: 'Image 3 of 3' }),
    ).toHaveAttribute('src', `${CDN}/3`);

    // The analysis comes before the post but as a single collapsed line.
    const summary = screen.getByRole('button', {
      name: new RegExp(enUS.feed.detail.analysis),
      expanded: false,
    });
    expect(summary).toHaveTextContent(listItem.lead!);
    expect(screen.queryByText(enUS.feed.detail.steps)).not.toBeInTheDocument();
  });

  it('says when a picture can no longer be loaded', async () => {
    await renderAt('/?item=9');
    const content = await screen.findByRole('region', {
      name: enUS.feed.detail.content,
    });
    fireEvent.error(within(content).getByRole('img', { name: 'Image 1 of 3' }));
    expect(
      await within(content).findByRole('img', {
        name: enUS.feed.media.unavailable,
      }),
    ).toBeInTheDocument();
  });

  it('plays a video from its cover and links the file', async () => {
    await renderAt('/?item=11');
    const play = await screen.findByRole('button', {
      name: enUS.feed.media.play,
    });
    expect(
      within(play).getByRole('img', { name: enUS.feed.media.videoCover }),
    ).toHaveAttribute('src', `${CDN}/cover`);
    expect(
      screen.getByRole('link', { name: enUS.feed.media.openVideo }),
    ).toHaveAttribute('href', 'https://sns-video-bd.xhscdn.com/stream/v.mp4');
    await userEvent.click(play);
    expect(document.querySelector('video')).toHaveAttribute(
      'src',
      'https://sns-video-bd.xhscdn.com/stream/v.mp4',
    );
  });

  it('offers to fetch the text of a title-only note', async () => {
    await renderAt('/?item=10');
    const content = await screen.findByRole('region', {
      name: enUS.feed.detail.content,
    });
    expect(content).toHaveTextContent(enUS.feed.detail.titleOnly);
    expect(
      within(content).getByRole('button', { name: 'Fetch Body, Comments' }),
    ).toBeInTheDocument();
  });
});
