const posix = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const powershell = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * A copy-ready command that signs OpenCode in to a hosted provider with the program the app
 * runs, quoted for zsh and bash, or for PowerShell. OpenCode keeps the login in the host's own
 * data folder, which its tabs use.
 */
export function loginCommand(
  executable: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform === "win32") return `& ${powershell(executable)} auth login`;
  return `${posix(executable)} auth login`;
}
