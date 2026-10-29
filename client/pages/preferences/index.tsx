import { zodResolver } from '@hookform/resolvers/zod';
import { useApiClient, useToaster } from '@nocobase/app-client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { CpuIcon, TrendingDownIcon, TrendingUpIcon } from 'lucide-react';
import {
  type FormEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { FeedbackForm } from '#components/feedback-form';
import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { SessionExpiredAlert } from '#components/session-expired-alert';
import { StatusBadge } from '#components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '#components/ui/card';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
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
import { Switch } from '#components/ui/switch';
import { Textarea } from '#components/ui/textarea';

import { requestProblem } from '../feed/format.js';
import { LoadProblem } from '../feed/parts.js';
import type { Catalog, Profile } from '../feed/types.js';

const FORM_ID = 'feed-preferences-form';

export default function PreferencesPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const [reloadCount, setReloadCount] = useState(0);
  const reload = useCallback(() => setReloadCount((count) => count + 1), []);
  const [result, setResult] = useState<{
    readonly key: number;
    readonly profile?: Profile;
    readonly catalog?: Catalog;
    readonly error?: unknown;
  }>();

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    void Promise.all([
      api.request<{ data: Profile }>({ path: 'feedProfile', signal }),
      api.request<{ data: Catalog }>({ path: 'feedCatalog', signal }),
    ]).then(
      ([profile, catalog]) => {
        if (!signal.aborted)
          setResult({
            key: reloadCount,
            profile: profile.data,
            catalog: catalog.data,
          });
      },
      (error: unknown) => {
        if (!signal.aborted) setResult({ key: reloadCount, error });
      },
    );
    return () => controller.abort();
  }, [api, reloadCount]);

  const loading = result?.key !== reloadCount;
  const error = loading ? undefined : result?.error;

  return (
    <PageContainer className='max-w-3xl'>
      <PageHeader
        title={t('preferences.title')}
        description={t('preferences.description')}
      />
      {result?.catalog ? <ModelStatus catalog={result.catalog} /> : null}
      {error ? <LoadProblem error={error} onRetry={reload} /> : null}
      {!result?.profile && !error ? <Skeleton className='h-96' /> : null}
      {result?.profile ? (
        <PreferencesForm key={reloadCount} profile={result.profile} />
      ) : null}
      {result?.profile ? (
        <LearnedWeights profile={result.profile} onCleared={reload} />
      ) : null}
    </PageContainer>
  );
}

function ModelStatus({ catalog }: { readonly catalog: Catalog }): ReactElement {
  const { t } = useTranslation();
  return (
    <Alert>
      <CpuIcon />
      <AlertTitle>
        {catalog.model.available
          ? t('preferences.model.ready', { model: catalog.model.name ?? '—' })
          : t('preferences.model.missing')}
      </AlertTitle>
      <AlertDescription>
        {catalog.model.available
          ? t('preferences.model.readyDescription')
          : t('preferences.model.missingDescription')}
      </AlertDescription>
    </Alert>
  );
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const hourLabel = (hour: number): string =>
  `${String(hour).padStart(2, '0')}:00`;

/** The words feedback has made count more or less, with a way to start over. */
function LearnedWeights({
  profile,
  onCleared,
}: {
  readonly profile: Profile;
  readonly onCleared: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const [clearing, setClearing] = useState(false);
  const entries = Object.entries(profile.termWeights).sort(
    (a, b) => b[1] - a[1],
  );
  if (!entries.length) return null;

  const clear = async (): Promise<void> => {
    setClearing(true);
    try {
      await api.request({
        path: 'feedProfile',
        method: 'PUT',
        json: {
          interests: profile.interests,
          expertise: profile.expertise,
          avoid: profile.avoid,
          dailyLimit: profile.dailyLimit,
          keepLearning: profile.keepLearning,
          resetLearning: true,
        },
      });
      toaster.show({
        type: 'success',
        title: t('preferences.learned.cleared'),
      });
      onCleared();
    } catch (error: unknown) {
      toaster.show({
        type: 'error',
        title: t(`feed.errors.${requestProblem(error)}`),
      });
    } finally {
      setClearing(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('preferences.learned.title')}</CardTitle>
        <CardDescription>
          {t('preferences.learned.description')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className='flex flex-wrap gap-2'>
          {entries.map(([term, weight]) => (
            <li key={term}>
              <StatusBadge tone={weight > 0 ? 'success' : 'warning'}>
                {weight > 0 ? (
                  <TrendingUpIcon data-icon='inline-start' />
                ) : (
                  <TrendingDownIcon data-icon='inline-start' />
                )}
                {term}
                <span className='tabular-nums'>
                  {weight > 0 ? `+${weight}` : weight}
                </span>
              </StatusBadge>
            </li>
          ))}
        </ul>
      </CardContent>
      <CardFooter className='justify-end'>
        <Button
          type='button'
          variant='outline'
          disabled={clearing}
          onClick={() => void clear()}
        >
          {clearing ? <Spinner data-icon='inline-start' /> : null}
          {t('preferences.learned.clear')}
        </Button>
      </CardFooter>
    </Card>
  );
}

function PreferencesForm({
  profile,
}: {
  readonly profile: Profile;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const entryRef = useRef(false);
  const browserZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
      return null;
    }
  }, []);

  const schema = useMemo(
    () =>
      z.object({
        interests: z
          .string()
          .max(2000, t('feed.validation.tooLong', { max: 2000 })),
        expertise: z
          .string()
          .max(4000, t('feed.validation.tooLong', { max: 4000 })),
        avoid: z
          .string()
          .max(2000, t('feed.validation.tooLong', { max: 2000 })),
        dailyLimit: z
          .number({ error: t('preferences.validation.dailyLimit') })
          .int(t('preferences.validation.dailyLimit'))
          .min(0, t('preferences.validation.dailyLimit'))
          .max(500, t('preferences.validation.dailyLimit')),
        keepLearning: z.boolean(),
        digestEnabled: z.boolean(),
        digestHour: z.number().int().min(0).max(23),
      }),
    [t],
  );

  const form = useForm({
    shouldFocusError: false,
    resolver: zodResolver(schema),
    defaultValues: {
      interests: profile.interests,
      expertise: profile.expertise,
      avoid: profile.avoid,
      dailyLimit: profile.dailyLimit,
      keepLearning: profile.keepLearning,
      digestEnabled: profile.digestEnabled,
      digestHour: profile.digestHour,
    },
  });

  const validatedSubmit = form.handleSubmit(async (values) => {
    try {
      const { data } = await api.request<{ data: Profile }>({
        path: 'feedProfile',
        method: 'PUT',
        // The analysis is written in the language the person reads the application in.
        // The digest hour is read in the browser's time zone.
        json: {
          ...values,
          locale: locale === 'zh-CN' ? 'zh-CN' : 'en-US',
          timeZone: browserZone,
        },
      });
      form.reset({
        interests: data.interests,
        expertise: data.expertise,
        avoid: data.avoid,
        dailyLimit: data.dailyLimit,
        keepLearning: data.keepLearning,
        digestEnabled: data.digestEnabled,
        digestHour: data.digestHour,
      });
      toaster.show({
        type: 'success',
        title: t('preferences.saved'),
        description: t('preferences.savedHint'),
      });
    } catch (error: unknown) {
      const problem = requestProblem(error);
      form.setError('root', {
        type: problem,
        message: t(`feed.errors.${problem}`),
      });
    }
  });

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (entryRef.current) return;
    entryRef.current = true;
    try {
      await validatedSubmit(event);
    } finally {
      entryRef.current = false;
    }
  };

  const rootError = form.formState.errors.root;
  const submitting = form.formState.isSubmitting;
  // Saving also moves the analysis language to the one shown now, so a changed language alone is worth saving.
  const languageChanged =
    profile.locale !== (locale === 'zh-CN' ? 'zh-CN' : 'en-US') ||
    (browserZone !== null && profile.timeZone !== browserZone);
  const digestEnabled = useWatch({
    control: form.control,
    name: 'digestEnabled',
  });

  const text = (
    name: 'interests' | 'expertise' | 'avoid',
    rows: number,
  ): ReactElement => (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={`${FORM_ID}-${name}`}>
            {t(`preferences.fields.${name}`)}
          </FieldLabel>
          <Textarea
            {...field}
            id={`${FORM_ID}-${name}`}
            rows={rows}
            aria-invalid={fieldState.invalid}
            placeholder={t(`preferences.placeholders.${name}`)}
          />
          <FieldDescription>{t(`preferences.hints.${name}`)}</FieldDescription>
          <FieldError errors={[fieldState.error]} />
        </Field>
      )}
    />
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('preferences.formTitle')}</CardTitle>
        <CardDescription>{t('preferences.formDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <FeedbackForm
          id={FORM_ID}
          noValidate
          submitting={submitting}
          validationErrors={form.formState.errors}
          error={rootError}
          errorContent={
            rootError?.type === 'sessionExpired' ? (
              <SessionExpiredAlert inline />
            ) : (
              rootError?.message
            )
          }
          onSubmit={(event) => onSubmit(event)}
        >
          <FieldGroup>
            {text('interests', 3)}
            {text('expertise', 5)}
            {text('avoid', 2)}
            <Controller
              control={form.control}
              name='dailyLimit'
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid} className='max-w-xs'>
                  <FieldLabel htmlFor={`${FORM_ID}-dailyLimit`}>
                    {t('preferences.fields.dailyLimit')}
                  </FieldLabel>
                  <Input
                    id={`${FORM_ID}-dailyLimit`}
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    type='number'
                    inputMode='numeric'
                    min={0}
                    max={500}
                    value={Number.isNaN(field.value) ? '' : field.value}
                    onChange={(event) =>
                      field.onChange(event.target.valueAsNumber)
                    }
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldDescription>
                    {t('preferences.hints.dailyLimit')}
                  </FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name='keepLearning'
              render={({ field }) => (
                <Field orientation='horizontal'>
                  <FieldContent>
                    <FieldLabel htmlFor={`${FORM_ID}-keepLearning`}>
                      {t('preferences.fields.keepLearning')}
                    </FieldLabel>
                    <FieldDescription>
                      {t('preferences.hints.keepLearning')}
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id={`${FORM_ID}-keepLearning`}
                    checked={field.value}
                    onCheckedChange={(checked) => field.onChange(checked)}
                  />
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name='digestEnabled'
              render={({ field }) => (
                <Field orientation='horizontal'>
                  <FieldContent>
                    <FieldLabel htmlFor={`${FORM_ID}-digestEnabled`}>
                      {t('preferences.fields.digestEnabled')}
                    </FieldLabel>
                    <FieldDescription>
                      {t('preferences.hints.digestEnabled')}
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id={`${FORM_ID}-digestEnabled`}
                    checked={field.value}
                    onCheckedChange={(checked) => field.onChange(checked)}
                  />
                </Field>
              )}
            />
            {digestEnabled ? (
              <Controller
                control={form.control}
                name='digestHour'
                render={({ field }) => (
                  <Field className='max-w-xs'>
                    <FieldLabel htmlFor={`${FORM_ID}-digestHour`}>
                      {t('preferences.fields.digestHour')}
                    </FieldLabel>
                    <Select
                      items={HOURS.map((hour) => ({
                        value: hour,
                        label: hourLabel(hour),
                      }))}
                      value={field.value}
                      onValueChange={(value) =>
                        field.onChange(Number(value ?? 8))
                      }
                    >
                      <SelectTrigger
                        id={`${FORM_ID}-digestHour`}
                        className='w-full'
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {HOURS.map((hour) => (
                            <SelectItem key={hour} value={hour}>
                              {hourLabel(hour)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      {t('preferences.hints.digestHour', {
                        zone: browserZone ?? profile.timeZone ?? '—',
                      })}
                    </FieldDescription>
                  </Field>
                )}
              />
            ) : null}
          </FieldGroup>
        </FeedbackForm>
      </CardContent>
      <CardFooter className='justify-end'>
        <Button
          type='submit'
          form={FORM_ID}
          disabled={submitting || (!form.formState.isDirty && !languageChanged)}
        >
          {submitting ? <Spinner data-icon='inline-start' /> : null}
          {submitting ? t('feed.common.saving') : t('actions.save')}
        </Button>
      </CardFooter>
    </Card>
  );
}
