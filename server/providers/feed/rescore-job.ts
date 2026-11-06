import { Job, type JobClass } from '@nocobase/jobs';

import type { FeedService, RescoreTask } from './service.js';

/**
 * Scores a person's recent rule-based analyses again after feedback changed the weight of some words. Runs outside the
 * request that recorded the feedback, so marking an item answers at once. Running it twice is harmless: each run
 * scores with the weights stored when it starts and leaves unchanged scores alone.
 */
export function createRescoreJob(
  feed: () => FeedService,
): JobClass<RescoreTask> {
  return class RescoreJob extends Job<RescoreTask> {
    public static readonly jobName: string = 'nocofeed.rescore-feedback';

    public async execute(): Promise<void> {
      await feed().rescoreTerms(this.payload.ownerId, this.payload.terms);
    }
  };
}
