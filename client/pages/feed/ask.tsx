import { useChat } from '@ai-sdk/react';
import { useApiClient } from '@nocobase/app-client';
import {
  ChatApi,
  type AppUIMessage,
} from '@nocobase/app-plugin-agents/client/chat';
import { useAgentOptions } from '@nocobase/app-plugin-agents/client/kit';
import { useTranslation } from '@nocobase/i18n/client';
import {
  BotIcon,
  GlobeIcon,
  MessageCircleQuestionIcon,
  SearchIcon,
  SendIcon,
  SquareIcon,
  Trash2Icon,
} from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { Link } from 'react-router';
import remarkGfm from 'remark-gfm';

import { SessionExpiredAlert } from '#components/session-expired-alert';
import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import { Skeleton } from '#components/ui/skeleton';
import { Spinner } from '#components/ui/spinner';
import { Textarea } from '#components/ui/textarea';

import { DeleteDialog } from './delete-dialog.js';
import { type RequestProblem, requestProblem } from './format.js';

/** `GET /feedItems/:id/ask`: the person's conversation about the item and what can answer. */
export interface AskState {
  readonly conversationId: string | null;
  readonly online: boolean;
  readonly webSearch: boolean;
  readonly runnerAgentId: string | null;
  readonly runnerPending: boolean;
}

/** `data-notice` types the server writes (`server/providers/feed/ask.ts`). */
const QUEUED_NOTICE = 'nocofeed.askQueued';
const ANSWER_NOTICE = 'nocofeed.askAnswer';
const RUNNER_POLL_MS = 5_000;

/**
 * Markdown the agent wrote. Raw HTML is dropped and there are no images; links are the sources it cites and open in a
 * new tab without telling the site where they came from.
 */
export function AskMarkdown({ text }: { readonly text: string }): ReactElement {
  const components: Components = {
    p: ({ children }) => <p className='leading-7'>{children}</p>,
    ul: ({ children }) => (
      <ul className='flex list-disc flex-col gap-1 ps-5 marker:text-muted-foreground'>
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className='flex list-decimal flex-col gap-1 ps-5 marker:text-muted-foreground'>
        {children}
      </ol>
    ),
    li: ({ children }) => <li className='leading-7'>{children}</li>,
    strong: ({ children }) => (
      <strong className='font-semibold text-foreground'>{children}</strong>
    ),
    blockquote: ({ children }) => (
      <blockquote className='border-s-2 ps-3 text-muted-foreground'>
        {children}
      </blockquote>
    ),
    h1: ({ children }) => <p className='font-semibold'>{children}</p>,
    h2: ({ children }) => <p className='font-semibold'>{children}</p>,
    h3: ({ children }) => <p className='font-semibold'>{children}</p>,
    a: ({ href, children }) =>
      href ? (
        <a
          href={href}
          target='_blank'
          rel='noopener noreferrer'
          className='text-primary underline underline-offset-2 break-all hover:no-underline'
        >
          {children}
        </a>
      ) : (
        <span>{children}</span>
      ),
    code: ({ children }) => (
      <code className='rounded bg-muted px-1 text-[0.85em]'>{children}</code>
    ),
    pre: ({ children }) => (
      <pre className='overflow-x-auto rounded-md bg-muted p-2 text-xs'>
        {children}
      </pre>
    ),
    img: () => null,
  };
  return (
    <div className='flex flex-col gap-2 text-sm break-words text-foreground'>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url, key) =>
          key === 'href' && /^https?:\/\//i.test(url) ? url : ''
        }
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

type Part = AppUIMessage['parts'][number];

interface Source {
  readonly title: string;
  readonly url: string;
}

/** The pages a web search found, from the tool's public output. */
function searchSources(output: unknown): Source[] {
  const results = (output as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const sources: Source[] = [];
  for (const result of results as { sources?: unknown }[]) {
    if (!Array.isArray(result.sources)) continue;
    for (const source of result.sources as Partial<Source>[]) {
      if (
        typeof source.url === 'string' &&
        /^https?:\/\//i.test(source.url) &&
        !sources.some((known) => known.url === source.url)
      )
        sources.push({ url: source.url, title: source.title || source.url });
    }
  }
  return sources;
}

function ToolLine({ part }: { readonly part: Part }): ReactElement | null {
  const { t } = useTranslation();
  const done = 'state' in part && part.state === 'output-available';
  if (part.type === 'tool-feed_read_item')
    return (
      <p className='flex items-center gap-1.5 text-xs text-muted-foreground'>
        <BotIcon className='size-3.5' aria-hidden />
        {t('feed.ask.tools.readItem')}
      </p>
    );
  if (part.type === 'tool-feed_read_original')
    return (
      <p className='flex items-center gap-1.5 text-xs text-muted-foreground'>
        <GlobeIcon className='size-3.5' aria-hidden />
        {t('feed.ask.tools.readOriginal')}
      </p>
    );
  if (part.type === 'tool-webSearch') {
    const sources = done
      ? searchSources((part as { output?: unknown }).output)
      : [];
    return (
      <div className='flex flex-col gap-1 text-xs text-muted-foreground'>
        <p className='flex items-center gap-1.5'>
          <SearchIcon className='size-3.5' aria-hidden />
          {done ? t('feed.ask.tools.searched') : t('feed.ask.tools.searching')}
        </p>
        {sources.length ? (
          <ul className='flex flex-col gap-0.5 ps-5'>
            {sources.slice(0, 8).map((source) => (
              <li key={source.url} className='truncate'>
                <a
                  href={source.url}
                  target='_blank'
                  rel='noopener noreferrer'
                  className='text-primary hover:underline'
                >
                  {source.title}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  return null;
}

function NoticeBlock({
  notice,
  agentName,
}: {
  readonly notice: { type: string; params?: Record<string, string> };
  readonly agentName: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const params = notice.params ?? {};
  if (notice.type === QUEUED_NOTICE)
    return (
      <div className='flex flex-col items-end gap-1'>
        <p className='text-xs text-muted-foreground'>
          {t('feed.ask.runner.asked', { agent: agentName })}
        </p>
        <p className='max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground'>
          {params.question}
        </p>
      </div>
    );
  if (notice.type === ANSWER_NOTICE)
    return (
      <div className='flex flex-col gap-1.5 rounded-lg border bg-muted/40 p-3'>
        <p className='flex items-center gap-1.5 text-xs font-medium text-muted-foreground'>
          <BotIcon className='size-3.5' aria-hidden />
          {t('feed.ask.runner.answered', { agent: agentName })}
        </p>
        {params.status === 'completed' && params.answer ? (
          <AskMarkdown text={params.answer} />
        ) : (
          <p className='text-sm text-muted-foreground'>
            {t('feed.ask.runner.failed')}
          </p>
        )}
      </div>
    );
  return null;
}

function MessageView({
  message,
  agentName,
}: {
  readonly message: AppUIMessage;
  readonly agentName: string;
}): ReactElement | null {
  if (message.role === 'user') {
    const text = message.parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    return (
      <div className='flex justify-end'>
        <p className='max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground'>
          {text}
        </p>
      </div>
    );
  }
  const blocks = message.parts.map((part, index) => {
    const key = `${message.id}:${index}`;
    if (part.type === 'text')
      return part.text.trim() ? (
        <AskMarkdown key={key} text={part.text} />
      ) : null;
    if (part.type === 'data-notice')
      return <NoticeBlock key={key} notice={part.data} agentName={agentName} />;
    if (part.type.startsWith('tool-'))
      return <ToolLine key={key} part={part} />;
    return null;
  });
  if (!blocks.some(Boolean)) return null;
  return <div className='flex flex-col gap-2'>{blocks}</div>;
}

interface ChatProps {
  readonly itemId: number;
  readonly conversationId: string;
  readonly history: AppUIMessage[];
  readonly chatApi: ChatApi;
  readonly state: AskState;
  /** The first question, asked before the conversation existed; sent once on mount. */
  readonly firstQuestion: string | null;
  readonly onFirstSent: () => void;
  readonly onStateChanged: () => void;
  readonly onCleared: () => void;
  readonly agentName: string;
}

function AskChat({
  itemId,
  conversationId,
  history,
  chatApi,
  state,
  firstQuestion,
  onFirstSent,
  onStateChanged,
  onCleared,
  agentName,
}: ChatProps): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const transport = useMemo(
    () => chatApi.transport(conversationId, () => undefined),
    [chatApi, conversationId],
  );
  const { messages, sendMessage, status, stop, setMessages, error } =
    useChat<AppUIMessage>({ id: conversationId, messages: history, transport });
  const [draft, setDraft] = useState('');
  const [runnerBusy, setRunnerBusy] = useState(false);
  const [problem, setProblem] = useState<RequestProblem>();
  const [clearing, setClearing] = useState(false);
  const sentFirstRef = useRef(false);
  const busy = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    if (!firstQuestion || sentFirstRef.current) return;
    sentFirstRef.current = true;
    onFirstSent();
    void sendMessage({ text: firstQuestion });
  }, [firstQuestion, onFirstSent, sendMessage]);

  const reload = useCallback(async () => {
    const page = await chatApi.messages(conversationId);
    setMessages([...page.items]);
  }, [chatApi, conversationId, setMessages]);

  // A question with the runner agent: look again now and then until its answer is in the conversation.
  useEffect(() => {
    if (!state.runnerPending) return;
    const timer = setInterval(() => {
      if (busy) return;
      void reload()
        .then(onStateChanged)
        .catch(() => undefined);
    }, RUNNER_POLL_MS);
    return () => clearInterval(timer);
  }, [busy, onStateChanged, reload, state.runnerPending]);

  const send = (event?: FormEvent): void => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    setProblem(undefined);
    void sendMessage({ text });
  };

  const askRunner = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || busy || runnerBusy) return;
    setRunnerBusy(true);
    setProblem(undefined);
    try {
      await api.request({
        path: `feedItems/${encodeURIComponent(itemId)}/ask/runner`,
        method: 'POST',
        json: { question: text },
      });
      setDraft('');
      await reload();
      onStateChanged();
    } catch (cause) {
      setProblem(requestProblem(cause));
    } finally {
      setRunnerBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      send();
    }
  };

  const visible = messages.filter((message) => message.role !== 'system');
  const lastIsUser = visible.at(-1)?.role === 'user';

  return (
    <div className='flex flex-col gap-3'>
      {visible.length ? (
        <div
          className='flex flex-col gap-3'
          aria-live='polite'
          data-testid='feed-ask-messages'
        >
          {visible.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              agentName={agentName}
            />
          ))}
          {busy && lastIsUser ? (
            <p className='flex items-center gap-2 text-xs text-muted-foreground'>
              <Spinner /> {t('feed.ask.thinking')}
            </p>
          ) : null}
          {state.runnerPending ? (
            <p className='flex items-center gap-2 text-xs text-muted-foreground'>
              <Spinner /> {t('feed.ask.runner.pending', { agent: agentName })}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role='alert' className='text-sm text-destructive'>
          {t('feed.ask.failed')}
        </p>
      ) : null}
      {problem === 'sessionExpired' ? (
        <SessionExpiredAlert />
      ) : problem ? (
        <p role='alert' className='text-sm text-destructive'>
          {problem === 'busy'
            ? t('feed.ask.runner.busy', { agent: agentName })
            : problem === 'unavailable'
              ? t('feed.ask.unavailable.title')
              : t(`feed.errors.${problem}`)}
        </p>
      ) : null}

      <form className='flex flex-col gap-2' onSubmit={send}>
        <Textarea
          aria-label={t('feed.ask.placeholder')}
          placeholder={t('feed.ask.placeholder')}
          value={draft}
          rows={2}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className='flex flex-wrap items-center gap-2'>
          {busy ? (
            <Button
              type='button'
              size='sm'
              variant='outline'
              onClick={() => {
                void stop();
                void chatApi.stop(conversationId).catch(() => undefined);
              }}
            >
              <SquareIcon data-icon='inline-start' />
              {t('feed.ask.stop')}
            </Button>
          ) : (
            <Button type='submit' size='sm' disabled={!draft.trim()}>
              <SendIcon data-icon='inline-start' />
              {t('feed.ask.send')}
            </Button>
          )}
          {state.runnerAgentId ? (
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={
                !draft.trim() || busy || runnerBusy || state.runnerPending
              }
              onClick={() => void askRunner()}
            >
              {runnerBusy ? (
                <Spinner data-icon='inline-start' />
              ) : (
                <BotIcon data-icon='inline-start' />
              )}
              {t('feed.ask.runner.action', { agent: agentName })}
            </Button>
          ) : null}
          {visible.length ? (
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='ms-auto'
              disabled={busy}
              onClick={() => setClearing(true)}
            >
              <Trash2Icon data-icon='inline-start' />
              {t('feed.ask.clear')}
            </Button>
          ) : null}
        </div>
        {state.webSearch ? (
          <p className='text-xs text-muted-foreground'>
            {t('feed.ask.webSearch')}
          </p>
        ) : null}
      </form>

      <DeleteDialog
        open={clearing}
        onOpenChange={setClearing}
        target={{
          name: conversationId,
          path: `feedItems/${encodeURIComponent(itemId)}/ask`,
        }}
        title={t('feed.ask.clearTitle')}
        description={t('feed.ask.clearDescription')}
        successTitle={t('feed.ask.cleared')}
        onDeleted={() => {
          setClearing(false);
          onCleared();
        }}
      />
    </div>
  );
}

/** Before the first question: the composer alone, which opens the conversation and hands the question to it. */
function FirstQuestion({
  itemId,
  onOpened,
  runnerAgentName,
  onRunnerAsked,
}: {
  readonly itemId: number;
  readonly onOpened: (conversationId: string, question: string) => void;
  /** Set when the person's runner agent can take a question. */
  readonly runnerAgentName: string | null;
  readonly onRunnerAsked: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<RequestProblem>();

  const send = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || pending) return;
    setPending(true);
    setProblem(undefined);
    try {
      const { data } = await api.request<{
        data: { conversationId: string };
      }>({
        path: `feedItems/${encodeURIComponent(itemId)}/ask`,
        method: 'POST',
      });
      onOpened(data.conversationId, text);
    } catch (cause) {
      setProblem(requestProblem(cause));
      setPending(false);
    }
  };

  const askRunner = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || pending) return;
    setPending(true);
    setProblem(undefined);
    try {
      await api.request({
        path: `feedItems/${encodeURIComponent(itemId)}/ask/runner`,
        method: 'POST',
        json: { question: text },
      });
      onRunnerAsked();
    } catch (cause) {
      setProblem(requestProblem(cause));
      setPending(false);
    }
  };

  return (
    <form
      className='flex flex-col gap-2'
      onSubmit={(event) => void send(event)}
    >
      <Textarea
        aria-label={t('feed.ask.placeholder')}
        placeholder={t('feed.ask.placeholder')}
        value={draft}
        rows={2}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            void send();
          }
        }}
      />
      {problem === 'sessionExpired' ? (
        <SessionExpiredAlert />
      ) : problem ? (
        <p role='alert' className='text-sm text-destructive'>
          {problem === 'unavailable'
            ? t('feed.ask.unavailable.title')
            : t(`feed.errors.${problem}`)}
        </p>
      ) : null}
      <div className='flex flex-wrap items-center gap-2'>
        <Button type='submit' size='sm' disabled={!draft.trim() || pending}>
          {pending ? (
            <Spinner data-icon='inline-start' />
          ) : (
            <SendIcon data-icon='inline-start' />
          )}
          {t('feed.ask.send')}
        </Button>
        {runnerAgentName ? (
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={!draft.trim() || pending}
            onClick={() => void askRunner()}
          >
            <BotIcon data-icon='inline-start' />
            {t('feed.ask.runner.action', { agent: runnerAgentName })}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * "Ask about this item" on the item detail: a conversation with the online agent about this item, kept per person and
 * item by the Agents plugin, with an optional hand-off to the person's runner agent for a deeper look.
 */
export function AskSection({
  itemId,
}: {
  readonly itemId: number;
}): ReactElement | null {
  const { t } = useTranslation();
  const agentOptions = useAgentOptions();
  const api = useApiClient();
  const chatApi = useMemo(() => new ChatApi(api), [api]);
  const [reloadCount, setReloadCount] = useState(0);
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly state?: AskState;
    readonly history?: AppUIMessage[];
    readonly failed?: boolean;
  }>();
  const [first, setFirst] = useState<{
    readonly conversationId: string;
    readonly question: string | null;
  } | null>(null);
  const key = `${itemId}:${reloadCount}`;

  useEffect(() => {
    let current = true;
    const load = async () => {
      const { data } = await api.request<{ data: AskState }>({
        path: `feedItems/${encodeURIComponent(itemId)}/ask`,
      });
      const history = data.conversationId
        ? [...(await chatApi.messages(data.conversationId)).items]
        : [];
      return { state: data, history };
    };
    load().then(
      (result) => {
        if (current)
          setLoaded((previous) => ({
            ...previous,
            key,
            ...result,
            failed: false,
          }));
      },
      () => {
        if (current) setLoaded({ key, failed: true });
      },
    );
    return () => {
      current = false;
    };
  }, [api, chatApi, itemId, key]);

  const refreshState = useCallback(() => {
    void api
      .request<{ data: AskState }>({
        path: `feedItems/${encodeURIComponent(itemId)}/ask`,
      })
      .then(
        ({ data }) =>
          setLoaded((previous) =>
            previous ? { ...previous, state: data } : previous,
          ),
        () => undefined,
      );
  }, [api, itemId]);

  // The question goes once; the conversation it opened stays until the section reloads.
  const onFirstSent = useCallback(
    () =>
      setFirst((previous) =>
        previous ? { ...previous, question: null } : previous,
      ),
    [],
  );

  const heading = (
    <h3
      id='feed-ask'
      className='flex items-center gap-1.5 text-sm font-semibold'
    >
      <MessageCircleQuestionIcon className='size-4' aria-hidden />
      {t('feed.ask.title')}
    </h3>
  );

  // Nothing to show when the section could not be read: the rest of the item still is.
  if (loaded?.failed) return null;
  if (!loaded?.state)
    return (
      <section aria-labelledby='feed-ask' className='flex flex-col gap-2'>
        {heading}
        <Skeleton className='h-16 w-full' />
      </section>
    );
  const { state } = loaded;
  const conversationId = first?.conversationId ?? state.conversationId;
  const runner =
    (state.runnerAgentId && agentOptions.nameOf(state.runnerAgentId)) ||
    t('feed.ask.runner.generic');
  const reloadAll = () => {
    setFirst(null);
    setLoaded(undefined);
    setReloadCount((count) => count + 1);
  };

  return (
    <section
      aria-labelledby='feed-ask'
      className='flex flex-col gap-3'
      data-testid='feed-ask'
    >
      {heading}
      {!state.online && !conversationId ? (
        <Alert>
          <AlertTitle>{t('feed.ask.unavailable.title')}</AlertTitle>
          <AlertDescription className='flex flex-col gap-1'>
            <span>{t('feed.ask.unavailable.description')}</span>
            <span className='flex flex-wrap gap-3'>
              <Link
                to='/settings/models'
                className='text-primary hover:underline'
              >
                {t('feed.ask.unavailable.models')}
              </Link>
              <Link to='/preferences' className='text-primary hover:underline'>
                {t('feed.ask.unavailable.preferences')}
              </Link>
            </span>
          </AlertDescription>
        </Alert>
      ) : conversationId ? (
        <AskChat
          key={conversationId}
          itemId={itemId}
          conversationId={conversationId}
          history={loaded.history ?? []}
          chatApi={chatApi}
          state={state}
          firstQuestion={first?.question ?? null}
          onFirstSent={onFirstSent}
          onStateChanged={refreshState}
          onCleared={reloadAll}
          agentName={runner}
        />
      ) : (
        <>
          <p className='text-sm text-muted-foreground'>{t('feed.ask.hint')}</p>
          <FirstQuestion
            itemId={itemId}
            onOpened={(id, question) => {
              setLoaded((previous) =>
                previous ? { ...previous, history: [] } : previous,
              );
              setFirst({ conversationId: id, question });
            }}
            runnerAgentName={state.runnerAgentId ? runner : null}
            onRunnerAsked={reloadAll}
          />
          {state.webSearch ? (
            <p className='text-xs text-muted-foreground'>
              {t('feed.ask.webSearch')}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
