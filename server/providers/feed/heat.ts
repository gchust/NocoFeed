/**
 * How much attention an item is getting on its own platform, as 0–100. It says nothing about worth: a hot item can be
 * noise, and the analysis judges that apart. Counts are weighed per platform (a comment costs more than a like, a view
 * almost nothing) and put on a log scale against what clearly counts as hot there, so 100 is "as hot as it gets" and
 * `HOT_HEAT` is roughly "on the platform's front page".
 */
interface PlatformHeat {
  /** What one of each count is worth; counts not listed are ignored. */
  readonly weights: Readonly<Record<string, number>>;
  /** Weighed engagement at which an item scores 100. */
  readonly hot: number;
}

const PLATFORM_HEAT: Readonly<Record<string, PlatformHeat>> = {
  // 30 points with 10 comments is about the front page; 300 is a top story of the day.
  hn: { weights: { points: 1, comments: 1 }, hot: 300 },
  reddit: { weights: { points: 1, comments: 1 }, hot: 1_000 },
  bilibili: {
    weights: { views: 0.01, likes: 1, favorites: 1, comments: 2 },
    hot: 20_000,
  },
  // Likes come cheaply there, so it takes many more of them.
  xiaohongshu: {
    weights: { likes: 1, favorites: 1, comments: 2 },
    hot: 10_000,
  },
  x: {
    weights: { likes: 1, reposts: 2, replies: 2, views: 0.001 },
    hot: 5_000,
  },
  youtube: { weights: { views: 0.01, likes: 1, comments: 2 }, hot: 20_000 },
};

/** From here an item is hot: listed under "Trending" and given a full model analysis if it never had one. */
export const HOT_HEAT = 60;
/** Only what was published this recently can be trending; older attention is history, not news. */
export const HEAT_WINDOW_MS = 3 * 24 * 60 * 60_000;

/** Null when the platform gives no counts NocoFeed can weigh, or none were given: unknown is not cold. */
export function heatOf(
  platform: string,
  metrics: Readonly<Record<string, number>> | null | undefined,
): number | null {
  const spec = PLATFORM_HEAT[platform];
  if (!spec || !metrics) return null;
  let engagement = 0;
  let counted = false;
  for (const [key, weight] of Object.entries(spec.weights)) {
    const value = metrics[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      continue;
    engagement += value * weight;
    counted = true;
  }
  if (!counted) return null;
  return Math.round(
    100 * Math.min(1, Math.log1p(engagement) / Math.log1p(spec.hot)),
  );
}

/** Platforms whose counts this server can read again on its own, without the Collector. */
export const REFRESHABLE_PLATFORMS = ['hn', 'reddit', 'bilibili'] as const;

/**
 * How long to wait before reading an item's counts again, by its age: attention moves fastest in the first hours.
 * Null once it is too old to become trending.
 */
export function refreshInterval(ageMs: number): number | null {
  if (ageMs >= HEAT_WINDOW_MS) return null;
  if (ageMs < 6 * 3_600_000) return 30 * 60_000;
  if (ageMs < 24 * 3_600_000) return 2 * 3_600_000;
  return 6 * 3_600_000;
}
