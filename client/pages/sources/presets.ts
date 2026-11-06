import type { Platform, Source } from '../feed/types.js';

/**
 * Recommended subscriptions offered under "Browse recommended" on the subscriptions page.
 *
 * This is a static catalogue in the client, not a seed: nothing is written until the person subscribes, and a
 * subscription made from it is an ordinary `POST /feedSources` validated like one typed by hand. The list was put
 * together for NocoFeed from each publisher's own feed address; the category scheme takes ideas from the
 * community-curated directory at horizon1123.top (issue gchust/nocofeed-feedback#10), whose data is not copied.
 *
 * Only list operations NocoFeed can follow as a subscription appear here (RSS feeds, Reddit communities, Hacker News
 * lists, YouTube channels and X accounts). Bilibili and Xiaohongshu only search, which belongs to topics.
 * Descriptions are translated under `sources.presets.items.<id>`; `name` is the publisher's own name.
 */

export const PRESET_CATEGORIES = [
  'ai',
  'dev',
  'web',
  'security',
  'product',
  'design',
  'news',
  'science',
  'chinese',
] as const;

export type PresetCategory = (typeof PRESET_CATEGORIES)[number];

export interface SourcePreset {
  /** Stable camelCase id; also the translation key of the description. */
  readonly id: string;
  readonly category: PresetCategory;
  readonly platform: Platform;
  readonly operation: string;
  readonly name: string;
  /** What the subscription follows, in the form the create form accepts; empty when the operation takes none. */
  readonly target: string;
  /** The language the source publishes in. */
  readonly language: 'en' | 'zh';
  /** Minutes between runs; a quiet blog does not need checking every hour. */
  readonly frequency: number;
}

const HOURLY = 60;
const EVERY_3H = 180;
const EVERY_6H = 360;
const EVERY_12H = 720;
const DAILY = 1440;

type Entry = Omit<SourcePreset, 'category'>;

const rss = (
  id: string,
  name: string,
  target: string,
  frequency: number,
  language: 'en' | 'zh' = 'en',
): Entry => ({
  id,
  platform: 'rss',
  operation: 'feed',
  name,
  target,
  language,
  frequency,
});

const reddit = (id: string, name: string, frequency = EVERY_3H): Entry => ({
  id,
  platform: 'reddit',
  operation: 'community',
  name: `r/${name}`,
  target: `r/${name}`,
  language: 'en',
  frequency,
});

/** `channelId` is the channel's UC… id, so subscribing never depends on resolving a handle page. */
const youtube = (id: string, name: string, channelId: string): Entry => ({
  id,
  platform: 'youtube',
  operation: 'channel',
  name,
  target: channelId,
  language: 'en',
  frequency: EVERY_12H,
});

const x = (id: string, name: string, account: string): Entry => ({
  id,
  platform: 'x',
  operation: 'account',
  name,
  target: account,
  language: 'en',
  frequency: EVERY_6H,
});

const hn = (id: string, name: string, operation: string): Entry => ({
  id,
  platform: 'hn',
  operation,
  name,
  target: '',
  language: 'en',
  frequency: HOURLY,
});

const GROUPS: Readonly<Record<PresetCategory, readonly Entry[]>> = {
  ai: [
    rss(
      'simonWillison',
      'Simon Willison',
      'https://simonwillison.net/atom/everything/',
      EVERY_3H,
    ),
    rss(
      'openAiNews',
      'OpenAI News',
      'https://openai.com/news/rss.xml',
      EVERY_6H,
    ),
    rss(
      'googleDeepMind',
      'Google DeepMind Blog',
      'https://deepmind.google/blog/rss.xml',
      EVERY_12H,
    ),
    rss(
      'googleResearch',
      'Google Research Blog',
      'https://research.google/blog/rss/',
      EVERY_12H,
    ),
    rss(
      'huggingFace',
      'Hugging Face Blog',
      'https://huggingface.co/blog/feed.xml',
      EVERY_6H,
    ),
    rss('bair', 'BAIR Blog', 'https://bair.berkeley.edu/blog/feed.xml', DAILY),
    rss(
      'lilianWeng',
      "Lil'Log (Lilian Weng)",
      'https://lilianweng.github.io/index.xml',
      DAILY,
    ),
    rss(
      'karpathyBlog',
      'Andrej Karpathy blog',
      'https://karpathy.github.io/feed.xml',
      DAILY,
    ),
    rss(
      'latentSpace',
      'Latent Space',
      'https://www.latent.space/feed',
      EVERY_12H,
    ),
    rss(
      'interconnects',
      'Interconnects',
      'https://www.interconnects.ai/feed',
      EVERY_12H,
    ),
    rss(
      'aheadOfAi',
      'Ahead of AI (Sebastian Raschka)',
      'https://magazine.sebastianraschka.com/feed',
      DAILY,
    ),
    rss('importAi', 'Import AI', 'https://importai.substack.com/feed', DAILY),
    rss(
      'oneUsefulThing',
      'One Useful Thing',
      'https://www.oneusefulthing.org/feed',
      DAILY,
    ),
    rss('theGradient', 'The Gradient', 'https://thegradient.pub/rss/', DAILY),
    rss('chipHuyen', 'Chip Huyen', 'https://huyenchip.com/feed.xml', DAILY),
    rss(
      'arsAi',
      'Ars Technica AI',
      'https://arstechnica.com/ai/feed/',
      EVERY_6H,
    ),
    rss(
      'nvidiaDeveloper',
      'NVIDIA Technical Blog',
      'https://developer.nvidia.com/blog/feed',
      EVERY_12H,
    ),
    rss(
      'arxivCsCl',
      'arXiv cs.CL (Computation and Language)',
      'https://rss.arxiv.org/rss/cs.CL',
      DAILY,
    ),
    rss(
      'arxivCsLg',
      'arXiv cs.LG (Machine Learning)',
      'https://rss.arxiv.org/rss/cs.LG',
      DAILY,
    ),
    reddit('localLlama', 'LocalLLaMA'),
    reddit('machineLearning', 'MachineLearning'),
    reddit('artificial', 'artificial'),
    reddit('openAiReddit', 'OpenAI'),
    reddit('claudeAi', 'ClaudeAI'),
    reddit('stableDiffusion', 'StableDiffusion'),
    youtube('karpathyYouTube', 'Andrej Karpathy', 'UCXUPKJO5MZQN11PqgIvyuvQ'),
    youtube('twoMinutePapers', 'Two Minute Papers', 'UCbfYPyITQ-7l4upoX8nvctg'),
    youtube('yannicKilcher', 'Yannic Kilcher', 'UCZHmQk67mSJgfCCTn7xBfew'),
    youtube('aiExplained', 'AI Explained', 'UCNJ1Ymd5yFuUPtn21xtRbbw'),
    x('karpathyX', 'Andrej Karpathy', '@karpathy'),
    x('simonwX', 'Simon Willison', '@simonw'),
    x('anthropicX', 'Anthropic', '@AnthropicAI'),
    x('openAiX', 'OpenAI', '@OpenAI'),
  ],
  dev: [
    // The front page first: `new` is every submission, most of which nobody ever reads.
    hn('hnTop', 'Hacker News: front page', 'top'),
    hn('hnBest', 'Hacker News: best stories', 'best'),
    hn('hnNew', 'Hacker News: new stories', 'new'),
    hn('hnShow', 'Show HN', 'show'),
    hn('hnAsk', 'Ask HN', 'ask'),
    rss('lobsters', 'Lobsters', 'https://lobste.rs/rss', HOURLY),
    rss(
      'githubBlog',
      'The GitHub Blog',
      'https://github.blog/feed/',
      EVERY_12H,
    ),
    rss(
      'githubChangelog',
      'GitHub Changelog',
      'https://github.blog/changelog/feed/',
      EVERY_6H,
    ),
    rss(
      'pragmaticEngineer',
      'The Pragmatic Engineer',
      'https://newsletter.pragmaticengineer.com/feed',
      DAILY,
    ),
    rss(
      'martinFowler',
      'Martin Fowler',
      'https://martinfowler.com/feed.atom',
      DAILY,
    ),
    rss('juliaEvans', 'Julia Evans', 'https://jvns.ca/atom.xml', DAILY),
    rss('danLuu', 'Dan Luu', 'https://danluu.com/atom.xml', DAILY),
    rss('lwn', 'LWN.net', 'https://lwn.net/headlines/rss', EVERY_6H),
    rss(
      'brendanGregg',
      'Brendan Gregg',
      'https://www.brendangregg.com/blog/rss.xml',
      DAILY,
    ),
    rss('rustBlog', 'Rust Blog', 'https://blog.rust-lang.org/feed.xml', DAILY),
    rss('goBlog', 'The Go Blog', 'https://go.dev/blog/feed.atom', DAILY),
    rss(
      'cloudflareBlog',
      'The Cloudflare Blog',
      'https://blog.cloudflare.com/rss/',
      EVERY_12H,
    ),
    rss(
      'netflixTech',
      'Netflix TechBlog',
      'https://netflixtechblog.com/feed',
      DAILY,
    ),
    rss(
      'stackOverflowBlog',
      'Stack Overflow Blog',
      'https://stackoverflow.blog/feed/',
      DAILY,
    ),
    rss('changelog', 'Changelog', 'https://changelog.com/feed', EVERY_12H),
    reddit('programming', 'programming'),
    reddit('rust', 'rust'),
    reddit('golang', 'golang'),
    reddit('python', 'Python'),
    reddit('linux', 'linux'),
    reddit('selfhosted', 'selfhosted'),
    reddit('devops', 'devops'),
    reddit('experiencedDevs', 'ExperiencedDevs'),
    youtube('fireship', 'Fireship', 'UCsBjURrPoezykLs9EqgamOA'),
    youtube('primeagen', 'The PrimeTime', 'UCUyeluBRhGPCW4rPe_UvBZQ'),
  ],
  web: [
    rss('cssTricks', 'CSS-Tricks', 'https://css-tricks.com/feed/', DAILY),
    rss(
      'smashing',
      'Smashing Magazine',
      'https://www.smashingmagazine.com/feed/',
      DAILY,
    ),
    rss(
      'joshComeau',
      'Josh W. Comeau',
      'https://www.joshwcomeau.com/rss.xml',
      DAILY,
    ),
    rss('reactBlog', 'React Blog', 'https://react.dev/rss.xml', DAILY),
    rss(
      'nodeBlog',
      'Node.js Blog',
      'https://nodejs.org/en/feed/blog.xml',
      DAILY,
    ),
    rss(
      'typescriptBlog',
      'TypeScript Blog',
      'https://devblogs.microsoft.com/typescript/feed/',
      DAILY,
    ),
    rss('webKit', 'WebKit Blog', 'https://webkit.org/feed/', DAILY),
    reddit('webdev', 'webdev'),
    reddit('javascript', 'javascript'),
    reddit('reactjs', 'reactjs'),
  ],
  security: [
    rss(
      'krebs',
      'Krebs on Security',
      'https://krebsonsecurity.com/feed/',
      EVERY_12H,
    ),
    rss(
      'schneier',
      'Schneier on Security',
      'https://www.schneier.com/feed/atom/',
      EVERY_12H,
    ),
    rss(
      'bleepingComputer',
      'BleepingComputer',
      'https://www.bleepingcomputer.com/feed/',
      EVERY_3H,
    ),
    rss(
      'hackerNewsSecurity',
      'The Hacker News',
      'https://feeds.feedburner.com/TheHackersNews',
      EVERY_3H,
    ),
    rss(
      'projectZero',
      'Google Project Zero',
      'https://googleprojectzero.blogspot.com/feeds/posts/default',
      DAILY,
    ),
    reddit('netsec', 'netsec'),
    reddit('cybersecurity', 'cybersecurity'),
  ],
  product: [
    rss(
      'productHunt',
      'Product Hunt',
      'https://www.producthunt.com/feed',
      EVERY_3H,
    ),
    rss(
      'lenny',
      "Lenny's Newsletter",
      'https://www.lennysnewsletter.com/feed',
      DAILY,
    ),
    rss('stratechery', 'Stratechery', 'https://stratechery.com/feed/', DAILY),
    reddit('startups', 'startups'),
    reddit('sideProject', 'SideProject'),
    reddit('indieHackers', 'indiehackers'),
    reddit('saas', 'SaaS'),
    youtube('yCombinator', 'Y Combinator', 'UCcefcZRL2oaA_uBNeo5UOWg'),
  ],
  design: [
    rss(
      'nngroup',
      'Nielsen Norman Group',
      'https://www.nngroup.com/feed/rss/',
      DAILY,
    ),
    rss('uxCollective', 'UX Collective', 'https://uxdesign.cc/feed', EVERY_12H),
    rss(
      'aListApart',
      'A List Apart',
      'https://alistapart.com/main/feed/',
      DAILY,
    ),
    rss('sidebar', 'Sidebar', 'https://sidebar.io/feed.xml', EVERY_12H),
    reddit('userExperience', 'userexperience'),
    reddit('uiDesign', 'UI_Design'),
  ],
  news: [
    rss(
      'theVerge',
      'The Verge',
      'https://www.theverge.com/rss/index.xml',
      EVERY_3H,
    ),
    rss(
      'arsTechnica',
      'Ars Technica',
      'https://feeds.arstechnica.com/arstechnica/index',
      EVERY_3H,
    ),
    rss('techCrunch', 'TechCrunch', 'https://techcrunch.com/feed/', EVERY_3H),
    rss('wired', 'WIRED', 'https://www.wired.com/feed/rss', EVERY_6H),
    rss(
      'mitTechReview',
      'MIT Technology Review',
      'https://www.technologyreview.com/feed/',
      EVERY_6H,
    ),
    reddit('technology', 'technology'),
  ],
  science: [
    rss(
      'quanta',
      'Quanta Magazine',
      'https://api.quantamagazine.org/feed/',
      DAILY,
    ),
    rss('nature', 'Nature', 'https://www.nature.com/nature.rss', EVERY_12H),
    reddit('science', 'science'),
    reddit('space', 'space'),
    youtube('threeBlueOneBrown', '3Blue1Brown', 'UCYO_jab_esuFRV4b17AJtAw'),
    youtube('veritasium', 'Veritasium', 'UCHnyfMqiRRG1u-2MsSQLbXA'),
    youtube('kurzgesagt', 'Kurzgesagt', 'UCsXVk37bltHxD1rDPwtNM8Q'),
  ],
  chinese: [
    rss(
      'ruanYifeng',
      '阮一峰的网络日志',
      'https://www.ruanyifeng.com/blog/atom.xml',
      DAILY,
      'zh',
    ),
    rss('v2ex', 'V2EX', 'https://www.v2ex.com/index.xml', HOURLY, 'zh'),
    rss('sspai', '少数派', 'https://sspai.com/feed', EVERY_6H, 'zh'),
    rss('infoqCn', 'InfoQ 中文', 'https://www.infoq.cn/feed', EVERY_6H, 'zh'),
    rss('ithome', 'IT之家', 'https://www.ithome.com/rss/', EVERY_3H, 'zh'),
    rss('ifanr', '爱范儿', 'https://www.ifanr.com/feed', EVERY_6H, 'zh'),
    rss('kr36', '36氪', 'https://36kr.com/feed', EVERY_3H, 'zh'),
    rss('geekpark', '极客公园', 'https://www.geekpark.net/rss', EVERY_6H, 'zh'),
    rss(
      'meituanTech',
      '美团技术团队',
      'https://tech.meituan.com/feed/',
      DAILY,
      'zh',
    ),
    rss('appinn', '小众软件', 'https://www.appinn.com/feed/', EVERY_12H, 'zh'),
    rss(
      'codingNow',
      '云风的 BLOG',
      'https://blog.codingnow.com/atom.xml',
      DAILY,
      'zh',
    ),
    rss(
      'scientificSpaces',
      '科学空间',
      'https://spaces.ac.cn/feed',
      DAILY,
      'zh',
    ),
  ],
};

export const SOURCE_PRESETS: readonly SourcePreset[] =
  PRESET_CATEGORIES.flatMap((category) =>
    GROUPS[category].map((entry) => ({ ...entry, category })),
  );

/** How a target is compared, so "r/Rust" and "rust", or a feed with and without its trailing slash, are one thing. */
export function presetKey(
  platform: string,
  operation: string,
  target: string,
): string {
  let value = target.trim().toLowerCase();
  if (platform === 'hn') value = '';
  else if (platform === 'rss')
    value = value.replace(/^https?:\/\/(www\.)?/u, '').replace(/\/+$/u, '');
  else if (platform === 'reddit')
    value = value
      .split(/[\s,，·+]+/u)
      .map((part) => part.replace(/^\/?r\//u, ''))
      .filter(Boolean)
      .sort()
      .join('+');
  else if (platform === 'youtube' || platform === 'x')
    value = value.replace(/^https?:\/\/[^/]+\//u, '').replace(/^@/u, '');
  return `${platform}:${operation}:${value}`;
}

/** The preset ids the person already follows through a direct subscription. */
export function subscribedPresetIds(
  sources: readonly Pick<Source, 'platform' | 'operation' | 'target'>[],
): ReadonlySet<string> {
  const followed = new Set(
    sources.map((source) =>
      presetKey(source.platform, source.operation, source.target),
    ),
  );
  return new Set(
    SOURCE_PRESETS.filter((preset) =>
      followed.has(presetKey(preset.platform, preset.operation, preset.target)),
    ).map((preset) => preset.id),
  );
}

/**
 * Presets in a category (or all), whose name, target or translated description contains every word of the query.
 * `describe` returns the description in the language shown, so a search matches what the person reads.
 */
export function filterPresets(
  presets: readonly SourcePreset[],
  {
    category,
    query,
    describe,
  }: {
    readonly category: PresetCategory | 'all';
    readonly query: string;
    readonly describe: (preset: SourcePreset) => string;
  },
): SourcePreset[] {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  return presets.filter((preset) => {
    if (category !== 'all' && preset.category !== category) return false;
    if (!words.length) return true;
    const text = [preset.name, preset.target, preset.platform, describe(preset)]
      .join(' ')
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
