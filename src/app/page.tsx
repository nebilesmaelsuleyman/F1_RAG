'use client';

import { useState } from 'react';
import { useChat } from '@ai-sdk/react';

export default function Home() {
	const [input, setInput] = useState('');

	const { messages, sendMessage, status } = useChat();

	const isLoading = status === 'submitted' || status === 'streaming';

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const trimmed = input.trim();

		if (!trimmed || isLoading) return;

		await sendMessage({ text: trimmed });
		setInput('');
	};

	return (
		<main className="chat-page">
			<h1 className="chat-title">RAG Chat Playground</h1>

			<div className="chat-box">
				{messages.length === 0 ? (
					<p className="chat-empty">
						Ask anything. This is the simple chat UI; later we can connect your full RAG retrieval.
					</p>
				) : (
					messages.map((message) => (
						<div key={message.id} className="chat-message">
							<strong>{message.role === 'user' ? 'You' : 'Assistant'}:</strong>{' '}
							{message.parts
								.filter((part) => part.type === 'text')
								.map((part, index) => (
									<span key={`${message.id}-${index}`}>{part.text}</span>
								))}
						</div>
					))
				)}
			</div>

			<form onSubmit={handleSubmit} className="chat-form">
				<input
					className="chat-input"
					value={input}
					onChange={(event) => setInput(event.target.value)}
					placeholder="Type your message..."
				/>
				<button
					className="chat-send"
					type="submit"
					disabled={isLoading || input.trim().length === 0}
				>
					{isLoading ? 'Thinking...' : 'Send'}
				</button>
			</form>
		</main>
	);
}
