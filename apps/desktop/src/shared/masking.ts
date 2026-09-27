// Masks credential-shaped strings in text that leaves the host for other room members.
// The placeholder contains a character outside every value class, so masking is idempotent.
const MASK = "•••";

const SECRET_WORD = String.raw`(?:key(?!board|word|stroke)|secret|token(?!iz)|passw(?:or)?d|pwd|credential|auth(?!or|entica))`;
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*${SECRET_WORD}[A-Za-z0-9_.-]*`;
const SCHEME = String.raw`(?:bearer|basic|token|negotiate|digest)`;
const PREFIXES = [
  "sk-ant-",
  "sk_live_",
  "rk_live_",
  "sk-",
  "whsec_",
  "gh[pousr]_",
  "github_pat_",
  "xox[abprs]-",
  "AKIA",
  "ASIA",
  "AIza",
  "sbp_",
  "sb_secret_",
  "npm_",
  "pypi-",
  "hf_",
].join("|");

type Rule = [RegExp, (match: string, ...groups: string[]) => string];
const keepGroup = (_match: string, kept: string) => kept + MASK;
const keepThree = (match: string) => match.slice(0, 3) + MASK;

// Ordered: blocks and whole tokens first, then header, query, and assignment values.
const RULES: Rule[] = [
  [
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
    () => MASK,
  ],
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    keepThree,
  ],
  [new RegExp(String.raw`\b(?:${PREFIXES})[A-Za-z0-9_-]{16,}`, "g"), keepThree],
  [/\b(?:ya29|SG)\.[A-Za-z0-9_.-]{16,}/g, keepThree],
  [/\bSK[0-9a-fA-F]{32}\b/g, keepThree],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, keepThree],
  [
    new RegExp(
      String.raw`\b((?:proxy-)?authorization[ \t]*:[ \t]*(?:${SCHEME}[ \t]+)?)(?!${SCHEME}\b)[^\s"'\\,;•]{8,}`,
      "gi",
    ),
    keepGroup,
  ],
  [/\b(bearer[ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi, keepGroup],
  [
    /\b((?:x-api-key|api-key|x-auth-token|x-access-token)[ \t]*:[ \t]*)[^\s"'\\,;•]+/gi,
    keepGroup,
  ],
  [/\b((?:set-)?cookie[ \t]*:[ \t]*)[^\s"'\\•][^\r\n"'\\•]*/gi, keepGroup],
  [
    /([?&](?:token|access_token|api_key|apikey|key|sig|signature|secret|password)=)[^&#\s"'\\•]+/gi,
    keepGroup,
  ],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/•]+(?=@)/gi, keepGroup],
  [/((?:^|\s)(?:-u|--user)[ \t]+[^\s:"']+:)[^\s"'•]+/g, keepGroup],
  [/((?:^|\s)--password[ \t]+)[^\s"'•-][^\s"'•]*/g, keepGroup],
  [
    /(?<![A-Za-z0-9_-])((?:password|passwd|pwd)[ \t]*=[ \t]*)[^\s;&"'\\•]+/gi,
    keepGroup,
  ],
  [
    new RegExp(
      String.raw`(?<![A-Za-z0-9_.-])(["']?${SECRET_NAME}["']?[ \t]*[:=][ \t]*["']?)(?!process\.env|os\.environ|env\.|\$|<)[^\s"'\\\`•:=>][^\s"'\\\`•]{7,}`,
      "gi",
    ),
    keepGroup,
  ],
];

export function maskCredentials(text: string): string {
  let masked = text;
  for (const [pattern, replace] of RULES)
    masked = masked.replace(pattern, replace);
  return masked;
}

// Tokens that start a shape whose secret arrives in a later token.
const SHAPE_STARTS = [
  /^(?:proxy-)?authorization:?$/i,
  new RegExp(String.raw`^${SCHEME}$`, "i"),
  /^(?:-h|--header|-p|--password|-u|--user)$/i,
  /^(?:x-api-key|api-key|x-auth-token|x-access-token|cookie|set-cookie):?$/i,
  new RegExp(
    String.raw`(?:^|[^A-Za-z0-9_.-])${SECRET_NAME}["']?[:=]["']?$`,
    "i",
  ),
];
const startsShape = (token: string) => {
  const bare = token.replace(/^["'([{]+/, "");
  return SHAPE_STARTS.some((shape) => shape.test(bare));
};

// The masked part of streaming text that no later text can change: whole whitespace-delimited
// tokens only, holding back a shape whose value is still arriving and an unfinished PEM header.
export function publishablePrefix(text: string): string {
  const end = text.search(/\s\S*$/);
  let prefix = /\s$/.test(text) ? text : end < 0 ? "" : text.slice(0, end + 1);
  const tokens = [...prefix.matchAll(/\S+/g)].slice(-3);
  const shape = tokens.find((token) => startsShape(token[0]));
  if (shape) prefix = prefix.slice(0, shape.index);
  const begin = prefix.lastIndexOf("-----BEGIN");
  // Cut back to the start of the token holding an unfinished header.
  if (begin >= 0 && !/^-----BEGIN [A-Z0-9 ]*-----/.test(prefix.slice(begin)))
    prefix = prefix.slice(0, prefix.slice(0, begin).search(/\S*$/));
  return maskCredentials(prefix);
}
