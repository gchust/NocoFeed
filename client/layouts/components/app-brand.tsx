import { useTranslation } from '@nocobase/i18n/client';
import { NewspaperIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';

export interface AppBrandProps {
  readonly compact?: boolean;
}

/**
 * NocoFeed's own mark: a type-set wordmark beside a square in the primary colour, drawn from the theme tokens instead
 * of the template's NocoBase logo images, so it follows the purple brand and dark mode without image assets. Changed
 * from the template's `app-brand.tsx`; see `.agents/rules/shell.md`.
 */
export function AppBrand(inputProps: AppBrandProps): ReactElement {
  const { t } = useTranslation();
  const { compact = false } = inputProps;

  return (
    <Link
      aria-label={t('navigation.brandHome')}
      className='flex min-w-0 items-center gap-2.5 text-foreground'
      to='/'
    >
      <span
        aria-hidden='true'
        className='flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm'
      >
        <NewspaperIcon className='size-4.5' />
      </span>
      {compact ? null : (
        <span className='truncate font-heading text-lg font-semibold tracking-[-0.03em]'>
          Noco<span className='text-primary'>Feed</span>
        </span>
      )}
    </Link>
  );
}
