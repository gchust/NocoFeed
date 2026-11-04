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

  it('keeps only https images and videos the browser may load', async () => {
    const media = [
      {
        type: 'image',
        url: 'https://sns-webpic-qc.xhscdn.com/a',
        width: 1080,
        height: 1440,
      },
      { type: 'image', url: 'http://sns-webpic-qc.xhscdn.com/b' },
      { type: 'image', url: 'javascript:alert(1)' },
      {
        type: 'video',
        url: 'https://sns-video-bd.xhscdn.com/v.mp4',
        cover: 'data:x',
        duration: 42,
      },
      { type: 'audio', url: 'https://sns-video-bd.xhscdn.com/a.mp3' },
      { type: 'image', url: 'https://sns-webpic-qc.xhscdn.com/a' },
    ];
    answer = (path) => ({
      status: 200,
      body: path.endsWith('/v1/collect')
        ? {
            status: 'ok',
            items: [
              { externalId: 'a', title: 'A', media },
              { externalId: 'b', title: 'B' },
            ],
          }
        : {
            status: 'ok',
            item: {
              body: '正文',
              media,
              coverage: { body: { status: 'available' } },
            },
          },
    });
    const expected = [
      {
        type: 'image',
        url: 'https://sns-webpic-qc.xhscdn.com/a',
        width: 1080,
        height: 1440,
      },
      {
        type: 'video',
        url: 'https://sns-video-bd.xhscdn.com/v.mp4',
        duration: 42,
      },
    ];
    const [withMedia, without] = (await collect()).items;
    expect(withMedia?.media).toEqual(expected);
    // An older Collector sends none: nothing, not an empty list.
    expect(without?.media).toBeUndefined();
    const enriched = await createAdapters(config).enrich({
      platform: 'xiaohongshu',
      externalId: 'a',
      url: 'https://www.xiaohongshu.com/explore/a',
      want: ['body'],
      signal: new AbortController().signal,
    });
    expect(enriched.media).toEqual(expected);
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

describe('Collector time window', () => {
  const since = new Date('2026-11-01T00:00:00Z');
  const collectSince = (adapters = createAdapters(config)) =>
    adapters.collect({
      platform: 'xiaohongshu',
      operation: 'keyword',
      target: '咖啡',
      limit: 20,
      cursor: null,
      knownIds: new Set(),
      since,
      signal: new AbortController().signal,
    });

  it('asks for what was published since the window starts', async () => {
    answer = () => ({ status: 200, body: { status: 'ok', items: items('a') } });
    const result = await collectSince();
    expect(result.items.map((item) => item.externalId)).toEqual(['a']);
    expect(received.map((entry) => entry.body)).toEqual([
      {
        platform: 'xiaohongshu',
        operation: 'keyword',
        target: '咖啡',
        limit: 20,
        cursor: null,
        since: '2026-11-01T00:00:00.000Z',
      },
    ]);
  });

  it('asks an older Collector that refuses since again without it, and keeps doing so for a while', async () => {
    // An older Collector validates strictly: an unknown field is a 400.
    answer = () => ({
      status:
        'since' in (received.at(-1)?.body as Record<string, unknown>)
          ? 400
          : 200,
      body: { status: 'ok', items: items('a') },
    });
    const adapters = createAdapters(config);
    expect((await collectSince(adapters)).status).toBe('ok');
    expect((await collectSince(adapters)).status).toBe('ok');
    expect(received.map((entry) => 'since' in (entry.body as object))).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('does not retry other refusals', async () => {
    answer = () => ({ status: 500, body: { error: 'boom' } });
    expect((await collectSince()).status).toBe('failed');
    expect(received).toHaveLength(1);
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
