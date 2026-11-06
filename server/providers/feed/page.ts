import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { cleanMedia } from './media.js';
import { htmlToText, truncate } from './text.js';
import { AdapterError, type MediaEntry } from './types.js';

/**
 * Reading an arbitrary web page someone pushed (`POST /feedItems/ingest` with only a link). The address comes from the
 * caller, so it is checked before every request, redirects included: only http(s) on the usual ports, and never a
 * loopback, private, link-local or otherwise internal address, so the push API cannot be used to reach this server's
 * own network. A page is read up to `MAX_PAGE_BYTES`; only HTML and plain text are read.
 */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20_000;

export type HostLookup = (host: string) => Promise<readonly string[]>;

const defaultLookup: HostLookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map(
    (entry) => entry.address,
  );

/** Whether an address is one a pushed link must never reach. */
export function internalAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    if (ip === '::' || ip === '::1') return true;
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mapped) return internalAddress(mapped);
    return /^(fc|fd|fe[89ab]|ff)/.test(ip);
  }
  return true;
}

/** Throws unless `url` is a public http(s) address. */
export async function assertPublicUrl(
  url: URL,
  lookup: HostLookup = defaultLookup,
): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new AdapterError('unsupported', 'pageUrlNotAllowed');
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port))
    throw new AdapterError('unsupported', 'pageUrlNotAllowed');
  if (url.username || url.password)
    throw new AdapterError('unsupported', 'pageUrlNotAllowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost'))
    throw new AdapterError('unsupported', 'pageUrlNotAllowed');
  let addresses: readonly string[];
  try {
    addresses = isIP(host) ? [host] : await lookup(host);
  } catch {
    throw new AdapterError('failed', 'pageHostUnknown');
  }
  if (!addresses.length || addresses.some(internalAddress))
    throw new AdapterError('unsupported', 'pageUrlNotAllowed');
}

export interface FetchedPage {
  /** Where the page was read, after redirects. */
  url: string;
  html: string;
  contentType: string;
}

export interface PageFetchOptions {
  signal: AbortSignal;
  userAgent: string;
  lookup?: HostLookup;
  fetch?: typeof fetch;
}

/** Reads a public page, following at most `MAX_REDIRECTS` redirects, each one checked again. */
export async function fetchPage(
  address: string,
  options: PageFetchOptions,
): Promise<FetchedPage> {
  const request = options.fetch ?? fetch;
  let url = new URL(address);
  for (let hop = 0; ; hop += 1) {
    await assertPublicUrl(url, options.lookup);
    let response: Response;
    try {
      response = await request(url, {
        redirect: 'manual',
        headers: {
          'user-agent': options.userAgent,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
        },
        signal: AbortSignal.any([
          options.signal,
          AbortSignal.timeout(TIMEOUT_MS),
        ]),
      });
    } catch (error) {
      throw new AdapterError(
        'failed',
        `${url.host}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || hop >= MAX_REDIRECTS)
        throw new AdapterError('failed', 'pageRedirects');
      url = new URL(location, url);
      continue;
    }
    if (response.status === 401 || response.status === 403)
      throw new AdapterError(
        response.status === 401 ? 'needsLogin' : 'blocked',
        `${url.host} answered ${response.status}`,
      );
    if (response.status === 429)
      throw new AdapterError('rateLimited', `${url.host} answered 429`);
    if (!response.ok)
      throw new AdapterError(
        'failed',
        `${url.host} answered ${response.status}`,
        response.status,
      );
    const contentType = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (
      contentType &&
      !['text/html', 'application/xhtml+xml', 'text/plain'].includes(
        contentType,
      )
    ) {
      await response.body?.cancel();
      throw new AdapterError('unsupported', 'pageNotText');
    }
    return {
      url: url.href,
      html: await readLimited(response),
      contentType: contentType || 'text/html',
    };
  }
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader: ReadableStreamDefaultReader<Uint8Array> =
    response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= MAX_PAGE_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return new TextDecoder().decode(
    Buffer.concat(chunks).subarray(0, MAX_PAGE_BYTES),
  );
}

export interface PageArticle {
  title: string;
  author?: string;
  summary?: string;
  body?: string;
  publishedAt?: string;
  media?: MediaEntry[];
}

const BODY_LIMIT = 20_000;

const decode = (value: string) => htmlToText(value).replace(/\s+/g, ' ').trim();

function meta(html: string, ...names: string[]): string | undefined {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');
    const patterns = [
      new RegExp(
        `<meta[^>]+(?:property|name|itemprop)\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
        'i',
      ),
      new RegExp(
        `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name|itemprop)\\s*=\\s*["']${escaped}["']`,
        'i',
      ),
    ];
    for (const pattern of patterns) {
      const value = html.match(pattern)?.[1];
      if (value && decode(value)) return decode(value);
    }
  }
  return undefined;
}

/** The part of the page that holds the text: `<article>`, else `<main>`, else the body, without navigation. */
function mainHtml(html: string): string {
  const pick = (tag: string) =>
    html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1];
  const region = pick('article') ?? pick('main') ?? pick('body') ?? html;
  return region
    .replace(
      /<\s*(script|style|noscript|template|svg|nav|header|footer|aside|form|iframe)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
      '',
    )
    .replace(/<!--[\s\S]*?-->/g, '');
}

/** Title, author, date, description and text of a page, read from its metadata and its main content. */
export function extractArticle(page: FetchedPage): PageArticle {
  if (page.contentType === 'text/plain') {
    const text = page.html.trim();
    const firstLine = text.split('\n', 1)[0]?.trim() ?? '';
    return {
      title: truncate(firstLine, 200) || page.url,
      body: text ? truncate(text, BODY_LIMIT) : undefined,
    };
  }
  const html = page.html;
  const title =
    meta(html, 'og:title', 'twitter:title') ??
    decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') ??
    '';
  const text = htmlToText(mainHtml(html));
  const published = meta(
    html,
    'article:published_time',
    'og:published_time',
    'datePublished',
    'pubdate',
  );
  const publishedAt =
    published && Number.isFinite(Date.parse(published))
      ? new Date(published).toISOString()
      : undefined;
  const image = meta(html, 'og:image', 'twitter:image');
  let imageUrl: string | undefined;
  try {
    imageUrl = image ? new URL(image, page.url).href : undefined;
  } catch {
    imageUrl = undefined;
  }
  const media = imageUrl
    ? cleanMedia([{ type: 'image', url: imageUrl }])
    : undefined;
  return {
    title: truncate(title, 500) || page.url,
    author: meta(html, 'author', 'article:author', 'twitter:creator'),
    summary: meta(html, 'og:description', 'description', 'twitter:description'),
    body: text ? truncate(text, BODY_LIMIT) : undefined,
    publishedAt,
    media: media?.length ? media : undefined,
  };
}

/** A public page as text for a reader (the conversation about an item): where it was read, its title and its text. */
export async function readPageText(
  address: string,
  options: PageFetchOptions,
): Promise<{ url: string; title: string; text: string }> {
  const page = await fetchPage(address, options);
  const article = extractArticle(page);
  const body = article.body?.trim() ?? '';
  const summary = article.summary?.trim() ?? '';
  // The description is usually the opening of the text; keep it only when the text does not already say it.
  const text =
    summary && !body.includes(summary)
      ? [summary, body].filter(Boolean).join('\n\n')
      : body;
  return { url: page.url, title: article.title, text };
}
