/**
 * LLM Chat App Frontend
 *
 * Handles the chat UI interactions and communication with the backend API.
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const voiceButton = document.getElementById("voice-button");

// Chat state
let chatHistory = [
	{
		role: "assistant",
		content:
			"Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?",
	},
];
let isProcessing = false;

// Session ID for Durable Object / realtime session
let sessionId = localStorage.getItem("sessionId");
if (!sessionId) {
	sessionId = crypto.randomUUID();
	localStorage.setItem("sessionId", sessionId);
}

// load existing messages from server-backed Durable Object and render them
async function loadSessionMessages() {
    try {
        const res = await fetch(`/api/messages?sessionId=${sessionId}`);
        if (!res.ok) return;
        const msgs = await res.json();
        if (Array.isArray(msgs) && msgs.length > 0) {
            chatHistory = msgs;
            // render
            chatMessages.innerHTML = "";
            for (const m of chatHistory) {
                addMessageToChat(m.role, m.content);
            }
        } else {
            // fallback to default greeting
            chatMessages.innerHTML = "";
            addMessageToChat("assistant", "Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?");
            chatHistory = [ { role: "assistant", content: chatMessages.lastElementChild.querySelector('p').textContent } ];
        }
        chatMessages.scrollTop = chatMessages.scrollHeight;
    } catch (e) {
        console.error("Failed to load session messages:", e);
    }
}

// Open websocket connection
let socket;
function openSocket() {
    socket = new WebSocket(`/api/realtime?sessionId=${sessionId}`);
    socket.addEventListener("open", () => {
        console.log("realtime socket open");
    });
    socket.addEventListener("message", (ev) => {
        try {
            const data = JSON.parse(ev.data);
            if (data.type === "delta") {
                // append streaming delta to last assistant element
                const last = chatMessages.lastElementChild;
                if (last && last.classList.contains("assistant-message")) {
                    const p = last.querySelector("p");
                    p.textContent += data.content;
                }
                chatMessages.scrollTop = chatMessages.scrollHeight;
                // cancel transcript timeout since deltas are arriving
                if (transcriptTimeout) {
                    clearTimeout(transcriptTimeout);
                    transcriptTimeout = null;
                }
            }
            if (data.type === "done") {
                // finalize assistant message
                const last = chatMessages.lastElementChild;
                if (last && last.classList.contains("assistant-message")) {
                    const p = last.querySelector("p");
                    chatHistory.push({ role: "assistant", content: p.textContent });
                }
                typingIndicator.classList.remove("visible");
                isProcessing = false;
                userInput.disabled = false;
                sendButton.disabled = false;
                userInput.focus();
            }
            if (data.type === "transcript") {
                // Received transcription placeholder
                addMessageToChat("user", data.content);
                chatHistory.push({ role: "user", content: data.content });

                // Prepare assistant placeholder so streaming deltas have somewhere to append
                const assistantMessageEl = document.createElement("div");
                assistantMessageEl.className = "message assistant-message";
                assistantMessageEl.innerHTML = "<p></p>";
                chatMessages.appendChild(assistantMessageEl);
                typingIndicator.classList.add("visible");
                isProcessing = true;
                userInput.disabled = true;
                sendButton.disabled = true;

                // start a timeout: if no deltas/done arrive in X seconds, recover UI
                if (transcriptTimeout) clearTimeout(transcriptTimeout);
                transcriptTimeout = setTimeout(() => {
                    addMessageToChat("assistant", "Error: response timed out. Please try again.");
                    typingIndicator.classList.remove("visible");
                    isProcessing = false;
                    userInput.disabled = false;
                    sendButton.disabled = false;
                    transcriptTimeout = null;
                }, 30000); // 30s timeout
            }
            if (data.type === "error") {
                addMessageToChat("assistant", "Error: " + data.message);
                // recover UI from stuck state
                typingIndicator.classList.remove("visible");
                isProcessing = false;
                userInput.disabled = false;
                sendButton.disabled = false;
                if (transcriptTimeout) {
                    clearTimeout(transcriptTimeout);
                    transcriptTimeout = null;
                }
            }
        } catch (e) {
            console.error("Malformed socket message", e, ev.data);
        }
    });
}

// initialize session messages then open the socket
loadSessionMessages().then(openSocket).catch(openSocket);

// Voice recording support
let mediaRecorder = null;
let isRecording = false;
let audioStream = null;
let transcriptTimeout = null;

voiceButton.addEventListener("click", async () => {
	if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
		alert("Microphone access not supported in this browser");
		return;
	}

	if (!socket || socket.readyState !== WebSocket.OPEN) {
		alert("Realtime socket not connected");
		return;
	}

	if (isRecording) {
		// stop recording
		mediaRecorder.stop();
		if (audioStream) {
			audioStream.getTracks().forEach((t) => t.stop());
			audioStream = null;
		}
		voiceButton.textContent = "🎤";
		isRecording = false;
		return;
	}

	try {
		audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
		mediaRecorder = new MediaRecorder(audioStream);
		mediaRecorder.ondataavailable = async (ev) => {
			if (ev.data && ev.data.size > 0) {
				const ab = await ev.data.arrayBuffer();
				try {
					socket.send(ab);
				} catch (e) {
					console.error("Failed to send audio chunk", e);
				}
			}
		};
		mediaRecorder.onstop = () => {
			try {
				socket.send(JSON.stringify({ type: "audio_end" }));
			} catch (e) {
				console.error("Failed to send audio_end", e);
			}
		};
		mediaRecorder.start(250); // chunk every 250ms
		voiceButton.textContent = "⏹️";
		isRecording = true;
	} catch (e) {
		console.error("Microphone access denied or error:", e);
		alert("Could not access microphone: " + e.message);
	}
});
// Send message on Enter (without Shift)
userInput.addEventListener("keydown", function (e) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});

// Send button click handler
sendButton.addEventListener("click", sendMessage);

/**
 * Sends a message to the chat API and processes the response
 */
async function sendMessage() {
	const message = userInput.value.trim();

	// Don't send empty messages
	if (message === "" || isProcessing) return;

	// Disable input while processing
	isProcessing = true;
	userInput.disabled = true;
	sendButton.disabled = true;

	// Add user message to chat
	addMessageToChat("user", message);

	// Clear input
	userInput.value = "";
	userInput.style.height = "auto";

	// Show typing indicator
	typingIndicator.classList.add("visible");

	// Add message to history
	chatHistory.push({ role: "user", content: message });

	try {
		// Create new assistant response element
		const assistantMessageEl = document.createElement("div");
		assistantMessageEl.className = "message assistant-message";
		assistantMessageEl.innerHTML = "<p></p>";
		chatMessages.appendChild(assistantMessageEl);

		// Scroll to bottom
		chatMessages.scrollTop = chatMessages.scrollHeight;

		// Send message over websocket
		socket.send(JSON.stringify({ type: "user_message", content: message }));
	} catch (error) {
		console.error("Error:", error);
		addMessageToChat(
			"assistant",
			"Sorry, there was an error processing your request.",
		);
		// Re-enable input
		typingIndicator.classList.remove("visible");
		isProcessing = false;
		userInput.disabled = false;
		sendButton.disabled = false;
		userInput.focus();
	}
}

/**
 * Helper function to add message to chat
 */
function addMessageToChat(role, content) {
	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}-message`;
	messageEl.innerHTML = `<p>${content}</p>`;
	chatMessages.appendChild(messageEl);

	// Scroll to bottom
	chatMessages.scrollTop = chatMessages.scrollHeight;
}

function consumeSseEvents(buffer) {
	let normalized = buffer.replace(/\r/g, "");
	const events = [];
	let eventEndIndex;
	while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
		const rawEvent = normalized.slice(0, eventEndIndex);
		normalized = normalized.slice(eventEndIndex + 2);

		const lines = rawEvent.split("\n");
		const dataLines = [];
		for (const line of lines) {
			if (line.startsWith("data:")) {
				dataLines.push(line.slice("data:".length).trimStart());
			}
		}
		if (dataLines.length === 0) continue;
		events.push(dataLines.join("\n"));
	}
	return { events, buffer: normalized };
}
