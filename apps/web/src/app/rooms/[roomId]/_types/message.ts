export type Message = {
    id: string;
    roomId: string;
    userId: string;
    text: string;
    sentAt: string;
};

export function isMessage(value: unknown): value is Message {
    if (typeof value !== 'object' || value === null) return false;

    const message = value as Record<string, unknown>;

    return (
        typeof message.id === 'string' &&
        typeof message.roomId === 'string' &&
        typeof message.userId === 'string' &&
        typeof message.text === 'string' &&
        message.text.length > 0 &&
        message.text.length <= 2_000 &&
        typeof message.sentAt === 'string'
    );
}
