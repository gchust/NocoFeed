import fileUi from '../extensions/nocobase-file-component-ui/locales/en-US.js';
import type { LocaleResource } from '@nocobase/i18n';

import systemEnUS from './system/en-US.js';

const enUS = {
  // The template's own copy: the shell, the sign-in pages, shared components and the homepage. Keep it in
  // `./system/` so a template upgrade can replace it without touching the application's copy below.
  ...systemEnUS,
  ...fileUi,
  // The application's copy goes here, one group per feature. A shared group such as `navigation` is extended by
  // spreading the system one first, `navigation: { ...systemEnUS.navigation, orders: 'Orders' }`, since a group
  // written here replaces the system group of the same name rather than merging with it.
  'navigation.brandHome': 'NocoFeed home',
  navigation: {
    ...systemEnUS.navigation,
    feed: 'Feed',
    topics: 'Topics',
    sources: 'Subscriptions',
    runs: 'Runs',
    preferences: 'Interests & skills',
    models: 'AI models',
  },
  app: { ...systemEnUS.app, title: 'NocoFeed' },
  feed: {
    title: 'Feed',
    description:
      'What your subscriptions brought in, ranked by how well it matches your topics. Each item says what to join or learn, and on which material that judgement rests.',
    refresh: 'Refresh',
    listLabel: 'Items',
    loadMore: 'Load more',
    loading: 'Loading',
    searchPlaceholder: 'Search titles and summaries',
    searchLabel: 'Search the feed',
    scoreValue: 'Match {{score}}',
    views: {
      label: 'Views',
      digest: 'Today',
      all: 'All',
      discuss: 'Join in',
      learn: 'Learn',
      saved: 'Saved',
      later: 'Later',
      participated: 'Joined',
    },
    filters: {
      allPlatforms: 'All platforms',
      allTopics: 'All topics',
      platform: 'Platform',
      topic: 'Topic',
    },
    platforms: {
      reddit: 'Reddit',
      hn: 'Hacker News',
      rss: 'RSS',
      youtube: 'YouTube',
      bilibili: 'Bilibili',
      xiaohongshu: 'Xiaohongshu',
      x: 'X',
    },
    verdict: {
      pending: 'Not analysed',
      discuss: 'Join in',
      learn: 'Learn',
      ignore: 'Skip',
    },
    state: {
      favorite: 'Save',
      later: 'Later',
      participated: 'Joined',
      dismissed: 'Dismiss',
    },
    feedback: {
      helpful: 'Useful',
      irrelevant: 'Not relevant',
      adjustedDown: 'Ranking adjusted: similar items will rank lower',
      adjustedUp: 'Ranking adjusted: similar items will rank higher',
      adjustedDetail:
        'Words weighed: {{terms}}. Recent items re-scored: {{count}}.',
    },
    digest: {
      title: 'Today’s digest',
      description:
        'The three best discussions to join and the best thing to learn from, among what arrived in the last 24 hours. It is also sent to your inbox once a day.',
      settings: 'Digest settings',
      discuss: 'Worth joining',
      learn: 'Worth learning from',
      discussEmpty:
        'Nothing in the last 24 hours matched well enough to join in.',
      learnEmpty: 'Nothing in the last 24 hours stood out to learn from.',
    },
    followUp: {
      hint: 'Paste the link to your Hacker News or Reddit post and NocoFeed will check it for new replies for two weeks.',
      unsupported:
        'Replies are followed for Hacker News and Reddit links only.',
      pending: 'Following for replies; the first check is under way.',
      replies: '{{count}} replies so far',
      newReplies: '{{count}} new',
      checked: 'checked {{time}}',
      ended: 'no longer followed',
      open: 'Open your post',
      markSeen: 'Mark as seen',
    },
    density: {
      label: 'List density',
      comfortable: 'Cards',
      compact: 'Compact list',
    },
    shortcuts: {
      title: 'Keyboard shortcuts',
      description: 'Triage the feed without leaving the keyboard.',
      hint: 'Press ? for keyboard shortcuts',
      next: 'Next item',
      previous: 'Previous item',
      favorite: 'Save or unsave',
      later: 'Read later, or not',
      dismiss: 'Dismiss from the feed',
      open: 'Open the original',
      close: 'Close the item',
      help: 'Show this help',
      favoriteOn: 'Saved',
      favoriteOff: 'Removed from saved',
      laterOn: 'Added to Later',
      laterOff: 'Removed from Later',
      dismissed: 'Dismissed',
      undo: 'Undo',
    },
    health: {
      banner:
        'Subscriptions needing attention: {{count}}. They keep failing or have found nothing new for days.',
      review: 'Review',
    },
    levels: {
      high: 'High',
      medium: 'Medium',
      low: 'Low',
      strong: 'Strong',
      some: 'Some',
      none: 'None',
    },
    parts: {
      body: 'Body',
      comments: 'Comments',
      transcript: 'Transcript',
      media: 'Images & video',
    },
    coverage: {
      available: 'Read',
      partial: 'Partly read',
      missing: 'Missing',
      unavailable: 'Not available',
      notRequested: 'Not fetched',
      failed: 'Failed',
    },
    metrics: {
      points: 'Points',
      comments: 'Comments',
      views: 'Views',
      likes: 'Likes',
      parts: 'Parts',
    },
    status: {
      pending: 'Not run yet',
      running: 'Running',
      ok: 'OK',
      succeeded: 'Succeeded',
      partial: 'Partly done',
      failed: 'Failed',
      needsLogin: 'Needs sign-in',
      blocked: 'Blocked',
      rateLimited: 'Rate limited',
      unconfigured: 'Collector missing',
      unsupported: 'Not supported',
      analysisFailed: 'Analysis failed',
    },
    messages: {
      channelNotResolved: 'The channel could not be found.',
      notAFeed: 'The address is not an RSS or Atom feed.',
      collectorNotConfigured:
        'This needs the Docker Collector, which is not configured.',
      invalidChannel: 'Enter a channel id (UC…) or an @handle.',
      invalidSubreddit: 'Enter community names such as r/selfhosted.',
      invalidVideo: 'Enter a video link or id.',
      missingUrl: 'This item has no link to read from.',
      redditRssFallback:
        'Reddit refused the JSON listing, so the RSS feed was used: no vote or comment counts.',
      collectorUnauthorized:
        'The Collector refused the token. Check FEED_COLLECTOR_TOKEN.',
      collectorBusy: 'The Collector is busy; it will be retried.',
      loginRequired: 'Sign in to this platform in the Collector browser.',
      securityBlock:
        'The platform asked for a security check; handle it in the Collector browser.',
      browserUnavailable: 'The Collector browser is not ready.',
      timeout: 'Reading timed out.',
      toolError: 'The Collector could not read this.',
      toolMissing: 'The Collector is missing its reading tool.',
      invalidTarget:
        'The Collector did not accept this target. Check the keyword, account or link.',
      notFound: 'The content does not exist or was deleted.',
      upstreamError: 'The platform returned an error.',
      networkError: 'The platform could not be reached.',
      outputLimit: 'The response was too large.',
      unsupportedOperation: 'The Collector does not support this operation.',
      unsupportedPart: 'The Collector cannot read this part.',
      invalidResponse: 'The Collector returned an unrecognised result.',
    },
    notes: {
      commentsNotSupported: 'Comments are not read for this platform.',
      countsUnknown: 'Vote and comment counts are unknown.',
      descriptionOnly: 'Only the description was read.',
      feedContent: 'Full text from the feed.',
      feedHasNoComments: 'Feeds carry no comments.',
      feedSummaryOnly: 'Only the feed summary was read.',
      linkedArticleNotFetched: 'The linked article was not fetched.',
      mediaNotAnalyzed: 'Images and video are not analysed.',
      noComments: 'No comments yet.',
      redditRss: 'Read from the RSS feed.',
      titleOnly: 'Only the title was read.',
      titleOnlyPost: 'The post has no text, only a title or link.',
      topLevel: '{{shown}} of {{total}} top-level comments read.',
      noTranscript: 'No subtitles are available.',
      commentsNotLoaded: 'The page shows comments, but the list did not load.',
      topLevelRead: '{{shown}} top-level comments read.',
      needsLogin: 'The platform requires sign-in.',
      blocked: 'The platform refused the request.',
      rateLimited: 'The platform is rate limiting; try later.',
      unconfigured: 'Needs the Docker Collector.',
      unsupported: 'Not supported for this platform.',
      failed: 'Fetching failed.',
    },
    errors: {
      sessionExpired: 'Your session has ended. Sign in again to continue.',
      notFound: 'This no longer exists. It may have been deleted.',
      forbidden: 'You do not have permission to do this.',
      invalid: 'Some input was not accepted. Check it and try again.',
      busy: 'This subscription is already running. Wait for it to finish.',
      unavailable:
        'The platform or the Collector could not provide this right now.',
      failed: 'The request failed. Please try again.',
    },
    common: {
      signInAgain: 'Sign in again',
      sessionExpired: 'Your session has ended. Sign in again to continue.',
      retry: 'Retry',
      saving: 'Saving…',
      create: 'Create',
      edit: 'Edit',
      delete: 'Delete',
      alreadyDeleted: 'It had already been deleted.',
      listSeparator: ', ',
      colon: ': ',
    },
    validation: { tooLong: 'Use at most {{max}} characters.' },
    empty: {
      title: 'Nothing here yet',
      description:
        'Add a subscription and run it; new items appear here, analysed against your topics.',
      filteredTitle: 'No matching items',
      filteredDescription: 'Try another view, platform, topic or search.',
      clear: 'Clear filters',
      addSource: 'Add a subscription',
    },
    detail: {
      label: 'Item details',
      placeholder:
        'Choose an item to see why it was picked and how to act on it.',
      close: 'Close details',
      openOriginal: 'Open original',
      analysis: 'Analysis',
      reanalyze: 'Analyse again',
      stale:
        'More material was fetched after this analysis. Analyse again to use it.',
      lead: {
        discuss: 'Where you could join in',
        learn: 'What to take away',
        ignore: 'Why it is skipped',
      },
      interest: 'Interest match',
      experience: 'Your experience',
      steps: 'Next steps',
      evidence: 'Based on',
      uncertainty: 'Not certain',
      byModel: 'Analysed by {{model}}',
      byRules:
        'Analysed by keyword rules (no model configured or budget used up)',
      noAnalysis: 'Not analysed yet.',
      coverage: 'Material read',
      coverageHint:
        'The analysis only knows what was read. Missing parts are stated, never guessed.',
      fetch: 'Fetch {{parts}}',
      analyzed: 'Analysed again.',
      enriched: 'Fetched {{parts}}. Analyse again to use it.',
      enrichEmpty: 'No new {{parts}} could be fetched.',
      enrichFailed: 'Could not fetch {{parts}} now.',
      comments: 'Comments read ({{count}})',
      showMore: 'Show more',
      showLess: 'Show less',
      feedbackQuestion: 'Was this judgement useful?',
    },
    record: {
      title: 'Your notes',
      notes: 'Notes',
      notesPlaceholder: 'What you learned, or want to come back to',
      participationUrl: 'Your reply or post',
      urlInvalid: 'Enter an address starting with http:// or https://.',
      participationNote: 'What you contributed',
      participationNotePlaceholder: 'A line on what you said or did',
      save: 'Save notes',
      saved: 'Notes saved.',
    },
  },
  topics: {
    title: 'Topics',
    description:
      'What you want to follow, and whether you want to join discussions, learn, or both. Every item is matched against these.',
    create: 'New topic',
    edit: 'Edit topic',
    formDescription:
      'Describe the goal in plain words; the analysis matches items against it.',
    actionsFor: 'Actions for {{name}}',
    sources: 'Subscriptions:',
    allSources: 'all subscriptions',
    openFeed: 'Show this topic in the feed',
    noSources: 'No subscriptions yet. The topic applies to all of them.',
    empty: {
      title: 'No topics yet',
      description:
        'Without topics, items are matched against your interests only.',
    },
    fields: {
      name: 'Name',
      goal: 'Goal',
      avoid: 'Avoid',
      mode: 'What you want from it',
      sources: 'Subscriptions',
    },
    modes: { both: 'Both', participate: 'Join in', learn: 'Learn' },
    modeHints: {
      both: 'Join where you can help, learn otherwise.',
      participate: 'Look for discussions you can contribute to.',
      learn: 'Collect what is worth learning.',
    },
    placeholders: {
      name: 'Agent engineering',
      goal: 'Practical experience building LLM agents: tool use, evaluation, memory',
      avoid: 'Funding news, hype threads',
    },
    hints: {
      goal: 'The words in the goal decide what matches.',
      sources: 'Choose none to apply the topic to every subscription.',
    },
    validation: {
      nameRequired: 'Enter a name.',
      goalRequired: 'Describe the goal.',
    },
    created: 'Topic “{{name}}” created.',
    saved: 'Topic “{{name}}” saved.',
    delete: {
      title: 'Delete topic “{{name}}”?',
      description:
        'Items already analysed keep their analysis. The topic is no longer used for new items.',
      success: 'Topic “{{name}}” deleted.',
    },
  },
  sources: {
    health: {
      failing: '{{count}} failed runs in a row',
      quiet: 'Nothing new in {{count}} runs',
    },
    title: 'Subscriptions',
    description:
      'Where items come from and how often they are checked. Each run reads only what is new since the last one.',
    create: 'New subscription',
    edit: 'Edit subscription',
    formDescription:
      'Choose a platform and what to follow. Platforms marked “Collector” need the Docker Collector.',
    running: 'Running “{{name}}”…',
    runDone: '“{{name}}”: {{found}} found, {{inserted}} new.',
    runProblem: '“{{name}}”: {{status}}.',
    resumed: '“{{name}}” resumed.',
    paused: '“{{name}}” paused.',
    runNow: 'Run now',
    actionsFor: 'Actions for {{name}}',
    activeFor: 'Run {{name}} on schedule',
    unavailable: 'Unavailable',
    columns: {
      name: 'Subscription',
      frequency: 'Every',
      status: 'Status',
      lastRun: 'Last run',
      nextRun: 'Next run',
      active: 'On',
      actions: 'Actions',
    },
    frequency: {
      minutes: '{{count}} min',
      hours: '{{count}} h',
      days: '{{count}} d',
    },
    implementation: { native: 'Built in', collector: 'Collector' },
    operations: {
      reddit: { community: 'New posts in communities' },
      hn: { new: 'New stories', ask: 'Ask HN', show: 'Show HN' },
      rss: { feed: 'Feed' },
      youtube: {
        channel: 'Channel uploads',
        keyword: 'Search',
        video: 'One video',
      },
      bilibili: { keyword: 'Search', video: 'One video' },
      xiaohongshu: { keyword: 'Search', post: 'One note' },
      x: { keyword: 'Search', account: 'Account posts', post: 'One post' },
    },
    capabilities: {
      newPosts: 'new posts',
      selftext: 'post text',
      counts: 'votes and comment counts',
      newStories: 'new stories',
      askStories: 'Ask HN stories',
      showStories: 'Show HN stories',
      text: 'text',
      feedEntries: 'feed entries',
      summaryOrContent: 'summary or full text',
      channelUploads: 'channel uploads',
      description: 'description',
      searchCandidates: 'search results',
      transcriptOnDemand: 'transcript on request',
      videoMetadata: 'video details',
      transcriptIfAvailable: 'transcript when available',
      videoInfo: 'video info',
      firstPartSubtitles: 'subtitles of the first part',
      noteText: 'note text',
      loadedComments: 'loaded comments',
      threadOnDemand: 'thread on request',
      accountPosts: 'account posts',
      postThread: 'post and thread',
    },
    targets: {
      reddit: { community: 'Communities' },
      rss: { feed: 'Feed address' },
      youtube: {
        channel: 'Channel',
        keyword: 'Search words',
        video: 'Video link',
      },
      bilibili: { keyword: 'Search words', video: 'Video link or BV id' },
      xiaohongshu: { keyword: 'Search words', post: 'Note link' },
      x: { keyword: 'Search words', account: 'Account', post: 'Post link' },
    },
    targetPlaceholders: {
      reddit: { community: 'r/selfhosted r/LocalLLaMA' },
      rss: { feed: 'https://simonwillison.net/atom/everything/' },
      youtube: {
        channel: '@AndrejKarpathy or UC…',
        keyword: 'local llm agents',
        video: 'https://www.youtube.com/watch?v=…',
      },
      bilibili: { keyword: 'AI Agent', video: 'BV1…' },
      xiaohongshu: {
        keyword: '独立开发',
        post: 'https://www.xiaohongshu.com/explore/…',
      },
      x: {
        keyword: 'mcp server',
        account: '@simonw',
        post: 'https://x.com/…/status/…',
      },
    },
    fields: {
      platform: 'Platform',
      operation: 'Follow',
      target: 'Target',
      name: 'Name',
      frequency: 'Check every',
      candidateLimit: 'Items per run',
      topics: 'Topics',
    },
    placeholders: { name: 'HN new stories' },
    hints: {
      experimental: 'Experimental: may break when the platform changes.',
      needsLogin: 'Needs a signed-in session in the Collector.',
      collectorNeeded:
        'The Docker Collector is not configured, so this subscription will wait until it is.',
      candidateLimit: 'At most this many items are read per run (1–100).',
      topics:
        'Items from this subscription are matched against these topics; none means all topics.',
    },
    validation: {
      operationRequired: 'Choose what to follow.',
      nameRequired: 'Enter a name.',
      candidates: 'Enter a whole number from 1 to 100.',
      targetRequired: 'Enter what to follow.',
      targetLength: 'Enter {{min}}–{{max}} characters, not starting with “-”.',
      rejected:
        'The platform, target or schedule was not accepted. Check them and try again.',
    },
    created: 'Subscription “{{name}}” created.',
    createdHint: 'It runs on its schedule; use “Run now” to fetch right away.',
    saved: 'Subscription “{{name}}” saved.',
    empty: {
      title: 'No subscriptions yet',
      description:
        'Start with Hacker News, an RSS feed or a Reddit community; they work without any setup.',
    },
    notice: {
      modelTitle: 'Analysis uses keyword rules',
      modelDescription:
        'No AI model is configured, so items are matched by keywords. An administrator can add one under System settings → AI models.',
      collectorTitle: 'Collector not configured',
      collectorDescription:
        'YouTube and Bilibili search, Xiaohongshu and X need the Docker Collector (FEED_COLLECTOR_URL). Built-in platforms work without it.',
    },
    delete: {
      title: 'Delete subscription “{{name}}”?',
      description:
        'It stops running. Items it already brought in stay in your feed.',
      success: 'Subscription “{{name}}” deleted.',
    },
  },
  runs: {
    title: 'Runs',
    description:
      'Every fetch and analysis, with what it found and how complete it was.',
    statsLabel: 'Last 24 hours',
    stats: {
      found: 'Found (24 h)',
      inserted: 'New (24 h)',
      analyzed: 'Analysed (24 h)',
      failed: 'Failed (24 h)',
    },
    empty: {
      title: 'No runs yet',
      description: 'Runs appear here once a subscription has been checked.',
    },
    columns: {
      startedAt: 'Started',
      source: 'Subscription',
      stage: 'Step',
      status: 'Status',
      found: 'Found',
      inserted: 'New',
      analyzed: 'Analysed',
      coverage: 'Completeness',
    },
    openItem: 'Open item',
    stages: { collect: 'Fetch', enrich: 'Fetch more', analyze: 'Analyse' },
    triggers: { schedule: 'Scheduled', manual: 'Manual' },
    coverage: {
      baseline: 'First run: nothing earlier to compare',
      complete: 'Complete: reached items seen before',
      partial: 'Cut off: some items may have been missed',
      single: 'One tracked item re-read',
    },
  },
  preferences: {
    title: 'Interests & skills',
    description:
      'What you care about and what you know. The analysis uses this to decide where you can join in and what is worth learning.',
    model: {
      ready: 'Analysing with {{model}}',
      readyDescription:
        'Items are analysed by the model up to your daily limit, then by keyword rules.',
      missing: 'No AI model configured',
      missingDescription:
        'Items are matched by keyword rules. An administrator can add a model under System settings → AI models.',
    },
    formTitle: 'Your profile',
    formDescription:
      'Plain sentences work best. Saved changes apply to items analysed from now on.',
    fields: {
      interests: 'Interests',
      expertise: 'Experience and skills',
      avoid: 'Avoid',
      dailyLimit: 'Model analyses per day',
      keepLearning: 'Keep items worth learning',
      digestEnabled: 'Daily digest',
      digestHour: 'Send after',
    },
    placeholders: {
      interests: 'LLM agents, self-hosting, databases',
      expertise:
        'Eight years of backend work in TypeScript and PostgreSQL; built an internal agent platform',
      avoid: 'Crypto, hiring threads',
    },
    hints: {
      interests: 'What you want to see more of.',
      expertise:
        'What you can speak to with authority; this decides where you are suggested to join in.',
      avoid: 'Items about these are pushed down.',
      dailyLimit:
        'Caps model cost. Beyond it, items are analysed by keyword rules. 0 never uses the model.',
      keepLearning:
        'When off, items you could only learn from are skipped, and the feed shows only where you can join in.',
      digestEnabled:
        'Once a day, your inbox gets the best three discussions and the best learning item of the last 24 hours. Days with nothing worth it send nothing.',
      digestHour: 'Your local time ({{zone}}).',
    },
    learned: {
      title: 'Learned from your feedback',
      description:
        '“Useful” makes these words count more, “Not relevant” less. They apply to every item analysed from now on.',
      clear: 'Forget all',
      cleared: 'Learned weights cleared.',
    },
    validation: { dailyLimit: 'Enter a whole number from 0 to 500.' },
    saved: 'Preferences saved.',
    savedHint: 'Use “Analyse again” on an item to apply them to it now.',
  },
};

/**
 * The shape every locale of this application follows, derived from the English wording above.
 *
 * Anything a plugin does not translate falls back to this namespace, so a term defined here is reused everywhere
 * without each plugin repeating it.
 */
export type AppResource = LocaleResource<typeof enUS>;

export default enUS;
