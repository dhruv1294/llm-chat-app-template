/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";
// Re-export Durable Object class so Wrangler can find it when building
export { ConversationDO } from "./conversation_do";

// Model ID for Workers AI model
// https://developers.cloudflare.com/workers-ai/models/
const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Default system prompt
const SYSTEM_PROMPT =
	"You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
	/**
	 * Main request handler for the Worker
	 */
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Handle static assets (frontend)
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// API Routes
		// GET messages for a session
		if (url.pathname === "/api/messages") {
			if (request.method === "GET") {
				const sessionId = url.searchParams.get("sessionId") || request.headers.get("x-session-id") || "anonymous";
				const doId = env.CONVERSATION_DO.idFromName(sessionId);
				const doStub = env.CONVERSATION_DO.get(doId);

				const messagesRes = await doStub.fetch("https://do/messages");
				if (!messagesRes.ok) {
					return new Response("Failed to fetch messages", { status: 500 });
				}
				const messages = await messagesRes.json();
				return new Response(JSON.stringify(messages), { status: 200, headers: { "content-type": "application/json" } });
			}
			return new Response("Method not allowed", { status: 405 });
		}

		if (url.pathname === "/api/chat") {
			// Handle POST requests for chat
			if (request.method === "POST") {
				return handleChatRequest(request, env);
			}

			// Method not allowed for other request types
			return new Response("Method not allowed", { status: 405 });
		}

		// Realtime WebSocket endpoint for lower-latency streaming and optional voice
		if (url.pathname === "/api/realtime") {
			if (request.headers.get("upgrade") !== "websocket") {
				return new Response("Expected websocket", { status: 400 });
			}

			const sessionId = url.searchParams.get("sessionId") || request.headers.get("x-session-id") || "anonymous";
			const pair = new WebSocketPair();
			const [client, server] = pair as [WebSocket, WebSocket];

			const doId = env.CONVERSATION_DO.idFromName(sessionId);
			const doStub = env.CONVERSATION_DO.get(doId);

			await handleRealtime(server as WebSocket, doStub, env, ctx, sessionId);

			return new Response(null, { status: 101, webSocket: client });
		}

		// Handle 404 for unmatched routes
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/**
 * Handles chat API requests
 */
async function handleChatRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		// Parse JSON request body
		const { messages = [] } = (await request.json()) as {
			messages: ChatMessage[];
		};

		// Add system prompt if not present
		if (!messages.some((msg) => msg.role === "system")) {
			messages.unshift({ role: "system", content: SYSTEM_PROMPT });
		}


		// Determine session id (header x-session-id or fallback to anonymous)
		const sessionId = request.headers.get("x-session-id") || "anonymous";

		// Durable Object stub for this session
		const doId = env.CONVERSATION_DO.idFromName(sessionId);
		const doStub = env.CONVERSATION_DO.get(doId);

		// If the incoming request contains user messages, append the latest user message to the DO
		const lastUser = messages.filter((m) => m.role === "user").slice(-1)[0];
		if (lastUser) {
			await doStub.fetch("https://do/append", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(lastUser),
			});
		}

		// Retrieve canonical message history from Durable Object
		const messagesRes = await doStub.fetch("https://do/messages");
		let canonicalMessages: ChatMessage[] = [];
		if (messagesRes.ok) {
			canonicalMessages = (await messagesRes.json()) as ChatMessage[];
		}

		// Ensure system prompt is present
		if (!canonicalMessages.some((msg) => msg.role === "system")) {
			canonicalMessages.unshift({ role: "system", content: SYSTEM_PROMPT });
		}

		// Run AI with streaming and tee the stream so we can both stream to the client
		// and accumulate the assistant text to persist back into the DO
		const aiStream = await env.AI.run(
			MODEL_ID,
			{
				messages: canonicalMessages,
				max_tokens: 1024,
				stream: true,
			},
		);

		// Duplicate the stream: one for the client, one for background accumulation
		const [clientStream, backgroundStream] = aiStream.tee();

		// Background task: read SSE events from backgroundStream, accumulate assistant content,
		// and append assistant message to the Durable Object when complete.
		const accumulateAndPersist = async () => {
			try {
				const reader = backgroundStream.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				let assistantText = "";

				const consumeBuffer = () => {
					// parse SSE-style events separated by \n\n
					let normalized = buffer.replace(/\r/g, "");
					let eventEndIndex;
					while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
						const rawEvent = normalized.slice(0, eventEndIndex);
						normalized = normalized.slice(eventEndIndex + 2);
						const lines = rawEvent.split("\n");
						const dataLines = [];
						for (const line of lines) {
							if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
						}
						if (dataLines.length === 0) continue;
						const data = dataLines.join("\n");
						if (data === "[DONE]") continue;
						try {
							const json = JSON.parse(data);
							if (typeof json.response === "string" && json.response.length > 0) {
								assistantText += json.response;
							} else if (json.choices?.[0]?.delta?.content) {
								assistantText += json.choices[0].delta.content;
							}
						} catch (e) {
							// ignore parse errors for individual events
						}
					}
					buffer = normalized;
				};

				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						buffer += "\n\n"; // flush
						consumeBuffer();
						break;
					}
					buffer += decoder.decode(value, { stream: true });
					consumeBuffer();
				}

				// Persist assistantText if any
				if (assistantText.length > 0) {
					await doStub.fetch("https://do/append", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ role: "assistant", content: assistantText }),
					});
				}
			} catch (e) {
				console.error("Error persisting assistant text:", e);
			}
		};

		ctx.waitUntil(accumulateAndPersist());

		return new Response(clientStream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("Error processing chat request:", error);
		return new Response(
			JSON.stringify({ error: "Failed to process request" }),
			{
				status: 500,
				headers: { "content-type": "application/json" },
			},
		);
	}
}

/**
 * Handle a WebSocket connection for realtime chat and optional voice chunks.
 */
async function handleRealtime(
	socket: WebSocket,
	doStub: DurableObjectStub,
	env: Env,
	ctx: ExecutionContext,
	sessionId: string,
) {
	socket.accept();

	// buffer audio chunks received for this connection
	const audioBuffers: ArrayBuffer[] = [];

	socket.addEventListener("message", async (ev) => {
		try {
			// binary audio chunk
			if (ev.data && typeof ev.data !== "string") {
				// ArrayBuffer or ArrayBufferView
				let buf: ArrayBuffer;
				if (ev.data instanceof ArrayBuffer) buf = ev.data;
				else if (ArrayBuffer.isView(ev.data)) buf = ev.data.buffer;
				else buf = await ev.data.arrayBuffer();
				audioBuffers.push(buf);
				return;
			}

			const data = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
			if (!data) return;

			if (data.type === "user_message") {
				// append to DO
				await doStub.fetch("https://do/append", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ role: "user", content: data.content }),
				});

				// fetch canonical messages
				const messagesRes = await doStub.fetch("https://do/messages");
				let canonicalMessages = [];
				if (messagesRes.ok) canonicalMessages = await messagesRes.json();
				if (!canonicalMessages.some((m) => m.role === "system")) {
					canonicalMessages.unshift({ role: "system", content: SYSTEM_PROMPT });
				}

				// run AI and stream deltas to client socket
				const aiStream = await env.AI.run(MODEL_ID, { messages: canonicalMessages, max_tokens: 1024, stream: true });
				const reader = aiStream.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				let assistantText = "";

				const flushBuffer = async () => {
					let normalized = buffer.replace(/\r/g, "");
					let eventEndIndex;
					while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
						const rawEvent = normalized.slice(0, eventEndIndex);
						normalized = normalized.slice(eventEndIndex + 2);
						const lines = rawEvent.split("\n");
						const dataLines = [];
						for (const line of lines) {
							if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
						}
						if (dataLines.length === 0) continue;
						const payload = dataLines.join("\n");
						if (payload === "[DONE]") continue;
						try {
							const json = JSON.parse(payload);
							let content = "";
							if (typeof json.response === "string" && json.response.length > 0) content = json.response;
							else if (json.choices?.[0]?.delta?.content) content = json.choices[0].delta.content;
							if (content) {
								assistantText += content;
								socket.send(JSON.stringify({ type: "delta", content }));
							}
						} catch (e) {
							// ignore parse errors
						}
					}
					buffer = normalized;
				};

				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						buffer += "\n\n";
						await flushBuffer();
						break;
					}
					buffer += decoder.decode(value, { stream: true });
					await flushBuffer();
				}

				// persist assistantText back to DO
				if (assistantText.length > 0) {
					await doStub.fetch("https://do/append", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ role: "assistant", content: assistantText }),
					});
				}

				socket.send(JSON.stringify({ type: "done" }));
			}

			if (data.type === "audio_end") {
				// Merge collected audio buffers
				let totalLen = 0;
				for (const b of audioBuffers) totalLen += b.byteLength;
				const combined = new Uint8Array(totalLen);
				let offset = 0;
				for (const b of audioBuffers) {
					combined.set(new Uint8Array(b), offset);
					offset += b.byteLength;
				}

				// TODO: upload combined buffer to R2 or forward to an STT service
				console.log(`Received audio ${totalLen} bytes for session ${sessionId}`);
				const placeholder = `[Audio received ${totalLen} bytes] (transcription not configured)`;

				// append as user message transcription
				await doStub.fetch("https://do/append", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ role: "user", content: placeholder }),
				});

				// Notify client
				socket.send(JSON.stringify({ type: "transcript", content: placeholder }));

				// Clear buffers
				audioBuffers.length = 0;

				// Now run AI to generate assistant reply (reuse user_message flow)
				try {
					console.log(`Starting AI.run for session ${sessionId}`);
					const messagesRes2 = await doStub.fetch("https://do/messages");
					let canonicalMessages2 = [];
					if (messagesRes2.ok) canonicalMessages2 = await messagesRes2.json();
					if (!canonicalMessages2.some((m) => m.role === "system")) {
						canonicalMessages2.unshift({ role: "system", content: SYSTEM_PROMPT });
					}

					const aiStream2 = await env.AI.run(MODEL_ID, { messages: canonicalMessages2, max_tokens: 1024, stream: true });
					const reader2 = aiStream2.getReader();
					const decoder2 = new TextDecoder();
					let buffer2 = "";
					let assistantText2 = "";

					const flushBuffer2 = async () => {
						let normalized = buffer2.replace(/\r/g, "");
						let eventEndIndex;
						while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
							const rawEvent = normalized.slice(0, eventEndIndex);
							normalized = normalized.slice(eventEndIndex + 2);
							const lines = rawEvent.split("\n");
							const dataLines = [];
							for (const line of lines) {
								if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
							}
							if (dataLines.length === 0) continue;
							const payload = dataLines.join("\n");
							if (payload === "[DONE]") continue;
							try {
								const json = JSON.parse(payload);
								let content = "";
								if (typeof json.response === "string" && json.response.length > 0) content = json.response;
								else if (json.choices?.[0]?.delta?.content) content = json.choices[0].delta.content;
								if (content) {
									assistantText2 += content;
									socket.send(JSON.stringify({ type: "delta", content }));
								}
							} catch (e) {
								// ignore parse errors
							}
						}
						buffer2 = normalized;
					};

					while (true) {
						const { done, value } = await reader2.read();
						if (done) {
							buffer2 += "\n\n";
							await flushBuffer2();
							break;
						}
						buffer2 += decoder2.decode(value, { stream: true });
						await flushBuffer2();
					}

					// persist assistantText back to DO
					if (assistantText2.length > 0) {
						await doStub.fetch("https://do/append", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ role: "assistant", content: assistantText2 }),
						});
					}

					console.log(`AI.run completed for session ${sessionId}; assistantText length=${assistantText2.length}`);
					socket.send(JSON.stringify({ type: "done" }));
				} catch (e) {
					console.error('Error during audio processing/AI run:', e);
					try {
						socket.send(JSON.stringify({ type: 'error', message: String(e) }));
					} catch (_) {}
				}
			}
		} catch (e) {
				console.error("Realtime handler error:", e);
				try {
					socket.send(JSON.stringify({ type: "error", message: String(e) }));
				} catch {}
			}
		});

		socket.addEventListener("close", () => {
			// noop
		});
}
