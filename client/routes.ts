import { modelsRoute } from '@nocobase/app-plugin-agents/client/routes';
import {
  Cpu,
  History,
  Newspaper,
  Rss,
  SlidersHorizontal,
  Tags,
} from 'lucide-react';
import {
  defineAppRoutes,
  type AppClientRouteContribution,
} from '@nocobase/app-client/plugins';

import systemSettingsRoutes from './pages/settings/routes.js';

const appRoutes: AppClientRouteContribution = defineAppRoutes([
  {
    // The landing page is the person's feed. Every NocoFeed endpoint answers only the caller's own topics,
    // subscriptions and items, so these pages need no page grant: `authz: 'skip'` keeps every signed-in user able to
    // reach them, and no permission change can leave a user signed in with nowhere to land.
    authz: 'skip',
    auth: 'required',
    componentLoader: () => import('./pages/feed/index.js'),
    name: 'home',
    navigation: { title: 'navigation.feed', icon: Newspaper },
    path: '/',
  },
  {
    authz: 'skip',
    auth: 'required',
    componentLoader: () => import('./pages/topics/index.js'),
    name: 'topics',
    navigation: { title: 'navigation.topics', icon: Tags },
    breadcrumb: { title: 'navigation.topics' },
    path: '/topics',
    children: [
      {
        name: 'topicCreate',
        path: 'new',
        componentLoader: () => import('./pages/topics/form.js'),
      },
      {
        name: 'topicEdit',
        path: ':topicId/edit',
        componentLoader: () => import('./pages/topics/form.js'),
      },
    ],
  },
  {
    authz: 'skip',
    auth: 'required',
    componentLoader: () => import('./pages/sources/index.js'),
    name: 'sources',
    navigation: { title: 'navigation.sources', icon: Rss },
    breadcrumb: { title: 'navigation.sources' },
    path: '/sources',
    children: [
      {
        name: 'sourceCreate',
        path: 'new',
        componentLoader: () => import('./pages/sources/form.js'),
      },
      {
        name: 'sourceEdit',
        path: ':sourceId/edit',
        componentLoader: () => import('./pages/sources/form.js'),
      },
    ],
  },
  {
    authz: 'skip',
    auth: 'required',
    componentLoader: () => import('./pages/runs/index.js'),
    name: 'runs',
    navigation: { title: 'navigation.runs', icon: History },
    breadcrumb: { title: 'navigation.runs' },
    path: '/runs',
  },
  {
    authz: 'skip',
    auth: 'required',
    componentLoader: () => import('./pages/preferences/index.js'),
    name: 'preferences',
    navigation: { title: 'navigation.preferences', icon: SlidersHorizontal },
    breadcrumb: { title: 'navigation.preferences' },
    path: '/preferences',
  },
  {
    // Declares no navigation, so the application decides where its entry goes (for example a sidebar item with an
    // unread badge). The plugin's API answers each person's own messages only, so the page needs no authorization of
    // its own.
    authz: 'skip',
    auth: 'required',
    componentLoader: () => import('./pages/inbox.js'),
    name: 'inbox',
    path: '/inbox',
  },
  {
    auth: 'guest',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/login.js'),
    name: 'login',
    path: '/login',
  },
  {
    auth: 'guest',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/register.js'),
    name: 'register',
    path: '/register',
  },
  {
    auth: 'guest',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/forgot-password.js'),
    name: 'forgot-password',
    path: '/forgot-password',
  },
  {
    auth: 'guest',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/reset-password.js'),
    name: 'reset-password',
    path: '/reset-password',
  },
  {
    // Where a command line's sign-in sends the person to approve it (`pages/auth/device.tsx`). Optional rather than
    // required so it renders outside the shell, like the sign-in pages; the page sends a guest to sign in and back.
    auth: 'optional',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/device.js'),
    name: 'device',
    path: '/device',
  },
]);

// The model services the analysis uses, under System settings beside users and roles. The page and its API stand
// behind `settings:agents.services`, so only administrators who may configure models see it.
const modelSettingsRoutes: AppClientRouteContribution = defineAppRoutes([
  {
    ...modelsRoute,
    parent: 'settings',
    navigation: { title: 'navigation.models', icon: Cpu },
    breadcrumb: { title: 'navigation.models' },
  },
]);

const routes: readonly AppClientRouteContribution[] = [
  appRoutes,
  systemSettingsRoutes,
  modelSettingsRoutes,
];

export default routes;
