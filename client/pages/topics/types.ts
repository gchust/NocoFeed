import type { Source, Topic } from '../feed/types.js';

/** What the topics page hands its create and edit dialogs. */
export interface TopicsOutletContext {
  readonly reload: () => void;
  readonly sources: readonly Source[];
  /** Undefined while the page is still loading. */
  readonly topics: readonly Topic[] | undefined;
}
