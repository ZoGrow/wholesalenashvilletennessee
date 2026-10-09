// SMS reply bot: GoHighLevel sends a webhook when a lead texts back, this Worker
// reads the SMS thread from GHL, asks Claude for the next reply, and texts it back.
// When the lead is ready for a human (or asks for one), it tags them and goes quiet.
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt";

export interface Env {
  ANTHROPIC_API_KEY: string;
  GHL_TOKEN: string;
  GHL_LOCATION_ID: string;
  WEBHOOK_SECRET: string; // must match ?key= on the webhook URL set in GHL
  BOT_GOAL: string; // plain-English goal, set in wrangler.toml
  SENDER_NAME: string; // the first name the bot signs as
  DRY_RUN?: string; // "true" = log the reply instead of texting it
}

const GHL = "https://services.leadconnectorhq.com";
const MODEL = "claude-opus-5-5";
const HANDOFF_TAG = "hot-lead"; // bot stops and you take over
const BOT_OFF_TAGS = ["hot-lead", "bot-off", "dnd-skipped"]; // bot never replies to these
const MAX_HISTORY = 40;

type Sms = { direction: "inbound" | "outbound"; body: string; at: string };

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET") return new Response("sms bot ok");
    if (req.method !== "POST" || url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
      return new Response("not found", { status: 404 });
    }
    const payload = (await req.json().catch(() => ({}))) as Record<string, any>;
    const contactId: string | undefined =
      payload.contact_id ?? payload.contactId ?? payload.contact?.id ?? payload.customData?.contact_id;
    if (!contactId) return new Response("no contact id", { status: 400 });
    // Answer GHL right away; the reply is written and sent in the background.
    ctx.waitUntil(handleReply(contactId, env).catch((e) => console.error("reply failed", contactId, e)));
    return new Response("ok");
  },
};

async function handleReply(contactId: string, env: Env): Promise<void> {
  const contact = (await ghl(env, `/contacts/${contactId}`)).contact ?? {};
  const tags: string[] = (contact.tags ?? []).map((t: string) => t.toLowerCase());
  if (BOT_OFF_TAGS.some((t) => tags.includes(t)) || contact.dnd || contact.dndSettings?.SMS?.status === "active") {
    console.log("skip: bot off for", contactId);
    return;
  }

  const thread = await smsThread(contactId, env);
  const last = thread[thread.length - 1];
  if (!last || last.direction !== "inbound") {
    console.log("skip: nothing new from", contactId); // already answered (duplicate webhook)
    return;
  }
  if (/^\s*(stop|unsubscribe|cancel|end|quit)\s*$/i.test(last.body)) return; // GHL handles opt-outs

  const decision = await nextReply(thread, contact, env);
  if (!decision) return;

  if (decision.reply.trim()) {
    if (env.DRY_RUN === "true") console.log("DRY RUN reply to", contactId, ":", decision.reply);
    else await ghl(env, "/conversations/messages", "POST", { type: "SMS", contactId, message: decision.reply.trim() });
  }
  if (decision.handoff) {
    await ghl(env, `/contacts/${contactId}/tags`, "POST", { tags: [HANDOFF_TAG] });
    if (decision.note) {
      await ghl(env, `/contacts/${contactId}/notes`, "POST", { body: `SMS bot handoff: ${decision.note}` });
    }
  }
}

type Decision = { reply: string; handoff: boolean; note: string };

async function nextReply(thread: Sms[], contact: Record<string, any>, env: Env): Promise<Decision | null> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const transcript = thread
    .map((m) => `${m.direction === "outbound" ? "US" : "AGENT"} (${m.at}): ${m.body}`)
    .join("\n");
  const about = [
    contact.firstName && `First name: ${contact.firstName}`,
    contact.companyName && `Brokerage: ${contact.companyName}`,
    contact.city && `City: ${contact.city}`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            reply: { type: "string", description: "The next text message to send, or empty to send nothing." },
            handoff: { type: "boolean", description: "True when a human should take over now." },
            note: { type: "string", description: "One line for the human on why, when handoff is true; else empty." },
          },
          required: ["reply", "handoff", "note"],
          additionalProperties: false,
        },
      },
    },
    system: SYSTEM_PROMPT.replaceAll("{{GOAL}}", env.BOT_GOAL).replaceAll("{{NAME}}", env.SENDER_NAME),
    messages: [
      {
        role: "user",
        content: `About this agent:\n${about || "(nothing on file)"}\n\nSMS thread so far, oldest first:\n${transcript}\n\nWrite our next text.`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    console.warn("refused", response.stop_details);
    return { reply: "", handoff: true, note: "Bot could not answer this one." };
  }
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") return null;
  return JSON.parse(text.text) as Decision;
}

async function smsThread(contactId: string, env: Env): Promise<Sms[]> {
  const search = await ghl(env, `/conversations/search?locationId=${env.GHL_LOCATION_ID}&contactId=${contactId}`);
  const conv = (search.conversations ?? [])[0];
  if (!conv) return [];
  const data = await ghl(env, `/conversations/${conv.id}/messages?limit=${MAX_HISTORY}`);
  const list: any[] = data.messages?.messages ?? data.messages ?? [];
  return list
    .filter((m) => (m.messageType ?? "").includes("SMS") || m.type === 2)
    .filter((m) => m.body && m.status !== "failed" && m.status !== "undelivered")
    .map((m) => ({ direction: m.direction, body: m.body, at: m.dateAdded }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

async function ghl(env: Env, path: string, method = "GET", body?: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(GHL + path, {
      method,
      headers: {
        Authorization: `Bearer ${env.GHL_TOKEN}`,
        Version: "2021-07-28",
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`GHL ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }
}
