// Provider credentials in the host's shell would override subscription sign-ins and could leak
// into tool shells, so harness launches never inherit them. Claude Code's OAuth variables and
// credential-store override would put the host's login in place of the app's own.
const CREDENTIALS =
  /^(CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_OAUTH_REFRESH_TOKEN|CLAUDE_CODE_OAUTH_SCOPES|CLAUDE_SECURESTORAGE_CONFIG_DIR|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|CODEX_API_KEY|CURSOR_API_KEY|AZURE_OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|OPENROUTER_API_KEY|MISTRAL_API_KEY|GROQ_API_KEY|XAI_API_KEY|DEEPSEEK_API_KEY|TOGETHER_API_KEY|FIREWORKS_API_KEY|CEREBRAS_API_KEY|OPENCODE_API_KEY)$/i;
// Variables Electron sets for its own processes.
const ELECTRON = /^(ELECTRON_|CHROME_DESKTOP|ORIGINAL_XDG_CURRENT_DESKTOP)/i;

/** The host's environment for harness launches, minus provider credentials. */
export function launchEnvironment(
  host: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(host).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !CREDENTIALS.test(entry[0]) &&
        !ELECTRON.test(entry[0]),
    ),
  );
}
