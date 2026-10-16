// ssh2 ships no types for its internals; only the list SshTunnelService reorders is declared.
declare module 'ssh2/lib/protocol/constants' {
  import type { ServerHostKeyAlgorithm } from 'ssh2'

  const constants: {
    /** ssh2's host key preference order; it lists `ssh-ed25519` only where the runtime supports it. */
    DEFAULT_SERVER_HOST_KEY: readonly ServerHostKeyAlgorithm[]
  }
  export = constants
}
