import { useTranslation } from '@nocobase/i18n/client';
import { NewspaperIcon, NotebookPen, Rss, Sparkles } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

import { AuthSplitLayout } from '#extensions/nocobase-auth-split-layout/auth-split-layout';

import './auth-page.css';

export interface AuthPageProps {
  readonly className?: string;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly children: ReactNode;
}

/**
 * The frame every sign-in, sign-up and password page shares: the form on the left, and on wide screens NocoFeed's
 * brand panel on the right. The mark is the sidebar's newspaper in the primary colour rather than the template's
 * NocoBase logo images, and the panel's copy is NocoFeed's slogan from `client/locales/{en-US,zh-CN}.ts`.
 */
export function AuthPage({
  children,
  className,
  description,
  title,
}: AuthPageProps): ReactElement {
  const { t } = useTranslation();
  return (
    <AuthSplitLayout
      aside={<BrandPanel />}
      asideLabel={t('auth.about')}
      className={['auth-page', className].filter(Boolean).join(' ')}
      description={description}
      logo={<NewspaperIcon aria-hidden='true' className='text-primary' />}
      name={t('app.title')}
      title={title}
    >
      {children}
    </AuthSplitLayout>
  );
}

// The brand panel stays dark in both color modes; its dedicated palette belongs to the theme presets.
function BrandPanel(): ReactElement {
  const { t } = useTranslation();
  const features = [
    {
      description: t('auth.frontendDescription'),
      icon: Rss,
      id: 'frontend',
      title: t('auth.frontend'),
    },
    {
      description: t('auth.foundationDescription'),
      icon: Sparkles,
      id: 'foundation',
      title: t('auth.foundation'),
    },
  ];

  return (
    <div className='auth-brand-panel relative grid h-full place-items-center overflow-hidden p-12 text-white'>
      <div className='relative w-full max-w-md'>
        <p className='text-xs font-semibold tracking-[0.16em] text-(--auth-brand-highlight) uppercase'>
          {t('auth.platform')}
        </p>
        <h2 className='mt-6 text-4xl leading-tight font-semibold tracking-tight'>
          {t('auth.marketingTitleFirst')}
          <br />
          {t('auth.marketingTitleSecond')}
          <br />
          {t('auth.marketingTitleThird')}
        </h2>
        <p className='mt-6 text-sm leading-7 text-(--auth-brand-muted)'>
          {t('auth.marketingDescription')}
        </p>
        <div className='mt-12 space-y-8'>
          {features.map(({ description, icon: Icon, id, title }) => (
            <div className='flex gap-4' key={id}>
              <span className='grid size-10 shrink-0 place-items-center rounded-xl bg-(--auth-brand-highlight)/8 text-(--auth-brand-highlight)'>
                <Icon aria-hidden='true' className='size-5' />
              </span>
              <div>
                <p className='text-sm font-medium'>{title}</p>
                <p className='mt-1.5 text-sm leading-6 text-(--auth-brand-muted)'>
                  {description}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className='mt-12 flex items-center gap-2.5 border-t border-white/8 pt-6 text-xs text-(--auth-brand-muted)'>
          <NotebookPen aria-hidden='true' className='size-4' />
          <span>{t('auth.marketingFooter')}</span>
        </div>
      </div>
    </div>
  );
}
