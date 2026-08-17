import { simulateReadableStream, type UIMessage, type UIMessageChunk } from 'ai';

const MOCK_TEXT_ID = 'mock-text';
const MAX_PROMPT_PREVIEW_LENGTH = 160;

function getLatestUserText(messages: Array<UIMessage>) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== 'user') continue;

        return message.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join(' ')
            .trim();
    }

    return '';
}

function buildMockReply(messages: Array<UIMessage>) {
    const latestUserText = getLatestUserText(messages);

    if (!latestUserText) {
        return 'Mock AI is ready. Streaming works, and no OpenAI credits were used.';
    }

    const promptPreview = latestUserText.slice(0, MAX_PROMPT_PREVIEW_LENGTH);
    const truncationMarker = latestUserText.length > promptPreview.length ? '...' : '';

    return `Mock AI received: "${promptPreview}${truncationMarker}" Streaming works, and no OpenAI credits were used.`;
}

export function createMockChatStream(messages: Array<UIMessage>) {
    const reply = buildMockReply(messages);
    const textChunks = reply.match(/\S+\s*/g) ?? [reply];
    const chunks: Array<UIMessageChunk> = [
        { type: 'start' },
        { type: 'start-step' },
        { type: 'text-start', id: MOCK_TEXT_ID },
        ...textChunks.map((delta): UIMessageChunk => ({
            type: 'text-delta',
            id: MOCK_TEXT_ID,
            delta,
        })),
        { type: 'text-end', id: MOCK_TEXT_ID },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
    ];

    return simulateReadableStream({
        chunks,
        initialDelayInMs: 150,
        chunkDelayInMs: 35,
    });
}
