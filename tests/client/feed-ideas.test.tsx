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

import { IdeasSection } from '../../client/pages/feed/ideas.js';
import {
  ideaText,
  type IdeaSet,
  type IdeaSettings,
  type IdeasState,
} from '../../client/pages/feed/ideas-model.js';
import { IdeaSettingsCard } from '../../client/pages/preferences/ideas.js';
import enUS from '../../client/locales/en-US.js';
import packageMetadata from '../../package.json' with { type: 'json' };

const getSession = vi.fn(async () => ({ data: null }));

const empty: IdeasState = {
  available: true,
  webSearch: false,
  kinds: ['xiaohongshu', 'x'],
  auto: false,
  styleVersion: 'v1',
  sets: [],
};

const set = (overrides: Partial<IdeaSet>): IdeaSet => ({
  kind: 'x',
  status: 'ready',
  ideas: [],
  error: null,
  generatedAt: new Date().toISOString(),
  styleVersion: 'v1',
  stale: false,
  webSearch: false,
  model: 's/m',
  trigger: 'manual',
  ...overrides,
});

const ready: IdeasState = {
  ...empty,
  sets: [
    set({
      kind: 'xiaohongshu',
      ideas: [
        {
          title: '备份恢复提速',
          body: '第一段\n\n第二段 🔥',
          tags: ['数据库', '运维'],
          cover: '计时器对比',
        },
      ],
    }),
    set({
      kind: 'x',
      ideas: [
        { posts: ['Restores: 3h → 4min 🧵', 'Incremental snapshots.'] },
        { posts: ['One liner.'] },
      ],
    }),
  ],
};

let ideasState: IdeasState;
let settings: IdeaSettings;
let polls = 0;
const calls: ApiCall[] = [];

const api = vi.fn((call: ApiCall) => {
  calls.push(call);
  const { method, path } = call;
  if (method === 'GET' && path === 'feedItems/7/ideas') {
    polls += 1;
    // The background generation finishes after the first read of the pending state.
    if (
      ideasState.sets.some((entry) => entry.status === 'pending') &&
      polls > 2
    )
      ideasState = ready;
    return { data: ideasState };
  }
  if (method === 'POST' && path === 'feedItems/7/ideas') {
    ideasState = {
      ...empty,
      sets: [
        set({ kind: 'xiaohongshu', status: 'pending' }),
        set({ kind: 'x', status: 'pending' }),
      ],
    };
    polls = 1;
    return new Response(JSON.stringify({ data: ideasState }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (method === 'POST' && path === 'feedItems/7/ideas/again') {
    ideasState = {
      ...ready,
      sets: ready.sets.map((entry) =>
        entry.kind === 'x' ? { ...entry, status: 'pending' } : entry,
      ),
    };
    polls = 1;
    return { data: ideasState };
  }
  if (method === 'DELETE' && path === 'feedItems/7/ideas') {
    ideasState = empty;
    return { data: { deleted: 2 } };
  }
  if (method === 'GET' && path === 'feedIdeaSettings')
    return { data: settings };
  if (method === 'PUT' && path === 'feedIdeaSettings') {
    const body = call.json as Partial<IdeaSettings>;
    settings = {
      ...settings,
      ...body,
      style: body.style ?? settings.defaultStyle,
      customized: Boolean(body.style),
    } as IdeaSettings;
    return { data: settings };
  }
  return new Response(null, { status: 404 });
});

async function render(element: React.ReactElement) {
  return renderWithApp(
    <AuthenticationProvider>
      <Routes>
        <Route path='/' element={element} />
      </Routes>
    </AuthenticationProvider>,
    {
      route: '/',
      namespace: packageMetadata.name,
      namespaces: { [packageMetadata.name]: enUS },
      fetch: answerApi(api),
      services: (app) => {
        app.container.instance(authenticationClientToken, { getSession });
      },
    },
  );
}

const ideas = enUS.feed.ideas;

describe('ideas on an item', () => {
  beforeEach(() => {
    ideasState = empty;
    polls = 0;
    calls.length = 0;
    api.mockClear();
  });

  it('points to the model settings when nothing can write ideas', async () => {
    ideasState = { ...empty, available: false };
    await render(<IdeasSection itemId={7} />);
    expect(await screen.findByText(ideas.unavailable.title)).toBeVisible();
    expect(
      screen.getByRole('link', { name: ideas.unavailable.models }),
    ).toHaveAttribute('href', '/settings/models');
    expect(
      screen.queryByRole('button', { name: ideas.generate }),
    ).not.toBeInTheDocument();
  });

  it('generates on request in the background and shows the ideas when they are ready', async () => {
    const user = userEvent.setup();
    await render(<IdeasSection itemId={7} />);
    expect(await screen.findByText(ideas.noWebSearch)).toBeVisible();
    await user.click(screen.getByRole('button', { name: ideas.generate }));
    expect(calls.find((call) => call.method === 'POST')?.path).toBe(
      'feedItems/7/ideas',
    );
    // Pending first, without blocking the page.
    expect(await screen.findAllByText(ideas.generating)).toHaveLength(2);
    // The card polls until the generation is done.
    expect(
      await screen.findByText('备份恢复提速', undefined, { timeout: 8_000 }),
    ).toBeVisible();
    expect(screen.getByText('#数据库 #运维')).toBeVisible();
    expect(screen.getByText('Restores: 3h → 4min 🧵')).toBeVisible();
    expect(screen.queryByText(ideas.generating)).not.toBeInTheDocument();
  }, 15_000);

  it('copies an idea as ready-to-post text, and asks for another one in its place', async () => {
    ideasState = ready;
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    await render(<IdeasSection itemId={7} />);
    const card = await screen.findByTestId('feed-ideas-x');
    const [first] = within(card).getAllByTestId('feed-idea');
    await user.click(within(first!).getByRole('button', { name: ideas.copy }));
    expect(write).toHaveBeenCalledWith(
      '1/2 Restores: 3h → 4min 🧵\n\n2/2 Incremental snapshots.',
    );
    expect(
      await within(first!).findByRole('button', { name: ideas.copied }),
    ).toBeVisible();

    const [, second] = within(card).getAllByTestId('feed-idea');
    await user.click(
      within(second!).getByRole('button', { name: ideas.again }),
    );
    const again = calls.find((call) => call.path === 'feedItems/7/ideas/again');
    expect(again?.json).toEqual({ kind: 'x', index: 1 });
    expect(await within(card).findByText(ideas.generating)).toBeVisible();
  });

  it('says when the style changed and when the model searched the web', async () => {
    ideasState = {
      ...ready,
      webSearch: true,
      sets: ready.sets.map((entry) => ({
        ...entry,
        stale: true,
        webSearch: true,
      })),
    };
    await render(<IdeasSection itemId={7} />);
    expect(await screen.findByText(ideas.webSearch)).toBeVisible();
    expect(screen.getByText(/with web search/)).toBeVisible();
    expect(screen.getByText(new RegExp(ideas.stale))).toBeVisible();
  });

  it('says there is not enough content yet instead of ideas from a bare title (issue #17)', async () => {
    ideasState = {
      ...empty,
      sets: [
        set({
          kind: 'xiaohongshu',
          status: 'failed',
          error: 'thinMaterial',
          generatedAt: null,
        }),
      ],
    };
    await render(<IdeasSection itemId={7} />);
    expect(await screen.findByText(ideas.errors.thinMaterial)).toBeVisible();
  });

  it('deletes after confirming', async () => {
    ideasState = ready;
    const user = userEvent.setup();
    await render(<IdeasSection itemId={7} />);
    await user.click(await screen.findByRole('button', { name: ideas.delete }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', { name: enUS.feed.common.delete }),
    );
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === 'DELETE' && call.path === 'feedItems/7/ideas',
        ),
      ).toBe(true),
    );
    expect(
      await screen.findByRole('button', { name: ideas.generate }),
    ).toBeVisible();
  });

  it('writes a short-video script as numbered shots', () => {
    const t = ((key: string, values?: Record<string, unknown>) =>
      `${key}${values ? JSON.stringify(values) : ''}`) as never;
    expect(
      ideaText(
        'shortVideo',
        {
          title: 'T',
          seconds: 30,
          shots: [{ visual: 'v', line: 'l', caption: 'c', seconds: 30 }],
        },
        t,
      ),
    ).toContain('feed.ideas.shot{"number":1,"seconds":30}');
  });
});

describe('idea settings', () => {
  beforeEach(() => {
    settings = {
      style: '默认人设',
      customized: false,
      kinds: ['xiaohongshu', 'x', 'shortVideo', 'bilibili', 'meme'],
      auto: false,
      xLanguage: 'en',
      styleVersion: 'v1',
      defaultStyle: '默认人设',
    };
    calls.length = 0;
  });

  it('saves the style, the kinds and automatic generation', async () => {
    const user = userEvent.setup();
    const prefs = enUS.preferences.ideas;
    await render(<IdeaSettingsCard />);
    const style = await screen.findByLabelText(prefs.style);
    expect(style).toHaveValue('默认人设');
    await user.clear(style);
    await user.type(style, '毒舌数据库博主');
    await user.click(
      screen.getByRole('checkbox', { name: enUS.feed.ideas.kinds.meme }),
    );
    await user.click(
      screen.getByRole('checkbox', { name: enUS.feed.ideas.kinds.bilibili }),
    );
    await user.click(screen.getByRole('switch', { name: prefs.auto }));
    await user.click(screen.getByRole('button', { name: prefs.save }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'PUT')?.json).toEqual({
        style: '毒舌数据库博主',
        kinds: ['xiaohongshu', 'x', 'shortVideo'],
        auto: true,
        xLanguage: 'en',
      }),
    );
    expect(await screen.findByText(prefs.saved)).toBeVisible();

    // Back to the default style in one click.
    await user.click(screen.getByRole('button', { name: prefs.resetStyle }));
    expect(screen.getByLabelText(prefs.style)).toHaveValue('默认人设');
  });

  it('needs at least one kind', async () => {
    settings = { ...settings, kinds: ['x'] };
    const user = userEvent.setup();
    const prefs = enUS.preferences.ideas;
    await render(<IdeaSettingsCard />);
    await user.click(
      await screen.findByRole('checkbox', { name: enUS.feed.ideas.kinds.x }),
    );
    expect(screen.getByText(prefs.kindsEmpty)).toBeVisible();
    expect(screen.getByRole('button', { name: prefs.save })).toBeDisabled();
  });
});
