import { zodResolver } from '@hookform/resolvers/zod';
import { ApiClientError, useApiClient, useToaster } from '@nocobase/app-client';
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
import { Textarea } from '#components/ui/textarea';
import { useRouteOverlay } from '#components/use-route-overlay';

import { frequencyText, requestProblem } from '../feed/format.js';
import { PlatformBadge } from '../feed/parts.js';
import { TOPIC_MODES, type Topic } from '../feed/types.js';
import { FREQUENCIES } from '../sources/types.js';
import { searchablePlatforms, type TopicsOutletContext } from './types.js';

const FORM_ID = 'feed-topic-form';
/** The server's limit on search terms per topic. */
const MAX_TERMS = 10;
/** Why the server turned a topic down, for what the form cannot check itself. */
const REJECTIONS: Readonly<Record<string, string>> = {
  FEED_TOO_MANY_SEARCH_TERMS: 'topics.validation.tooManyTerms',
  FEED_SEARCH_TERM_LENGTH: 'topics.validation.termRejected',
};

/** `/topics/new` and `/topics/:topicId/edit`. */
export default function TopicDialog(): ReactElement {
  const { t } = useTranslation();
  const { topicId } = useParams();
  const { topics, catalog } = useOutletContext<TopicsOutletContext>();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const onSubmittingChange = (value: boolean): void => {
    submittingRef.current = value;
    setSubmitting(value);
  };
  const topic = topicId
    ? topics?.find((entry) => String(entry.id) === topicId)
    : undefined;
  const missing = Boolean(topicId && topics && !topic);

  return (
    <RouteDialog
      title={topicId ? t('topics.edit') : t('topics.create')}
      description={t('topics.formDescription')}
      className='sm:max-w-xl'
      beforeClose={() => !submittingRef.current}
      footer={<Footer submitting={submitting} editing={Boolean(topicId)} />}
    >
      {missing ? (
        <p role='alert' className='text-sm text-destructive'>
          {t('feed.errors.notFound')}
        </p>
      ) : (topicId && !topic) || !catalog ? (
        // The search platforms come from the catalog, so the form waits for it.
        <Skeleton className='h-64' />
      ) : (
        <Body topic={topic} onSubmittingChange={onSubmittingChange} />
      )}
    </RouteDialog>
  );
}

function Body({
  topic,
  onSubmittingChange,
}: {
  readonly topic?: Topic;
  readonly onSubmittingChange: (submitting: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const { close } = useRouteOverlay();
  const { reload, sources, catalog } = useOutletContext<TopicsOutletContext>();
  const entryRef = useRef(false);
  const searchable = useMemo(() => searchablePlatforms(catalog), [catalog]);

  const schema = useMemo(
    () =>
      z.object({
        name: z
          .string()
          .trim()
          .min(1, t('topics.validation.nameRequired'))
          .max(40, t('feed.validation.tooLong', { max: 40 })),
        goal: z
          .string()
          .trim()
          .min(1, t('topics.validation.goalRequired'))
          .max(2000, t('feed.validation.tooLong', { max: 2000 })),
        avoid: z
          .string()
          .trim()
          .max(1000, t('feed.validation.tooLong', { max: 1000 })),
        mode: z.enum(TOPIC_MODES),
        sourceIds: z.array(z.number()),
        searchTerms: z.string(),
        searchPlatforms: z.array(z.string()),
        searchFrequency: z.number().int().min(15).max(10080),
        searchLimit: z
          .number({ error: t('sources.validation.candidates') })
          .int(t('sources.validation.candidates'))
          .min(1, t('sources.validation.candidates'))
          .max(100, t('sources.validation.candidates')),
      }),
    [t],
  );

  const form = useForm({
    shouldFocusError: false,
    resolver: zodResolver(schema),
    defaultValues: {
      name: topic?.name ?? '',
      goal: topic?.goal ?? '',
      avoid: topic?.avoid ?? '',
      mode: topic?.mode ?? 'both',
      sourceIds: [...(topic?.sourceIds ?? [])],
      searchTerms: (topic?.searchTerms ?? []).join('\n'),
      // No stored choice means every platform that can search, now and later.
      searchPlatforms: [
        ...(topic?.searchPlatforms.length
          ? topic.searchPlatforms
          : searchable.map((entry) => entry.platform)),
      ] as string[],
      searchFrequency: topic?.searchFrequency ?? 360,
      searchLimit: topic?.searchLimit ?? 20,
    },
  });

  const termsText = useWatch({ control: form.control, name: 'searchTerms' });
  const searching = termsText.trim().length > 0;
  const frequencyItems = FREQUENCIES.map((value) => ({
    value: String(value),
    label: frequencyText(t, value),
  }));

  const validatedSubmit = form.handleSubmit(async (values) => {
    const terms = [
      ...new Set(
        values.searchTerms
          .split('\n')
          .map((term) => term.trim())
          .filter(Boolean),
      ),
    ];
    const chosen = searchable.filter((entry) =>
      values.searchPlatforms.includes(entry.platform),
    );
    if (terms.length > MAX_TERMS) {
      form.setError('searchTerms', {
        message: t('topics.validation.tooManyTerms', { max: MAX_TERMS }),
      });
      return;
    }
    if (terms.length > 0 && chosen.length === 0) {
      form.setError('searchPlatforms', {
        message: t('topics.validation.platformRequired'),
      });
      return;
    }
    // A term has to suit every platform it runs on.
    const lengths = chosen.flatMap((entry) =>
      entry.targetLength ? [entry.targetLength] : [],
    );
    if (lengths.length > 0) {
      const min = Math.max(...lengths.map((length) => length.min));
      const max = Math.min(...lengths.map((length) => length.max));
      const bad = terms.find(
        (term) =>
          term.length < min || term.length > max || term.startsWith('-'),
      );
      if (bad !== undefined) {
        form.setError('searchTerms', {
          message: t('topics.validation.termLength', { term: bad, min, max }),
        });
        return;
      }
    }
    const json = {
      name: values.name,
      goal: values.goal,
      avoid: values.avoid || null,
      mode: values.mode,
      sourceIds: values.sourceIds,
      searchTerms: terms,
      searchPlatforms:
        chosen.length === searchable.length
          ? []
          : chosen.map((entry) => entry.platform),
      searchFrequency: values.searchFrequency,
      searchLimit: values.searchLimit,
    };
    try {
      const { data } = await api.request<{ data: Topic }>(
        topic
          ? {
              path: `feedTopics/${encodeURIComponent(topic.id)}`,
              method: 'PATCH',
              json,
            }
          : { path: 'feedTopics', method: 'POST', json },
      );
      onSubmittingChange(false);
      toaster.show({
        type: 'success',
        title: topic
          ? t('topics.saved', { name: data.name })
          : t('topics.created', { name: data.name }),
      });
      reload();
      void close();
    } catch (error: unknown) {
      const problem = requestProblem(error);
      const reason = error instanceof ApiClientError ? error.reason : undefined;
      form.setError('root', {
        type: problem,
        message:
          reason && REJECTIONS[reason]
            ? t(REJECTIONS[reason], { max: MAX_TERMS })
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
          name='name'
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={`${FORM_ID}-name`}>
                {t('topics.fields.name')}
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
                placeholder={t('topics.placeholders.name')}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name='goal'
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={`${FORM_ID}-goal`}>
                {t('topics.fields.goal')}
                <span aria-hidden='true' className='text-destructive'>
                  *
                </span>
              </FieldLabel>
              <Textarea
                {...field}
                id={`${FORM_ID}-goal`}
                rows={3}
                aria-required='true'
                aria-invalid={fieldState.invalid}
                placeholder={t('topics.placeholders.goal')}
              />
              <FieldDescription>{t('topics.hints.goal')}</FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name='avoid'
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={`${FORM_ID}-avoid`}>
                {t('topics.fields.avoid')}
              </FieldLabel>
              <Textarea
                {...field}
                id={`${FORM_ID}-avoid`}
                rows={2}
                aria-invalid={fieldState.invalid}
                placeholder={t('topics.placeholders.avoid')}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name='mode'
          render={({ field }) => (
            <FieldSet>
              <FieldLegend variant='label'>
                {t('topics.fields.mode')}
              </FieldLegend>
              <RadioGroup
                value={field.value}
                onValueChange={(value) => field.onChange(value)}
                className='grid gap-2 sm:grid-cols-3'
              >
                {TOPIC_MODES.map((mode) => (
                  <FieldLabel key={mode} htmlFor={`${FORM_ID}-mode-${mode}`}>
                    <Field orientation='horizontal'>
                      <RadioGroupItem
                        value={mode}
                        id={`${FORM_ID}-mode-${mode}`}
                      />
                      <FieldContent>
                        <span className='font-medium'>
                          {t(`topics.modes.${mode}`)}
                        </span>
                        <FieldDescription>
                          {t(`topics.modeHints.${mode}`)}
                        </FieldDescription>
                      </FieldContent>
                    </Field>
                  </FieldLabel>
                ))}
              </RadioGroup>
            </FieldSet>
          )}
        />
        <FieldSet>
          <FieldLegend variant='label'>{t('topics.fields.search')}</FieldLegend>
          <FieldDescription>{t('topics.hints.search')}</FieldDescription>
          <Controller
            control={form.control}
            name='searchTerms'
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor={`${FORM_ID}-terms`}>
                  {t('topics.fields.searchTerms')}
                </FieldLabel>
                <Textarea
                  {...field}
                  id={`${FORM_ID}-terms`}
                  rows={3}
                  aria-invalid={fieldState.invalid}
                  placeholder={t('topics.placeholders.searchTerms')}
                />
                <FieldDescription>
                  {t('topics.hints.searchTerms', { max: MAX_TERMS })}
                </FieldDescription>
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
          {searching ? (
            <>
              <Controller
                control={form.control}
                name='searchPlatforms'
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel>
                      {t('topics.fields.searchPlatforms')}
                    </FieldLabel>
                    {searchable.length === 0 ? (
                      <p className='text-sm text-muted-foreground'>
                        {t('topics.noSearchPlatforms')}
                      </p>
                    ) : (
                      <div className='flex flex-wrap gap-x-4 gap-y-2'>
                        {searchable.map((entry) => (
                          <Field
                            key={entry.platform}
                            orientation='horizontal'
                            className='w-auto'
                          >
                            <Checkbox
                              id={`${FORM_ID}-platform-${entry.platform}`}
                              checked={field.value.includes(entry.platform)}
                              onCheckedChange={(next) =>
                                field.onChange(
                                  next
                                    ? [...field.value, entry.platform]
                                    : field.value.filter(
                                        (value) => value !== entry.platform,
                                      ),
                                )
                              }
                            />
                            <FieldLabel
                              htmlFor={`${FORM_ID}-platform-${entry.platform}`}
                              className='font-normal'
                            >
                              <PlatformBadge platform={entry.platform} />
                            </FieldLabel>
                          </Field>
                        ))}
                      </div>
                    )}
                    {searchable.some((entry) => !entry.available) ? (
                      <FieldDescription>
                        {t('sources.hints.collectorNeeded')}
                      </FieldDescription>
                    ) : null}
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
              <div className='grid gap-4 sm:grid-cols-2'>
                <Controller
                  control={form.control}
                  name='searchFrequency'
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
                        <SelectTrigger
                          id={`${FORM_ID}-frequency`}
                          className='w-full'
                        >
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
                  name='searchLimit'
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor={`${FORM_ID}-limit`}>
                        {t('topics.fields.searchLimit')}
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
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />
              </div>
            </>
          ) : null}
        </FieldSet>
        <Controller
          control={form.control}
          name='sourceIds'
          render={({ field }) => (
            <FieldSet>
              <FieldLegend variant='label'>
                {t('topics.fields.sources')}
              </FieldLegend>
              <FieldDescription>{t('topics.hints.sources')}</FieldDescription>
              {sources.length === 0 ? (
                <p className='text-sm text-muted-foreground'>
                  {t('topics.noSources')}
                </p>
              ) : (
                <div className='flex max-h-48 flex-col gap-2 overflow-y-auto'>
                  {sources.map((source) => {
                    const checked = field.value.includes(source.id);
                    return (
                      <Field key={source.id} orientation='horizontal'>
                        <Checkbox
                          id={`${FORM_ID}-source-${source.id}`}
                          checked={checked}
                          onCheckedChange={(next) =>
                            field.onChange(
                              next
                                ? [...field.value, source.id]
                                : field.value.filter((id) => id !== source.id),
                            )
                          }
                        />
                        <FieldLabel
                          htmlFor={`${FORM_ID}-source-${source.id}`}
                          className='font-normal'
                        >
                          <PlatformBadge platform={source.platform} />
                          {source.name}
                        </FieldLabel>
                      </Field>
                    );
                  })}
                </div>
              )}
            </FieldSet>
          )}
        />
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
