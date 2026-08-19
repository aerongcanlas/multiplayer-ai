import * as React from 'react';

import { cn } from '@/lib/utils';

function TextBox({ children, className, ...props }: React.ComponentProps<'p'>) {
    return (
        <p
            className={cn(className)}
            {...props}
        >
            {children}
        </p>
    );
}

export { TextBox };
