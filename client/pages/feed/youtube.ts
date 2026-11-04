// YouTube videos are played inside the feed: the video id is worked out from the item's link (or, for YouTube items,
// its external id), and the page derives the thumbnail and the privacy-enhanced embed from it, so nothing is stored.

/** A YouTube video the page can show: its id, whether it is a Short (portrait) and where to start. */
export interface YouTubeVideo {
  readonly id: string;
  readonly short: boolean;
  /** Seconds into the video the link pointed at (`t=` / `start=`); absent starts at the beginning. */
  readonly start?: number;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Hosts that serve a YouTube video page or player. */
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/** Path prefixes followed by the video id: `/shorts/<id>`, `/embed/<id>`, `/live/<id>`, `/v/<id>`. */
const ID_PATHS = ['shorts', 'embed', 'live', 'v'] as const;

/** `90`, `90s`, `1m30s`, `1h2m3s` → seconds; anything else is ignored. */
function parseStart(value: string | null): number | undefined {
  if (!value) return undefined;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value.trim());
  if (!match || !match[0]) return undefined;
  const seconds =
    Number(match[1] ?? 0) * 3600 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0);
  return seconds > 0 ? seconds : undefined;
}

/** The video a YouTube link points to, or null when it is not one (a channel, a playlist, another site). */
export function parseYouTubeUrl(
  link: string | null | undefined,
): YouTubeVideo | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  let id: string | undefined;
  let short = false;
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    id = segments[0];
  } else if (YOUTUBE_HOSTS.has(host)) {
    const [first, second] = segments;
    if (first === 'watch') id = url.searchParams.get('v') ?? undefined;
    else if (first && (ID_PATHS as readonly string[]).includes(first)) {
      id = second;
      short = first === 'shorts';
    }
  }
  if (!id || !VIDEO_ID.test(id)) return null;
  const start = parseStart(
    url.searchParams.get('t') ?? url.searchParams.get('start'),
  );
  return { id, short, ...(start ? { start } : {}) };
}

/**
 * The YouTube video an item is, if any: its link first (any platform may link a video), then — for YouTube items —
 * the external id (`yt:video:<id>` from a channel feed, or the bare id). Null keeps the plain link to the original.
 */
export function youTubeVideoOf(item: {
  readonly platform: string;
  readonly url: string | null;
  readonly externalId?: string;
}): YouTubeVideo | null {
  const fromUrl = parseYouTubeUrl(item.url);
  if (fromUrl) return fromUrl;
  if (item.platform !== 'youtube' || !item.externalId) return null;
  const id = item.externalId.trim().replace(/^yt:video:/, '');
  return VIDEO_ID.test(id) ? { id, short: false } : null;
}

/** The video's thumbnail on YouTube's image CDN (always present, 480×360). */
export function youTubeThumbnail(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/** The privacy-enhanced player (no cookies until the person plays), started on click. */
export function youTubeEmbedUrl(video: YouTubeVideo): string {
  const params = new URLSearchParams({
    autoplay: '1',
    playsinline: '1',
    rel: '0',
  });
  if (video.start) params.set('start', String(video.start));
  return `https://www.youtube-nocookie.com/embed/${video.id}?${params.toString()}`;
}

/** The video's page on YouTube, for opening it there. */
export function youTubeWatchUrl(video: YouTubeVideo): string {
  return video.short
    ? `https://www.youtube.com/shorts/${video.id}`
    : `https://www.youtube.com/watch?v=${video.id}`;
}
