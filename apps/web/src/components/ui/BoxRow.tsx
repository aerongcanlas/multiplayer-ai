import * as React from "react";

import { cn } from "@/lib/utils";

import { Box } from "./Box";

function BoxRow({
    children,
    className,
    ...props
}: React.ComponentProps<typeof Box>) {
    return (
        <Box
            className={cn("flex flex-row", className)}
            {...props}>
            {children}
        </Box>
    );
}

export { BoxRow };
