/**
 * Type definitions for the LLM chat application.
 */

export interface Env {
	/**
	 * Binding for the Workers AI API.
	 */
	AI: Ai;

	/**
	 * Binding for static assets.
	 */
	ASSETS: { fetch: (request: Request) => Promise<Response> };

	/**
	 * Durable Object namespace for conversation/session state.
	 */
	CONVERSATION_DO: DurableObjectNamespace;

	/**
	 * Optional KV namespace for long-term conversation summaries / memory.
	 */
	CONVERSATIONS?: KVNamespace;
}

/**
 * Represents a chat message.
 */
export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}
