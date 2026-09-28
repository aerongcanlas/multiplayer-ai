/** Lenient readers for harness JSON: a missing or mistyped field reads as empty. */
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
export const clip = (text: string, limit = 400) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
