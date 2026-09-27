export { cn } from "@multiplayer-ai/ui/lib/utils";

export const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : "s"}`;
