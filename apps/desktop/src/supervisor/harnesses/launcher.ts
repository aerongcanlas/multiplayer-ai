/** Test fixtures replace how a harness executable is launched. */
export type Launcher = (
  executable: string,
  args: string[],
  env: Record<string, string>,
) => { executable: string; args: string[]; env: Record<string, string> };

export const direct: Launcher = (executable, args, env) => ({
  executable,
  args,
  env,
});
