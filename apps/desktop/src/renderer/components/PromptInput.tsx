import { Composer } from "@multiplayer-ai/ui/chat/composer";
import type { ReactNode } from "react";

interface Props {
  value: string;
  onChange(value: string): void;
  onSubmit(text: string): Promise<boolean>;
  targetKey: string;
  disabled?: boolean;
  label: string;
  placeholder: string;
  submitLabel: string;
  footer?: ReactNode;
  maxLength?: number;
}
export function PromptInput({
  onChange,
  onSubmit,
  footer,
  maxLength = 8000,
  ...props
}: Props) {
  return (
    <Composer
      {...props}
      appearance="compact"
      maxLength={maxLength}
      lengthUnit="code-units"
      onValueChange={onChange}
      controls={footer}
      onSubmit={async (text) => ({ accepted: await onSubmit(text) })}
    />
  );
}
