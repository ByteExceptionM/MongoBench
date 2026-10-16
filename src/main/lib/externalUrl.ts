/** True when main may hand `url` to `shell.openExternal`, which starts whatever handles its scheme: https only. */
export function opensInBrowser(url: string): boolean {
  return URL.parse(url)?.protocol === 'https:'
}
