import { useTranslation } from '@nocobase/i18n/client';
import { AlertCircleIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { SessionExpiredAlert } from '#components/session-expired-alert';
import { StatusBadge } from '#components/status-badge';
import { Alert, AlertAction, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';

import { requestProblem, statusTone } from './format.js';
import type { Platform, Source, Verdict } from './types.js';

export function PlatformBadge({
  platform,
}: {
  readonly platform: Platform | null;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!platform) return null;
  return (
    <StatusBadge size='sm' data-platform={platform}>
      {t(`feed.platforms.${platform}`)}
    </StatusBadge>
  );
}

const VERDICT_TONES = {
  discuss: 'info',
  learn: 'success',
  ignore: 'neutral',
} as const;

export function VerdictBadge({
  verdict,
}: {
  readonly verdict: Verdict | null;
}): ReactElement {
  const { t } = useTranslation();
  if (!verdict)
    return <StatusBadge size='sm'>{t('feed.verdict.pending')}</StatusBadge>;
  return (
    <StatusBadge size='sm' tone={VERDICT_TONES[verdict]}>
      {t(`feed.verdict.${verdict}`)}
    </StatusBadge>
  );
}

/** Says when a subscription keeps failing or has gone quiet; nothing while it is healthy. */
export function HealthBadge({
  source,
}: {
  readonly source: Pick<Source, 'health' | 'failureStreak' | 'emptyStreak'>;
}): ReactElement | null {
  const { t } = useTranslation();
  if (source.health === 'ok') return null;
  return (
    <StatusBadge size='sm' tone='warning'>
      {source.health === 'failing'
        ? t('sources.health.failing', { count: source.failureStreak })
        : t('sources.health.quiet', { count: source.emptyStreak })}
    </StatusBadge>
  );
}

export function RunStatusBadge({
  status,
}: {
  readonly status: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <StatusBadge size='sm' tone={statusTone(status)}>
      {t(`feed.status.${status}`, { defaultValue: status })}
    </StatusBadge>
  );
}

/**
 * Why a load failed, with a retry only where one can help: a session that ended offers to sign in, and a missing or
 * forbidden record offers nothing to repeat.
 */
export function LoadProblem({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry?: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const problem = requestProblem(error);
  if (problem === 'sessionExpired') return <SessionExpiredAlert />;
  const retryable =
    problem !== 'notFound' && problem !== 'forbidden' && problem !== 'invalid';
  return (
    <Alert variant='destructive'>
      <AlertCircleIcon />
      <AlertDescription>{t(`feed.errors.${problem}`)}</AlertDescription>
      {retryable && onRetry ? (
        <AlertAction>
          <Button type='button' variant='outline' size='sm' onClick={onRetry}>
            {t('feed.common.retry')}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
