import type { SlashCommand } from "../../shared/tabs";
import { clip } from "./json";

/** A harness's commands as the prompt box shows them: named once, clipped, and bounded. */
export function slashCommands(
  reported: { name: string; description: string; argumentHint?: string }[],
): SlashCommand[] {
  const commands = new Map<string, SlashCommand>();
  for (const { name, description, argumentHint } of reported) {
    // A command the prompt box cannot complete to `/name ` is left out.
    if (!name || /\s/.test(name) || name.length > 200 || commands.has(name))
      continue;
    commands.set(name, {
      name,
      description: clip(description.trim(), 300),
      ...(argumentHint?.trim()
        ? { argumentHint: clip(argumentHint.trim(), 120) }
        : {}),
    });
    if (commands.size === 500) break;
  }
  return [...commands.values()];
}
