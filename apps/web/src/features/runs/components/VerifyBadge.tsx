import { Box, TextBox } from "@/components/ui";
import { cn } from "@/lib/utils";

interface Props {
    ok: boolean;
    issues: Array<string>;
}

function VerifyBadge({ ok, issues }: Props) {
    const unverified = !ok && issues.length === 0;

    return (
        <Box
            className={cn(
                "m-2 rounded-xl border px-3 py-2 text-sm",
                ok && "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
                !ok && !unverified && "border-amber-500/30 bg-amber-500/10 text-amber-300",
                unverified && "border-white/15 bg-white/5 text-white/50",
            )}
        >
            <TextBox className="font-medium">
                {ok ? "Verified" : unverified ? "Unverified" : "Issues found"}
            </TextBox>
            {issues.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                    ))}
                </ul>
            )}
        </Box>
    );
}

export default VerifyBadge;
