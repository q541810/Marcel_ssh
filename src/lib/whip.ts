export const DEFAULT_WHIP_CRACK_SPEED = 240;

export const DEFAULT_WHIP_PHRASES = [
  '快点干活，别磨蹭。',
  '再慢鞭子又要响了。',
  '别装死，继续。',
  '速度，别让我等。',
  '醒醒，该干活了。',
];

export function normalizeWhipPhrases(value: string[] | undefined | null) {
  const phrases = (value ?? [])
    .map((phrase) => phrase.trim())
    .filter(Boolean)
    .slice(0, 20);
  return phrases.length > 0 ? phrases : DEFAULT_WHIP_PHRASES;
}
