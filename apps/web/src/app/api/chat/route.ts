import { openai } from '@ai-sdk/openai';
import { createMockChatStream } from '@/lib/ai/mock-chat';
import {
    convertToModelMessages,
    createUIMessageStreamResponse,
    streamText,
    toUIMessageStream,
    type UIMessage,
} from 'ai';

const DEFAULT_MODEL = 'gpt-5-mini';

export async function POST(request: Request) {
    const { messages }: { messages: Array<UIMessage> } = await request.json();
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

    const result = streamText({
        model: openai(process.env.OPENAI_MODEL ?? DEFAULT_MODEL),
        messages: await convertToModelMessages(messages),
    });

    return createUIMessageStreamResponse({
        headers: { 'x-ai-mode': 'openai' },
        stream: toUIMessageStream({ stream: result.stream }),
    });
}
