const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
  '#x2F': '/',
};

/** Turns an HTML fragment from a feed or API into readable plain text, keeping paragraph breaks. */
export function htmlToText(html: string | undefined | null): string {
  if (!html) return '';
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|blockquote|pre)\s*>/gi, '\n\n')
    .replace(/<\s*p[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
      if (ENTITIES[code]) return ENTITIES[code];
      if (code.startsWith('#x'))
        return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith('#'))
        return String.fromCodePoint(Number(code.slice(1)));
      return match;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(text: string | undefined | null, max: number): string {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const STOP_WORDS = new Set(
  "the and for with that this from your you are was were have has had not but can how what why when who which into about over under more most less than then them they their there here just like also only very much many some any all out our its it's use using used get got via per one two new".split(
    ' ',
  ),
);

const CJK = /[㐀-鿿豈-﫿]/;

/**
 * Splits free text into match terms: lower-cased English words of three letters or more, and overlapping two-character
 * pieces of Chinese runs. Good enough to say whether a title touches a topic; not a search engine.
 */
export function terms(text: string | undefined | null): Set<string> {
  const result = new Set<string>();
  if (!text) return result;
  const lower = text.toLowerCase();
  for (const word of lower.match(/[a-z][a-z0-9+#.-]{2,}/g) ?? []) {
    const clean = word.replace(/[.-]+$/, '');
    if (clean.length >= 3 && !STOP_WORDS.has(clean)) result.add(clean);
  }
  for (const run of lower.match(/[㐀-鿿豈-﫿]+/g) ?? []) {
    if (run.length === 1) continue;
    for (let i = 0; i < run.length - 1; i += 1) result.add(run.slice(i, i + 2));
  }
  return result;
}

export function hasCjk(text: string): boolean {
  return CJK.test(text);
}

/** Phrases that suggest an open question or discussion rather than an announcement. */
export function looksLikeQuestion(text: string): boolean {
  return /[?？]|^ask hn|\b(how|why|what|anyone|should i|advice|help)\b|怎么|如何|为什么|求助|请教|有没有|吗[？?]?$/i.test(
    text.trim(),
  );
}

/** Runs `worker` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run()),
  );
  return results;
}
