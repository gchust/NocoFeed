import {
  AuthenticationProvider,
  authenticationClientToken,
} from '@nocobase/app-plugin-authentication/client';
import {
  answerApi,
  renderWithApp,
  type ApiCall,
} from '@nocobase/app-testing/client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import type { Catalog, Source } from '../../client/pages/feed/types.js';
import SourceDialog from '../../client/pages/sources/form.js';
import SourcesPage from '../../client/pages/sources/index.js';
import { splitList } from '../../client/pages/sources/mail.js';
import PushDialog from '../../client/pages/sources/push.js';
import packageMetadata from '../../package.json' with { type: 'json' };

const getSession = vi.fn(async () => ({ data: null }));
const apiKey = {
  list: vi.fn(async () => ({
    data: {
      apiKeys: [
        {
          id: 'k1',
          name: 'Old script',
          prefix: null,
          start: 'abc123',
          enabled: true,
          expiresAt: null,
        },
      ],
      total: 1,
    },
    error: null,
  })),
  create: vi.fn(async () => ({
    data: { id: 'k2', key: 'secret-key-shown-once' },
    error: null,
  })),
  delete: vi.fn(async () => ({ data: { success: true }, error: null })),
};

const mailSource: Source = {
  id: 7,
  topicId: null,
  platform: 'mail',
  operation: 'messages',
  name: 'Newsletters',
  target: 'acc-1',
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
  options: {
    folder: 'News',
    senders: ['@example.com'],
    subjectKeywords: [],
  },
};

const catalog = {
  collectorConfigured: false,
  model: { available: true, name: 'm' },
  platforms: [
    {
      platform: 'hn',
      experimental: false,
      needsLogin: false,
      operations: [
        {
          operation: 'new',
          implementation: 'native',
          input: 'none',
          single: false,
          capabilities: [],
          targetLength: null,
          available: true,
        },
      ],
    },
    {
      platform: 'mail',
      experimental: false,
      needsLogin: false,
      operations: [
        {
          operation: 'messages',
          implementation: 'native',
          input: 'account',
          single: false,
          capabilities: ['newMessages'],
          targetLength: null,
          available: true,
        },
      ],
    },
  ],
} as unknown as Catalog;

const api = vi.fn(({ method, path }: ApiCall) => {
  if (method === 'GET' && path === 'feedSources') return { data: [mailSource] };
  if (method === 'GET' && path === 'feedCatalog') return { data: catalog };
  if (method === 'GET' && path === 'feedMailAccounts')
    return {
      data: [
        {
          id: 'acc-1',
          address: 'me@example.com',
          displayName: null,
          provider: 'imap-smtp',
          status: 'active',
        },
      ],
      meta: { total: 1, available: true },
    };
  if (method === 'PATCH' && path === 'feedSources/7')
    return { data: mailSource };
  return new Response(null, { status: 404 });
});

function renderAt(route: string) {
  return renderWithApp(
    <AuthenticationProvider>
      <Routes>
        <Route path='/sources' element={<SourcesPage />}>
          <Route path=':sourceId/edit' element={<SourceDialog />} />
          <Route path='push' element={<PushDialog />} />
        </Route>
      </Routes>
    </AuthenticationProvider>,
    {
      route,
      namespace: packageMetadata.name,
      namespaces: { [packageMetadata.name]: enUS },
      fetch: answerApi(api),
      services: (app) => {
        app.container.instance(authenticationClientToken, {
          getSession,
          apiKey,
        });
      },
    },
  );
}

describe('mail subscriptions', () => {
  beforeEach(() => {
    api.mockClear();
  });

  it('splits typed lists', () => {
    expect(splitList('a@x.com, @y.org\n b ,a@x.com，', 200)).toEqual([
      'a@x.com',
      '@y.org',
      'b',
    ]);
  });

  it('edits the account, folder and filters of a mail subscription', async () => {
    const user = userEvent.setup();
    await renderAt('/sources/7/edit');
    expect(await screen.findByText('me@example.com')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Manage mail accounts' })
        .getAttribute('href'),
    ).toBe('/mail/accounts');
    const folder = screen.getByLabelText<HTMLInputElement>('Folder');
    expect(folder.value).toBe('News');
    const senders = screen.getByLabelText<HTMLTextAreaElement>(
      'Only from these senders',
    );
    expect(senders.value).toBe('@example.com');
    await user.clear(senders);
    await user.type(senders, '@example.com, news@other.org');
    await user.type(
      screen.getByLabelText('Only with these words in the subject'),
      'weekly',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'PATCH',
          path: 'feedSources/7',
          json: expect.objectContaining({
            target: 'acc-1',
            options: {
              folder: 'News',
              senders: ['@example.com', 'news@other.org'],
              subjectKeywords: ['weekly'],
            },
          }),
        }),
      ),
    );
  });
});

describe('push dialog', () => {
  beforeEach(() => {
    api.mockClear();
    apiKey.create.mockClear();
    apiKey.delete.mockClear();
  });

  it('is offered from the subscriptions page', async () => {
    await renderAt('/sources');
    const link = await screen.findByRole('link', { name: 'Push & API' });
    expect(link.getAttribute('href')).toBe('/sources/push');
  });

  it('shows the endpoint with examples, lists keys and shows a new key once', async () => {
    const user = userEvent.setup();
    await renderAt('/sources/push');
    expect(await screen.findByText('Old script')).toBeTruthy();
    const examples = document.querySelectorAll('pre code');
    expect(examples).toHaveLength(2);
    expect(examples[0].textContent).toContain('/api/feedItems/ingest');
    expect(examples[0].textContent).toContain('x-api-key');
    expect(examples[1].textContent).toContain('"content"');
    expect(screen.getByText('Browser extension')).toBeTruthy();

    await user.type(screen.getByLabelText('Key name'), 'Bookmarklet');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(await screen.findByText('secret-key-shown-once')).toBeTruthy();
    expect(apiKey.create).toHaveBeenCalledWith({
      name: 'Bookmarklet',
      expiresIn: 90 * 86_400,
    });

    // Revoking asks once more before it happens.
    await user.click(screen.getByRole('button', { name: 'Revoke Old script' }));
    expect(apiKey.delete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Revoke Old script' }));
    await waitFor(() =>
      expect(apiKey.delete).toHaveBeenCalledWith({ keyId: 'k1' }),
    );
  });
});
