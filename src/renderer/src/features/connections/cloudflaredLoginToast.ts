import { toast } from 'sonner'
import type { CloudflaredLoginPrompt } from '@shared/events'

// cloudflared gives up on a sign-in after ten long polls of up to 60 s each.
const SIGN_IN_WINDOW_MS = 10 * 60_000

/** Explains why a browser window opened while connecting, with a way back to the sign-in page. */
export function showCloudflaredLogin(prompt: CloudflaredLoginPrompt): void {
  const id = `cloudflared-login:${prompt.hostname}`
  if (prompt.state === 'finished') {
    toast.dismiss(id)
    return
  }
  // Sign-ins that access tcp starts mid-session never report 'finished'; the duration bounds them.
  toast.info('Sign in to Cloudflare Access', {
    id,
    description: `cloudflared opened your browser to sign in to ${prompt.hostname}. MongoBench continues once you are done.`,
    duration: SIGN_IN_WINDOW_MS,
    action: {
      label: 'Open again',
      onClick: (event) => {
        // Keeps the toast: the sign-in is still pending and may need the page once more.
        event.preventDefault()
        window.open(prompt.url, '_blank')
      }
    }
  })
}
