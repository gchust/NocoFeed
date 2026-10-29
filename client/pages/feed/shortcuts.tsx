import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#components/ui/dialog';
import { Kbd } from '#components/ui/kbd';

import { SHORTCUTS } from './use-feed-shortcuts.js';

export function ShortcutHelp({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-sm'>
        <DialogHeader>
          <DialogTitle>{t('feed.shortcuts.title')}</DialogTitle>
          <DialogDescription>
            {t('feed.shortcuts.description')}
          </DialogDescription>
        </DialogHeader>
        <dl className='grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm'>
          {SHORTCUTS.map(([key, action]) => (
            <div key={action} className='contents'>
              <dt>
                <Kbd>{key}</Kbd>
              </dt>
              <dd className='text-muted-foreground'>
                {t(`feed.shortcuts.${action}`)}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
