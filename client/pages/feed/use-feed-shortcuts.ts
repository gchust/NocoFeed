import { useEffect, useRef } from 'react';

export type ShortcutAction =
  | 'next'
  | 'previous'
  | 'favorite'
  | 'later'
  | 'dismiss'
  | 'open'
  | 'close'
  | 'help';

const KEYS: Readonly<Record<string, ShortcutAction>> = {
  j: 'next',
  k: 'previous',
  s: 'favorite',
  l: 'later',
  x: 'dismiss',
  o: 'open',
  Escape: 'close',
  '?': 'help',
};

/** The keys in the order the help lists them. */
export const SHORTCUTS: readonly (readonly [string, ShortcutAction])[] = [
  ['j', 'next'],
  ['k', 'previous'],
  ['s', 'favorite'],
  ['l', 'later'],
  ['x', 'dismiss'],
  ['o', 'open'],
  ['Esc', 'close'],
  ['?', 'help'],
];

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    target.closest('[role="listbox"], [role="menu"], [role="combobox"]') !==
      null
  );
}

/**
 * Single-key triage shortcuts for the feed. Keys typed into a field, with a modifier, or while another dialog has focus
 * are left alone, so the page never steals typing.
 */
export function useFeedShortcuts(
  enabled: boolean,
  run: (action: ShortcutAction) => void,
): void {
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey) return;
      if (event.altKey || typing(event.target)) return;
      const action = KEYS[event.key];
      if (!action) return;
      const dialog =
        event.target instanceof HTMLElement
          ? event.target.closest('[role="dialog"], [role="alertdialog"]')
          : null;
      // Inside the item sheet the keys still work; inside any other dialog they belong to it.
      if (dialog && !dialog.closest('[data-feed-detail]')) return;
      if (
        action === 'close' &&
        !dialog &&
        !document.querySelector('[data-feed-detail-open]')
      )
        return;
      event.preventDefault();
      runRef.current(action);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
