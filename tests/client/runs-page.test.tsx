import {
  answerApi,
  renderWithApp,
  type ApiCall,
} from '@nocobase/app-testing/client';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import RunsPage from '../../client/pages/runs/index.js';
import type { Run } from '../../client/pages/feed/types.js';
import enUS from '../../client/locales/en-US.js';
import packageMetadata from '../../package.json' with { type: 'json' };

const base = {
  sourceId: 1,
  sourceName: 'AI 工具',
  platform: 'xiaohongshu',
  itemId: null,
  stage: 'collect',
  trigger: 'schedule',
  status: 'succeeded',
  scope: null,
  found: 3,
  inserted: 3,
  analyzed: 3,
  error: null,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
} as const;

const runs: Run[] = [
  {
    ...base,
    id: 3,
    coverage: 'baseline',
    windowFilter: 'local',
    windowScanned: 100,
    windowShort: true,
  },
  {
    ...base,
    id: 2,
    coverage: 'complete',
    windowFilter: 'platform',
    windowScanned: null,
    windowShort: false,
  },
  // A run recorded before the field existed.
  { ...base, id: 1, coverage: 'complete' },
];

const api = vi.fn(({ method, path }: ApiCall) => {
  if (method === 'GET' && path === 'feedRuns')
    return {
      data: runs,
      meta: { stats: { found: 9, inserted: 9, analyzed: 9, failed: 0 } },
    };
  return new Response(null, { status: 404 });
});

describe('runs page', () => {
  it('says how the time window was applied and suggests widening it', async () => {
    renderWithApp(
      <Routes>
        <Route path='/runs' element={<RunsPage />} />
      </Routes>,
      {
        route: '/runs',
        namespace: packageMetadata.name,
        namespaces: { [packageMetadata.name]: enUS },
        fetch: answerApi(api),
      },
    );
    expect(
      await screen.findByText(
        'The platform cannot search by date: read 100 popular results and kept those inside the time window',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('The platform filtered by publication date'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Widen "Collect items from"' }),
    ).toHaveAttribute('href', '/preferences');
    expect(
      screen.getAllByText(
        /The platform (cannot search|filtered) by (date|publication date)/,
      ),
    ).toHaveLength(2);
  });
});
