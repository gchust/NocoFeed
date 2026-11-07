import type { Application } from '@nocobase/app-server/application';
import type { AppRouteContribution } from '@nocobase/app-server/router';

import { feedAskRoutes } from './feed-ask.js';
import { feedIdeasRoutes } from './feed-ideas.js';
import { feedIngestRoutes } from './feed-ingest.js';
import { feedReplyRoutes } from './feed-replies.js';
import { feedRoutes } from './feed.js';
import { feedWritingSkillRoutes } from './feed-writing-skills.js';

const routes: readonly AppRouteContribution<Application>[] = [
  feedRoutes,
  feedAskRoutes,
  feedIdeasRoutes,
  feedIngestRoutes,
  feedReplyRoutes,
  feedWritingSkillRoutes,
];

export default routes;
