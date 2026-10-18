// SMS reply bot: GoHighLevel sends a webhook when a lead texts back, this Worker
// reads the SMS thread from GHL, asks Claude for the next reply, and texts it back.
// When the lead is ready for a human (or asks for one), it tags them and goes quiet.
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt";

export interface Env {
  ANTHROPIC_API_KEY: string;
  SLACK_WEBHOOK_URL?: string; // optional: qualified leads are posted to this Slack channel
  GHL_TOKEN: string;
  GHL_LOCATION_ID: string;
  WEBHOOK_SECRET: string; // must match ?key= on the webhook URL set in GHL
  BOT_GOAL: string; // plain-English goal, set in wrangler.toml
  SENDER_NAME: string; // the first name the bot signs as
  ARV_PERCENT: string; // max offer = ARV x this % - repairs - fee
  ASSIGNMENT_FEE: string; // our wholesale fee in dollars
  PROPERTY_TYPES: string; // what we buy
  QUALIFY_PERCENT: string; // qualified = asking at or under this % of Zestimate
  DRY_RUN?: string; // "true" = log the reply instead of texting it
}

const GHL = "https://services.leadconnectorhq.com";
const MODEL = "claude-opus-5-5";
const HANDOFF_TAG = "hot-lead"; // bot stops and you take over
const WARM_TAG = "warm-lead"; // has something coming later; bot keeps talking
const OPTED_OUT_TAG = "opted-out"; // asked us to stop: never text again
const BOT_OFF_TAGS = ["hot-lead", "bot-off", "dnd-skipped", OPTED_OUT_TAG]; // bot never replies to these
// Clear opt-outs ("STOP", "remove me", "don't text me", ...). Subtler ones are caught by Claude (optout).
const OPT_OUT =
  /^\s*(stop\w*|stop all|unsubscribe|cancel|end|quit|opt[\s-]?out|remove)\s*[.!]*\s*$|\b(remove me|take me off|unsubscribe|opt(ed)?[\s-]?out|stop (texting|messaging|contacting)|(do not|don'?t) (text|message|contact)|lose (this|my) number|wrong number)\b/i;
const QUALIFIED_TAG = "qualified-lead"; // asking under Zestimate, seller vetted
const NOT_QUALIFIED_TAG = "not-qualified";
const MAX_HISTORY = 40;
const REPLIED_TAG = "agent-replied"; // anyone who has texted back; counted in the weekly scorecard
const REPLY_DELAY_MS = 20_000; // replies go out no sooner than this after their text
// Check-ins: "maybe next month" / "let me see what I can find" gets a tag like follow-up-2026-10-23 (Central date).
// A cron (wrangler.toml) texts everyone whose date has come, if they haven't texted since.
const FOLLOW_UP_PREFIX = "follow-up-";
const CHECKED_IN_TAG = "checked-in"; // got a check-in and hasn't replied yet; at most one more is scheduled
const CHECKINS_PER_RUN = 5; // each check-in uses ~8 Cloudflare subrequests (50 per run on the free plan)
const LOOKBACK_DAYS = 14; // also catch check-ins a missed or full run left behind

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
      return new Response(`error: ${String(e).slice(0, 1500)}`, { status: 500 });
    }
    return new Response("ok");
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCheckIns(env));
  },
};

/** YYYY-MM-DD in Central time, `days` from now. */
function centralDate(days = 0): string {
  return new Date(Date.now() + days * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

async function runCheckIns(env: Env): Promise<void> {
  let sent = 0;
  for (let back = LOOKBACK_DAYS; back >= 0 && sent < CHECKINS_PER_RUN; back--) {
    const tag = FOLLOW_UP_PREFIX + centralDate(-back);
    const res = await ghl(env, "/contacts/search", "POST", {
      locationId: env.GHL_LOCATION_ID, page: 1, pageLimit: CHECKINS_PER_RUN,
      filters: [{ field: "tags", operator: "contains", value: tag }],
    });
    for (const c of res.contacts ?? []) {
      if (sent >= CHECKINS_PER_RUN) break;
      try {
        if (await checkIn(c.id, tag, env)) sent++;
      } catch (e) {
        console.error("check-in failed", c.id, e);
      }
    }
  }
  console.log("check-ins sent:", sent);
}

/** Text a scheduled check-in to one contact. Returns true if a text went out. */
async function checkIn(contactId: string, dueTag: string, env: Env): Promise<boolean> {
  const contact = (await ghl(env, `/contacts/${contactId}`)).contact ?? {};
  const tags: string[] = (contact.tags ?? []).map((t: string) => t.toLowerCase());
  const followUps = tags.filter((t) => t.startsWith(FOLLOW_UP_PREFIX));
  await ghl(env, `/contacts/${contactId}/tags`, "DELETE", { tags: followUps.length ? followUps : [dueTag] });
  if (BOT_OFF_TAGS.some((t) => tags.includes(t)) || contact.dnd || contact.dndSettings?.SMS?.status === "active") return false;
  const thread = await smsThread(contactId, env);
  // If their last text is still unanswered, the reply webhook handles it instead.
  if (!thread.length || thread[thread.length - 1].direction !== "outbound") return false;

  const decision = await nextReply(thread, contact, env, true);
  if (!decision?.reply.trim() || decision.optout || decision.handoff) return false;
  if (env.DRY_RUN === "true") {
    await ghl(env, `/contacts/${contactId}/notes`, "POST", { body: `SMS bot (test mode, not sent) check-in: ${decision.reply.trim()}` });
  } else {
    await sendSms(contactId, decision.reply.trim(), thread, contact, env);
  }
  // One more check-in at most if they stay quiet, so nobody gets chased forever.
  const again = !tags.includes(CHECKED_IN_TAG) && decision.follow_up_days > 0;
  const add = [CHECKED_IN_TAG, ...(again ? [FOLLOW_UP_PREFIX + centralDate(Math.min(decision.follow_up_days, 120))] : [])];
  await ghl(env, `/contacts/${contactId}/tags`, "POST", { tags: add });
  return true;
}

/** Text them, and if the carrier blocks it as spam (error 30007), rewrite it plainly and try once more. */
async function sendSms(contactId: string, text: string, thread: Sms[], contact: Record<string, any>, env: Env): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const sent = await ghl(env, "/conversations/messages", "POST", { type: "SMS", contactId, message: text });
    const status = await deliveryStatus(sent.conversationId, sent.messageId, env);
    if (!status || !/30007|carrier/i.test(status.error ?? "")) return;
    console.warn("carrier blocked text to", contactId, ":", text);
    await ghl(env, `/contacts/${contactId}/notes`, "POST", { body: `SMS bot: carrier blocked this text as spam (30007): "${text}"` });
    await ghl(env, `/contacts/${contactId}/tags`, "POST", { tags: ["carrier-blocked"] });
    if (attempt >= 1) return;
    const redo = await nextReply(thread, contact, env, false, text);
    if (!redo?.reply.trim() || redo.optout) return;
    text = redo.reply.trim();
  }
}

/** Wait for the carrier's verdict on a message we just sent (it lands a few seconds later). */
async function deliveryStatus(conversationId: string, messageId: string, env: Env): Promise<{ status: string; error?: string } | null> {
  if (!conversationId || !messageId) return null;
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const data = await ghl(env, `/conversations/${conversationId}/messages?limit=5`);
    const m = (data.messages?.messages ?? data.messages ?? []).find((x: any) => x.id === messageId);
    if (m && m.status !== "pending" && m.status !== "sent" && m.status !== "queued") return { status: m.status, error: m.error };
    if (m?.error) return { status: m.status, error: m.error };
  }
  return null;
}

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
  if (OPT_OUT.test(last.body)) {
    await optOut(contactId, env, last.body);
    return;
  }

  if (!tags.includes(REPLIED_TAG)) await ghl(env, `/contacts/${contactId}/tags`, "POST", { tags: [REPLIED_TAG] });
  // They texted back: any planned check-in is replaced by whatever this reply decides.
  const stale = tags.filter((t) => t.startsWith(FOLLOW_UP_PREFIX) || t === CHECKED_IN_TAG);
  if (stale.length) await ghl(env, `/contacts/${contactId}/tags`, "DELETE", { tags: stale });

  const decision = await nextReply(thread, contact, env);
  if (!decision) return;
  if (decision.optout) {
    await optOut(contactId, env, last.body);
    return;
  }
  // Zack wants replies to land about 20 seconds after their text, like a person typing back.
  const wait = REPLY_DELAY_MS - (Date.now() - Date.parse(last.at));
  if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, REPLY_DELAY_MS)));
  // Writing a reply takes a while; if GHL retried meanwhile and that copy already answered,
  // or the agent texted again (a newer webhook will answer both), don't send this one.
  const now = await smsThread(contactId, env);
  const newest = now[now.length - 1];
  if (!newest || newest.direction !== "inbound" || newest.at !== last.at) {
    console.log("skip: thread moved on while writing the reply for", contactId);
    return;
  }

  if (decision.reply.trim()) {
    if (env.DRY_RUN === "true") {
      // Test mode: nothing is texted; the reply shows up as a note on the contact in GHL.
      console.log("DRY RUN reply to", contactId, ":", decision.reply);
      await ghl(env, `/contacts/${contactId}/notes`, "POST", {
        body: `SMS bot (test mode, not sent) would reply: ${decision.reply.trim()}`,
      });
    } else await sendSms(contactId, decision.reply.trim(), thread, contact, env);
  }
  const newTags: string[] = [];
  if (decision.handoff) newTags.push(HANDOFF_TAG);
  else if (decision.warm) newTags.push(WARM_TAG);
  if (decision.deal === "qualified") newTags.push(QUALIFIED_TAG);
  if (decision.deal === "not_qualified") newTags.push(NOT_QUALIFIED_TAG);
  if (decision.follow_up_days > 0 && !decision.handoff && decision.deal !== "qualified") {
    newTags.push(FOLLOW_UP_PREFIX + centralDate(Math.min(decision.follow_up_days, 120)));
  }
  if (newTags.length) {
    await ghl(env, `/contacts/${contactId}/tags`, "POST", { tags: newTags });
    if (decision.note) {
      const label = decision.handoff ? "SMS bot handoff"
        : decision.deal === "not_qualified" ? "SMS bot, did not qualify" : "SMS bot, possible future deal";
      await ghl(env, `/contacts/${contactId}/notes`, "POST", { body: `${label}: ${decision.note}` });
    }
  }
  // Qualified leads, and any handoff about a specific house (e.g. the agent asks for an offer), go to Slack.
  const qualified = decision.deal === "qualified";
  if (qualified || (decision.handoff && decision.lead?.address?.trim())) {
    const card = qualifiedLeadCard(decision.lead, contact, contactId, env, qualified);
    await ghl(env, `/contacts/${contactId}/notes`, "POST", { body: card.replace(/[*_]/g, "") });
    if (env.SLACK_WEBHOOK_URL) {
      const res = await fetch(env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: card }),
      });
      if (!res.ok) console.error("slack post failed", res.status, await res.text());
    }
  }
}

type Lead = Record<(typeof LEAD_FIELDS)[number], string>;
const LEAD_FIELDS = [
  "address", "asking_price", "zestimate", "percent_of_zestimate", "market_status", "condition",
  "beds_baths_sqft", "year_built", "occupancy", "motivation", "timeline", "arv_range", "repairs",
  "max_offer", "opening_offer", "call_script", "summary",
] as const;

/** The "New qualified lead" message: posted to Slack and saved as a note on the contact. */
function qualifiedLeadCard(lead: Lead, contact: Record<string, any>, contactId: string, env: Env, qualified = true): string {
  const v = (k: keyof Lead) => (lead?.[k] || "").trim() || "unknown";
  const agent = [contact.firstName && `${contact.firstName} ${contact.lastName ?? ""}`.trim(), contact.companyName, contact.phone]
    .filter(Boolean).join(" · ");
  const link = `https://app.gohighlevel.com/v2/location/${env.GHL_LOCATION_ID}/contacts/detail/${contactId}`;
  // Blank lines between sections so it's easy to scan in Slack.
  return [
    `${qualified ? "🏠 *New qualified lead*" : "🔥 *Agent wants you on this one*"}\n*${v("address")}*`,
    `💰 *Asking:* ${v("asking_price")}\n📊 *Zestimate:* ${v("zestimate")} (asking is ${v("percent_of_zestimate")})\n📍 *Status:* ${v("market_status")}`,
    `🔧 *Condition:* ${v("condition")}\n🏡 *Property:* ${v("beds_baths_sqft")} · built ${v("year_built")} · ${v("occupancy")}`,
    `🙋 *Seller:* ${v("motivation")}\n⏱️ *Timeline:* ${v("timeline")}`,
    `🧮 *Rough numbers*\nARV: ${v("arv_range")}\nRepairs: ${v("repairs")}\nMax offer: ${v("max_offer")}`,
    `🤝 *Make the offer*\nOpen at: ${v("opening_offer")}\nWhat to say: ${v("call_script")}`,
    `👤 *Agent:* ${agent || "unknown"}`,
    `${qualified ? "✅ *Why it qualifies:*" : "📝 *What's going on:*"} ${v("summary")}`,
    `<${link}|Open in GHL>`,
  ].join("\n\n");
}

type Decision = {
  reply: string; handoff: boolean; warm: boolean; optout: boolean; deal: string; note: string; lead: Lead;
  follow_up_days: number;
};

/** They asked us to stop: no reply, tag them, and turn on SMS Do Not Disturb so nothing texts them again. */
async function optOut(contactId: string, env: Env, text: string): Promise<void> {
  console.log("opt-out from", contactId);
  await ghl(env, `/contacts/${contactId}/tags`, "POST", { tags: [OPTED_OUT_TAG] });
  await ghl(env, `/contacts/${contactId}`, "PUT", { dndSettings: { SMS: { status: "active", message: "Opted out by text" } } });
  await ghl(env, `/contacts/${contactId}/notes`, "POST", { body: `SMS bot: opted out, no more texts. They said: "${text.slice(0, 200)}"` });
}

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
      optout: {
        type: "boolean",
        description: "True when they ask us to stop texting, remove them, or say it's the wrong number. Then reply must be empty.",
      },
      follow_up_days: {
        type: "integer",
        description: "Days until a check-in text if they don't text first, when they might have something later or need time: 'let me see what I can find' = 4, 'maybe next week' = 7, 'next month' = 30, 'after the holidays' = until then (max 120). 0 = no check-in (handed off, not interested, opted out, or nothing pending).",
      },
      deal: {
        type: "string",
        enum: ["qualified", "not_qualified", "unknown"],
        description: "qualified = asking under the qualify % of Zestimate and we know why they are selling; not_qualified = we know enough and it fails; unknown = still learning.",
      },
      lead: {
        type: "object",
        description: "Fill in when deal is qualified, or when you hand off about a specific property (e.g. they want an offer); short values, e.g. \"$145,000\", \"52%\", \"Off-market\". Otherwise empty strings.",
        properties: Object.fromEntries(LEAD_FIELDS.map((f) => [f, { type: "string" }])),
        required: [...LEAD_FIELDS],
        additionalProperties: false,
      },
      note: {
        type: "string",
        description: "When handoff or warm is true: for warm, one line on what they might have and when; for handoff, one or two lines for the human with the address, listing price, condition and seller's asking price learned so far. Else empty.",
      },
    },
    required: ["reply", "handoff", "warm", "optout", "follow_up_days", "deal", "lead", "note"],
    additionalProperties: false,
  },
};

async function nextReply(
  thread: Sms[], contact: Record<string, any>, env: Env, checkIn = false, blocked = "",
): Promise<Decision | null> {
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
    content: `About this agent:\n${about || "(nothing on file)"}\n\nSMS thread so far, oldest first:\n${transcript}\n\n${checkIn ? CHECK_IN_ASK.replace("{{TODAY}}", centralDate()) : "Write our next text."}${blocked ? `\n\nThe carrier just blocked this text as spam: "${blocked}". Say the same thing in different, plain everyday words. Avoid "cash", "buy houses", "as-is", "close fast", "investor", "deal" and anything that sounds like an ad.` : ""}`,
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
        { type: "web_search_20260209", name: "web_search", max_uses: 6, user_location: { type: "approximate", city: contact.city || "Nashville", region: contact.state || "TN", country: "US" } },
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
    return { reply: "", handoff: true, warm: false, optout: false, follow_up_days: 0, deal: "unknown", note: "Bot could not answer this one.", lead: {} as Lead };
  }
  // The JSON answer is the last text block; earlier ones can be notes around the web lookups.
  const texts = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text");
  const last = texts[texts.length - 1];
  if (!last) return null;
  return JSON.parse(last.text) as Decision;
}

const CHECK_IN_ASK = `Today is {{TODAY}}. The agent hasn't texted since, and it's time for the check-in you planned. Write one short, casual follow-up that picks up on what they said (for example "Hey Sarah, checking back on that seller who was thinking about selling. Anything firm up?"). Don't repeat earlier wording or re-introduce yourself. If a check-in no longer makes sense (they said no, or nothing was pending), return an empty reply. Set follow_up_days for one more check-in only if their timing points to a later date; otherwise 0.`;

function systemPrompt(env: Env): string {
  return SYSTEM_PROMPT.replaceAll("{{GOAL}}", env.BOT_GOAL)
    .replaceAll("{{NAME}}", env.SENDER_NAME)
    .replaceAll("{{ARV_PERCENT}}", env.ARV_PERCENT)
    .replaceAll("{{FEE}}", Number(env.ASSIGNMENT_FEE).toLocaleString("en-US"))
    .replaceAll("{{PROPERTY_TYPES}}", env.PROPERTY_TYPES)
    .replaceAll("{{QUALIFY_PERCENT}}", env.QUALIFY_PERCENT || "55");
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
