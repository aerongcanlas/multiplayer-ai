import { useCallback, useRef } from "react";

export function useChatScroll() {
    const containerRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = useCallback(() => {
        const container = containerRef.current;

        if (container === null) {
            return;
        }

        container.scrollTo({
            top: container.scrollHeight,
            behavior: "smooth",
        });
    }, []);

    return {
        containerRef,
        scrollToBottom,
    };
}
