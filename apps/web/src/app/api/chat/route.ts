import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { createMockChatStream } from '@/features/ai/server/mockChat';
import {
    convertToModelMessages,
    createUIMessageStreamResponse,
    streamText,
    toUIMessageStream,
    type UIMessage,
} from 'ai';

const DEFAULT_MODEL = 'gpt-5-mini';
type ChatProvider = 'gemini' | 'openai';

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

    if (requestedProvider !== 'gemini' && requestedProvider !== 'openai') {
        return Response.json(
            { error: 'Unsupported chat provider' },
            { status: 400 },
        );
    }

    const provider = requestedProvider as ChatProvider;

    const result = streamText({
        model:
            provider === 'gemini'
                ? google('gemini-3.6-flash')
                : openai(process.env.OPENAI_MODEL ?? DEFAULT_MODEL),
        messages: await convertToModelMessages(messages),
    });

    return createUIMessageStreamResponse({
        headers: { 'x-ai-mode': provider },
        stream: toUIMessageStream({ stream: result.stream }),
    });
}
