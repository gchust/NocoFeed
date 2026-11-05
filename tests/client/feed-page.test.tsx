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
  publishedApproximate: false,
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
  read: false,
  newReplies: 0,
  brief: null,
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
  read: false,
  followUp: null,
};

const detail: FeedItem = {
  ...listItem,
  readingLanguage: 'en',
  brief: null,
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

const YT = 'dQw4w9WgXcQ';

/** A YouTube video from a channel feed: no stored media, the player and thumbnail come from the video id. */
const youtubeDetail: FeedItem = {
  ...detail,
  id: 12,
  platform: 'youtube',
  sourceLabel: 'Some channel',
  title: 'How agents use tools',
  url: `https://www.youtube.com/watch?v=${YT}`,
  externalId: `yt:video:${YT}`,
  summary: 'The video description.',
  body: null,
  media: [],
};

/** An English post briefed in Chinese: the brief places the post's own chart and tries an outside picture. */
const briefed: FeedItem = {
  ...noteDetail,
  id: 20,
  platform: 'hn',
  title: 'Postgres backups restored in minutes',
  body: 'We cut restore time from 3 hours to 4 minutes.',
  readingLanguage: 'zh-CN',
  brief: {
    language: 'zh-CN',
    sourceLanguage: 'en',
    title: 'Postgres 备份几分钟内恢复',
    gist: '作者把恢复时间从 3 小时降到 4 分钟。',
    brief:
      '作者把恢复时间从 3 小时降到 4 分钟。\n\n- 用了**增量快照**\n\n![恢复时间对比](media:2)\n\n![x](https://tracker.example/t.gif)\n\n<img src="https://tracker.example/raw.gif">',
    body: null,
    bodyStale: false,
    stale: false,
    model: 's/m',
    createdAt: '2026-11-05T04:00:00Z',
  },
};

let itemsResponse: unknown;
let summaryUnhealthy = 0;
// The person's marks as the server keeps them: each PATCH changes only what it sends.
let states: Record<string, ItemState> = {};
const patched = (id: string, changes: unknown) => {
  states[id] = { ...(states[id] ?? state), ...(changes as object) };
  return { data: states[id] };
};
const api = vi.fn(({ method, path, query, json }: ApiCall) => {
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
        unread: {
          all: query?.unread ? 12 : 5,
          discuss: 1,
          learn: 0,
          saved: 0,
          later: 0,
          participated: 0,
        },
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
    return patched('7', json);
  if (method === 'POST' && path === 'feedItems/markRead')
    return { data: { marked: 5 } };
  if (method === 'GET' && path === 'feedItems/9') return { data: noteDetail };
  if (method === 'GET' && path === 'feedItems/11') return { data: videoDetail };
  if (method === 'GET' && path === 'feedItems/12')
    return { data: youtubeDetail };
  if (method === 'GET' && path === 'feedItems/13')
    return {
      data: {
        ...youtubeDetail,
        id: 13,
        url: `https://www.youtube.com/shorts/${YT}?feature=share`,
      },
    };
  if (method === 'GET' && path === 'feedItems/14')
    return {
      data: {
        ...youtubeDetail,
        id: 14,
        url: 'https://www.youtube.com/@channel',
        externalId: 'yt:channel:none',
      },
    };
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
  if (method === 'GET' && path === 'feedItems/20') return { data: briefed };
  if (method === 'POST' && path === 'feedItems/20/translate')
    return {
      data: {
        ...briefed,
        brief: {
          ...briefed.brief!,
          body: '我们把恢复时间从 3 小时降到 4 分钟。',
        },
      },
    };
  if (method === 'GET' && path === 'feedItems/21')
    return { data: { ...briefed, id: 21, brief: null } };
  if (method === 'POST' && path === 'feedItems/21/brief')
    return { data: { ...briefed, id: 21 } };
  if (method === 'GET' && path === 'feedItems/8')
    return { data: { ...detail, id: 8, title: 'Second item' } };
  if (method === 'PATCH' && path === 'feedItems/8/state')
    return patched('8', json);
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
    states = {};
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

  it('says when a time is approximate, and never shows the collection time as the publication time', async () => {
    const day = 24 * 3_600_000;
    itemsResponse = {
      data: [
        listItem,
        {
          ...listItem,
          id: 21,
          platform: 'youtube',
          title: 'Search result said to be three weeks old',
          publishedAt: new Date(Date.now() - 21 * day).toISOString(),
          publishedApproximate: true,
        },
        {
          ...listItem,
          id: 22,
          platform: 'youtube',
          title: 'Search result with no time',
          publishedAt: null,
          publishedApproximate: false,
          createdAt: new Date(Date.now() - 13 * 60_000).toISOString(),
        },
      ],
      meta: {},
    };
    await renderAt('/');

    const list = await screen.findByRole('region', {
      name: enUS.feed.listLabel,
    });
    const timeOf = async (name: RegExp) =>
      within(await within(list).findByRole('button', { name })).getByText(
        (_, element) => element?.tagName === 'TIME',
      );

    const approximate = await timeOf(/three weeks old/);
    expect(approximate).toHaveTextContent('about 3 weeks ago');
    expect(approximate.getAttribute('title')).toMatch(
      /^The platform only said/,
    );

    const undated = await timeOf(/with no time/);
    expect(undated).toHaveTextContent('collected 13 minutes ago');
    expect(undated.getAttribute('title')).toMatch(/gave no publication time/);

    const exact = await timeOf(/evaluate agent tool use/);
    expect(exact).not.toHaveTextContent(/about|collected/);
    expect(exact).toHaveAttribute('dateTime', '2026-10-28T10:00:00Z');
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

  it('lists newest first by default, narrows to a period and sorts by priority on request', async () => {
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
          query: expect.objectContaining({ period: 'week', sort: 'newest' }),
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
        name: enUS.feed.filters.sorts.priority,
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
  });

  it('marks an item read when it is opened and unread again on request', async () => {
    itemsResponse = {
      data: [
        listItem,
        { ...listItem, id: 8, title: 'Second item', read: true },
      ],
      meta: {},
    };
    await renderAt('/');
    const list = await screen.findByRole('region', {
      name: enUS.feed.listLabel,
    });
    const first = await within(list).findByRole('button', {
      name: /evaluate agent tool use/,
    });
    const second = within(list).getByRole('button', { name: /Second item/ });
    // Unread items stand apart, and say so to a screen reader.
    expect(first).toHaveAttribute('data-read', 'false');
    expect(first).toHaveTextContent(enUS.feed.read.unread);
    expect(second).toHaveAttribute('data-read', 'true');
    expect(second).not.toHaveTextContent(enUS.feed.read.unread);

    await userEvent.click(first);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'PATCH',
          path: 'feedItems/7/state',
          json: { read: true },
        }),
      ),
    );
    await waitFor(() => expect(first).toHaveAttribute('data-read', 'true'));

    const markUnread = await screen.findByRole('button', {
      name: enUS.feed.state.unread,
      pressed: false,
    });
    await userEvent.click(markUnread);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'PATCH',
          path: 'feedItems/7/state',
          json: { read: false },
        }),
      ),
    );
    expect(
      await screen.findByRole('button', {
        name: enUS.feed.state.unread,
        pressed: true,
      }),
    ).toBeInTheDocument();
    // Still open, it is not read again behind the person's back.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reads = api.mock.calls.filter(
      ([call]) =>
        call.method === 'PATCH' &&
        (call.json as { read?: boolean } | undefined)?.read === true,
    );
    expect(reads).toHaveLength(1);
  });

  it('toggles read with the keyboard', async () => {
    itemsResponse = {
      data: [{ ...listItem, read: true }],
      meta: {},
    };
    states = { '7': { ...state, read: true } };
    await renderAt('/?item=7');
    const list = await screen.findByRole('region', {
      name: enUS.feed.listLabel,
    });
    const card = await within(list).findByRole('button', {
      name: /evaluate agent tool use/,
      current: true,
    });

    await userEvent.keyboard('u');
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'PATCH',
          path: 'feedItems/7/state',
          json: { read: false },
        }),
      ),
    );
    await waitFor(() => expect(card).toHaveAttribute('data-read', 'false'));
    expect(
      await screen.findByText(enUS.feed.shortcuts.readOff),
    ).toBeInTheDocument();
  });

  it('shows unread counts, lists only unread items and marks a view read', async () => {
    const user = userEvent.setup();
    await renderAt('/?view=discuss&platform=hn');
    const rail = await screen.findByRole('navigation', {
      name: enUS.feed.views.label,
    });
    expect(await within(rail).findByLabelText('5 unread')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', {
        name: enUS.feed.read.unreadOnly,
        pressed: false,
      }),
    );
    // The list and its counts filter alike.
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          path: 'feedItems',
          query: expect.objectContaining({ view: 'discuss', unread: 'true' }),
        }),
      ),
    );
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: 'feedItems/summary',
        query: expect.objectContaining({ platform: 'hn', unread: 'true' }),
      }),
    );
    expect(
      screen.getByRole('button', {
        name: enUS.feed.read.unreadOnly,
        pressed: true,
      }),
    ).toBeInTheDocument();
    // Counts are already unread counts: no second figure.
    await waitFor(() =>
      expect(within(rail).queryByLabelText(/unread/)).not.toBeInTheDocument(),
    );

    await user.click(
      screen.getByRole('button', { name: enUS.feed.read.markAllRead }),
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: 'feedItems/markRead',
          json: { view: 'discuss', platform: 'hn' },
        }),
      ),
    );
    expect(await screen.findByText('Marked 5 as read')).toBeInTheDocument();
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

  it('shows a YouTube video’s thumbnail and play mark on its card', async () => {
    localStorage.clear();
    itemsResponse = {
      data: [{ ...listItem, ...youtubeDetail, cover: null, video: false }],
      meta: {},
    };
    await renderAt('/');
    const list = await screen.findByRole('region', {
      name: enUS.feed.listLabel,
    });
    const card = await within(list).findByRole('button', {
      name: /How agents use tools/,
    });
    const cover = within(card).getByRole('img', {
      name: enUS.feed.media.videoCover,
    });
    expect(cover).toHaveAttribute(
      'src',
      `https://i.ytimg.com/vi/${YT}/hqdefault.jpg`,
    );
    expect(cover).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('plays a YouTube video in place, loading the player only on click', async () => {
    await renderAt('/?item=12');
    const player = await screen.findByTestId('feed-youtube');
    expect(player.querySelector('iframe')).toBeNull();
    const play = within(player).getByRole('button', {
      name: enUS.feed.media.play,
    });
    expect(
      within(play).getByRole('img', { name: enUS.feed.media.videoCover }),
    ).toHaveAttribute('src', `https://i.ytimg.com/vi/${YT}/hqdefault.jpg`);
    expect(
      within(player).getByRole('link', { name: enUS.feed.media.openYouTube }),
    ).toHaveAttribute('href', `https://www.youtube.com/watch?v=${YT}`);
    expect(play.parentElement).toHaveClass('aspect-video');

    await userEvent.click(play);
    const frame = player.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute('src')).toMatch(
      new RegExp(`^https://www\\.youtube-nocookie\\.com/embed/${YT}\\?`),
    );
    expect(frame).toHaveAttribute(
      'title',
      'YouTube video: How agents use tools',
    );
    expect(frame).toHaveAttribute(
      'referrerpolicy',
      'strict-origin-when-cross-origin',
    );
    expect(frame!.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame!.getAttribute('allow')).toContain('encrypted-media');
    expect(frame).toHaveAttribute('allowfullscreen');
    expect(player).toHaveTextContent(enUS.feed.media.youtubeTrouble);
  });

  it('plays a YouTube Short in portrait', async () => {
    await renderAt('/?item=13');
    const player = await screen.findByTestId('feed-youtube');
    expect(
      within(player).getByRole('button', { name: enUS.feed.media.play })
        .parentElement,
    ).toHaveClass('aspect-[9/16]');
    expect(
      within(player).getByRole('link', { name: enUS.feed.media.openYouTube }),
    ).toHaveAttribute('href', `https://www.youtube.com/shorts/${YT}`);
  });

  it('keeps the plain link when no video id can be read', async () => {
    await renderAt('/?item=14');
    const content = await screen.findByRole('region', {
      name: enUS.feed.detail.content,
    });
    expect(screen.queryByTestId('feed-youtube')).not.toBeInTheDocument();
    expect(content.querySelector('iframe')).toBeNull();
    expect(
      screen
        .getAllByRole('link')
        .some(
          (link) =>
            link.getAttribute('href') === 'https://www.youtube.com/@channel',
        ),
    ).toBe(true);
  });

  it('puts the brief on the card: the translated title and the gist', async () => {
    localStorage.clear();
    itemsResponse = {
      data: [{ ...listItem, ...briefed, brief: { ...briefed.brief! } }],
      meta: {},
    };
    await renderAt('/');
    const list = await screen.findByRole('region', {
      name: enUS.feed.listLabel,
    });
    const card = await within(list).findByRole('button', {
      name: /Postgres 备份几分钟内恢复/,
    });
    expect(card).toHaveTextContent('作者把恢复时间从 3 小时降到 4 分钟。');
    expect(card).not.toHaveTextContent(briefed.excerpt!);
  });

  it('shows the brief first, with only the post’s own pictures, and folds the original', async () => {
    await renderAt('/?item=20');
    const brief = await screen.findByTestId('feed-brief');
    expect(brief).toHaveTextContent('用了增量快照');
    expect(within(brief).getByText('增量快照').tagName).toBe('STRONG');
    const images = within(brief).getAllByRole('img');
    expect(images).toHaveLength(1);
    expect(images[0]).toHaveAttribute('src', `${CDN}/2`);
    expect(images[0]).toHaveAccessibleName('恢复时间对比');
    expect(brief.innerHTML).not.toContain('tracker.example');
    // The translated title leads; the original stays under it.
    expect(
      screen.getByRole('heading', { name: 'Postgres 备份几分钟内恢复' }),
    ).toBeInTheDocument();
    expect(screen.getByText(briefed.title)).toBeInTheDocument();
    // No brief is written again for an item that has one.
    expect(
      api.mock.calls.some(([call]) => call.path === 'feedItems/20/brief'),
    ).toBe(false);

    expect(
      screen.queryByRole('region', { name: enUS.feed.detail.content }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: enUS.feed.brief.translate }),
    );
    const content = await screen.findByRole('region', {
      name: enUS.feed.detail.content,
    });
    expect(content).toHaveTextContent('我们把恢复时间从 3 小时降到 4 分钟。');
    await userEvent.click(
      screen.getByRole('button', { name: enUS.feed.brief.showOriginal }),
    );
    expect(content).toHaveTextContent(briefed.body!);
  });

  it('writes a brief at once for an item that has none', async () => {
    await renderAt('/?item=21');
    const brief = await screen.findByTestId('feed-brief');
    expect(brief).toHaveTextContent('作者把恢复时间从 3 小时降到 4 分钟。');
    expect(
      api.mock.calls.filter(
        ([call]) =>
          call.method === 'POST' && call.path === 'feedItems/21/brief',
      ),
    ).toHaveLength(1);
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
