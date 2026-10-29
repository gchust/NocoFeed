import type { Application } from '@nocobase/app-server/application';
import type { AppRouteContribution } from '@nocobase/app-server/router';

import { feedRoutes } from './feed.js';

const routes: readonly AppRouteContribution<Application>[] = [feedRoutes];

export default routes;
