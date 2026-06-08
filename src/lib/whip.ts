export const DEFAULT_WHIP_CRACK_SPEED = 240;

export const DEFAULT_WHIP_PHRASES = [
  '快点干活，别磨蹭。',
  '再慢鞭子又要响了。',
  'Go Work!!',
  '再偷懒我就断你token😡',
];

export function normalizeWhipPhrases(value: string[] | undefined | null) {
  const phrases = (value ?? [])
    .map((phrase) => phrase.trim())
    .filter(Boolean)
    .slice(0, 20);
  return phrases.length > 0 ? phrases : DEFAULT_WHIP_PHRASES;
}
