/** Feishu interactive card (Card 2.0) for a bot reply. */

/** The card's title bar: the bot's own name, so a card reads as the bot's message in the chat. */
const TITLE = 'superagent'

/**
 * The card body of a reply: its Markdown as a card's Markdown element. A card renders an image only from an
 * uploaded key, so an image in the reply becomes a link to it, and a heading becomes bold text, because a
 * card's own headings are larger than a short reply should look.
 */
export function cardBody(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '[$1]($2)')
    .replace(/^#{1,6}[ \t]+(.*)$/gm, '**$1**')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The Card 2.0 JSON of a reply, as the `content` of an `interactive` message. Feishu renders it as a card
 * message in the chat, the way the other bots of the group answer.
 */
export function feishuCard(text: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: { title: { tag: 'plain_text', content: TITLE }, template: 'blue' },
    body: { direction: 'vertical', elements: [{ tag: 'markdown', content: cardBody(text) }] },
  })
}
