import type { Application } from '@nocobase/app-server/application';
import type { AppRouteContribution } from '@nocobase/app-server/router';

import { feedAskRoutes } from './feed-ask.js';
import { feedRoutes } from './feed.js';

const routes: readonly AppRouteContribution<Application>[] = [
  feedRoutes,
  feedAskRoutes,
];

export default routes;
