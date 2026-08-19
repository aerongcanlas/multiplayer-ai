import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const boxVariants = cva('', {
    variants: {
        variant: {
            default: '',
            panel: '',
        },
    },
    defaultVariants: {
        variant: 'default',
    },
});

function Box({
    children,
    className,
    onClick,
    variant,
    ...props
}: React.ComponentProps<'div'> & VariantProps<typeof boxVariants>) {
    return (
        <div
            className={cn(
                boxVariants({ variant }),
                onClick && 'cursor-pointer',
                className,
            )}
            onClick={onClick}
            {...props}
        >
            {children}
        </div>
    );
}

export { Box, boxVariants };
