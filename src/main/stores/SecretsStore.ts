import { safeStorage } from 'electron'

/**
 * Wraps Electron's `safeStorage` (DPAPI on Windows) for symmetric
 * encryption of small secrets. Throws clearly if encryption is not
 * available on the host — we never silently fall back to plaintext.
 */
export class SecretsStore {
  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  encrypt(plaintext: string): string {
    if (!this.isAvailable()) {
      throw new Error(
        'safeStorage encryption is not available on this host; refusing to store secrets'
      )
    }
    return safeStorage.encryptString(plaintext).toString('base64')
  }

  decrypt(ciphertextBase64: string): string {
    if (!this.isAvailable()) {
      throw new Error(
        'safeStorage encryption is not available on this host; cannot decrypt stored secrets'
      )
    }
    return safeStorage.decryptString(Buffer.from(ciphertextBase64, 'base64'))
  }
}
