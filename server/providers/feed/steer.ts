/**
 * What the person asks for when they write again (issue #20): "another batch" of reply drafts, "regenerate" or "one
 * more" idea can carry a few angles picked from a short list and a free note ("more casual", "less polite", "as an
 * indie developer"). They go into the prompt as this round's own request, above the default rules but never above
 * "not misleading, not unfriendly". The steer a result was written with is stored beside it so the card can say so.
 *
 * Also here: the rules that keep generated text from reading like a model wrote it (`HUMAN_VOICE_*`), shared by
 * reply drafts and ideas.
 */

/** Angles for reply drafts; the client has a label for each. */
export const REPLY_ANGLES = [
  'askDetail',
  'experience',
  'pushBack',
  'addSource',
  'humor',
  'agree',
  'askHelp',
] as const;
export type ReplyAngle = (typeof REPLY_ANGLES)[number];

/** Directions for ideas. */
export const IDEA_ANGLES = [
  'downToEarth',
  'controversial',
  'shorter',
  'funnier',
  'newPersona',
] as const;
export type IdeaAngle = (typeof IDEA_ANGLES)[number];

/** A note is at most this many characters, after cleaning. */
export const STEER_NOTE_MAX = 500;

export interface Steer {
  readonly angles: string[];
  readonly note: string;
}

export interface SteerInput {
  readonly angles?: readonly string[] | null;
  readonly note?: string | null;
}

/** What each angle asks of the model; written for the model, so in English. */
const ANGLE_PROMPTS: Record<ReplyAngle | IdeaAngle, string> = {
  askDetail:
    'ask about a specific detail in the post (how exactly, what numbers, what setup)',
  experience:
    "share hands-on experience — only the person's own, from PERSON; if there is none that fits, write as someone curious instead of inventing a story",
  pushBack:
    'respectfully push back or play devil’s advocate on one concrete point',
  addSource:
    'add a relevant fact, link-worthy resource or reference the thread does not mention yet (only what you are sure of)',
  humor: 'be funny: a joke, a meme reference or wordplay that fits this crowd',
  agree:
    'a short agreement or +1 that adds one small specific thing, a line or two',
  askHelp:
    'ask the thread for help or advice on a related problem the person could plausibly have',
  downToEarth:
    'more down to earth: everyday words, concrete situations, no jargon or grand framing',
  controversial:
    'take a clear, debatable stance that invites argument (still fair and factual, no rage bait)',
  shorter: 'much shorter: cut everything that is not essential',
  funnier: 'funnier: more jokes, memes and playful lines',
  newPersona:
    'switch to a clearly different persona or point of view than the CREATOR STYLE usually takes',
};

/**
 * The person's note as it may go into a prompt: no tags, no control characters, no fence markers that could close the
 * block it sits in, runs of blank lines and spaces collapsed, at most `STEER_NOTE_MAX` characters.
 */
export function cleanNote(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value
    .normalize('NFC')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/<<<|>>>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return Array.from(text).slice(0, STEER_NOTE_MAX).join('').trim();
}

/** Keeps the known angles (in their list order, once each) and the cleaned note; null when nothing is left. */
export function normalizeSteer(
  input: SteerInput | null | undefined,
  allowed: readonly string[],
): Steer | null {
  if (!input) return null;
  const picked = new Set(input.angles ?? []);
  const angles = allowed.filter((angle) => picked.has(angle));
  const note = cleanNote(input.note);
  return angles.length || note ? { angles, note } : null;
}

/** A stored steer (JSON column) read back; anything malformed is null. */
export function storedSteer(
  value: unknown,
  allowed: readonly string[],
): Steer | null {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return normalizeSteer(parsed, allowed);
}

/**
 * The prompt block for this round's request. It comes after the defaults so it wins over them; the person's note is
 * their own words (trusted, like their rules), but it cannot make the text misleading or unfriendly.
 */
export function steerBlock(steer: Steer | null): string {
  if (!steer) return '';
  const lines = [
    "THIS ROUND (the person's own request for this rewrite; trusted)",
    'It takes priority over the default guidelines, style and angle suggestions above, except that the result must never be misleading, made up or unfriendly.',
  ];
  if (steer.angles.length)
    lines.push(
      `Directions they picked — cover these (spread them across the results when there are several): ${steer.angles
        .map(
          (angle) =>
            ANGLE_PROMPTS[angle as keyof typeof ANGLE_PROMPTS] ?? angle,
        )
        .join('; ')}.`,
    );
  if (steer.note) lines.push(`Their note:\n<<<\n${steer.note}\n>>>`);
  return `${lines.join('\n')}\n\n`;
}

/** Rules against the generic model voice, for replies people will post under their own name. */
export const HUMAN_VOICE_RULE = [
  'Sound like a real person typing a quick reply, not like an assistant:',
  '- No stock openers or closers: never "Great question", "Great point", "Love this", "As someone who…", "I\'d love to…", "This is a great…", "Thanks for sharing", "Hope this helps", "Happy to…", "Just my two cents", "In conclusion"; in Chinese no "作为一个…", "感谢分享", "总的来说", "希望对你有帮助", "说得太好了".',
  '- No tidy structure: no three-part lists or symmetrical "not only… but also", no summary or moral at the end, no restating the post before answering.',
  '- Do not overuse the em dash (—); at most one per reply. No exclamation-mark enthusiasm, no excessive politeness or hedging.',
  '- Vary the length a lot: one can be a single short line, another a few sentences. Not every reply needs a question.',
  "- Casual wording, contractions, sentence fragments and the platform's slang are fine; small imperfections are fine. Write the way regulars on this platform actually write.",
  '- Each reply takes a clearly different angle and opening; never start two replies the same way.',
].join('\n');

/** The same, for content the person publishes as their own. */
export const HUMAN_VOICE_IDEAS_RULE = [
  'Write like a real creator posting, not like an assistant:',
  '- No stock phrases: no "In today\'s fast-paced world", "Let\'s dive in", "game-changer", "Here\'s the thing", "Not only… but also", "In conclusion"; in Chinese no "在这个…的时代", "让我们一起", "总而言之", "不得不说", "宝子们" unless it truly fits.',
  '- No templated structure: avoid three-part lists by habit, symmetrical sentences and a tidy moral at the end. Do not overuse the em dash (—).',
  '- Vary length and rhythm; short punchy lines are welcome. Concrete details over adjectives.',
  "- Colloquial wording, the platform's own slang and small imperfections are fine, the way real people on that platform write.",
  '- Ideas of the same kind must differ clearly in angle and opening.',
].join('\n');
