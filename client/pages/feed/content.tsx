import { useTranslation } from '@nocobase/i18n/client';
import { ExternalLinkIcon, ImageOffIcon, PlayIcon } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { Button } from '#components/ui/button';
import { cn } from 'cn';

import type { MediaEntry } from './types.js';
import {
  type YouTubeVideo,
  youTubeEmbedUrl,
  youTubeThumbnail,
  youTubeWatchUrl,
} from './youtube.js';

/*
 * The post itself: its pictures, video and text, shown the way the platform lays them out. Media links are the
 * platform's own CDN links: they load with no Referer (Xiaohongshu refuses foreign ones) and may expire, so a picture
 * that does not load says so instead of leaving a broken frame.
 */

/** Long posts open folded past this many characters. */
const FOLD_AT = 1_200;

/** The post's text with its paragraphs: blank lines separate paragraphs, single line breaks stay. */
export function ArticleText({ text }: { readonly text: string }): ReactElement {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const long = text.length > FOLD_AT;
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return (
    <div className='flex flex-col gap-1.5'>
      <div
        data-testid='feed-article-text'
        className={cn(
          'flex flex-col gap-3 text-[0.95rem] leading-7 break-words text-foreground',
          long && !expanded && 'line-clamp-[18]',
        )}
      >
        {/* Paragraphs have no ids and never reorder, so their position is their identity. */}
        {paragraphs.map((paragraph, index) => (
          // eslint-disable-next-line @eslint-react/no-array-index-key
          <p key={index} className='whitespace-pre-line'>
            {paragraph}
          </p>
        ))}
      </div>
      {long ? (
        <Button
          type='button'
          size='xs'
          variant='link'
          className='self-start px-0'
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t('feed.detail.showLess') : t('feed.detail.showMore')}
        </Button>
      ) : null}
    </div>
  );
}

/** A picture from the platform's CDN, or a placeholder once it fails to load. */
export function RemoteImage({
  src,
  alt,
  className,
}: {
  readonly src: string;
  readonly alt: string;
  readonly className?: string;
}): ReactElement {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <span
        role='img'
        aria-label={t('feed.media.unavailable')}
        className={cn(
          'flex flex-col items-center justify-center gap-1 bg-muted p-2 text-center text-xs text-muted-foreground',
          className,
        )}
      >
        <ImageOffIcon className='size-4' aria-hidden='true' />
      </span>
    );
  return (
    <img
      src={src}
      alt={alt}
      loading='lazy'
      referrerPolicy='no-referrer'
      onError={() => setFailed(true)}
      className={cn('bg-muted', className)}
    />
  );
}

/** The card's picture: the first image or the video's cover, with a play mark on a video. */
export function CoverThumbnail({
  src,
  video,
}: {
  readonly src: string;
  readonly video: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <span className='relative block size-20 shrink-0 overflow-hidden rounded-lg sm:size-24'>
      <RemoteImage
        src={src}
        alt={video ? t('feed.media.videoCover') : t('feed.media.cover')}
        className='size-full object-cover'
      />
      {video ? (
        <span className='absolute inset-0 flex items-center justify-center'>
          <span className='flex size-7 items-center justify-center rounded-full bg-background/80 text-foreground'>
            <PlayIcon className='size-3.5 fill-current' aria-hidden='true' />
          </span>
        </span>
      ) : null}
    </span>
  );
}

function VideoPlayer({ entry }: { readonly entry: MediaEntry }): ReactElement {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  return (
    <div className='flex flex-col gap-1.5'>
      <div className='overflow-hidden rounded-lg bg-muted'>
        {playing ? (
          // The platform's stream; the source offers no captions.
          <video
            src={entry.url}
            poster={entry.cover}
            controls
            autoPlay
            playsInline
            className='max-h-[32rem] w-full bg-muted'
          />
        ) : (
          <button
            type='button'
            onClick={() => setPlaying(true)}
            className='relative block w-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50'
            aria-label={t('feed.media.play')}
          >
            {entry.cover ? (
              <RemoteImage
                src={entry.cover}
                alt={t('feed.media.videoCover')}
                className='max-h-[32rem] w-full object-contain'
              />
            ) : (
              <span className='block aspect-video w-full' />
            )}
            <span className='absolute inset-0 flex items-center justify-center'>
              <span className='flex size-12 items-center justify-center rounded-full bg-background/80 text-foreground'>
                <PlayIcon className='size-5 fill-current' aria-hidden='true' />
              </span>
            </span>
          </button>
        )}
      </div>
      <a
        href={entry.url}
        target='_blank'
        rel='noreferrer noopener'
        className='inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-primary hover:underline'
      >
        {t('feed.media.openVideo')}
        <ExternalLinkIcon className='size-3' aria-hidden='true' />
      </a>
    </div>
  );
}

/** What the YouTube player may do inside its frame: run, go full screen and open YouTube in a new tab. */
const YOUTUBE_SANDBOX =
  'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox';
const YOUTUBE_ALLOW =
  'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';

/**
 * A YouTube video, played inside the feed. Until the person presses play only the thumbnail loads (from
 * i.ytimg.com); the privacy-enhanced player (youtube-nocookie.com) is loaded on click. Shorts are portrait.
 */
export function YouTubePlayer({
  video,
  title,
}: {
  readonly video: YouTubeVideo;
  readonly title: string;
}): ReactElement {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  const frame = cn(
    'relative overflow-hidden rounded-lg bg-muted',
    video.short
      ? 'mx-auto aspect-[9/16] w-full max-w-[18rem]'
      : 'aspect-video w-full',
  );
  return (
    <div className='flex flex-col gap-1.5' data-testid='feed-youtube'>
      <div className={frame}>
        {playing ? (
          <iframe
            src={youTubeEmbedUrl(video)}
            title={t('feed.media.youtubeTitle', { title })}
            allow={YOUTUBE_ALLOW}
            allowFullScreen
            // YouTube's player refuses to play without the embedding page's origin (error 153).
            referrerPolicy='strict-origin-when-cross-origin'
            // allow-scripts with allow-same-origin is unsafe only for a same-origin frame; this one is always
            // youtube-nocookie.com, whose player needs its own origin's storage to play.
            // eslint-disable-next-line @eslint-react/dom-no-unsafe-iframe-sandbox
            sandbox={YOUTUBE_SANDBOX}
            className='absolute inset-0 size-full border-0'
          />
        ) : (
          <button
            type='button'
            onClick={() => setPlaying(true)}
            className='absolute inset-0 block size-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50'
            aria-label={t('feed.media.play')}
          >
            <RemoteImage
              src={youTubeThumbnail(video.id)}
              alt={t('feed.media.videoCover')}
              className='size-full object-cover'
            />
            <span className='absolute inset-0 flex items-center justify-center'>
              <span className='flex size-12 items-center justify-center rounded-full bg-background/80 text-foreground'>
                <PlayIcon className='size-5 fill-current' aria-hidden='true' />
              </span>
            </span>
          </button>
        )}
      </div>
      <span className='flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground'>
        {playing ? <span>{t('feed.media.youtubeTrouble')}</span> : null}
        <a
          href={youTubeWatchUrl(video)}
          target='_blank'
          rel='noreferrer noopener'
          className='inline-flex items-center gap-1 hover:text-primary hover:underline'
        >
          {t('feed.media.openYouTube')}
          <ExternalLinkIcon className='size-3' aria-hidden='true' />
        </a>
      </span>
    </div>
  );
}

/**
 * The post's pictures (one large, the rest as a strip to switch between) and its video. A YouTube video replaces the
 * media's own video entries, which would be the same video.
 */
export function MediaGallery({
  media,
  youtube = null,
  title = '',
}: {
  readonly media: readonly MediaEntry[];
  readonly youtube?: YouTubeVideo | null;
  readonly title?: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const [current, setCurrent] = useState(0);
  const videos = youtube ? [] : media.filter((entry) => entry.type === 'video');
  const images = media.filter((entry) => entry.type === 'image');
  if (!youtube && !videos.length && !images.length) return null;
  const shown = images[Math.min(current, images.length - 1)];
  return (
    <section aria-label={t('feed.parts.media')} className='flex flex-col gap-2'>
      {youtube ? <YouTubePlayer video={youtube} title={title} /> : null}
      {videos.map((entry) => (
        <VideoPlayer key={entry.url} entry={entry} />
      ))}
      {shown ? (
        <div className='flex flex-col gap-2'>
          <RemoteImage
            key={shown.url}
            src={shown.url}
            alt={t('feed.media.image', {
              index: images.indexOf(shown) + 1,
              count: images.length,
            })}
            className='max-h-[32rem] w-full rounded-lg object-contain'
          />
          {images.length > 1 ? (
            <ul className='flex gap-2 overflow-x-auto pb-1'>
              {images.map((entry, index) => (
                <li key={entry.url} className='shrink-0'>
                  <button
                    type='button'
                    onClick={() => setCurrent(index)}
                    aria-current={entry === shown ? 'true' : undefined}
                    aria-label={t('feed.media.image', {
                      index: index + 1,
                      count: images.length,
                    })}
                    className={cn(
                      'block size-14 overflow-hidden rounded-md border-2 border-transparent outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                      entry === shown && 'border-primary',
                    )}
                  >
                    <RemoteImage
                      src={entry.url}
                      alt=''
                      className='size-full object-cover'
                    />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
