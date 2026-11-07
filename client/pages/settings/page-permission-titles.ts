import type { PagePermissionTitles } from './page-permissions.js';

/** Permission labels for application pages without navigation/breadcrumb titles (including overlays).
 * Keys are existing route names; values are application translation keys.
 * Do not add navigation/breadcrumbs or change authorization ids just to name a permission.
 */
export const pagePermissionTitles: PagePermissionTitles = {
  // The Agents plugin's "Add runtime" dialog under Runtimes (`client/routes.ts`).
  'runtimes-connect': 'agents.pages.runtimeConnect',
  // The Agents plugin's "New skill" and skill detail pages under Skills (`client/routes.ts`).
  'skills-new': 'agents.pages.skillNew',
  'skills-detail': 'agents.pages.skillDetail',
};
