/** Where the person connects their mail accounts (the Mail plugin's own page, `client/routes.ts`). */
export const MAIL_ACCOUNTS_PATH = '/mail/accounts';

/** Entries typed one per line or separated by commas, trimmed, without duplicates or overlong ones. */
export function splitList(value: string, max: number): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,，;；]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry && entry.length <= max),
    ),
  ];
}
