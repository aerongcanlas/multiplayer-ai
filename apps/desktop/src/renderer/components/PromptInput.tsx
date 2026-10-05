import { Composer } from "@multiplayer-ai/ui/chat/composer";
import { useId, useState, type ReactNode } from "react";
import type { SlashCommand } from "../../shared/tabs";
import {
  matchCommands,
  slashQuery,
  useSlashCommands,
} from "../lib/slash-commands";

interface Props {
  value: string;
  onChange(value: string): void;
  onSubmit(text: string): Promise<boolean>;
  targetKey: string;
  disabled?: boolean;
  busy?: boolean;
  onStop?(): void;
  stopDisabled?: boolean;
  stopping?: boolean;
  label: string;
  placeholder: string;
  submitLabel: string;
  footer?: ReactNode;
  maxLength?: number;
  /** Slash commands offered while the draft is only a leading `/name`. */
  commands?: { key: string; load(): Promise<SlashCommand[]> };
}

const noCommands = { key: "", load: async () => [] };

export function PromptInput({
  value,
  onChange,
  onSubmit,
  footer,
  maxLength = 8000,
  commands,
  ...props
}: Props) {
  const listId = useId();
  const query = commands && !props.disabled ? slashQuery(value) : null;
  // The draft the menu was dismissed on; any edit brings the menu back.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [picked, setPicked] = useState({ query: "", index: 0 });
  const source = commands ?? noCommands;
  const { commands: all, loading } = useSlashCommands(
    source.key,
    query !== null,
    source.load,
  );
  const matches =
    query === null || dismissed === value ? [] : matchCommands(all, query);
  const open = matches.length > 0;
  const index =
    picked.query === query ? Math.min(picked.index, matches.length - 1) : 0;
  const option = (at: number) => `${listId}-${at}`;
  const pick = (command: SlashCommand) => onChange(`/${command.name} `);
  return (
    <Composer
      {...props}
      value={value}
      appearance="compact"
      maxLength={maxLength}
      lengthUnit="code-units"
      onValueChange={onChange}
      controls={footer}
      onSubmit={async (text) => ({ accepted: await onSubmit(text) })}
      textareaProps={
        commands
          ? {
              "aria-autocomplete": "list",
              "aria-controls": open ? listId : undefined,
              "aria-activedescendant": open ? option(index) : undefined,
            }
          : undefined
      }
      onKeyDown={(event) => {
        if (!open || event.nativeEvent.isComposing) return;
        const move = (by: number) =>
          setPicked({
            query: query!,
            index: (index + by + matches.length) % matches.length,
          });
        if (event.key === "ArrowDown") move(1);
        else if (event.key === "ArrowUp") move(-1);
        else if (event.key === "Escape") setDismissed(value);
        else if (
          (event.key === "Enter" && !event.shiftKey) ||
          event.key === "Tab"
        )
          pick(matches[index]!);
        else return;
        event.preventDefault();
      }}
      context={
        open ? (
          <ul
            id={listId}
            className="slash-menu"
            role="listbox"
            aria-label="Commands"
          >
            {matches.map((command, at) => (
              <li
                key={command.name}
                id={option(at)}
                role="option"
                aria-selected={at === index}
                ref={
                  at === index
                    ? (node) => node?.scrollIntoView({ block: "nearest" })
                    : undefined
                }
                // Keeps focus in the prompt box.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setPicked({ query: query!, index: at })}
                onClick={() => pick(command)}
              >
                <span className="slash-name">
                  /{command.name}
                  {command.argumentHint && <i> {command.argumentHint}</i>}
                </span>
                {command.description && <small>{command.description}</small>}
              </li>
            ))}
          </ul>
        ) : query !== null && loading && !all.length ? (
          <p className="slash-menu slash-menu-status" role="status">
            Loading commands…
          </p>
        ) : null
      }
    />
  );
}
