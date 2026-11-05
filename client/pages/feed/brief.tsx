import type { ReactElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { RemoteImage } from './content.js';
import type { MediaEntry } from './types.js';

/** The picture `media:N` stands for: the item's own image, or a video's cover; nothing else. */
function mediaSource(ref: string, media: readonly MediaEntry[]): string | null {
  const match = /^media:(\d+)$/.exec(ref.trim());
  if (!match) return null;
  const entry = media[Number(match[1]) - 1];
  if (!entry) return null;
  return entry.type === 'image' ? entry.url : (entry.cover ?? null);
}

/**
 * Markdown the model wrote, rendered as rich text. The material behind it was written by strangers, so raw HTML is
 * dropped, links are plain text, and the only images are the item's own (`media:N`), never an address the text names.
 */
export function BriefMarkdown({
  text,
  media,
}: {
  readonly text: string;
  readonly media: readonly MediaEntry[];
}): ReactElement {
  const components: Components = {
    p: ({ children }) => <p className='leading-7'>{children}</p>,
    ul: ({ children }) => (
      <ul className='flex list-disc flex-col gap-1.5 ps-5 marker:text-muted-foreground'>
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className='flex list-decimal flex-col gap-1.5 ps-5 marker:text-muted-foreground'>
        {children}
      </ol>
    ),
    li: ({ children }) => <li className='leading-7'>{children}</li>,
    strong: ({ children }) => (
      <strong className='font-semibold text-foreground'>{children}</strong>
    ),
    blockquote: ({ children }) => (
      <blockquote className='border-s-2 ps-3 text-muted-foreground'>
        {children}
      </blockquote>
    ),
    // Headings are not part of a brief; keep their words at body size.
    h1: ({ children }) => <p className='font-semibold'>{children}</p>,
    h2: ({ children }) => <p className='font-semibold'>{children}</p>,
    h3: ({ children }) => <p className='font-semibold'>{children}</p>,
    a: ({ children }) => <span>{children}</span>,
    code: ({ children }) => (
      <code className='rounded bg-muted px-1 text-[0.85em]'>{children}</code>
    ),
    pre: ({ children }) => <>{children}</>,
    img: ({ src, alt }) =>
      typeof src === 'string' && src ? (
        <RemoteImage
          src={src}
          alt={alt ?? ''}
          className='my-1 max-h-80 w-auto max-w-full rounded-lg border object-contain'
        />
      ) : null,
  };
  return (
    <div
      data-testid='feed-brief'
      className='flex flex-col gap-3 text-[0.95rem] break-words text-foreground'
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        // Every address goes through here: media:N becomes the item's own picture, anything else nothing.
        urlTransform={(url, key) =>
          key === 'src' ? (mediaSource(url, media) ?? '') : ''
        }
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
