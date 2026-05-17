/**
 * Convert a canonical (forward-slash, per TERAX.md) absolute path to a
 * `file://` URI the language server expects.
 *
 * Cross-platform footgun, centralized here:
 *  - Windows drive paths (`C:/Users/x`) need a leading slash → `file:///C:/...`
 *  - segments are percent-encoded (spaces, unicode) but `/` and the drive
 *    `C:` token are preserved.
 */
export function pathToFileUri(p: string): string {
  let path = p.replace(/\\/g, "/");
  const isWinDrive = /^[A-Za-z]:\//.test(path);
  if (isWinDrive) path = `/${path}`;
  if (!path.startsWith("/")) path = `/${path}`;
  const encoded = path
    .split("/")
    .map((seg) =>
      // Keep the drive token "C:" intact — encodeURIComponent would
      // turn ":" into %3A and break the server's URI parsing.
      /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg),
    )
    .join("/");
  return `file://${encoded}`;
}
