import { useTranslation } from '@nocobase/i18n/client';
import { SparklesIcon } from 'lucide-react';
import { type ReactElement, useId, useState } from 'react';

import { Button } from '#components/ui/button';
import { Textarea } from '#components/ui/textarea';

import {
  IDEA_ANGLES,
  REPLY_ANGLES,
  type Steer,
  STEER_NOTE_MAX,
  type SteerKind,
} from './steer-model.js';

/**
 * Steering a rewrite (issue #20): "New batch" of reply drafts, "Regenerate" or "One more" idea first open this small
 * panel, where the person picks directions and writes a note, or goes ahead without one. The server keeps the steer a
 * result was written with (`steer` on the state) and the card shows it; the last steer used is also remembered in this
 * browser so the panel opens with it on any item.
 */

/** "Following your notes: Ask about details, Funny · more casual" for a stored steer. */
export function SteerApplied({
  kind,
  steer,
}: {
  readonly kind: SteerKind;
  readonly steer: Steer | null | undefined;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!steer || (!steer.angles.length && !steer.note)) return null;
  const parts = [
    steer.angles
      .map((angle) => t(`feed.steer.angles.${kind}.${angle}`))
      .join(t('feed.steer.separator')),
    steer.note,
  ].filter(Boolean);
  return (
    <p
      className='text-xs break-words text-muted-foreground'
      data-testid={`feed-steer-applied-${kind}`}
    >
      {t('feed.steer.applied', { steer: parts.join(' · ') })}
    </p>
  );
}

/** The panel: directions to pick, a note, "go with these notes" and "go without". */
export function SteerPanel({
  kind,
  initial,
  title,
  submitLabel,
  plainLabel,
  disabled,
  onSubmit,
  onPlain,
  onCancel,
}: {
  readonly kind: SteerKind;
  /** What the panel opens with: the item's last steer, else the one last used here. */
  readonly initial: Steer | null;
  readonly title: string;
  readonly submitLabel: string;
  readonly plainLabel: string;
  readonly disabled?: boolean;
  readonly onSubmit: (steer: Steer) => void;
  readonly onPlain: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const noteId = useId();
  const titleId = useId();
  const angles = kind === 'replies' ? REPLY_ANGLES : IDEA_ANGLES;
  const [picked, setPicked] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        (initial?.angles ?? []).filter((angle) =>
          (angles as readonly string[]).includes(angle),
        ),
      ),
  );
  const [note, setNote] = useState(initial?.note ?? '');
  const steer: Steer = {
    angles: angles.filter((angle) => picked.has(angle)),
    note: note.trim(),
  };
  const empty = !steer.angles.length && !steer.note;

  const toggle = (angle: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(angle)) next.delete(angle);
      else next.add(angle);
      return next;
    });

  return (
    <div
      role='group'
      aria-labelledby={titleId}
      className='flex flex-col gap-2 rounded-md border bg-muted/30 p-3'
      data-testid={`feed-steer-${kind}`}
    >
      <p id={titleId} className='text-xs font-medium'>
        {title}
      </p>
      <div
        className='flex flex-wrap gap-1.5'
        aria-label={t('feed.steer.anglesLabel')}
      >
        {angles.map((angle) => (
          <Button
            key={angle}
            type='button'
            size='xs'
            variant={picked.has(angle) ? 'secondary' : 'outline'}
            aria-pressed={picked.has(angle)}
            className='aria-pressed:border-primary aria-pressed:text-primary'
            onClick={() => toggle(angle)}
          >
            {t(`feed.steer.angles.${kind}.${angle}`)}
          </Button>
        ))}
      </div>
      <label htmlFor={noteId} className='sr-only'>
        {t('feed.steer.noteLabel')}
      </label>
      <Textarea
        id={noteId}
        value={note}
        maxLength={STEER_NOTE_MAX}
        rows={2}
        placeholder={t(`feed.steer.placeholder.${kind}`)}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className='flex flex-wrap items-center gap-1.5'>
        <span className='text-xs text-muted-foreground'>
          {t('feed.steer.count', {
            count: note.length,
            max: STEER_NOTE_MAX,
          })}
        </span>
        <Button
          type='button'
          size='xs'
          variant='ghost'
          className='ml-auto'
          onClick={onCancel}
        >
          {t('feed.steer.cancel')}
        </Button>
        <Button
          type='button'
          size='xs'
          variant='outline'
          disabled={disabled}
          onClick={onPlain}
        >
          {plainLabel}
        </Button>
        <Button
          type='button'
          size='xs'
          disabled={disabled || empty}
          onClick={() => onSubmit(steer)}
        >
          <SparklesIcon data-icon='inline-start' />
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
