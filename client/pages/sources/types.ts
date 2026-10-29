import type { Catalog, Source, Topic } from '../feed/types.js';

/** What the sources page hands its create and edit dialogs. */
export interface SourcesOutletContext {
  readonly reload: () => void;
  /** Undefined while the page is still loading. */
  readonly sources: readonly Source[] | undefined;
  readonly catalog: Catalog | undefined;
  readonly topics: readonly Topic[];
}

/** The schedule choices offered in minutes; the API accepts 15 minutes to 7 days. */
export const FREQUENCIES = [15, 30, 60, 180, 360, 720, 1440, 10080] as const;
