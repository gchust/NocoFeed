import type { Application } from '@nocobase/app-server/application';
import { jobExecutorServiceToken } from '@nocobase/app-server/jobs';
import { loggingToken } from '@nocobase/app-server/logging';
import { agentsToken } from '@nocobase/app-plugin-agents/server/tokens';
import { notificationServiceToken } from '@nocobase/app-plugin-notification/server';
import { databaseManagerToken } from '@nocobase/db';
import type { ScheduleExecutor } from '@nocobase/jobs';
import {
  createServiceToken,
  ServiceProvider,
  type ServiceToken,
} from '@nocobase/service-provider';

import type { FeedConfig } from '../../config/feed.js';
import { createAdapters } from './adapters.js';
import { createFeedService, type FeedService } from './service.js';

export type { FeedService } from './service.js';
export { FeedError } from './service.js';

export const feedServiceToken: ServiceToken<FeedService> =
  createServiceToken<FeedService>('nocofeed/feed-service');

/**
 * Binds the feed service and runs the subscription schedule: every few minutes it collects the subscriptions whose own
 * frequency says they are due. Model analysis goes through the Agents plugin's model gateway when a chat model is
 * configured on the Models page; without one, the rule-based analysis runs and says so. Two more jobs follow up on threads
 * the person posted in and send the daily digest, both through the in-app notification Channel.
 */
export default class FeedProvider extends ServiceProvider<Application> {
  public readonly name: string = 'nocofeed/feed-provider';

  private executor: ScheduleExecutor | undefined;

  public override register(): void {
    this.app.container.singleton(feedServiceToken, () => {
      const config = () => this.app.config.get<FeedConfig>('feed')!;
      const logger = this.app.container
        .resolve(loggingToken)
        .getLogger('nocofeed');
      return createFeedService({
        database: this.app.container.resolve(databaseManagerToken),
        adapters: createAdapters(config),
        agents: () =>
          this.app.container.has(agentsToken)
            ? this.app.container.resolve(agentsToken)
            : undefined,
        config,
        notify: async (notice) => {
          if (!this.app.container.has(notificationServiceToken)) return false;
          const result = await this.app.container
            .resolve(notificationServiceToken)
            .send({
              idempotencyKey: notice.key,
              source: {
                type: `nocofeed.${notice.type}`,
                referenceId: notice.referenceId,
              },
              messages: {
                [config().notificationChannel]: {
                  to: notice.ownerId,
                  title: notice.title,
                  body: notice.body,
                  target: { type: 'route', path: notice.path },
                },
              },
            });
          return result.status !== 'failed';
        },
        log: (level, message, context) =>
          logger[level]({ ...context }, message),
      });
    });
  }

  public override async start(): Promise<void> {
    if (!this.app.container.has(jobExecutorServiceToken)) return;
    const tick = this.app.config.get<FeedConfig>('feed')?.tickMinutes ?? 5;
    this.executor = this.app.container
      .resolve(jobExecutorServiceToken)
      .getScheduleExecutor('nocofeed');
    await this.executor.addJob({
      name: 'collect-due-sources',
      options: { every: tick * 60_000 },
      payload: {},
      execute: async () => {
        await this.app.container.resolve(feedServiceToken).runDue();
      },
    });
    await this.executor.addJob({
      name: 'check-follow-ups',
      options: { every: 10 * 60_000 },
      payload: {},
      execute: async () => {
        await this.app.container.resolve(feedServiceToken).checkFollowUps();
      },
    });
    await this.executor.addJob({
      name: 'send-digests',
      options: { every: 10 * 60_000 },
      payload: {},
      execute: async () => {
        await this.app.container.resolve(feedServiceToken).sendDigests();
      },
    });
    await this.executor.setup();
  }

  public override async shutdown(): Promise<void> {
    await this.executor?.shutdown();
  }
}
