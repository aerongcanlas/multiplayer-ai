import { createMockChatStream } from '@/features/ai/server/mockChat';
import { isChatProvider } from '@multiplayer-ai/domain';
import { createChatModel } from '@multiplayer-ai/providers';
import {
    convertToModelMessages,
    createUIMessageStreamResponse,
    streamText,
    toUIMessageStream,
    type UIMessage,
} from 'ai';

export async function POST(request: Request) {
    const {
        messages,
        provider: requestedProvider = 'gemini',
    }: {
        messages: Array<UIMessage>;
        provider?: unknown;
    } = await request.json();
    const aiMode = process.env.AI_MODE?.trim().toLowerCase() ?? 'openai';

    if (aiMode === 'mock') {
        return createUIMessageStreamResponse({
            headers: { 'x-ai-mode': 'mock' },
            stream: createMockChatStream(messages),
        });
    }

    if (aiMode !== 'openai') {
        return Response.json(
            { error: 'AI_MODE must be either "mock" or "openai".' },
            { status: 500 },
        );
    }

    if (!isChatProvider(requestedProvider)) {
        return Response.json(
            { error: 'Unsupported chat provider' },
            { status: 400 },
        );
    }

    const result = streamText({
        model: createChatModel(requestedProvider, process.env.OPENAI_MODEL),
        messages: await convertToModelMessages(messages),
    });

    return createUIMessageStreamResponse({
        headers: { 'x-ai-mode': requestedProvider },
        stream: toUIMessageStream({ stream: result.stream }),
    });
}
