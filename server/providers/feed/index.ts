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
import { feedItemSubject } from './agent-reader.js';
import {
  ASK_THREAD,
  ASK_TRIGGER,
  createFeedAsk,
  fetchPageText,
  type FeedAsk,
} from './ask.js';
import { createFeedService, type FeedService } from './service.js';

export type { FeedService } from './service.js';
export type { FeedAsk } from './ask.js';
export { FeedError } from './service.js';

export const feedServiceToken: ServiceToken<FeedService> =
  createServiceToken<FeedService>('nocofeed/feed-service');

/** Questions about one item (`ask.ts`): the online agent's conversation and the runner agent's deeper look. */
export const feedAskToken: ServiceToken<FeedAsk> =
  createServiceToken<FeedAsk>('nocofeed/feed-ask');

/**
 * Binds the feed service and runs the subscription schedule: every few minutes it collects the subscriptions whose own
 * frequency says they are due. Model analysis goes through the Agents plugin's model gateway when a chat model is
 * configured on the Models page; without one, the rule-based analysis runs and says so. Two more jobs follow up on threads
 * the person posted in and send the daily digest, both through the in-app notification Channel.
 */
export default class FeedProvider extends ServiceProvider<Application> {
  public readonly name: string = 'nocofeed/feed-provider';

  private executor: ScheduleExecutor | undefined;

  private unregisterSubject: (() => void) | undefined;

  private unregisterAsk: (() => void) | undefined;

  public override register(): void {
    this.app.container.singleton(feedAskToken, () => {
      const config = () => this.app.config.get<FeedConfig>('feed')!;
      const logger = this.app.container
        .resolve(loggingToken)
        .getLogger('nocofeed');
      const feed = () => this.app.container.resolve(feedServiceToken);
      return createFeedAsk({
        agents: () =>
          this.app.container.has(agentsToken)
            ? this.app.container.resolve(agentsToken)
            : undefined,
        getItem: (ownerId, id) => feed().getItem(ownerId, id),
        getProfile: (ownerId) => feed().getProfile(ownerId),
        readPage: (url, signal) =>
          fetchPageText(url, signal, config().userAgent),
        log: (level, message, context) =>
          logger[level]({ ...context }, message),
      });
    });
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

  /**
   * Contributes the `feedItem` subject to the Agents plugin, so "Analyze again" can be handed to a runner agent
   * (`agent-reader.ts`). Without the plugin, analysis stays with the model gateway and the rules.
   */
  public override async boot(): Promise<void> {
    if (!this.app.container.has(agentsToken)) return;
    const agents = this.app.container.resolve(agentsToken);
    const settle = () => {
      // After the plugin's transaction commits; the schedule below catches anything this misses.
      setTimeout(() => {
        void this.app.container
          .resolve(feedServiceToken)
          .settleAgentReads()
          .catch(() => undefined);
      }, 1_000).unref();
    };
    const ask = this.app.container.resolve(feedAskToken);
    // The tools, the scope and the `feedItem` link kind of "Ask about this item".
    this.unregisterAsk = ask.register(agents);
    this.unregisterSubject = agents.subjects.register(
      feedItemSubject(settle, {
        thread: ASK_THREAD,
        trigger: ASK_TRIGGER,
        assemble: (conn, claim) => ask.assembleAsk(conn, claim),
        onRunFinished: (tx, run) => ask.onAskFinished(tx, run),
      }),
    );
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
        const feed = this.app.container.resolve(feedServiceToken);
        await feed.settleAgentReads();
        await feed.runDue();
        // Title-only items still waiting for their text (Xiaohongshu search), a few per tick.
        await feed.prefetchWaiting();
        // Exact publication times for items whose list gave none or only "3 weeks ago" (YouTube search).
        await feed.resolvePublishedTimes();
        // Counts of recent items read again, so "Trending" follows attention as it grows rather than as it was at
        // collection; an item that turns hot gets the full analysis it skipped.
        await feed.refreshHeat();
        // Briefs in the person's reading language for what the feed shows, a few per tick.
        await feed.briefPending();
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
    this.unregisterSubject?.();
    this.unregisterAsk?.();
    await this.executor?.shutdown();
  }
}
