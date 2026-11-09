import { describe, expect, it } from 'vitest'
import { cardBody, feishuCard } from '../src/sources/feishu-card.ts'

describe('Feishu card', () => {
  it('makes the reply a card message that carries its text', () => {
    const card = JSON.parse(feishuCard('收到，已经改成卡片回复。'))
    expect(card.schema).toBe('2.0')
    expect(card.header.title.content).toBe('superagent')
    expect(card.body.elements[0]).toEqual({ tag: 'markdown', content: '收到，已经改成卡片回复。' })
  })
  it('turns a heading into bold text, because a card heading is larger than a short reply', () => {
    expect(cardBody('# 一句话结论\n\n- 第一项')).toBe('**一句话结论**\n\n- 第一项')
  })
  it('turns an image into a link, because a card renders an image only from an uploaded key', () => {
    expect(cardBody('![图](https://example.com/a.png)')).toBe('[图](https://example.com/a.png)')
  })
})
