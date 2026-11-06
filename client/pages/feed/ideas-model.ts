import type { useTranslation } from '@nocobase/i18n/client';

/**
 * What the Ideas card and the idea settings share: the kinds, the shapes the server stores
 * (`server/providers/feed/ideas.ts`) and the text an idea is copied as.
 */

/** The kinds of ideas, in the order the server returns them (`server/providers/feed/ideas.ts`). */
export const IDEA_KINDS = [
  'xiaohongshu',
  'x',
  'shortVideo',
  'bilibili',
  'meme',
] as const;
export type IdeaKind = (typeof IDEA_KINDS)[number];

export interface XiaohongshuIdea {
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly cover: string;
}
export interface XIdea {
  readonly posts: readonly string[];
}
export interface ShortVideoIdea {
  readonly title: string;
  readonly seconds: number;
  readonly shots: readonly {
    readonly visual: string;
    readonly line: string;
    readonly caption: string;
    readonly seconds: number;
  }[];
}
export interface BilibiliIdea {
  readonly title: string;
  readonly description: string;
  readonly outline: readonly string[];
}
export interface MemeIdea {
  readonly caption: string;
  readonly image: string;
  readonly trend: string;
}
export type Idea =
  XiaohongshuIdea | XIdea | ShortVideoIdea | BilibiliIdea | MemeIdea;

export interface IdeaSet {
  readonly kind: IdeaKind;
  readonly status: 'pending' | 'ready' | 'failed';
  readonly ideas: readonly Idea[];
  readonly error: string | null;
  readonly generatedAt: string | null;
  readonly styleVersion: string | null;
  readonly stale: boolean;
  readonly webSearch: boolean;
  readonly model: string | null;
  readonly trigger: 'manual' | 'auto';
}

/** `GET /feedItems/:id/ideas`. */
export interface IdeasState {
  readonly available: boolean;
  readonly webSearch: boolean;
  readonly kinds: readonly IdeaKind[];
  readonly auto: boolean;
  readonly styleVersion: string;
  readonly sets: readonly IdeaSet[];
}

/** How often the card reads the state again while ideas are being generated. */
export const IDEAS_POLL_MS = 3_000;

type Translate = ReturnType<typeof useTranslation>['t'];

/** The text an idea is copied as: ready to paste into the platform. */
export function ideaText(kind: IdeaKind, idea: Idea, t: Translate): string {
  switch (kind) {
    case 'xiaohongshu': {
      const note = idea as XiaohongshuIdea;
      return [
        note.title,
        note.body,
        note.tags.map((tag) => `#${tag}`).join(' '),
      ]
        .filter(Boolean)
        .join('\n\n');
    }
    case 'x': {
      const { posts } = idea as XIdea;
      return posts.length > 1
        ? posts
            .map((post, index) => `${index + 1}/${posts.length} ${post}`)
            .join('\n\n')
        : (posts[0] ?? '');
    }
    case 'shortVideo': {
      const script = idea as ShortVideoIdea;
      return [
        `${script.title} (${t('feed.ideas.seconds', { count: script.seconds })})`,
        ...script.shots.map((shot, index) =>
          [
            t('feed.ideas.shot', {
              number: index + 1,
              seconds: shot.seconds,
            }),
            `${t('feed.ideas.visual')}: ${shot.visual}`,
            `${t('feed.ideas.line')}: ${shot.line}`,
            `${t('feed.ideas.caption')}: ${shot.caption}`,
          ].join('\n'),
        ),
      ].join('\n\n');
    }
    case 'bilibili': {
      const plan = idea as BilibiliIdea;
      return [
        plan.title,
        plan.description,
        plan.outline.map((part, index) => `${index + 1}. ${part}`).join('\n'),
      ]
        .filter(Boolean)
        .join('\n\n');
    }
    case 'meme': {
      const meme = idea as MemeIdea;
      return [meme.caption, `${t('feed.ideas.image')}: ${meme.image}`].join(
        '\n\n',
      );
    }
  }
}

/** Languages an X post can be written in. */
export const X_LANGUAGES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'] as const;
export type XLanguage = (typeof X_LANGUAGES)[number];

/** `GET|PUT /feedIdeaSettings`. */
export interface IdeaSettings {
  readonly style: string;
  readonly customized: boolean;
  readonly kinds: readonly IdeaKind[];
  readonly auto: boolean;
  readonly xLanguage: XLanguage;
  readonly styleVersion: string;
  readonly defaultStyle: string;
}
