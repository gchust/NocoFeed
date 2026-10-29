import { zodResolver } from '@hookform/resolvers/zod';
import { useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  type FormEvent,
  type ReactElement,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useOutletContext, useParams } from 'react-router';
import { z } from 'zod';

import { FeedbackForm } from '#components/feedback-form';
import { RouteDialog } from '#components/route-dialog';
import { SessionExpiredAlert } from '#components/session-expired-alert';
import { StatusBadge } from '#components/status-badge';
import { Button } from '#components/ui/button';
import { Checkbox } from '#components/ui/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '#components/ui/field';
import { Input } from '#components/ui/input';
import { RadioGroup, RadioGroupItem } from '#components/ui/radio-group';
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

import { frequencyText, requestProblem } from '../feed/format.js';
import { type Catalog, PLATFORMS, type Source } from '../feed/types.js';
import { FREQUENCIES, type SourcesOutletContext } from './types.js';

const FORM_ID = 'feed-source-form';

/** `/sources/new` and `/sources/:sourceId/edit`. */
export default function SourceDialog(): ReactElement {
  const { t } = useTranslation();
  const { sourceId } = useParams();
  const { sources, catalog } = useOutletContext<SourcesOutletContext>();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const onSubmittingChange = (value: boolean): void => {
    submittingRef.current = value;
    setSubmitting(value);
  };
  const source = sourceId
    ? sources?.find((entry) => String(entry.id) === sourceId)
    : undefined;
  const missing = Boolean(sourceId && sources && !source);

  return (
    <RouteDialog
      title={sourceId ? t('sources.edit') : t('sources.create')}
      description={t('sources.formDescription')}
      className='sm:max-w-2xl'
      beforeClose={() => !submittingRef.current}
      footer={<Footer submitting={submitting} editing={Boolean(sourceId)} />}
    >
      {missing ? (
        <p role='alert' className='text-sm text-destructive'>
          {t('feed.errors.notFound')}
        </p>
      ) : !catalog || (sourceId && !source) ? (
        <Skeleton className='h-80' />
      ) : (
        <Body
          catalog={catalog}
          source={source}
          onSubmittingChange={onSubmittingChange}
        />
      )}
    </RouteDialog>
  );
}

function Body({
  catalog,
  source,
  onSubmittingChange,
}: {
  readonly catalog: Catalog;
  readonly source?: Source;
  readonly onSubmittingChange: (submitting: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const { close } = useRouteOverlay();
  const { reload, topics } = useOutletContext<SourcesOutletContext>();
  const entryRef = useRef(false);

  const schema = useMemo(
    () =>
      z.object({
        platform: z.enum(PLATFORMS),
        operation: z.string().min(1, t('sources.validation.operationRequired')),
        name: z
          .string()
          .trim()
          .min(1, t('sources.validation.nameRequired'))
          .max(60, t('feed.validation.tooLong', { max: 60 })),
        target: z
          .string()
          .trim()
          .max(500, t('feed.validation.tooLong', { max: 500 })),
        frequency: z.number().int().min(15).max(10080),
        candidateLimit: z
          .number({ error: t('sources.validation.candidates') })
          .int(t('sources.validation.candidates'))
          .min(1, t('sources.validation.candidates'))
          .max(100, t('sources.validation.candidates')),
        topicIds: z.array(z.number()),
      }),
    [t],
  );

  const form = useForm({
    shouldFocusError: false,
    resolver: zodResolver(schema),
    defaultValues: {
      platform: source?.platform ?? 'hn',
      operation: source?.operation ?? 'new',
      name: source?.name ?? '',
      target: source?.target ?? '',
      frequency: source?.frequency ?? 60,
      candidateLimit: source?.candidateLimit ?? 20,
      topicIds: [] as number[],
    },
  });

  const platform = useWatch({ control: form.control, name: 'platform' });
  const operation = useWatch({ control: form.control, name: 'operation' });
  const platformSpec = catalog.platforms.find(
    (entry) => entry.platform === platform,
  );
  const operationSpec = platformSpec?.operations.find(
    (entry) => entry.operation === operation,
  );
  const needsTarget = operationSpec ? operationSpec.input !== 'none' : false;

  const validatedSubmit = form.handleSubmit(async (values) => {
    if (needsTarget && !values.target) {
      form.setError('target', {
        message: t('sources.validation.targetRequired'),
      });
      return;
    }
    const length = operationSpec?.targetLength;
    if (
      needsTarget &&
      length &&
      (values.target.length < length.min ||
        values.target.length > length.max ||
        values.target.startsWith('-'))
    ) {
      form.setError('target', {
        message: t('sources.validation.targetLength', length),
      });
      return;
    }
    const target = needsTarget ? values.target : '';
    try {
      const { data } = await api.request<{ data: Source }>(
        source
          ? {
              path: `feedSources/${encodeURIComponent(source.id)}`,
              method: 'PATCH',
              json: {
                name: values.name,
                target,
                frequency: values.frequency,
                candidateLimit: values.candidateLimit,
              },
            }
          : {
              path: 'feedSources',
              method: 'POST',
              json: {
                platform: values.platform,
                operation: values.operation,
                name: values.name,
                target,
                frequency: values.frequency,
                candidateLimit: values.candidateLimit,
                topicIds: values.topicIds,
              },
            },
      );
      onSubmittingChange(false);
      toaster.show({
        type: 'success',
        title: source
          ? t('sources.saved', { name: data.name })
          : t('sources.created', { name: data.name }),
        description: source ? undefined : t('sources.createdHint'),
      });
      reload();
      void close();
    } catch (error: unknown) {
      const problem = requestProblem(error);
      form.setError('root', {
        type: problem,
        message:
          problem === 'invalid'
            ? t('sources.validation.rejected')
            : t(`feed.errors.${problem}`),
      });
    }
  });

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (entryRef.current) return;
    entryRef.current = true;
    onSubmittingChange(true);
    try {
      await validatedSubmit(event);
    } finally {
      entryRef.current = false;
      onSubmittingChange(false);
    }
  };

  const rootError = form.formState.errors.root;
  const platformItems = catalog.platforms.map((entry) => ({
    value: entry.platform,
    label: t(`feed.platforms.${entry.platform}`),
  }));
  const frequencyItems = FREQUENCIES.map((value) => ({
    value: String(value),
    label: frequencyText(t, value),
  }));

  return (
    <FeedbackForm
      id={FORM_ID}
      noValidate
      submitting={form.formState.isSubmitting}
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
        <Controller
          control={form.control}
          name='platform'
          render={({ field }) => (
            <Field>
              <FieldLabel htmlFor={`${FORM_ID}-platform`}>
                {t('sources.fields.platform')}
              </FieldLabel>
              <Select
                items={platformItems}
                value={field.value}
                disabled={Boolean(source)}
                onValueChange={(value) => {
                  if (!value) return;
                  field.onChange(value);
                  const first = catalog.platforms.find(
                    (entry) => entry.platform === value,
                  )?.operations[0];
                  form.setValue('operation', first?.operation ?? '');
                }}
              >
                <SelectTrigger id={`${FORM_ID}-platform`} className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {platformItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {platformSpec?.experimental || platformSpec?.needsLogin ? (
                <FieldDescription>
                  {platformSpec.experimental
                    ? t('sources.hints.experimental')
                    : null}{' '}
                  {platformSpec.needsLogin
                    ? t('sources.hints.needsLogin')
                    : null}
                </FieldDescription>
              ) : null}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name='operation'
          render={({ field, fieldState }) => (
            <FieldSet data-invalid={fieldState.invalid}>
              <FieldLegend variant='label'>
                {t('sources.fields.operation')}
              </FieldLegend>
              <RadioGroup
                value={field.value}
                disabled={Boolean(source)}
                onValueChange={(value) => field.onChange(value)}
                className='grid gap-2 sm:grid-cols-2'
              >
                {platformSpec?.operations.map((op) => (
                  <FieldLabel
                    key={op.operation}
                    htmlFor={`${FORM_ID}-op-${op.operation}`}
                  >
                    <Field orientation='horizontal'>
                      <RadioGroupItem
                        value={op.operation}
                        id={`${FORM_ID}-op-${op.operation}`}
                      />
                      <FieldContent>
                        <span className='flex flex-wrap items-center gap-1.5 font-medium'>
                          {t(`sources.operations.${platform}.${op.operation}`, {
                            defaultValue: op.operation,
                          })}
                          <StatusBadge
                            size='sm'
                            tone={
                              op.implementation === 'native'
                                ? 'success'
                                : 'neutral'
                            }
                          >
                            {t(`sources.implementation.${op.implementation}`)}
                          </StatusBadge>
                          {!op.available ? (
                            <StatusBadge size='sm' tone='warning'>
                              {t('sources.unavailable')}
                            </StatusBadge>
                          ) : null}
                        </span>
                        <FieldDescription>
                          {op.capabilities
                            .map((code) =>
                              t(`sources.capabilities.${code}`, {
                                defaultValue: code,
                              }),
                            )
                            .join(t('feed.common.listSeparator'))}
                        </FieldDescription>
                      </FieldContent>
                    </Field>
                  </FieldLabel>
                ))}
              </RadioGroup>
              <FieldError errors={[fieldState.error]} />
            </FieldSet>
          )}
        />
        {operationSpec && !operationSpec.available ? (
          <p className='rounded-lg border border-dashed p-3 text-sm text-muted-foreground'>
            {t('sources.hints.collectorNeeded')}
          </p>
        ) : null}
        {needsTarget ? (
          <Controller
            control={form.control}
            name='target'
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor={`${FORM_ID}-target`}>
                  {t(`sources.targets.${platform}.${operation}`, {
                    defaultValue: t('sources.fields.target'),
                  })}
                  <span aria-hidden='true' className='text-destructive'>
                    *
                  </span>
                </FieldLabel>
                <Input
                  {...field}
                  id={`${FORM_ID}-target`}
                  autoComplete='off'
                  aria-required='true'
                  aria-invalid={fieldState.invalid}
                  placeholder={t(
                    `sources.targetPlaceholders.${platform}.${operation}`,
                    {
                      defaultValue: '',
                    },
                  )}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        ) : null}
        <Controller
          control={form.control}
          name='name'
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={`${FORM_ID}-name`}>
                {t('sources.fields.name')}
                <span aria-hidden='true' className='text-destructive'>
                  *
                </span>
              </FieldLabel>
              <Input
                {...field}
                id={`${FORM_ID}-name`}
                autoComplete='off'
                aria-required='true'
                aria-invalid={fieldState.invalid}
                placeholder={t('sources.placeholders.name')}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <div className='grid gap-4 sm:grid-cols-2'>
          <Controller
            control={form.control}
            name='frequency'
            render={({ field }) => (
              <Field>
                <FieldLabel htmlFor={`${FORM_ID}-frequency`}>
                  {t('sources.fields.frequency')}
                </FieldLabel>
                <Select
                  items={frequencyItems}
                  value={String(field.value)}
                  onValueChange={(value) => field.onChange(Number(value))}
                >
                  <SelectTrigger id={`${FORM_ID}-frequency`} className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {frequencyItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            )}
          />
          <Controller
            control={form.control}
            name='candidateLimit'
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor={`${FORM_ID}-limit`}>
                  {t('sources.fields.candidateLimit')}
                </FieldLabel>
                <Input
                  id={`${FORM_ID}-limit`}
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  type='number'
                  inputMode='numeric'
                  min={1}
                  max={100}
                  value={Number.isNaN(field.value) ? '' : field.value}
                  onChange={(event) =>
                    field.onChange(event.target.valueAsNumber)
                  }
                  aria-invalid={fieldState.invalid}
                />
                <FieldDescription>
                  {t('sources.hints.candidateLimit')}
                </FieldDescription>
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        </div>
        {!source && topics.length > 0 ? (
          <Controller
            control={form.control}
            name='topicIds'
            render={({ field }) => (
              <FieldSet>
                <FieldLegend variant='label'>
                  {t('sources.fields.topics')}
                </FieldLegend>
                <FieldDescription>{t('sources.hints.topics')}</FieldDescription>
                <div className='flex flex-wrap gap-x-4 gap-y-2'>
                  {topics.map((topic) => (
                    <Field
                      key={topic.id}
                      orientation='horizontal'
                      className='w-auto'
                    >
                      <Checkbox
                        id={`${FORM_ID}-topic-${topic.id}`}
                        checked={field.value.includes(topic.id)}
                        onCheckedChange={(next) =>
                          field.onChange(
                            next
                              ? [...field.value, topic.id]
                              : field.value.filter((id) => id !== topic.id),
                          )
                        }
                      />
                      <FieldLabel
                        htmlFor={`${FORM_ID}-topic-${topic.id}`}
                        className='font-normal'
                      >
                        {topic.name}
                      </FieldLabel>
                    </Field>
                  ))}
                </div>
              </FieldSet>
            )}
          />
        ) : null}
      </FieldGroup>
    </FeedbackForm>
  );
}

function Footer({
  submitting,
  editing,
}: {
  readonly submitting: boolean;
  readonly editing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { close } = useRouteOverlay();
  return (
    <>
      <Button
        type='button'
        variant='outline'
        disabled={submitting}
        onClick={() => void close()}
      >
        {t('actions.cancel')}
      </Button>
      <Button type='submit' form={FORM_ID} disabled={submitting}>
        {submitting ? <Spinner data-icon='inline-start' /> : null}
        {submitting
          ? t('feed.common.saving')
          : editing
            ? t('actions.save')
            : t('feed.common.create')}
      </Button>
    </>
  );
}
