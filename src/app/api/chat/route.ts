import { google } from '@ai-sdk/google';
import { convertToModelMessages, streamText, UIMessage } from 'ai';

export const maxDuration = 30;

export async function POST(request: Request) {
	const { messages }: { messages: UIMessage[] } = await request.json();

	const modelMessages = await convertToModelMessages(messages);

	const result = streamText({
		model: google('gemini-2.0-flash'),
		system:
			'You are a helpful assistant. Keep responses concise and clear. This endpoint will later be replaced with a RAG pipeline.',
		messages: modelMessages,
	});

	return result.toUIMessageStreamResponse();
}
