"use client";
import { Composer, type ComposerProps } from "@multiplayer-ai/ui/chat/composer";
import type { ModelKey } from "@multiplayer-ai/domain";
import RunModelSwitcher from "@/features/runs/components/RunModelSwitcher";
export interface ThreadComposerProps extends ComposerProps {
  revision: number;
  model: ModelKey;
  onModelChange(model: ModelKey): void;
}
export default function ThreadComposer({
  model,
  onModelChange,
  controls,
  ...props
}: ThreadComposerProps) {
  return (
    <Composer
      {...props}
      controls={
        <>
          <RunModelSwitcher value={model} onChange={onModelChange} />
          {controls}
        </>
      }
    />
  );
}
