import { useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
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
import { Spinner } from '#components/ui/spinner';

import { requestProblem } from '../feed/format.js';

/** `SKILL_USES` and `SKILL_LANGUAGES` in `server/providers/feed/skills-prompt.ts`. */
const SKILL_USES = ['replies', 'ideas', 'briefs'] as const;
const SKILL_LANGUAGES = ['en', 'zh', 'other'] as const;
type SkillUse = (typeof SKILL_USES)[number];
type SkillLanguage = (typeof SKILL_LANGUAGES)[number];
type Bindings = Partial<
  Record<SkillUse, Partial<Record<SkillLanguage, string>>>
>;

/** `GET /feedWritingSkills`. */
export interface WritingSkillSettings {
  readonly bindings: Bindings;
  readonly skills: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly version: number;
    readonly size: number;
  }[];
  readonly available: boolean;
}

const FORM_ID = 'feed-writing-skills';
const NONE = 'none';

/**
 * "Writing skills": which skill of the skill library (System settings → Skills, the Agents plugin's) shapes reply
 * drafts, ideas and briefs, for text in English, in Chinese and in other languages. Saved on its own.
 */
export function WritingSkillsCard(): ReactElement | null {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const [loaded, setLoaded] = useState<WritingSkillSettings>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [bindings, setBindings] = useState<Bindings>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    api
      .request<{ data: WritingSkillSettings }>({
        path: 'feedWritingSkills',
        signal: controller.signal,
      })
      .then(
        ({ data }) => {
          if (controller.signal.aborted) return;
          setLoaded(data);
          setBindings(data.bindings);
        },
        () => {
          if (!controller.signal.aborted) setLoadFailed(true);
        },
      );
    return () => controller.abort();
  }, [api]);

  if (loadFailed) return null;
  if (!loaded) return <Skeleton className='h-48' />;
  if (!loaded.available) return null;

  const items = [
    { value: NONE, label: t('preferences.writingSkills.none') },
    ...loaded.skills.map((skill) => ({ value: skill.id, label: skill.name })),
  ];

  const choose = (
    use: SkillUse,
    language: SkillLanguage,
    value: string | null,
  ): void =>
    setBindings((current) => {
      const entry = { ...current[use] };
      if (!value || value === NONE) delete entry[language];
      else entry[language] = value;
      return { ...current, [use]: entry };
    });

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const { data } = await api.request<{ data: WritingSkillSettings }>({
        path: 'feedWritingSkills',
        method: 'PUT',
        json: { bindings },
      });
      setLoaded(data);
      setBindings(data.bindings);
      toaster.show({
        type: 'success',
        title: t('preferences.writingSkills.saved'),
        description: t('preferences.writingSkills.savedHint'),
      });
    } catch (cause: unknown) {
      setError(t(`feed.errors.${requestProblem(cause)}`));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card data-testid='writing-skills'>
      <CardHeader>
        <CardTitle>{t('preferences.writingSkills.title')}</CardTitle>
        <CardDescription>
          {t('preferences.writingSkills.description')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loaded.skills.length ? (
          <form id={FORM_ID} noValidate onSubmit={(event) => void save(event)}>
            <FieldGroup>
              {SKILL_USES.map((use) => (
                <FieldSet key={use}>
                  <FieldLegend variant='label'>
                    {t(`preferences.writingSkills.uses.${use}`)}
                  </FieldLegend>
                  <FieldDescription>
                    {t(`preferences.writingSkills.usesHint.${use}`)}
                  </FieldDescription>
                  <div className='grid gap-3 sm:grid-cols-3'>
                    {SKILL_LANGUAGES.map((language) => {
                      const id = `${FORM_ID}-${use}-${language}`;
                      const value = bindings[use]?.[language] ?? NONE;
                      const chosen = loaded.skills.find(
                        (skill) => skill.id === value,
                      );
                      return (
                        <Field key={language}>
                          <FieldLabel htmlFor={id}>
                            {t(
                              `preferences.writingSkills.languages.${language}`,
                            )}
                          </FieldLabel>
                          <Select
                            items={items}
                            value={value}
                            onValueChange={(next) =>
                              choose(use, language, next)
                            }
                          >
                            <SelectTrigger id={id} className='w-full'>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {items.map((item) => (
                                  <SelectItem
                                    key={item.value}
                                    value={item.value}
                                  >
                                    {item.label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                          {chosen?.description ? (
                            <FieldDescription className='line-clamp-2'>
                              {chosen.description}
                            </FieldDescription>
                          ) : null}
                        </Field>
                      );
                    })}
                  </div>
                </FieldSet>
              ))}
            </FieldGroup>
            {error ? (
              <p role='alert' className='mt-4 text-sm text-destructive'>
                {error}
              </p>
            ) : null}
          </form>
        ) : (
          <p className='text-sm text-muted-foreground'>
            {t('preferences.writingSkills.empty')}
          </p>
        )}
      </CardContent>
      {loaded.skills.length ? (
        <CardFooter className='justify-between gap-3'>
          <p className='text-sm text-muted-foreground'>
            {t('preferences.writingSkills.library')}
          </p>
          <Button type='submit' form={FORM_ID} disabled={saving}>
            {saving ? <Spinner data-icon='inline-start' /> : null}
            {t('preferences.writingSkills.save')}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
