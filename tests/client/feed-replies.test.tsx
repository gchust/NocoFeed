import {
  answerApi,
  renderWithApp,
  type ApiCall,
} from '@nocobase/app-testing/client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ReplyDrafts,
  type ReplyState,
} from '../../client/pages/feed/replies.js';
import {
  ReplyGuidelinesCard,
  type ReplyGuidelines,
} from '../../client/pages/preferences/reply-guidelines.js';
import enUS from '../../client/locales/en-US.js';
import zhCN from '../../client/locales/zh-CN.js';
import packageMetadata from '../../package.json' with { type: 'json' };

/** As the server sends it (`DEFAULT_REPLY_GUIDELINES` in `server/providers/feed/replies.ts`). */
const DEFAULT_RULES = 'Never misleading, never unfriendly.';

const ready: ReplyState = {
  status: 'ready',
  drafts: [
    {
      text: 'Incremental snapshots are the way.',
      tone: 'Adds a fact',
      emoji: '🚀',
      image: 'A before/after restore chart',
    },
    { text: 'How big was the database?', tone: 'Asks', emoji: '', image: '' },
    {
      text: 'Me waiting 3 hours for a restore',
      tone: 'Meme',
      emoji: '💀',
      image: '',
    },
  ],
  language: 'en',
  trigger: 'auto',
  guidelinesVersion: 'aaa',
  currentGuidelinesVersion: 'aaa',
  guidelinesChanged: false,
  stale: false,
  available: true,
  model: 's/m',
  updatedAt: '2026-11-06T00:00:00Z',
};

let replyState: ReplyState;
let polls = 0;
let guidelines: ReplyGuidelines;

const api = vi.fn((call: ApiCall) => {
  const { method, path, json } = call;
  if (method === 'GET' && path === 'feedItems/7/replies') {
    polls += 1;
    // The background run ends after one poll.
    if (replyState.status === 'pending' && polls > 1)
      replyState = {
        ...ready,
        trigger: 'asked',
        drafts: [
          { text: 'Fresh one', tone: '', emoji: '', image: '' },
          ...ready.drafts.slice(1),
        ],
      };
    return { data: replyState };
  }
  if (method === 'POST' && path === 'feedItems/7/replies') {
    replyState = { ...replyState, status: 'pending' };
    polls = 0;
    return new Response(JSON.stringify({ data: replyState }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (method === 'GET' && path === 'feedReplyGuidelines')
    return { data: guidelines };
  if (method === 'PUT' && path === 'feedReplyGuidelines') {
    const body = json as Pick<
      ReplyGuidelines,
      'guidelines' | 'platformGuidelines'
    >;
    guidelines = {
      ...guidelines,
      guidelines:
        body.guidelines === guidelines.defaultGuidelines
          ? null
          : body.guidelines,
      platformGuidelines: Object.fromEntries(
        Object.entries(body.platformGuidelines).filter(([, value]) =>
          value?.trim(),
        ),
      ),
    };
    return { data: guidelines };
  }
  return new Response(null, { status: 404 });
});

const writeText = vi.fn<(text: string) => Promise<void>>();

/** `userEvent.setup()` installs a clipboard stub of its own, so the mock goes in after it. */
function setup(): ReturnType<typeof userEvent.setup> {
  const user = userEvent.setup();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return user;
}

function render(element: ReactElement) {
  return renderWithApp(
    <Routes>
      <Route path='/' element={element} />
    </Routes>,
    {
      route: '/',
      namespace: packageMetadata.name,
      namespaces: { [packageMetadata.name]: enUS },
      fetch: answerApi(api),
    },
  );
}

describe('reply drafts', () => {
  beforeEach(() => {
    api.mockClear();
    replyState = ready;
    polls = 0;
  });

  it('lists the drafts in the post’s language with their emoji and picture ideas', async () => {
    await render(
      <ReplyDrafts
        itemId={7}
        worthJoining
        participated={false}
        onMarkJoined={() => undefined}
      />,
    );
    const section = await screen.findByRole('region', {
      name: enUS.feed.replies.title,
    });
    expect(
      within(section).getByText('Incremental snapshots are the way.'),
    ).toHaveAttribute('lang', 'en');
    expect(within(section).getByText('Replies in English')).toBeVisible();
    expect(within(section).getByText('Emoji: 🚀')).toBeVisible();
    expect(
      within(section).getByText('Picture idea: A before/after restore chart'),
    ).toBeVisible();
    expect(
      within(section).getAllByRole('button', { name: /^Copy reply/ }),
    ).toHaveLength(3);
    expect(
      within(section).getByRole('link', { name: enUS.feed.replies.editRules }),
    ).toHaveAttribute('href', '/preferences');
  });

  it('copies a draft without marking the item, and offers to mark it', async () => {
    const user = setup();
    const onMarkJoined = vi.fn();
    const view = await render(
      <ReplyDrafts
        itemId={7}
        worthJoining
        participated={false}
        onMarkJoined={onMarkJoined}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: 'Copy reply 2' }),
    );
    expect(writeText).toHaveBeenCalledWith('How big was the database?');
    expect(onMarkJoined).not.toHaveBeenCalled();
    expect(view.toasts()).toEqual([
      expect.objectContaining({
        type: 'success',
        title: enUS.feed.replies.copied,
        description: enUS.feed.replies.copiedHint,
      }),
    ]);
    await user.click(
      screen.getByRole('button', { name: enUS.feed.replies.markJoined }),
    );
    expect(onMarkJoined).toHaveBeenCalledTimes(1);
    // No state change was sent for the copy itself.
    expect(api.mock.calls.every(([call]) => call.method === 'GET')).toBe(true);
  });

  it('writes a new batch in the background and shows it when ready', async () => {
    const user = setup();
    await render(
      <ReplyDrafts
        itemId={7}
        worthJoining
        participated
        onMarkJoined={() => undefined}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: enUS.feed.replies.again }),
    );
    expect(
      api.mock.calls.some(
        ([call]) =>
          call.method === 'POST' && call.path === 'feedItems/7/replies',
      ),
    ).toBe(true);
    // The earlier drafts stay while the new ones are written.
    expect(await screen.findByText(enUS.feed.replies.writing)).toBeVisible();
    expect(screen.getByText('How big was the database?')).toBeVisible();
    await waitFor(() => expect(screen.getByText('Fresh one')).toBeVisible(), {
      timeout: 6_000,
    });
    expect(screen.queryByText(enUS.feed.replies.writing)).toBeNull();
  });

  it('offers drafts on demand for other items, and says when the rules changed', async () => {
    replyState = {
      ...ready,
      status: 'none',
      drafts: [],
      language: null,
      trigger: null,
    };
    const user = setup();
    await render(
      <ReplyDrafts
        itemId={7}
        worthJoining={false}
        participated={false}
        onMarkJoined={() => undefined}
      />,
    );
    expect(await screen.findByText(enUS.feed.replies.noneOther)).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: enUS.feed.replies.write }),
    );
    await waitFor(() => expect(screen.getByText('Fresh one')).toBeVisible(), {
      timeout: 6_000,
    });
  });

  it('says when the drafts were written under earlier rules', async () => {
    replyState = { ...ready, guidelinesChanged: true };
    await render(
      <ReplyDrafts
        itemId={7}
        worthJoining
        participated={false}
        onMarkJoined={() => undefined}
      />,
    );
    expect(
      await screen.findByText(enUS.feed.replies.guidelinesChanged),
    ).toBeVisible();
  });
});

describe('reply rules in preferences', () => {
  beforeEach(() => {
    api.mockClear();
    guidelines = {
      guidelines: null,
      platformGuidelines: {},
      defaultGuidelines: DEFAULT_RULES,
    };
  });

  it('starts from the default and saves the person’s own rules', async () => {
    const user = setup();
    const view = await render(<ReplyGuidelinesCard />);
    const general = await screen.findByLabelText(
      enUS.preferences.replies.general,
    );
    expect(general).toHaveValue(DEFAULT_RULES);

    await user.clear(general);
    await user.type(general, 'Always use a meme.');
    await user.click(
      screen.getByRole('button', { name: enUS.preferences.replies.platforms }),
    );
    await user.type(screen.getByLabelText('X'), 'Under 100 characters.');
    await user.click(
      screen.getByRole('button', { name: enUS.preferences.replies.save }),
    );
    await waitFor(() =>
      expect(view.toasts()).toEqual([
        expect.objectContaining({
          type: 'success',
          title: enUS.preferences.replies.saved,
        }),
      ]),
    );
    const [put] = api.mock.calls.find(
      ([call]) => call.method === 'PUT' && call.path === 'feedReplyGuidelines',
    )!;
    expect(put.json).toEqual({
      guidelines: 'Always use a meme.',
      platformGuidelines: { x: 'Under 100 characters.' },
    });

    await user.click(
      screen.getByRole('button', { name: enUS.preferences.replies.reset }),
    );
    expect(general).toHaveValue(DEFAULT_RULES);
  });
});

describe('reply copy', () => {
  it('has the same keys in both languages', () => {
    expect(Object.keys(zhCN.feed.replies).sort()).toEqual(
      Object.keys(enUS.feed.replies).sort(),
    );
    expect(Object.keys(zhCN.preferences.replies).sort()).toEqual(
      Object.keys(enUS.preferences.replies).sort(),
    );
  });
});
