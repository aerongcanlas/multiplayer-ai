import { useEffect, useState } from "react";
import type { SlashCommand } from "../../shared/tabs";

/** The command name being typed when a draft is only a leading `/name`, else null. */
export function slashQuery(value: string): string | null {
  return /^\/\S*$/.test(value) ? value.slice(1).toLowerCase() : null;
}

/** Commands whose name starts with the query, then those that only contain it. */
export function matchCommands(commands: SlashCommand[], query: string) {
  const named = commands.map((command) => ({
    command,
    at: command.name.toLowerCase().indexOf(query),
  }));
  return [
    ...named.filter((item) => item.at === 0),
    ...named.filter((item) => item.at > 0),
  ].map((item) => item.command);
}

// Lists per room and harness, kept so the menu opens filled the next time.
const lists = new Map<string, SlashCommand[]>();

/** A tab's slash commands, loaded while `active` and refreshed each time it turns on. */
export function useSlashCommands(
  key: string,
  active: boolean,
  load: () => Promise<SlashCommand[]>,
) {
  // The key whose latest load has ended, so a failed load stops showing as loading.
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let current = true;
    load()
      .then((commands) => {
        lists.set(key, commands);
      })
      // A failed load keeps the last list.
      .catch(() => {})
      .finally(() => {
        if (current) setSettled(`${key}\n${Date.now()}`);
      });
    return () => {
      current = false;
    };
    // `load` is the caller's closure over the same key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active]);
  return {
    commands: lists.get(key) ?? [],
    loading: active && !lists.has(key) && !settled?.startsWith(`${key}\n`),
  };
}
