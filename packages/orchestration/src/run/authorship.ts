import type { RunUIMessage } from "@multiplayer-ai/domain";

const MAX_NAME_LENGTH = 64;

function sanitizeName(name: string): string {
    return name
        .replace(/[\p{C}\s]+/gu, " ")
        .trim()
        .slice(0, MAX_NAME_LENGTH);
}

export function attributeAuthors(
    thread: Array<RunUIMessage>,
): Array<RunUIMessage> {
    return thread.map((message) => {
        if (message.role !== "user") return message;

        const author = message.metadata?.author;
        if (author === undefined) return message;

        const label = sanitizeName(author.name);
        if (label.length === 0) return message;

        let labelled = false;
        return {
            ...message,
            parts: message.parts.map((part) => {
                if (labelled || part.type !== "text") return part;
                labelled = true;
                return { ...part, text: `${label}: ${part.text}` };
            }),
        };
    });
}
