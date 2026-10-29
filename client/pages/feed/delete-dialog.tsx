import { useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { type ReactElement, useState } from 'react';

import { SessionExpiredAlert } from '#components/session-expired-alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#components/ui/alert-dialog';
import { Spinner } from '#components/ui/spinner';

import { type RequestProblem, requestProblem } from './format.js';

export interface DeleteDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The record to delete; the parent keeps it while the dialog closes, so the title does not go blank. */
  readonly target: { readonly name: string; readonly path: string } | undefined;
  readonly title: string;
  readonly description: string;
  readonly successTitle: string;
  /** Deleted, or already gone (404): the parent closes the dialog and reloads. */
  readonly onDeleted: () => void;
}

/** Confirms deleting a topic or a subscription; failures stay inside the dialog. */
export function DeleteDialog({
  open,
  onOpenChange,
  target,
  title,
  description,
  successTitle,
  onDeleted,
}: DeleteDialogProps): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<RequestProblem>();

  const confirm = async (): Promise<void> => {
    if (!target) return;
    setPending(true);
    setProblem(undefined);
    try {
      await api.request<void>({ path: target.path, method: 'DELETE' });
      toaster.show({ type: 'success', title: successTitle });
    } catch (cause: unknown) {
      const kind = requestProblem(cause);
      if (kind !== 'notFound') {
        setProblem(kind);
        setPending(false);
        return;
      }
      // Someone already deleted it: what the person wanted has happened.
      toaster.show({ type: 'info', title: t('feed.common.alreadyDeleted') });
    }
    setPending(false);
    onDeleted();
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        if (!next) setProblem(undefined);
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {problem === 'sessionExpired' ? (
          <SessionExpiredAlert />
        ) : problem ? (
          <p role='alert' className='text-sm text-destructive'>
            {t(`feed.errors.${problem}`)}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {t('actions.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant='destructive'
            disabled={
              pending || (problem !== undefined && problem !== 'failed')
            }
            onClick={() => void confirm()}
          >
            {pending ? <Spinner data-icon='inline-start' /> : null}
            {t('feed.common.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
