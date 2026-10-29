import { useAuthentication } from '@nocobase/app-plugin-authentication/client';
import { useTranslation } from '@nocobase/i18n/client';
import { AlertCircleIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { Alert, AlertAction, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';

/**
 * Shown where a request failed with 401: the session ended, so a retry cannot succeed. refresh() re-reads the session;
 * while it runs, AuthenticationGuard renders nothing and RequiredAuthentication then sends the user to sign in. That is
 * why the user starts it, never an effect or a catch.
 */
export function SessionExpiredAlert({
  inline = false,
}: {
  readonly inline?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { refresh } = useAuthentication();
  const signIn = (
    <Button
      type='button'
      variant='outline'
      size='sm'
      onClick={() => void refresh()}
    >
      {t('feed.common.signInAgain')}
    </Button>
  );
  if (inline)
    return (
      <>
        <span>{t('feed.common.sessionExpired')}</span>
        {signIn}
      </>
    );
  return (
    <Alert variant='destructive'>
      <AlertCircleIcon />
      <AlertDescription>{t('feed.common.sessionExpired')}</AlertDescription>
      <AlertAction>{signIn}</AlertAction>
    </Alert>
  );
}
