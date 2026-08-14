import * as React from "react";

import { cn } from "@/lib/utils";

import { Box } from "./Box";

function BoxColumn({
    children,
    className,
    ...props
}: React.ComponentProps<typeof Box>) {
    return (
        <Box
            className={cn("flex flex-col", className)}
            {...props}>
            {children}
        </Box>
    );
}

export { BoxColumn };
