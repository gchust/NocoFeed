import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import type {
  MailAccountView,
  MailFolder,
  MailListMessagesInput,
  MailMessage,
  MailOperationContext,
} from '@nocobase/app-plugin-mail/server';
import { createAppTest } from '@nocobase/app-testing/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { describe, expect, it, vi } from 'vitest';

import type { Adapters } from '../../server/providers/feed/adapters.js';
import {
  createMailCollector,
  mailExternalId,
  mailOptions,
  matchesMailFilters,
  withMail,
  type MailReader,
} from '../../server/providers/feed/mail.js';
import { createFeedService } from '../../server/providers/feed/service.js';
import { createStandaloneServer } from '../../server/standalone.js';

const ORIGIN = 'http://localhost';
const DAY = 86_400_000;

const test = createAppTest({
  createServer: createStandaloneServer,
  connections: ['main'],
  scope: 'test',
  config: {
    app: { publicOrigin: ORIGIN },
    auth: {
      secret: 'test-auth-secret-at-least-32-characters',
      trustedOrigins: [ORIGIN],
    },
    users: { initialAdmin: DEFAULT_ADMIN_CREDENTIALS },
  },
});

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function message(
  id: string,
  values: Partial<MailMessage> & { folder?: string },
): MailMessage & { folder: string } {
  return {
    id,
    accountId: 'acc-1',
    providerMessageId: `p-${id}`,
    internetMessageId: `<${id}@mail.example.com>`,
    folderIds: [],
    labelIds: [],
    to: [],
    cc: [],
    bcc: [],
    subject: `Subject ${id}`,
    read: false,
    starred: false,
    draft: false,
    hasAttachments: false,
    todo: false,
    replyTo: [],
    references: [],
    attachments: [],
    folder: 'INBOX',
    ...values,
  };
}

/**
 * A stand-in for the Mail plugin's `MailService`: one person's account with an inbox and a newsletter folder. Every
 * mutating method fails the test when called, so collecting is shown to read only.
 */
function fakeMail(
  owner: string,
  messages: (MailMessage & { folder: string })[],
) {
  const account: MailAccountView = {
    id: 'acc-1',
    userId: owner,
    provider: { type: 'imap-smtp', name: 'company-mail' },
    address: 'me@example.com',
    scopes: [],
    status: 'active',
  };
  const folders: MailFolder[] = [
    {
      id: 'f-inbox',
      accountId: 'acc-1',
      providerFolderId: 'INBOX',
      type: 'inbox',
      name: 'Inbox',
      kind: 'folder',
    },
    {
      id: 'f-news',
      accountId: 'acc-1',
      providerFolderId: 'News',
      type: 'custom',
      name: 'Newsletters',
      kind: 'folder',
    },
  ];
  const mine = (context: MailOperationContext) => context.actorId === owner;
  const forbidden = vi.fn(() => {
    throw new Error('collecting must not change the mailbox');
  });
  const service = {
    listAccounts: vi.fn(async (context: MailOperationContext) =>
      mine(context) ? [account] : [],
    ),
    listFolders: vi.fn(async (context: MailOperationContext, id: string) =>
      mine(context) && id === account.id ? folders : [],
    ),
    listMessages: vi.fn(
      async (context: MailOperationContext, input: MailListMessagesInput) => {
        if (!mine(context)) return { items: [] };
        const matching = messages
          .filter((entry) => input.folderIds?.includes(entry.folder))
          .sort((a, b) =>
            (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''),
          );
        const start = Number(input.cursor ?? 0);
        const limit = input.limit ?? 50;
        const items = matching.slice(start, start + limit);
        return {
          items,
          nextCursor:
            start + limit < matching.length ? String(start + limit) : undefined,
        };
      },
    ),
    getMessage: vi.fn(
      async (context: MailOperationContext, _account: string, id: string) =>
        mine(context) ? messages.find((entry) => entry.id === id) : undefined,
    ),
    updateMessage: forbidden,
    moveMessage: forbidden,
    deleteMessage: forbidden,
    updateMessageLabels: forbidden,
    retryMessageContent: forbidden,
    startSync: forbidden,
  };
  return { service, forbidden };
}

describe('mail filters', () => {
  it('normalizes what is stored and matches senders and subjects', () => {
    const options = mailOptions({
      folder: '  Newsletters ',
      senders: ['@Example.com', ' Alice ', 'alice', 3],
      subjectKeywords: ['Postgres', ''],
    });
    expect(options).toEqual({
      folder: 'Newsletters',
      senders: ['@example.com', 'alice'],
      subjectKeywords: ['postgres'],
    });
    const from = (address: string, name?: string) => ({
      from: { address, name },
      subject: 'Weekly POSTGRES digest',
    });
    expect(matchesMailFilters(from('news@example.com'), options)).toBe(true);
    expect(matchesMailFilters(from('x@other.org', 'Alice'), options)).toBe(
      true,
    );
    expect(matchesMailFilters(from('x@example.com.evil.org'), options)).toBe(
      false,
    );
    expect(
      matchesMailFilters(
        { from: { address: 'news@example.com' }, subject: 'Hello' },
        options,
      ),
    ).toBe(false);
    expect(
      matchesMailFilters(
        { from: { address: 'any@where.org' }, subject: 'Anything' },
        mailOptions(null),
      ),
    ).toBe(true);
  });

  it('keeps the Message-ID as the external id', () => {
    expect(
      mailExternalId('acc-1', { id: 'm1', internetMessageId: '<a@b.c>' }),
    ).toBe('a@b.c');
    expect(mailExternalId('acc-1', { id: 'm1' })).toBe('mail:acc-1:m1');
  });
});

async function setUp(testApp: Parameters<typeof signIn>[0]) {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const database = (
    testApp as unknown as {
      application: {
        container: { resolve: (token: unknown) => DatabaseManager };
      };
    }
  ).application.container.resolve(databaseManagerToken);
  const messages = [
    message('fresh', {
      subject: 'Postgres 18 is out',
      from: { address: 'news@example.com', name: 'Example News' },
      receivedAt: ago(DAY),
      preview: 'The new release',
      html: '<p>Faster <b>vacuum</b> and async I/O.</p>',
    }),
    message('other-sender', {
      subject: 'Postgres tips',
      from: { address: 'spam@elsewhere.org' },
      receivedAt: ago(2 * DAY),
      text: 'Buy now',
    }),
    message('other-subject', {
      subject: 'Lunch on Friday?',
      from: { address: 'friend@example.com' },
      receivedAt: ago(2 * DAY),
      text: 'Shall we?',
    }),
    message('draft', {
      subject: 'Postgres draft',
      from: { address: 'news@example.com' },
      receivedAt: ago(DAY),
      draft: true,
    }),
    message('stale', {
      subject: 'Postgres 9.6 retired',
      from: { address: 'news@example.com' },
      receivedAt: ago(30 * DAY),
      text: 'Old news',
    }),
    message('in-news', {
      subject: 'Postgres weekly',
      from: { address: 'news@example.com' },
      receivedAt: ago(DAY),
      text: 'Weekly',
      folder: 'News',
    }),
  ];
  const { service: mail, forbidden } = fakeMail(admin.user.id, messages);
  const collector = createMailCollector(() => mail as unknown as MailReader);
  const publicCollect = vi.fn();
  const service = createFeedService({
    database,
    adapters: withMail(
      {
        collect: publicCollect,
        enrich: vi.fn(),
        collectorConfigured: () => false,
        replyCount: vi.fn(),
        metrics: vi.fn(),
      } as unknown as Adapters,
      collector,
    ),
    mailAccounts: (owner) => collector.accounts(owner),
    agents: () => undefined,
    config: () => ({
      collector: { timeoutMs: 1_000 },
      tickMinutes: 5,
      userAgent: 'test',
      notificationChannel: 'inbox',
    }),
    notify: async () => true,
    log: () => undefined,
  });
  await service.saveProfile(admin.user.id, {
    interests: 'postgres databases',
    expertise: '',
    avoid: '',
    dailyLimit: 0,
    keepLearning: true,
    locale: 'en-US',
  });
  const items = async () =>
    (await database
      .query()
      .selectFrom('feedItems')
      .select([
        'externalId',
        'platform',
        'title',
        'author',
        'body',
        'publishedAt',
        'ownerId',
      ])
      .orderBy('externalId', 'asc')
      .execute()) as Record<string, unknown>[];
  return {
    admin,
    database,
    service,
    mail,
    forbidden,
    publicCollect,
    messages,
    items,
  };
}

test('a mail subscription turns new messages into feed items, filtered and within the window, reading only', async ({
  testApp,
}) => {
  const {
    admin,
    database,
    service,
    mail,
    forbidden,
    publicCollect,
    messages,
    items,
  } = await setUp(testApp);
  const source = await service.createSource(admin.user.id, {
    platform: 'mail',
    operation: 'messages',
    name: 'Postgres mail',
    target: 'acc-1',
    frequency: 60,
    candidateLimit: 20,
    options: {
      senders: ['@example.com'],
      subjectKeywords: ['postgres'],
    },
  });
  expect(source.options).toEqual({
    folder: null,
    senders: ['@example.com'],
    subjectKeywords: ['postgres'],
  });

  const run = await service.runSource(admin.user.id, source.id, 'manual');
  expect(run.status).toBe('succeeded');
  expect(run.inserted).toBe(1);
  expect(await items()).toEqual([
    expect.objectContaining({
      externalId: 'fresh@mail.example.com',
      platform: 'mail',
      ownerId: admin.user.id,
      title: 'Postgres 18 is out',
      author: 'Example News <news@example.com>',
      body: 'Faster vacuum and async I/O.',
    }),
  ]);
  const [stored] = await items();
  expect(new Date(String(stored.publishedAt)).toISOString()).toBe(
    messages[0].receivedAt,
  );
  // It went through the analysis like anything collected.
  const analyses = await database
    .query()
    .selectFrom('feedAnalyses')
    .select(['itemId'])
    .execute();
  expect(analyses).toHaveLength(1);
  // Read as the owner, from the inbox only, and nothing in the mailbox was changed.
  for (const call of mail.listMessages.mock.calls)
    expect(call[0].actorId).toBe(admin.user.id);
  expect(mail.listMessages.mock.calls[0][1].folderIds).toEqual(['INBOX']);
  expect(forbidden).not.toHaveBeenCalled();
  expect(publicCollect).not.toHaveBeenCalled();

  // The next run stores nothing twice.
  const again = await service.runSource(admin.user.id, source.id, 'manual');
  expect(again.inserted).toBe(0);

  // A new message arrives; a later run picks it up.
  messages.push(
    message('newer', {
      subject: 'Postgres meetup',
      from: { address: 'events@example.com' },
      receivedAt: ago(60_000),
      text: 'See you there',
    }),
  );
  const third = await service.runSource(admin.user.id, source.id, 'manual');
  expect(third.inserted).toBe(1);
  expect((await items()).map((row) => row.externalId)).toEqual([
    'fresh@mail.example.com',
    'newer@mail.example.com',
  ]);
  expect(forbidden).not.toHaveBeenCalled();
});

test('a mail subscription reads the folder it names and keeps everything when the window is off', async ({
  testApp,
}) => {
  const { admin, service, items } = await setUp(testApp);
  await service.saveProfile(admin.user.id, {
    interests: 'postgres databases',
    expertise: '',
    avoid: '',
    dailyLimit: 0,
    keepLearning: true,
    maxAgeDays: 0,
  });
  const news = await service.createSource(admin.user.id, {
    platform: 'mail',
    operation: 'messages',
    name: 'Newsletters',
    target: 'acc-1',
    frequency: 60,
    candidateLimit: 20,
    options: { folder: 'newsletters' },
  });
  expect(
    (await service.runSource(admin.user.id, news.id, 'manual')).inserted,
  ).toBe(1);
  expect((await items()).map((row) => row.externalId)).toEqual([
    'in-news@mail.example.com',
  ]);

  const inbox = await service.createSource(admin.user.id, {
    platform: 'mail',
    operation: 'messages',
    name: 'Inbox',
    target: 'acc-1',
    frequency: 60,
    candidateLimit: 2,
  });
  const run = await service.runSource(admin.user.id, inbox.id, 'manual');
  // Two of the four non-draft inbox messages fit; the rest wait for the next run.
  expect(run.inserted).toBe(2);
  expect(run.coverage).toBe('baseline');
  expect(
    (await service.runSource(admin.user.id, inbox.id, 'manual')).inserted,
  ).toBe(2);
  expect((await items()).map((row) => row.externalId)).toEqual([
    'fresh@mail.example.com',
    'in-news@mail.example.com',
    'other-sender@mail.example.com',
    'other-subject@mail.example.com',
    'stale@mail.example.com',
  ]);

  const missing = await service.updateSource(admin.user.id, news.id, {
    options: { folder: 'Nowhere' },
  });
  expect(missing.options).toMatchObject({ folder: 'Nowhere' });
  const failed = await service.runSource(admin.user.id, news.id, 'manual');
  expect(failed.status).toBe('failed');
  expect(failed.error).toBe('mailFolderMissing');
});

test("a mail subscription only ever reads its owner's account", async ({
  testApp,
}) => {
  const { admin, service, database, items } = await setUp(testApp);
  // Another person cannot subscribe to it: to them the account does not exist.
  await expect(
    service.createSource('someone-else', {
      platform: 'mail',
      operation: 'messages',
      name: 'Not mine',
      target: 'acc-1',
      frequency: 60,
      candidateLimit: 20,
    }),
  ).rejects.toMatchObject({ code: 'invalid', message: 'mailAccountMissing' });

  // Even a row pointing at it reads nothing: the Mail plugin answers as that person.
  const now = new Date();
  const created = await database.repository('feedSources').createOne({
    values: {
      ownerId: 'someone-else',
      platform: 'mail',
      operation: 'messages',
      name: 'Forged',
      target: 'acc-1',
      frequency: 60,
      candidateLimit: 20,
      active: true,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    },
  } as never);
  const forged = Number((created as { record: { id: number } }).record.id);
  const run = await service.runSource('someone-else', forged, 'manual');
  expect(run.status).toBe('failed');
  expect(run.error).toBe('mailAccountMissing');
  expect(await items()).toEqual([]);
  expect(admin.user.id).not.toBe('someone-else');
});
