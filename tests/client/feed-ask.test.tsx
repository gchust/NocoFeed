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

import { AskSection, type AskState } from '../../client/pages/feed/ask.js';
import enUS from '../../client/locales/en-US.js';
import packageMetadata from '../../package.json' with { type: 'json' };

const getSession = vi.fn(async () => ({ data: null }));

const ready: AskState = {
  conversationId: null,
  online: true,
  webSearch: true,
  runnerAgentId: null,
  runnerPending: false,
};

let askState: AskState;
let history: unknown[];
const calls: ApiCall[] = [];

/** A UI message stream as the Agents plugin answers `POST …/messages`. */
function stream(text: string): Response {
  const events = [
    { type: 'start', messageId: 'a-new' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish' },
  ];
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
    {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-vercel-ai-ui-message-stream': 'v1',
      },
    },
  );
}

const api = vi.fn((call: ApiCall) => {
  calls.push(call);
  const { method, path } = call;
  if (method === 'GET' && path === 'feedItems/7/ask') return { data: askState };
  if (method === 'POST' && path === 'feedItems/7/ask') {
    askState = { ...askState, conversationId: 'c1' };
    return { data: { conversationId: 'c1', created: true } };
  }
  if (method === 'DELETE' && path === 'feedItems/7/ask') {
    askState = { ...askState, conversationId: null };
    history = [];
    return { data: { deleted: 1 } };
  }
  if (method === 'POST' && path === 'feedItems/7/ask/runner') {
    askState = { ...askState, conversationId: 'c1', runnerPending: true };
    history = [
      {
        id: 'n1',
        role: 'assistant',
        parts: [
          {
            type: 'data-notice',
            data: {
              type: 'nocofeed.askQueued',
              title: 'Asked',
              params: { question: 'Who maintains it?', runId: 'r1' },
            },
          },
        ],
      },
    ];
    return { data: { conversationId: 'c1', runId: 'r1' } };
  }
  if (method === 'GET' && path === 'agents/conversations/c1/messages')
    return { data: history, meta: { lastSeq: history.length } };
  if (method === 'POST' && path === 'agents/conversations/c1/messages')
    return stream(
      'Kopf is a **Python** framework. See [Kopf docs](https://kopf.dev).',
    );
  return new Response(null, { status: 404 });
});

async function renderAsk() {
  return renderWithApp(
    <AuthenticationProvider>
      <Routes>
        <Route path='/' element={<AskSection itemId={7} />} />
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

describe('ask about an item', () => {
  beforeEach(() => {
    askState = { ...ready };
    history = [];
    calls.length = 0;
    api.mockClear();
  });

  it('points to the settings when nothing can answer', async () => {
    askState = { ...ready, online: false, webSearch: false };
    await renderAsk();
    expect(
      await screen.findByText(enUS.feed.ask.unavailable.title),
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: enUS.feed.ask.unavailable.models }),
    ).toHaveAttribute('href', '/settings/models');
    expect(
      screen.getByRole('link', { name: enUS.feed.ask.unavailable.preferences }),
    ).toHaveAttribute('href', '/preferences');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('opens the conversation with the first question and streams the answer as Markdown with its sources', async () => {
    const user = userEvent.setup();
    await renderAsk();
    expect(await screen.findByText(enUS.feed.ask.hint)).toBeVisible();
    expect(screen.getByText(enUS.feed.ask.webSearch)).toBeVisible();
    await user.type(
      screen.getByRole('textbox', { name: enUS.feed.ask.placeholder }),
      'What is Kopf?',
    );
    await user.click(screen.getByRole('button', { name: enUS.feed.ask.send }));

    const link = await screen.findByRole('link', { name: 'Kopf docs' });
    expect(link).toHaveAttribute('href', 'https://kopf.dev');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('Python').tagName).toBe('STRONG');
    expect(screen.getByText('What is Kopf?')).toBeVisible();

    const sent = calls.find(
      (call) =>
        call.method === 'POST' &&
        call.path === 'agents/conversations/c1/messages',
    );
    expect(sent?.json).toMatchObject({
      message: {
        role: 'user',
        parts: [{ type: 'text', text: 'What is Kopf?' }],
      },
    });
  });

  it('shows the kept conversation, with the runner answer, and clears it', async () => {
    askState = { ...ready, conversationId: 'c1' };
    history = [
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'What is an operator?' }],
      },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-feed_read_item',
            toolCallId: 'x',
            state: 'output-available',
            input: {},
            output: {},
          },
          {
            type: 'tool-feed_read_comments',
            toolCallId: 'y',
            state: 'output-available',
            input: {},
            output: { status: 'unavailable', count: 0, reason: 'needsLogin' },
          },
          { type: 'text', text: 'A controller for Kubernetes resources.' },
        ],
      },
      {
        id: 'n2',
        role: 'assistant',
        parts: [
          {
            type: 'data-notice',
            data: {
              type: 'nocofeed.askAnswer',
              title: 'Answered',
              params: {
                status: 'completed',
                answer: 'Maintained by [nolar](https://github.com/nolar).',
                runId: 'r0',
              },
            },
          },
        ],
      },
    ];
    const user = userEvent.setup();
    await renderAsk();
    expect(await screen.findByText('What is an operator?')).toBeVisible();
    expect(
      screen.getByText('A controller for Kubernetes resources.'),
    ).toBeVisible();
    // A tool that could not read says why.
    expect(
      screen.getByText(
        'Could not read the discussion: the platform needs a signed-in account',
      ),
    ).toBeVisible();
    expect(screen.getByText(enUS.feed.ask.tools.readItem)).toBeVisible();
    expect(screen.getByRole('link', { name: 'nolar' })).toHaveAttribute(
      'href',
      'https://github.com/nolar',
    );

    await user.click(screen.getByRole('button', { name: enUS.feed.ask.clear }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', { name: enUS.feed.common.delete }),
    );
    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.method === 'DELETE' && call.path === 'feedItems/7/ask',
        ),
      ).toBe(true),
    );
    expect(await screen.findByText(enUS.feed.ask.hint)).toBeVisible();
    expect(screen.queryByText('What is an operator?')).not.toBeInTheDocument();
  });

  it('hands a question to the runner agent and shows it waiting', async () => {
    askState = { ...ready, runnerAgentId: 'reader' };
    const user = userEvent.setup();
    await renderAsk();
    await user.type(
      await screen.findByRole('textbox', { name: enUS.feed.ask.placeholder }),
      'Who maintains it?',
    );
    await user.click(screen.getByRole('button', { name: /dig deeper/ }));
    await waitFor(() =>
      expect(
        calls.find(
          (call) =>
            call.method === 'POST' && call.path === 'feedItems/7/ask/runner',
        )?.json,
      ).toEqual({ question: 'Who maintains it?' }),
    );
    expect(await screen.findByText('Who maintains it?')).toBeVisible();
    expect(screen.getByText(/is looking into it/)).toBeVisible();
    expect(screen.getByRole('button', { name: /dig deeper/ })).toBeDisabled();
  });
});
