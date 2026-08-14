import { Box } from '@/components/ui';
import { cn } from '@/lib/utils';
interface Props {
    className?: string;
    onSubmit: () => void;
}

function TextEntryBubble({ onSubmit, className }: Props) {
    return (
        <Box className={cn('bg-[#2A2A2A] p-2 m-2 w-full', className)}>
            TextEntry
        </Box>
    );
}
export default TextEntryBubble;
