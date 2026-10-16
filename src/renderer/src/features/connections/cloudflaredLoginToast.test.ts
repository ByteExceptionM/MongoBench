import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Action, ExternalToast } from 'sonner'
import { showCloudflaredLogin } from './cloudflaredLoginToast'

const { toast } = vi.hoisted(() => ({
  toast: {
    info: vi.fn((_title: string, _options: ExternalToast) => 'toast'),
    dismiss: vi.fn((_id: string) => 'toast')
  }
}))
vi.mock('sonner', () => ({ toast }))

const open = vi.fn()
const URL_A = 'https://mongo.example.com/cdn-cgi/access/cli?aud=a&token=1'

function lastToast(): { title: string; options: ExternalToast; action: Action } {
  const call = toast.info.mock.lastCall
  if (call === undefined) throw new Error('no toast was shown')
  const [title, options] = call
  return { title, options, action: options.action as Action }
}

const shownIds = () => toast.info.mock.calls.map(([, options]) => options.id)

function click(action: Action): { defaultPrevented: boolean } {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true
    }
  }
  action.onClick(event as unknown as Parameters<Action['onClick']>[0])
  return event
}

beforeEach(() => {
  toast.info.mockClear()
  toast.dismiss.mockClear()
  open.mockClear()
  vi.stubGlobal('window', { open })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('showCloudflaredLogin', () => {
  it('shows one toast per hostname that lasts as long as cloudflared waits', () => {
    showCloudflaredLogin({ hostname: 'mongo.example.com', state: 'waiting', url: URL_A })

    expect(toast.info).toHaveBeenCalledTimes(1)
    const { title, options, action } = lastToast()
    expect(title).toBe('Sign in to Cloudflare Access')
    expect(options).toMatchObject({
      id: 'cloudflared-login:mongo.example.com',
      duration: 10 * 60_000
    })
    expect(options.description).toContain('mongo.example.com')
    expect(action.label).toBe('Open again')
  })

  it('reopens the sign-in page without closing the toast', () => {
    showCloudflaredLogin({ hostname: 'mongo.example.com', state: 'waiting', url: URL_A })

    const event = click(lastToast().action)

    expect(open).toHaveBeenCalledWith(URL_A, '_blank')
    expect(event.defaultPrevented).toBe(true)
  })

  it('points the same toast at the newest sign-in URL', () => {
    const urlB = 'https://mongo.example.com/cdn-cgi/access/cli?aud=a&token=2'
    showCloudflaredLogin({ hostname: 'mongo.example.com', state: 'waiting', url: URL_A })
    showCloudflaredLogin({ hostname: 'mongo.example.com', state: 'waiting', url: urlB })

    expect(new Set(shownIds()).size).toBe(1)
    click(lastToast().action)
    expect(open).toHaveBeenCalledWith(urlB, '_blank')
  })

  it('keeps toasts of different hostnames apart', () => {
    showCloudflaredLogin({ hostname: 'a.example.com', state: 'waiting', url: URL_A })
    showCloudflaredLogin({ hostname: 'b.example.com', state: 'waiting', url: URL_A })

    expect(shownIds()).toEqual([
      'cloudflared-login:a.example.com',
      'cloudflared-login:b.example.com'
    ])
  })

  it('dismisses the toast of that hostname once the sign-in ends', () => {
    showCloudflaredLogin({ hostname: 'mongo.example.com', state: 'finished' })

    expect(toast.dismiss).toHaveBeenCalledWith('cloudflared-login:mongo.example.com')
    expect(toast.info).not.toHaveBeenCalled()
  })
})
