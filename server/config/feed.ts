import {
  defineAppConfig,
  envInteger,
  envString,
  type AppConfigFactory,
} from '@nocobase/app-server/config';

export interface FeedConfig {
  /**
   * The Docker Collector that runs login-bound fetch actions (Xiaohongshu, X, YouTube/Bilibili search and subtitles).
   * Unset, those subscriptions stay "collector not configured" and never pretend to have synced anything.
   */
  collector: {
    url?: string;
    token?: string;
    timeoutMs: number;
  };
  /** How often the due-subscription scan runs, in minutes. Each subscription still keeps its own frequency. */
  tickMinutes: number;
  /** User-Agent sent to public APIs and feeds. */
  userAgent: string;
  /**
   * The in-app notification Channel (under `notification.channels`) that daily digests, new replies and subscription
   * problems are sent to.
   */
  notificationChannel: string;
}

const feed: AppConfigFactory<FeedConfig> = defineAppConfig({
  env: {
    FEED_COLLECTOR_URL: envString('collector.url', {
      description:
        'Base URL of the NocoFeed Docker Collector, such as http://collector:8080. Optional.',
      required: false,
    }),
    FEED_COLLECTOR_TOKEN: envString('collector.token', {
      description: 'Bearer token sent to the Docker Collector.',
      required: false,
      secret: true,
    }),
    FEED_TICK_MINUTES: envInteger('tickMinutes', {
      description: 'Minutes between scans for subscriptions that are due.',
      required: false,
    }),
  },
  defaults: (): FeedConfig => ({
    collector: { timeoutMs: 60_000 },
    tickMinutes: 5,
    userAgent: 'NocoFeed/1.0 (+https://www.nocobase.com)',
    notificationChannel: 'inbox',
  }),
  validate(value, ctx) {
    if (!Number.isInteger(value.tickMinutes) || value.tickMinutes < 1) {
      ctx.error(
        'tickMinutes',
        'must be a whole number of minutes, at least 1.',
      );
    }
    if (value.collector.url && !/^https?:\/\//.test(value.collector.url)) {
      ctx.error('collector.url', 'must be an http(s) URL.');
    }
  },
});

export default feed;
