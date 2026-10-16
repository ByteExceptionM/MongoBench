import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatusBar, type StatusSummary } from './StatusBar'

type Paged = Extract<StatusSummary, { kind: 'paged' }>

const paged = (extra: Partial<Paged> = {}): Paged => ({
  kind: 'paged',
  count: 1000,
  countError: null,
  estimated: false,
  pageSize: 100,
  skip: 100,
  pageDocs: 100,
  busy: false,
  onJump: () => undefined,
  ...extra
})

const render = (summary: StatusSummary, loading = false): string =>
  renderToStaticMarkup(<StatusBar loading={loading} tookMs={12} summary={summary} />)

const disabledPagerButtons = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*>/g)]
    .filter((tag) => tag[0].includes('disabled=""'))
    .map((tag) => /aria-label="(\w+)"/.exec(tag[0])?.[1] ?? '?')

describe('StatusBar pager', () => {
  it('can page both ways from a middle page', () => {
    expect(disabledPagerButtons(render(paged()))).toEqual([])
  })

  it('locks every pager button while a page is loading', () => {
    expect(disabledPagerButtons(render(paged({ busy: true }), true))).toEqual([
      'First',
      'Prev',
      'Next',
      'Last'
    ])
  })
})

describe('StatusBar count', () => {
  it('names the count as unavailable once it failed', () => {
    const html = render(paged({ count: undefined, countError: '$where is not allowed' }))
    expect(html).toContain('count unavailable')
  })

  it('shows no count note while the count is still pending', () => {
    const html = render(paged({ count: undefined }), true)
    expect(html).not.toContain('count unavailable')
    expect(html).toContain('running…')
  })

  it('shows the total when the count is known', () => {
    expect(render(paged({ count: 999 }))).toContain('999 docs')
  })
})
