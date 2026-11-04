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

import PreferencesPage from '../../client/pages/preferences/index.js';
import type { Catalog, Profile } from '../../client/pages/feed/types.js';
import enUS from '../../client/locales/en-US.js';
import packageMetadata from '../../package.json' with { type: 'json' };

// The enabled runner agents come from the Agents plugin's own query cache; the page only offers them.
const agentOptions = vi.hoisted(() => ({
  options: [{ value: 'claude-sonnet', label: 'Claude Sonnet' }],
  agents: [],
  loading: false,
  failed: false,
  nameOf: (id: string) => (id === 'claude-sonnet' ? 'Claude Sonnet' : null),
}));
vi.mock('@nocobase/app-plugin-agents/client/kit', () => ({
  useAgentOptions: () => agentOptions,
}));

const getSession = vi.fn(async () => ({ data: null }));

const profile: Profile = {
  interests: 'LLM agents',
  expertise: 'Evaluation harnesses',
  avoid: '',
  dailyLimit: 1000,
  keepLearning: true,
  locale: 'en-US',
  configured: true,
  termWeights: {},
  digestEnabled: false,
  digestHour: 8,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
  readerAgentId: null,
};

const catalog = {
  collectorConfigured: false,
  model: { available: true, name: 'openai/gpt' },
  platforms: [],
} as unknown as Catalog;

const api = vi.fn(({ method, path, json }: ApiCall) => {
  if (method === 'GET' && path === 'feedProfile') return { data: profile };
  if (method === 'GET' && path === 'feedCatalog') return { data: catalog };
  if (method === 'PUT' && path === 'feedProfile')
    return { data: { ...profile, ...(json as Partial<Profile>) } };
  return new Response(null, { status: 404 });
});

function renderPage() {
  return renderWithApp(
    <AuthenticationProvider>
      <Routes>
        <Route path='/preferences' element={<PreferencesPage />} />
      </Routes>
    </AuthenticationProvider>,
    {
      route: '/preferences',
      namespace: packageMetadata.name,
      namespaces: { [packageMetadata.name]: enUS },
      fetch: answerApi(api),
      services: (app) => {
        app.container.instance(authenticationClientToken, { getSession });
      },
    },
  );
}

describe('preferences page', () => {
  beforeEach(() => {
    api.mockClear();
  });

  it('hands "Analyse again" to a chosen runner agent', async () => {
    const user = userEvent.setup();
    await renderPage();
    const select = await screen.findByRole('combobox', {
      name: 'Runner agent for “Analyse again”',
    });
    expect(select.textContent).toContain('None: use the AI model');
    await user.click(select);
    await user.click(
      await screen.findByRole('option', { name: 'Claude Sonnet' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(
        api.mock.calls.some(
          ([call]) => call.method === 'PUT' && call.path === 'feedProfile',
        ),
      ).toBe(true),
    );
    const [call] = api.mock.calls.find(
      ([entry]) => entry.method === 'PUT' && entry.path === 'feedProfile',
    )!;
    expect(call.json).toMatchObject({ readerAgentId: 'claude-sonnet' });
  });

  it('sends null when no runner agent is chosen', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.clear(await screen.findByLabelText('Avoid'));
    await user.type(screen.getByLabelText('Avoid'), 'Crypto');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(
        api.mock.calls.some(
          ([call]) => call.method === 'PUT' && call.path === 'feedProfile',
        ),
      ).toBe(true),
    );
    const [call] = api.mock.calls.find(
      ([entry]) => entry.method === 'PUT' && entry.path === 'feedProfile',
    )!;
    expect(call.json).toMatchObject({ readerAgentId: null, avoid: 'Crypto' });
  });
});
