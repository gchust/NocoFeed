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
import { Checkbox } from '#components/ui/checkbox';
import {
  Field,
  FieldContent,
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
import { Switch } from '#components/ui/switch';
import { Textarea } from '#components/ui/textarea';

import {
  IDEA_KINDS,
  X_LANGUAGES,
  type IdeaKind,
  type IdeaSettings,
  type XLanguage,
} from '../feed/ideas-model.js';
import { requestProblem } from '../feed/format.js';

const FORM_ID = 'feed-idea-settings';

/** The creative style and kinds ideas are written in, and whether items worth discussing get ideas on their own. */
export function IdeaSettingsCard(): ReactElement | null {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const [settings, setSettings] = useState<IdeaSettings>();
  const [failed, setFailed] = useState(false);
  const [style, setStyle] = useState('');
  const [kinds, setKinds] = useState<IdeaKind[]>([]);
  const [auto, setAuto] = useState(false);
  const [xLanguage, setXLanguage] = useState<XLanguage>('en');
  const [saving, setSaving] = useState(false);

  const apply = (value: IdeaSettings) => {
    setSettings(value);
    setStyle(value.style);
    setKinds([...value.kinds]);
    setAuto(value.auto);
    setXLanguage(value.xLanguage);
  };

  useEffect(() => {
    let current = true;
    api.request<{ data: IdeaSettings }>({ path: 'feedIdeaSettings' }).then(
      ({ data }) => {
        if (current) apply(data);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [api]);

  if (failed) return null;
  if (!settings) return <Skeleton className='h-64' />;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!kinds.length) return;
    setSaving(true);
    try {
      const { data } = await api.request<{ data: IdeaSettings }>({
        path: 'feedIdeaSettings',
        method: 'PUT',
        json: {
          style: style.trim() ? style : null,
          kinds,
          auto,
          xLanguage,
        },
      });
      apply(data);
      toaster.show({ type: 'success', title: t('preferences.ideas.saved') });
    } catch (cause: unknown) {
      toaster.show({
        type: 'error',
        title: t(`feed.errors.${requestProblem(cause)}`),
      });
    } finally {
      setSaving(false);
    }
  };

  const languageItems = X_LANGUAGES.map((value) => ({
    value,
    label: t(`preferences.ideas.xLanguages.${value}`),
  }));

  return (
    <Card data-testid='idea-settings'>
      <CardHeader>
        <CardTitle>{t('preferences.ideas.title')}</CardTitle>
        <CardDescription>{t('preferences.ideas.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form id={FORM_ID} onSubmit={(event) => void submit(event)}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${FORM_ID}-style`}>
                {t('preferences.ideas.style')}
              </FieldLabel>
              <Textarea
                id={`${FORM_ID}-style`}
                rows={6}
                maxLength={4_000}
                value={style}
                onChange={(event) => setStyle(event.target.value)}
              />
              <FieldDescription className='flex flex-wrap items-center gap-2'>
                <span>{t('preferences.ideas.styleHint')}</span>
                <Button
                  type='button'
                  variant='link'
                  size='sm'
                  className='h-auto p-0'
                  disabled={style === settings.defaultStyle}
                  onClick={() => setStyle(settings.defaultStyle)}
                >
                  {t('preferences.ideas.resetStyle')}
                </Button>
              </FieldDescription>
            </Field>
            <FieldSet>
              <FieldLegend variant='label'>
                {t('preferences.ideas.kinds')}
              </FieldLegend>
              <FieldDescription>
                {kinds.length
                  ? t('preferences.ideas.kindsHint')
                  : t('preferences.ideas.kindsEmpty')}
              </FieldDescription>
              <FieldGroup className='gap-2'>
                {IDEA_KINDS.map((kind) => (
                  <Field key={kind} orientation='horizontal'>
                    <Checkbox
                      id={`${FORM_ID}-kind-${kind}`}
                      checked={kinds.includes(kind)}
                      onCheckedChange={(checked) =>
                        setKinds((previous) =>
                          checked
                            ? IDEA_KINDS.filter(
                                (entry) =>
                                  entry === kind || previous.includes(entry),
                              )
                            : previous.filter((entry) => entry !== kind),
                        )
                      }
                    />
                    <FieldLabel
                      htmlFor={`${FORM_ID}-kind-${kind}`}
                      className='font-normal'
                    >
                      {t(`feed.ideas.kinds.${kind}`)}
                    </FieldLabel>
                  </Field>
                ))}
              </FieldGroup>
            </FieldSet>
            <Field>
              <FieldLabel htmlFor={`${FORM_ID}-xLanguage`}>
                {t('preferences.ideas.xLanguage')}
              </FieldLabel>
              <Select
                items={languageItems}
                value={xLanguage}
                onValueChange={(value) => setXLanguage(value ?? 'en')}
              >
                <SelectTrigger id={`${FORM_ID}-xLanguage`} className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {languageItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field orientation='horizontal'>
              <FieldContent>
                <FieldLabel htmlFor={`${FORM_ID}-auto`}>
                  {t('preferences.ideas.auto')}
                </FieldLabel>
                <FieldDescription>
                  {t('preferences.ideas.autoHint')}
                </FieldDescription>
              </FieldContent>
              <Switch
                id={`${FORM_ID}-auto`}
                checked={auto}
                onCheckedChange={(checked) => setAuto(checked)}
              />
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
      <CardFooter className='justify-end'>
        <Button type='submit' form={FORM_ID} disabled={saving || !kinds.length}>
          {saving ? <Spinner /> : null}
          {t('preferences.ideas.save')}
        </Button>
      </CardFooter>
    </Card>
  );
}
