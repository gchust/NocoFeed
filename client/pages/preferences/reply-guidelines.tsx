import { useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { ChevronDownIcon } from 'lucide-react';
import { type FormEvent, type ReactElement, useEffect, useState } from 'react';

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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '#components/ui/collapsible';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '#components/ui/field';
import { Skeleton } from '#components/ui/skeleton';
import { Spinner } from '#components/ui/spinner';
import { Textarea } from '#components/ui/textarea';
import { cn } from 'cn';

import { requestProblem } from '../feed/format.js';

/** Platforms whose own rules can be added (`REPLY_PLATFORMS` in `server/providers/feed/replies.ts`). */
const REPLY_PLATFORMS = [
  'x',
  'xiaohongshu',
  'reddit',
  'hn',
  'youtube',
  'bilibili',
  'rss',
  'mail',
] as const;
type ReplyPlatform = (typeof REPLY_PLATFORMS)[number];
const MAX = 4_000;

/** `GET /feedReplyGuidelines`. */
export interface ReplyGuidelines {
  readonly guidelines: string | null;
  readonly platformGuidelines: Partial<Record<ReplyPlatform, string>>;
  readonly defaultGuidelines: string;
}

const FORM_ID = 'feed-reply-guidelines';

/**
 * "Reply style": the person's own rules for reply drafts (issue #15), saved apart from the rest of Preferences. The
 * text starts as the default; saving the default or nothing keeps following it. Rules for one platform are added to
 * the general ones for that platform's posts.
 */
export function ReplyGuidelinesCard(): ReactElement | null {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const [loaded, setLoaded] = useState<ReplyGuidelines>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [general, setGeneral] = useState('');
  const [platforms, setPlatforms] = useState<
    Partial<Record<ReplyPlatform, string>>
  >({});
  const [platformsOpen, setPlatformsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    api
      .request<{ data: ReplyGuidelines }>({
        path: 'feedReplyGuidelines',
        signal: controller.signal,
      })
      .then(
        ({ data }) => {
          if (controller.signal.aborted) return;
          setLoaded(data);
          setGeneral(data.guidelines ?? data.defaultGuidelines);
          setPlatforms(data.platformGuidelines);
          setPlatformsOpen(Object.keys(data.platformGuidelines).length > 0);
        },
        () => {
          if (!controller.signal.aborted) setLoadFailed(true);
        },
      );
    return () => controller.abort();
  }, [api]);

  if (loadFailed) return null;
  if (!loaded) return <Skeleton className='h-48' />;

  const tooLong =
    general.length > MAX ||
    Object.values(platforms).some((value) => (value?.length ?? 0) > MAX);

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (saving || tooLong) return;
    setSaving(true);
    setError(undefined);
    try {
      const { data } = await api.request<{ data: ReplyGuidelines }>({
        path: 'feedReplyGuidelines',
        method: 'PUT',
        json: { guidelines: general, platformGuidelines: platforms },
      });
      setLoaded(data);
      setGeneral(data.guidelines ?? data.defaultGuidelines);
      setPlatforms(data.platformGuidelines);
      toaster.show({
        type: 'success',
        title: t('preferences.replies.saved'),
        description: t('preferences.replies.savedHint'),
      });
    } catch (cause: unknown) {
      setError(t(`feed.errors.${requestProblem(cause)}`));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('preferences.replies.title')}</CardTitle>
        <CardDescription>
          {t('preferences.replies.description')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form id={FORM_ID} noValidate onSubmit={(event) => void save(event)}>
          <FieldGroup>
            <Field data-invalid={general.length > MAX}>
              <FieldLabel htmlFor={`${FORM_ID}-general`}>
                {t('preferences.replies.general')}
              </FieldLabel>
              <Textarea
                id={`${FORM_ID}-general`}
                rows={5}
                value={general}
                aria-invalid={general.length > MAX}
                onChange={(event) => setGeneral(event.target.value)}
              />
              <FieldDescription>
                {t('preferences.replies.generalHint')}
              </FieldDescription>
              {general.length > MAX ? (
                <FieldError>
                  {t('feed.validation.tooLong', { max: MAX })}
                </FieldError>
              ) : null}
            </Field>
            <Collapsible open={platformsOpen} onOpenChange={setPlatformsOpen}>
              <CollapsibleTrigger className='flex items-center gap-1.5 rounded-md text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50'>
                <ChevronDownIcon
                  className={cn(
                    'size-4 transition-transform',
                    !platformsOpen && '-rotate-90',
                  )}
                  aria-hidden='true'
                />
                {t('preferences.replies.platforms')}
              </CollapsibleTrigger>
              <CollapsibleContent className='mt-3 flex flex-col gap-4'>
                <p className='text-sm text-muted-foreground'>
                  {t('preferences.replies.platformsHint')}
                </p>
                {REPLY_PLATFORMS.map((platform) => {
                  const value = platforms[platform] ?? '';
                  return (
                    <Field key={platform} data-invalid={value.length > MAX}>
                      <FieldLabel htmlFor={`${FORM_ID}-${platform}`}>
                        {t(`feed.platforms.${platform}`)}
                      </FieldLabel>
                      <Textarea
                        id={`${FORM_ID}-${platform}`}
                        rows={2}
                        value={value}
                        aria-invalid={value.length > MAX}
                        placeholder={t(
                          'preferences.replies.platformPlaceholder',
                        )}
                        onChange={(event) =>
                          setPlatforms((current) => ({
                            ...current,
                            [platform]: event.target.value,
                          }))
                        }
                      />
                    </Field>
                  );
                })}
              </CollapsibleContent>
            </Collapsible>
            {error ? (
              <p role='alert' className='text-sm text-destructive'>
                {error}
              </p>
            ) : null}
          </FieldGroup>
        </form>
      </CardContent>
      <CardFooter className='justify-end gap-2'>
        <Button
          type='button'
          variant='outline'
          disabled={saving || general === loaded.defaultGuidelines}
          onClick={() => setGeneral(loaded.defaultGuidelines)}
        >
          {t('preferences.replies.reset')}
        </Button>
        <Button type='submit' form={FORM_ID} disabled={saving || tooLong}>
          {saving ? <Spinner data-icon='inline-start' /> : null}
          {t('preferences.replies.save')}
        </Button>
      </CardFooter>
    </Card>
  );
}
