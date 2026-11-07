import {
  answerApi,
  renderWithApp,
  type ApiCall,
} from '@nocobase/app-testing/client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WritingSkillsCard,
  type WritingSkillSettings,
} from '../../client/pages/preferences/writing-skills.js';
import enUS from '../../client/locales/en-US.js';
import zhCN from '../../client/locales/zh-CN.js';
import packageMetadata from '../../package.json' with { type: 'json' };

const copy = enUS.preferences.writingSkills;

const skills = [
  {
    id: 's-en',
    name: 'humanizer',
    description: 'Rewrite AI-sounding text so it reads like the writer.',
    version: 3,
    size: 32_000,
  },
  {
    id: 's-zh',
    name: 'humanizer-zh',
    description: '去掉中文里的模板化表达。',
    version: 1,
    size: 20_000,
  },
];

let settings: WritingSkillSettings;

const api = vi.fn((call: ApiCall) => {
  const { method, path, json } = call;
  if (method === 'GET' && path === 'feedWritingSkills')
    return { data: settings };
  if (method === 'PUT' && path === 'feedWritingSkills') {
    settings = {
      ...settings,
      bindings: (json as Pick<WritingSkillSettings, 'bindings'>).bindings,
    };
    return { data: settings };
  }
  return new Response(null, { status: 404 });
});

function render() {
  return renderWithApp(
    <Routes>
      <Route path='/' element={<WritingSkillsCard />} />
    </Routes>,
    {
      route: '/',
      namespace: packageMetadata.name,
      namespaces: { [packageMetadata.name]: enUS },
      fetch: answerApi(api),
    },
  );
}

describe('writing skills card', () => {
  beforeEach(() => {
    api.mockClear();
    settings = {
      bindings: { replies: { en: 's-en' } },
      skills,
      available: true,
    };
  });

  it('shows the chosen skill per use and language, and saves a new choice', async () => {
    const user = userEvent.setup();
    const view = await render();
    expect(await screen.findByText(copy.title)).toBeInTheDocument();
    expect(screen.getByText(copy.uses.replies)).toBeInTheDocument();
    expect(screen.getByText(copy.uses.ideas)).toBeInTheDocument();
    expect(screen.getByText(copy.uses.briefs)).toBeInTheDocument();
    // English replies use humanizer, and its description is shown.
    expect(screen.getByText(skills[0]!.description)).toBeInTheDocument();

    const [, zhReplies] = screen.getAllByRole('combobox');
    await user.click(zhReplies!);
    await user.click(
      await screen.findByRole('option', { name: 'humanizer-zh' }),
    );
    await user.click(screen.getByRole('button', { name: copy.save }));
    await waitFor(() =>
      expect(view.toasts()).toEqual([
        expect.objectContaining({ type: 'success', title: copy.saved }),
      ]),
    );
    const [put] = api.mock.calls.find(
      ([call]) => call.method === 'PUT' && call.path === 'feedWritingSkills',
    )!;
    expect(put.json).toEqual({
      bindings: { replies: { en: 's-en', zh: 's-zh' } },
    });
  });

  it('says where skills come from when the library is empty', async () => {
    settings = { bindings: {}, skills: [], available: true };
    await render();
    expect(await screen.findByText(copy.empty)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.save })).toBeNull();
  });

  it('has the same keys in both languages', () => {
    const keys = (value: object): string[] =>
      Object.entries(value)
        .flatMap(([key, entry]) =>
          entry && typeof entry === 'object'
            ? keys(entry).map((inner) => `${key}.${inner}`)
            : [key],
        )
        .sort();
    expect(keys(zhCN.preferences.writingSkills)).toEqual(
      keys(enUS.preferences.writingSkills),
    );
  });
});
