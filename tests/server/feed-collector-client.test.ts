import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { FeedConfig } from '../../server/config/feed.js';
import { createAdapters } from '../../server/providers/feed/adapters.js';
import { storedExternalId } from '../../server/providers/feed/service.js';

const TOKEN = 'collector-test-token';

interface Exchange {
  path: string;
  authorization: string | undefined;
  body: unknown;
}

let server: Server;
let base = '';
const received: Exchange[] = [];
let answer: (path: string) => { status: number; body: unknown } = () => ({
  status: 200,
  body: { status: 'ok', items: [] },
});

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void readJson(req).then((body) => {
      const path = req.url ?? '';
      received.push({ path, authorization: req.headers.authorization, body });
      const { status, body: reply } = answer(path);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(() => {
  received.length = 0;
  vi.restoreAllMocks();
});

const config = (): FeedConfig => ({
  collector: { url: base, token: TOKEN, timeoutMs: 180_000 },
  tickMinutes: 5,
  userAgent: 'NocoFeed-test',
  notificationChannel: 'inbox',
});

const collect = (
  overrides: Partial<{ limit: number; knownIds: Set<string> }> = {},
) =>
  createAdapters(config).collect({
    platform: 'xiaohongshu',
    operation: 'keyword',
    target: '咖啡',
    limit: overrides.limit ?? 20,
    cursor: null,
    knownIds: overrides.knownIds ?? new Set(),
    signal: new AbortController().signal,
  });

const items = (...ids: string[]) =>
  ids.map((externalId) => ({
    externalId,
    title: `Note ${externalId}`,
    url: `https://www.xiaohongshu.com/explore/${externalId}`,
  }));

describe('Collector client', () => {
  it('sends exactly the protocol fields with the token and the configured timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await collect();
    expect(received).toEqual([
      {
        path: '/v1/collect',
        authorization: `Bearer ${TOKEN}`,
        body: {
          platform: 'xiaohongshu',
          operation: 'keyword',
          target: '咖啡',
          limit: 20,
          cursor: null,
        },
      },
    ]);
    // The Collector waits for its browser; the 30 s limit for public platforms must not apply.
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([180_000]);
  });

  it('reports a refused token as a configuration problem, not a platform sign-in', async () => {
    answer = () => ({ status: 401, body: { error: 'unauthorized' } });
    expect(await collect()).toMatchObject({
      status: 'unconfigured',
      message: 'collectorUnauthorized',
    });
  });

  it('marks a full page of unseen items as possibly incomplete', async () => {
    answer = () => ({
      status: 200,
      body: { status: 'ok', items: items('a', 'b') },
    });
    expect(
      (await collect({ limit: 2, knownIds: new Set(['z']) })).truncated,
    ).toBe(true);
    expect(
      (await collect({ limit: 2, knownIds: new Set(['b']) })).truncated,
    ).toBe(false);
    expect(
      (await collect({ limit: 5, knownIds: new Set(['z']) })).truncated,
    ).toBe(false);
    // The Collector's own "page was full" counts only while nothing stored was reached.
    answer = () => ({
      status: 200,
      body: { status: 'ok', truncated: true, items: items('a', 'b') },
    });
    expect(
      (await collect({ limit: 50, knownIds: new Set(['z']) })).truncated,
    ).toBe(true);
    expect(
      (await collect({ limit: 50, knownIds: new Set(['b']) })).truncated,
    ).toBe(false);
    // The first run is a baseline; nothing can have been missed yet.
    expect((await collect({ limit: 2 })).truncated).toBe(false);
  });

  it('drops links that are not http(s)', async () => {
    answer = () => ({
      status: 200,
      body: {
        status: 'ok',
        items: [{ externalId: 'a', title: 'A', url: 'javascript:alert(1)' }],
      },
    });
    const [item] = (await collect()).items;
    expect(item?.url).toBeUndefined();
  });

  it('keeps one translatable message when enrich combines two Collector calls', async () => {
    answer = () => ({
      status: 200,
      body: {
        status: 'ok',
        message: 'unsupportedPart',
        item: { coverage: {} },
      },
    });
    const result = await createAdapters(config).enrich({
      platform: 'x',
      externalId: '1234567890',
      url: 'https://x.com/i/status/1234567890',
      want: ['comments', 'transcript'],
      signal: new AbortController().signal,
    });
    expect(
      received.map((entry) => (entry.body as { want: string[] }).want),
    ).toEqual([['comments'], ['transcript']]);
    expect(result.message).toBe('unsupportedPart');
  });
});

describe('storedExternalId', () => {
  it('keeps short ids and hashes long ones stably', () => {
    expect(storedExternalId('abc')).toBe('abc');
    const long = `https://example.com/${'x'.repeat(300)}`;
    expect(storedExternalId(long)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(storedExternalId(long)).toBe(storedExternalId(long));
    expect(storedExternalId(long).length).toBeLessThanOrEqual(191);
  });
});
