import type { Catalog, Platform, Source, Topic } from '../feed/types.js';

/** What the topics page hands its create and edit dialogs. */
export interface TopicsOutletContext {
  readonly reload: () => void;
  readonly sources: readonly Source[];
  /** Undefined while the page is still loading. */
  readonly topics: readonly Topic[] | undefined;
  readonly catalog: Catalog | undefined;
}

export interface SearchablePlatform {
  readonly platform: Platform;
  readonly available: boolean;
  readonly targetLength: { readonly min: number; readonly max: number } | null;
}

/** The platforms a topic can search on: those with a keyword search, in catalog order. */
export function searchablePlatforms(
  catalog: Catalog | undefined,
): readonly SearchablePlatform[] {
  return (catalog?.platforms ?? []).flatMap((entry) => {
    const search = entry.operations.find((op) => op.operation === 'keyword');
    return search
      ? [
          {
            platform: entry.platform,
            available: search.available,
            targetLength: search.targetLength,
          },
        ]
      : [];
  });
}
