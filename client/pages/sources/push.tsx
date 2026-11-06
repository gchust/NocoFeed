import { copyText, resolveAppUrl, useToaster } from '@nocobase/app-client';
import {
  API_KEY_EXPIRY_CHOICES,
  expiryChoiceToSeconds,
  formatKeyHint,
  isExpired,
  type ApiKeyExpiryChoice,
  type ApiKeySummary,
} from '@nocobase/app-plugin-api-keys/client';
import { useAuthentication } from '@nocobase/app-plugin-authentication/client';
import { useTranslation } from '@nocobase/i18n/client';
import { CopyIcon, KeyRoundIcon, Trash2Icon } from 'lucide-react';
import {
  type FormEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useState,
} from 'react';

import { RouteDialog } from '#components/route-dialog';
import { StatusBadge } from '#components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '#components/ui/field';
import { Input } from '#components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';
import { Skeleton } from '#components/ui/skeleton';
import { Spinner } from '#components/ui/spinner';
import { useRouteOverlay } from '#components/use-route-overlay';

import { absoluteTime } from '../feed/format.js';

/**
 * `/sources/push`: how to push links and posts into the feed (`POST /api/feedItems/ingest`) from a script, a bookmark or
 * a browser extension, and the API keys that let them do it as this person. Keys are the API Keys plugin's own
 * (Better Auth), managed here through the signed-in client; a new key is shown once.
 */
export default function PushDialog(): ReactElement {
  const { t } = useTranslation();
  return (
    <RouteDialog
      title={t('sources.push.title')}
      description={t('sources.push.description')}
      className='sm:max-w-3xl'
      footer={<DoneButton />}
    >
      <div className='flex flex-col gap-6'>
        <ApiKeys />
        <Examples />
        <Alert>
          <AlertTitle>{t('sources.push.extensionTitle')}</AlertTitle>
          <AlertDescription>
            {t('sources.push.extensionDescription')}
          </AlertDescription>
        </Alert>
      </div>
    </RouteDialog>
  );
}

function DoneButton(): ReactElement {
  const { t } = useTranslation();
  const { close } = useRouteOverlay();
  return (
    <Button type='button' onClick={() => void close()}>
      {t('sources.presets.done')}
    </Button>
  );
}

const endpoint = (): string =>
  new URL(resolveAppUrl('/api/feedItems/ingest'), window.location.origin).href;

function useCopy(): (text: string) => void {
  const { t } = useTranslation();
  const toaster = useToaster();
  return useCallback(
    (text: string) => {
      // Inside the dialog's focus scope, so the fallback for plain HTTP can select its text.
      const container =
        document.activeElement instanceof HTMLElement
          ? (document.activeElement.closest<HTMLElement>('[role="dialog"]') ??
            undefined)
          : undefined;
      void copyText(text, { container }).then((copied) =>
        toaster.show(
          copied
            ? { type: 'success', title: t('sources.push.copied') }
            : { type: 'error', title: t('sources.push.copyFailed') },
        ),
      );
    },
    [t, toaster],
  );
}

function Examples(): ReactElement {
  const { t } = useTranslation();
  const copy = useCopy();
  const url = endpoint();
  const examples = [
    {
      key: 'link',
      text: `curl -X POST '${url}' \\\n  -H 'x-api-key: <your key>' \\\n  -H 'content-type: application/json' \\\n  -d '{"url": "https://example.com/an-article"}'`,
    },
    {
      key: 'post',
      text: `curl -X POST '${url}' \\\n  -H 'x-api-key: <your key>' \\\n  -H 'content-type: application/json' \\\n  -d '{"title": "A post", "content": "The text of the post", "url": "https://example.com/post/1", "author": "someone", "externalId": "post-1"}'`,
    },
  ];
  return (
    <section aria-labelledby='push-examples' className='flex flex-col gap-3'>
      <h3 id='push-examples' className='font-medium'>
        {t('sources.push.examplesTitle')}
      </h3>
      <p className='text-sm text-muted-foreground'>
        {t('sources.push.examplesDescription')}
      </p>
      {examples.map((example) => (
        <div key={example.key} className='flex flex-col gap-1.5'>
          <div className='flex items-center justify-between gap-2'>
            <span className='text-sm'>
              {t(`sources.push.examples.${example.key}`)}
            </span>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              onClick={() => copy(example.text)}
            >
              <CopyIcon data-icon='inline-start' />
              {t('sources.push.copy')}
            </Button>
          </div>
          <pre className='overflow-x-auto rounded-lg border bg-muted p-3 text-xs'>
            <code>{example.text}</code>
          </pre>
        </div>
      ))}
      <p className='text-sm text-muted-foreground'>
        {t('sources.push.answers')}
      </p>
    </section>
  );
}

function ApiKeys(): ReactElement {
  const { t, i18n } = useTranslation();
  const { client } = useAuthentication();
  const toaster = useToaster();
  const copy = useCopy();
  const [keys, setKeys] = useState<readonly ApiKeySummary[]>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<ApiKeyExpiryChoice>('90');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string>();
  const [revoking, setRevoking] = useState<string>();
  const [confirming, setConfirming] = useState<string>();

  useEffect(() => {
    let current = true;
    void client.apiKey.list().then(
      ({ data, error }) => {
        if (!current) return;
        if (error) {
          setLoadFailed(true);
          return;
        }
        const list = Array.isArray(data)
          ? (data as ApiKeySummary[])
          : ((data as { apiKeys?: ApiKeySummary[] } | null)?.apiKeys ?? []);
        setLoadFailed(false);
        setKeys(list);
      },
      () => {
        if (current) setLoadFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [client, reloadCount]);

  const create = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (creating || !name.trim()) return;
    setCreating(true);
    try {
      const seconds = expiryChoiceToSeconds(expiry);
      const { data, error } = await client.apiKey.create({
        name: name.trim().slice(0, 32),
        ...(seconds ? { expiresIn: seconds } : {}),
      });
      if (error || !data) {
        toaster.show({ type: 'error', title: t('feed.errors.failed') });
        return;
      }
      setCreated(data.key);
      setName('');
      setReloadCount((count) => count + 1);
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (key: ApiKeySummary): Promise<void> => {
    if (confirming !== key.id) {
      setConfirming(key.id);
      return;
    }
    setRevoking(key.id);
    try {
      const { error } = await client.apiKey.delete({ keyId: key.id });
      toaster.show(
        error
          ? { type: 'error', title: t('feed.errors.failed') }
          : {
              type: 'success',
              title: t('sources.push.revoked', { name: key.name ?? '' }),
            },
      );
      setConfirming(undefined);
      setReloadCount((count) => count + 1);
    } finally {
      setRevoking(undefined);
    }
  };

  const expiryItems = API_KEY_EXPIRY_CHOICES.map((choice) => ({
    value: choice,
    label: t(`sources.push.expiry.${choice}`),
  }));

  return (
    <section aria-labelledby='push-keys' className='flex flex-col gap-3'>
      <h3 id='push-keys' className='font-medium'>
        {t('sources.push.keysTitle')}
      </h3>
      <p className='text-sm text-muted-foreground'>
        {t('sources.push.keysDescription')}
      </p>
      {created ? (
        <Alert>
          <KeyRoundIcon />
          <AlertTitle>{t('sources.push.createdTitle')}</AlertTitle>
          <AlertDescription className='flex flex-col gap-2'>
            <span>{t('sources.push.createdDescription')}</span>
            <code className='rounded bg-muted p-2 text-xs break-all'>
              {created}
            </code>
            <span>
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={() => copy(created)}
              >
                <CopyIcon data-icon='inline-start' />
                {t('sources.push.copy')}
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      <form onSubmit={(event) => void create(event)} noValidate>
        <FieldGroup className='grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end'>
          <Field>
            <FieldLabel htmlFor='push-key-name'>
              {t('sources.push.keyName')}
            </FieldLabel>
            <Input
              id='push-key-name'
              value={name}
              maxLength={32}
              autoComplete='off'
              placeholder={t('sources.push.keyNamePlaceholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor='push-key-expiry'>
              {t('sources.push.keyExpiry')}
            </FieldLabel>
            <Select
              items={expiryItems}
              value={expiry}
              onValueChange={(value) => {
                if (value) setExpiry(value);
              }}
            >
              <SelectTrigger id='push-key-expiry' className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {expiryItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Button type='submit' disabled={creating || !name.trim()}>
            {creating ? <Spinner data-icon='inline-start' /> : null}
            {t('sources.push.createKey')}
          </Button>
        </FieldGroup>
        <FieldDescription className='mt-2'>
          {t('sources.push.keyHint')}
        </FieldDescription>
      </form>
      {loadFailed ? (
        <p role='alert' className='text-sm text-destructive'>
          {t('feed.errors.failed')}
        </p>
      ) : !keys ? (
        <Skeleton className='h-16 w-full' />
      ) : keys.length === 0 ? (
        <p className='text-sm text-muted-foreground'>
          {t('sources.push.noKeys')}
        </p>
      ) : (
        <ul className='divide-y rounded-lg border'>
          {keys.map((key) => (
            <li
              key={key.id}
              className='flex flex-wrap items-center justify-between gap-2 p-3'
            >
              <div className='flex min-w-0 flex-col gap-0.5'>
                <span className='flex items-center gap-2 font-medium'>
                  {key.name}
                  {isExpired(key.expiresAt) || !key.enabled ? (
                    <StatusBadge size='sm' tone='warning'>
                      {t('sources.push.inactive')}
                    </StatusBadge>
                  ) : null}
                </span>
                <span className='text-xs text-muted-foreground'>
                  <code>{formatKeyHint(key)}</code>
                  {' · '}
                  {key.expiresAt
                    ? t('sources.push.expires', {
                        date: absoluteTime(
                          new Date(key.expiresAt).toISOString(),
                          i18n.language,
                        ),
                      })
                    : t('sources.push.expiry.never')}
                </span>
              </div>
              <Button
                type='button'
                size='sm'
                variant={confirming === key.id ? 'destructive' : 'ghost'}
                disabled={revoking === key.id}
                onClick={() => void revoke(key)}
                aria-label={t('sources.push.revokeFor', {
                  name: key.name ?? '',
                })}
              >
                {revoking === key.id ? (
                  <Spinner data-icon='inline-start' />
                ) : (
                  <Trash2Icon data-icon='inline-start' />
                )}
                {confirming === key.id
                  ? t('sources.push.confirmRevoke')
                  : t('sources.push.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
