// Exact document matching also rejects lookalike hosts, subframes, and file traversal.
export function isTrustedDocument(
  candidate: string,
  expected: string,
): boolean {
  try {
    const actual = new URL(candidate);
    const trusted = new URL(expected);
    actual.hash = "";
    trusted.hash = "";
    return actual.href === trusted.href;
  } catch {
    return false;
  }
}

export function isLocalDevUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
