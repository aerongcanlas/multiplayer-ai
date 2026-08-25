"use client";

import { cn } from "@/lib/utils";
import type { Components } from "streamdown";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";

const components: Components = {
    p: ({ className, ...props }) => (
        <p className={cn("my-2 first:mt-0 last:mb-0", className)} {...props} />
    ),
    ul: ({ className, ...props }) => (
        <ul
            className={cn("my-2 list-disc space-y-0.5 pl-5 first:mt-0 last:mb-0", className)}
            {...props}
        />
    ),
    ol: ({ className, ...props }) => (
        <ol
            className={cn("my-2 list-decimal space-y-0.5 pl-5 first:mt-0 last:mb-0", className)}
            {...props}
        />
    ),
    li: ({ className, ...props }) => <li className={cn("pl-0.5", className)} {...props} />,
    h1: ({ className, ...props }) => (
        <h1 className={cn("mt-3 mb-1 text-base font-semibold first:mt-0", className)} {...props} />
    ),
    h2: ({ className, ...props }) => (
        <h2 className={cn("mt-3 mb-1 text-sm font-semibold first:mt-0", className)} {...props} />
    ),
    h3: ({ className, ...props }) => (
        <h3 className={cn("mt-2 mb-1 text-sm font-semibold first:mt-0", className)} {...props} />
    ),
    h4: ({ className, ...props }) => (
        <h4 className={cn("mt-2 mb-1 text-sm font-medium first:mt-0", className)} {...props} />
    ),
    a: ({ className, ...props }) => (
        <a
            className={cn(
                "underline decoration-current/40 underline-offset-2 hover:decoration-current",
                className,
            )}
            {...props}
        />
    ),
    blockquote: ({ className, ...props }) => (
        <blockquote
            className={cn(
                "my-2 border-l-2 border-current/20 pl-3 text-current/80 first:mt-0 last:mb-0",
                className,
            )}
            {...props}
        />
    ),
    hr: ({ className, ...props }) => (
        <hr className={cn("my-3 border-current/10", className)} {...props} />
    ),
    code: ({ className, ...props }) => (
        <code
            className={cn("rounded bg-white/10 px-1 py-0.5 font-mono text-[0.85em]", className)}
            {...props}
        />
    ),
    pre: ({ className, ...props }) => (
        <pre
            className={cn(
                "my-2 overflow-x-auto rounded-lg border border-white/10 bg-black/30 p-2.5 font-mono text-xs first:mt-0 last:mb-0",
                className,
            )}
            {...props}
        />
    ),
    table: ({ className, ...props }) => (
        <div className="my-2 overflow-x-auto first:mt-0 last:mb-0">
            <table className={cn("w-full border-collapse text-xs", className)} {...props} />
        </div>
    ),
    thead: ({ className, ...props }) => (
        <thead className={cn("border-b border-current/15", className)} {...props} />
    ),
    tbody: ({ className, ...props }) => (
        <tbody className={cn("divide-y divide-current/10", className)} {...props} />
    ),
    th: ({ className, ...props }) => (
        <th
            className={cn("whitespace-nowrap px-2 py-1 text-left font-medium", className)}
            {...props}
        />
    ),
    td: ({ className, ...props }) => (
        <td className={cn("px-2 py-1 align-top", className)} {...props} />
    ),
};

interface Props {
    children: string;
    className?: string;
    isAnimating?: boolean;
}

function Markdown({ children, className, isAnimating }: Props) {
    return (
        <Streamdown
            className={cn("text-sm leading-normal", className)}
            components={components}
            skipHtml
            controls={false}
            caret="block"
            isAnimating={isAnimating}
        >
            {children}
        </Streamdown>
    );
}

export { Markdown };
