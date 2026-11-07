/**
 * What the steer panel (`steer.tsx`, issue #20) shares: the directions, the note limit and the steer last used in this
 * browser.
 */

/** Same lists as `server/providers/feed/steer.ts`. */
export const REPLY_ANGLES = [
  'askDetail',
  'experience',
  'pushBack',
  'addSource',
  'humor',
  'agree',
  'askHelp',
] as const;
export const IDEA_ANGLES = [
  'downToEarth',
  'controversial',
  'shorter',
  'funnier',
  'newPersona',
] as const;
export const STEER_NOTE_MAX = 500;

export type SteerKind = 'replies' | 'ideas';

export interface Steer {
  readonly angles: readonly string[];
  readonly note: string;
}

const STORAGE_KEY = (kind: SteerKind) => `nocofeed.steer.${kind}`;

/** The steer last used for this kind in this browser, or null. */
export function rememberedSteer(kind: SteerKind): Steer | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(kind));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Steer>;
    const angles = Array.isArray(value.angles)
      ? value.angles.filter((angle) => typeof angle === 'string')
      : [];
    const note =
      typeof value.note === 'string' ? value.note.slice(0, STEER_NOTE_MAX) : '';
    return angles.length || note ? { angles, note } : null;
  } catch {
    return null;
  }
}

export function rememberSteer(kind: SteerKind, steer: Steer): void {
  try {
    localStorage.setItem(STORAGE_KEY(kind), JSON.stringify(steer));
  } catch {
    // Private mode or a full store: the panel just opens empty next time.
  }
}
