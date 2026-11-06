import type { Application } from '@nocobase/app-server/application';
import type { AppRouteContribution } from '@nocobase/app-server/router';

import { feedAskRoutes } from './feed-ask.js';
import { feedIngestRoutes } from './feed-ingest.js';
import { feedReplyRoutes } from './feed-replies.js';
import { feedRoutes } from './feed.js';

const routes: readonly AppRouteContribution<Application>[] = [
  feedRoutes,
  feedAskRoutes,
  feedIngestRoutes,
  feedReplyRoutes,
];

export default routes;
