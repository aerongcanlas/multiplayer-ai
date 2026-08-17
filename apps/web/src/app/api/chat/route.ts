import { openai } from '@ai-sdk/openai';
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

    const result = streamText({
        model: openai(process.env.OPENAI_MODEL ?? DEFAULT_MODEL),
        messages: await convertToModelMessages(messages),
    });

    return createUIMessageStreamResponse({
        stream: toUIMessageStream({ stream: result.stream }),
    });
}
