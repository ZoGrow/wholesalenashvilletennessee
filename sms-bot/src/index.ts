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
  ARV_PERCENT: string; // max offer = ARV x this % - repairs - fee
  ASSIGNMENT_FEE: string; // our wholesale fee in dollars
  PROPERTY_TYPES: string; // what we buy
  DRY_RUN?: string; // "true" = log the reply instead of texting it
}

const GHL = "https://services.leadconnectorhq.com";
const MODEL = "claude-opus-5-5";
const HANDOFF_TAG = "hot-lead"; // bot stops and you take over
const WARM_TAG = "warm-lead"; // has something coming later; bot keeps talking
const BOT_OFF_TAGS = ["hot-lead", "bot-off", "dnd-skipped"]; // bot never replies to these
const MAX_HISTORY = 40;

type Sms = { direction: "inbound" | "outbound"; body: string; at: string };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET") return new Response("sms bot ok");
    if (req.method !== "POST" || url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
      return new Response("not found", { status: 404 });
    }
    const payload = (await req.json().catch(() => ({}))) as Record<string, any>;
    const contactId: string | undefined =
      payload.contact_id ?? payload.contactId ?? payload.contact?.id ?? payload.customData?.contact_id;
    if (!contactId) return new Response("no contact id", { status: 400 });
    // Handled before answering GHL: a listing lookup can take longer than background work is
    // allowed to run. If GHL retries meanwhile, the retry sees our reply already sent and skips.
    try {
      await handleReply(contactId, env);
    } catch (e) {
      console.error("reply failed", contactId, e);
      return new Response("error", { status: 500 });
    }
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
  if (decision.handoff || decision.warm) {
    await ghl(env, `/contacts/${contactId}/tags`, "POST", { tags: [decision.handoff ? HANDOFF_TAG : WARM_TAG] });
    if (decision.note) {
      const label = decision.handoff ? "SMS bot handoff" : "SMS bot, possible future deal";
      await ghl(env, `/contacts/${contactId}/notes`, "POST", { body: `${label}: ${decision.note}` });
    }
  }
}

type Decision = { reply: string; handoff: boolean; warm: boolean; note: string };

const REPLY_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      reply: { type: "string", description: "The next text message to send, or empty to send nothing." },
      handoff: { type: "boolean", description: "True when a human should take over now." },
      warm: {
        type: "boolean",
        description: "True when the agent may have a property later (e.g. 'maybe one next month') but nothing is ready yet.",
      },
      note: {
        type: "string",
        description: "When handoff or warm is true: for warm, one line on what they might have and when; for handoff, one or two lines for the human with the address, listing price, condition and seller's asking price learned so far. Else empty.",
      },
    },
    required: ["reply", "handoff", "warm", "note"],
    additionalProperties: false,
  },
};

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

  const userTurn: Anthropic.Beta.BetaMessageParam = {
    role: "user",
    content: `About this agent:\n${about || "(nothing on file)"}\n\nSMS thread so far, oldest first:\n${transcript}\n\nWrite our next text.`,
  };
  let messages: Anthropic.Beta.BetaMessageParam[] = [userTurn];
  let response: Anthropic.Beta.BetaMessage;
  for (let turn = 0; ; turn++) {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // Lets Claude look up a listing the agent sends (Zillow, Realtor.com, Redfin, ...) and nearby sales for ARV.
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 6, user_location: { type: "approximate", city: "Nashville", region: "Tennessee", country: "US" } },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3 },
      ],
      output_config: { effort: "low", format: REPLY_FORMAT },
      system: systemPrompt(env),
      messages,
    });
    // A long lookup can pause; resend with the partial turn and the server picks up where it left off.
    if (response.stop_reason !== "pause_turn" || turn >= 3) break;
    messages = [userTurn, { role: "assistant", content: response.content }];
  }

  if (response.stop_reason === "refusal") {
    console.warn("refused", response.stop_details);
    return { reply: "", handoff: true, warm: false, note: "Bot could not answer this one." };
  }
  // The JSON answer is the last text block; earlier ones can be notes around the web lookups.
  const texts = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text");
  const last = texts[texts.length - 1];
  if (!last) return null;
  return JSON.parse(last.text) as Decision;
}

function systemPrompt(env: Env): string {
  return SYSTEM_PROMPT.replaceAll("{{GOAL}}", env.BOT_GOAL)
    .replaceAll("{{NAME}}", env.SENDER_NAME)
    .replaceAll("{{ARV_PERCENT}}", env.ARV_PERCENT)
    .replaceAll("{{FEE}}", Number(env.ASSIGNMENT_FEE).toLocaleString("en-US"))
    .replaceAll("{{PROPERTY_TYPES}}", env.PROPERTY_TYPES);
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
