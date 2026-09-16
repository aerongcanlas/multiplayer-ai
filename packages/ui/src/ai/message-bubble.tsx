import { BoxColumn } from "../primitives/box-column";
import { BoxRow } from "../primitives/box-row";
import { TextBox } from "../primitives/text-box";
import { cn } from "../lib/utils";

interface Props {
  className?: string;
  text: string;
  author?: string;
}
function MessageBubble({ className, text, author }: Props) {
  return (
    <BoxColumn className={cn("m-2 w-fit items-end gap-0.5", className)}>
      {author !== undefined && (
        <TextBox className="px-1 text-[10px] text-white/40">{author}</TextBox>
      )}
      <BoxRow className="wrap-break-word rounded-xl bg-[#242424] px-4 pt-2 pb-2.5">
        <TextBox>{text}</TextBox>
      </BoxRow>
    </BoxColumn>
  );
}
export default MessageBubble;
