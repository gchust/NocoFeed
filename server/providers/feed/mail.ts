import type {
  MailAccountView,
  MailFolder,
  MailMessageSummary,
  MailService,
} from '@nocobase/app-plugin-mail/server';

import type { Adapters } from './adapters.js';
import { htmlToText, truncate } from './text.js';
import type { CollectRequest, CollectResult, CollectedItem } from './types.js';

/**
 * Mail as a subscription: the person's own mailbox, read through the Mail plugin's `MailService` as that person
 * (`actorId` is the subscription's owner, so the plugin's own ownership checks apply). Only reads are used —
 * `listAccounts`, `listFolders`, `listMessages` and `getMessage` — so collecting never marks a message read, moves it
 * or changes anything else in the mailbox. The plugin synchronizes the mailbox on its own schedule; this reads what it
 * has synchronized.
 */
export type MailReader = Pick<
  MailService,
  'listAccounts' | 'listFolders' | 'listMessages' | 'getMessage'
>;

/** What a mail subscription narrows to, stored in `feedSources.options`. */
export interface MailSourceOptions {
  /** A folder's type (`inbox`, `archive`, …) or name; null reads the inbox. */
  folder: string | null;
  /** Kept when the sender matches one: a full address, an `@domain`, or part of the address or display name. */
  senders: string[];
  /** Kept when the subject contains one, ignoring case. */
  subjectKeywords: string[];
}

/** One connected account, as the subscription form offers it. Never carries credentials. */
export interface MailAccountChoice {
  id: string;
  address: string;
  displayName: string | null;
  provider: string;
  status: string;
}

const PAGE_SIZE = 50;
/** At most this many messages are looked at in one run, however many the filters leave out. */
const MAX_SCAN = 500;
const BODY_LIMIT = 20_000;
/** Accounts that cannot be read until the person reconnects or resumes them. */
const INACTIVE = new Set([
  'suspended',
  'removing',
  'revoked',
  'reauthorizationRequired',
]);

const list = (value: unknown, max: number, length: number): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim().toLowerCase())
            .filter((entry) => entry && entry.length <= length),
        ),
      ].slice(0, max)
    : [];

/** The stored options of a mail subscription, normalized; anything unreadable is left out. */
export function mailOptions(value: unknown): MailSourceOptions {
  const row =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const folder =
    typeof row.folder === 'string' ? row.folder.trim().slice(0, 100) : '';
  return {
    folder: folder || null,
    senders: list(row.senders, 20, 200),
    subjectKeywords: list(row.subjectKeywords, 20, 100),
  };
}

/** Whether a message passes the subscription's sender and subject filters. */
export function matchesMailFilters(
  message: Pick<MailMessageSummary, 'from' | 'subject'>,
  options: MailSourceOptions,
): boolean {
  if (options.senders.length) {
    const address = (message.from?.address ?? '').toLowerCase();
    const name = (message.from?.name ?? '').toLowerCase();
    const sender = options.senders.some((entry) =>
      entry.startsWith('@')
        ? address.endsWith(entry)
        : entry.includes('@')
          ? address === entry
          : address.includes(entry) || name.includes(entry),
    );
    if (!sender) return false;
  }
  if (options.subjectKeywords.length) {
    const subject = (message.subject ?? '').toLowerCase();
    if (!options.subjectKeywords.some((entry) => subject.includes(entry)))
      return false;
  }
  return true;
}

/** The item's external id: the Message-ID the sender gave it, else the Mail plugin's own id for it. */
export function mailExternalId(
  accountId: string,
  message: Pick<MailMessageSummary, 'id' | 'internetMessageId'>,
): string {
  const messageId = message.internetMessageId?.trim().replace(/^<|>$/g, '');
  return messageId || `mail:${accountId}:${message.id}`;
}

const folderMatches = (folder: MailFolder, wanted: string | null) =>
  wanted
    ? folder.type.toLowerCase() === wanted ||
      folder.name.toLowerCase() === wanted
    : folder.type === 'inbox';

export interface MailCollector {
  /** The person's connected accounts; null when the Mail plugin is not there. */
  accounts(ownerId: string): Promise<MailAccountChoice[] | null>;
  collect(request: CollectRequest): Promise<CollectResult>;
}

export function createMailCollector(
  mail: () => MailReader | undefined,
): MailCollector {
  async function collect(request: CollectRequest): Promise<CollectResult> {
    const service = mail();
    if (!service)
      return { status: 'unconfigured', message: 'mailUnavailable', items: [] };
    if (!request.ownerId)
      return { status: 'failed', message: 'mailOwnerMissing', items: [] };
    const context = { actorId: request.ownerId, signal: request.signal };
    const options = mailOptions(request.options);
    const account = (await service.listAccounts(context)).find(
      (entry) => entry.id === request.target,
    );
    if (!account)
      return { status: 'failed', message: 'mailAccountMissing', items: [] };
    if (INACTIVE.has(account.status))
      return {
        status: 'needsLogin',
        message: 'mailAccountInactive',
        items: [],
      };

    const folderValue = options.folder?.toLowerCase() ?? null;
    const folders = (await service.listFolders(context, account.id)).filter(
      (folder) => folderMatches(folder, folderValue),
    );
    if (!folders.length) {
      // Before its first synchronization an account has no folders yet: nothing to read, which is not a failure.
      return options.folder
        ? { status: 'failed', message: 'mailFolderMissing', items: [] }
        : { status: 'ok', items: [] };
    }

    const since = request.since?.getTime();
    const picked: MailMessageSummary[] = [];
    let truncated = false;
    let scanned = 0;
    let cursor: string | undefined;
    // Newest first: stop at the first message older than the window, or once the limit is full.
    scan: while (scanned < MAX_SCAN) {
      const page = await service.listMessages(context, {
        accountIds: [account.id],
        folderIds: folders.map((folder) => folder.providerFolderId),
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      for (const message of page.items) {
        scanned += 1;
        if (message.draft) continue;
        const at = Date.parse(message.receivedAt ?? message.sentAt ?? '');
        if (since !== undefined && Number.isFinite(at) && at < since)
          break scan;
        if (!matchesMailFilters(message, options)) continue;
        if (request.knownIds.has(mailExternalId(account.id, message))) continue;
        if (picked.length >= request.limit) {
          truncated = true;
          break scan;
        }
        picked.push(message);
      }
      if (!page.nextCursor || !page.items.length) break;
      cursor = page.nextCursor;
    }

    const items: CollectedItem[] = [];
    for (const summary of picked) {
      const message =
        (await service.getMessage(context, account.id, summary.id)) ?? summary;
      items.push(toItem(account, message));
    }
    return { status: 'ok', items, truncated };
  }

  return {
    async accounts(ownerId) {
      const service = mail();
      if (!service) return null;
      const accounts = await service.listAccounts({ actorId: ownerId });
      return accounts
        .filter((account) => account.status !== 'removing')
        .map((account) => ({
          id: account.id,
          address: account.address,
          displayName: account.displayName ?? null,
          provider: account.provider.type,
          status: account.status,
        }));
    },
    async collect(request) {
      try {
        return await collect(request);
      } catch (error) {
        return {
          status: 'failed',
          message: truncate(
            error instanceof Error ? error.message : String(error),
            500,
          ),
          items: [],
        };
      }
    },
  };
}

function toItem(
  account: MailAccountView,
  message: MailMessageSummary & { text?: string; html?: string },
): CollectedItem {
  const text = message.text?.trim() || htmlToText(message.html);
  const preview = message.preview?.trim() ?? '';
  const from = message.from;
  const author = from
    ? from.name && from.name !== from.address
      ? `${from.name} <${from.address}>`
      : from.address
    : undefined;
  return {
    externalId: mailExternalId(account.id, message),
    title:
      message.subject?.trim() || truncate(preview, 120) || from?.address || '',
    author,
    summary: preview || undefined,
    body: text ? truncate(text, BODY_LIMIT) : undefined,
    publishedAt: message.receivedAt ?? message.sentAt,
    coverage: {
      body: text
        ? {
            status: text.length > BODY_LIMIT ? 'partial' : 'available',
            ...(text.length > BODY_LIMIT ? { note: 'truncated' } : {}),
          }
        : preview
          ? { status: 'partial', note: 'previewOnly' }
          : { status: 'missing' },
      comments: { status: 'unavailable', note: 'commentsNotSupported' },
      media: { status: 'unavailable', note: 'mediaNotAnalyzed' },
    },
  };
}

/**
 * The adapters with mail and the push inbox added: a `mail` subscription is read through the Mail plugin, and the push
 * inbox is never collected (its items arrive through `POST /feedItems/ingest`).
 */
export function withMail(adapters: Adapters, mail: MailCollector): Adapters {
  return {
    ...adapters,
    collect(request) {
      if (request.platform === 'mail') return mail.collect(request);
      if (request.platform === 'inbox')
        return Promise.resolve({
          status: 'unsupported',
          message: 'pushSource',
          items: [],
        });
      return adapters.collect(request);
    },
  };
}
