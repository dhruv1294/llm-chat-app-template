import { ChatMessage } from "./types";

export class ConversationDO {
  state: DurableObjectState;
  env: any;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/messages") {
        const msgs = (await this.state.storage.get<ChatMessage[]>("messages")) || [];
        return new Response(JSON.stringify(msgs), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (request.method === "POST" && url.pathname === "/append") {
        const body = await request.text();
        if (!body) return new Response("Missing body", { status: 400 });
        let msg: ChatMessage;
        try {
          msg = JSON.parse(body) as ChatMessage;
        } catch (e) {
          return new Response("Invalid JSON", { status: 400 });
        }

        const msgs = (await this.state.storage.get<ChatMessage[]>("messages")) || [];
        msgs.push(msg);
        await this.state.storage.put("messages", msgs);
        return new Response(null, { status: 204 });
      }

      if (request.method === "DELETE" && url.pathname === "/clear") {
        await this.state.storage.delete("messages");
        return new Response(null, { status: 204 });
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      return new Response("Internal DO error", { status: 500 });
    }
  }
}
