import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { type ReactElement, useEffect, useState } from 'react';
import type { FieldError as FormFieldError } from 'react-hook-form';
import { Link } from 'react-router';

import { StatusBadge } from '#components/status-badge';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '#components/ui/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';
import { Skeleton } from '#components/ui/skeleton';

import { requestProblem } from '../feed/format.js';
import type { MailAccount } from '../feed/types.js';
import { MAIL_ACCOUNTS_PATH } from './mail.js';

const INACTIVE = new Set([
  'suspended',
  'revoked',
  'reauthorizationRequired',
  'removing',
]);

/** Picks one of the person's own connected mail accounts as a mail subscription's target. */
export function MailAccountField({
  id,
  value,
  invalid,
  error,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly invalid: boolean;
  readonly error?: FormFieldError;
  readonly onChange: (account: MailAccount) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const [state, setState] = useState<{
    readonly accounts?: readonly MailAccount[];
    readonly available?: boolean;
    readonly error?: unknown;
  }>({});

  useEffect(() => {
    const controller = new AbortController();
    api
      .request<{ data: MailAccount[]; meta: { available: boolean } }>({
        path: 'feedMailAccounts',
        signal: controller.signal,
      })
      .then(
        (response) => {
          if (!controller.signal.aborted)
            setState({
              accounts: response.data,
              available: response.meta.available,
            });
        },
        (cause: unknown) => {
          if (!controller.signal.aborted) setState({ error: cause });
        },
      );
    return () => controller.abort();
  }, [api]);

  const label = (
    <FieldLabel htmlFor={id}>
      {t('sources.mail.account')}
      <span aria-hidden='true' className='text-destructive'>
        *
      </span>
    </FieldLabel>
  );

  if (state.error)
    return (
      <Field data-invalid>
        {label}
        <p role='alert' className='text-sm text-destructive'>
          {t(`feed.errors.${requestProblem(state.error)}`)}
        </p>
      </Field>
    );
  if (!state.accounts)
    return (
      <Field>
        {label}
        <Skeleton className='h-9 w-full' />
      </Field>
    );
  if (!state.available)
    return (
      <Field>
        {label}
        <FieldDescription>{t('sources.mail.unavailable')}</FieldDescription>
      </Field>
    );
  const accounts = state.accounts;
  const items = accounts.map((account) => ({
    value: account.id,
    label: account.displayName
      ? `${account.displayName} <${account.address}>`
      : account.address,
  }));
  return (
    <Field data-invalid={invalid}>
      {label}
      {accounts.length ? (
        <Select
          items={items}
          value={value || null}
          onValueChange={(next) => {
            const account = accounts.find((entry) => entry.id === next);
            if (account) onChange(account);
          }}
        >
          <SelectTrigger id={id} className='w-full' aria-invalid={invalid}>
            <SelectValue placeholder={t('sources.mail.choose')} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {accounts.map((account, index) => (
                <SelectItem key={account.id} value={account.id}>
                  <span className='flex items-center gap-2'>
                    {items[index].label}
                    {INACTIVE.has(account.status) ? (
                      <StatusBadge size='sm' tone='warning'>
                        {t('sources.mail.inactive')}
                      </StatusBadge>
                    ) : null}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : (
        <p className='text-sm text-muted-foreground'>
          {t('sources.mail.none')}
        </p>
      )}
      <FieldDescription>
        {t('sources.mail.accountHint')}{' '}
        <Link to={MAIL_ACCOUNTS_PATH} className='text-primary hover:underline'>
          {t('sources.mail.manage')}
        </Link>
      </FieldDescription>
      <FieldError errors={[error]} />
    </Field>
  );
}
