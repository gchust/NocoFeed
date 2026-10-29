import { describe, expect, it } from 'vitest';
import { resolveAppRuntime } from '@nocobase/app-client/runtime';
import appRuntime from '../../client/runtime.js';
import cliPlugins from '../../cli/plugins.js';
import serverPlugins from '../../server/plugins.js';
import { buildRouteNavigation } from '../../client/routing/route-navigation.js';

describe('default Foundation integration', () => {
  it('registers the Foundation deployment evidence build hook', () => {
    expect(
      cliPlugins.plugins.filter(
        (plugin) => plugin.packageName === '@nocobase/app-plugin-foundation',
      ),
    ).toHaveLength(1);
  });
  // NocoFeed ships its own System settings group (users, roles, AI models), so Foundation joins it as the last entry
  // instead of opening a group of its own.
  it('places Foundation last in System settings for an unrestricted administrator', async () => {
    const runtime = await resolveAppRuntime(appRuntime);
    const menu = buildRouteNavigation(runtime.routes, new Set());
    expect(menu.some(({ route }) => route.name === 'foundationSettings')).toBe(
      false,
    );
    const settings = menu.find(({ route }) => route.name === 'settings');
    const page = settings?.children.at(-1)?.route;
    expect(page).toMatchObject({
      name: 'foundation',
      path: '/foundation',
      auth: 'required',
      authz: 'unrestricted',
    });
    if (!page) throw new Error('Foundation route missing');

    // Denied Foundation, the administrator keeps the rest of System settings.
    const denied = buildRouteNavigation(
      runtime.routes,
      new Set([`${page.packageName}:${page.path}:${page.id}`]),
    ).find(({ route }) => route.name === 'settings');
    expect(denied?.children.map(({ route }) => route.name)).not.toContain(
      'foundation',
    );
    expect(denied?.children.length).toBeGreaterThan(0);
    expect(
      serverPlugins.plugins.filter(
        (plugin) => plugin.packageName === '@nocobase/app-plugin-foundation',
      ),
    ).toHaveLength(1);
  });
});
