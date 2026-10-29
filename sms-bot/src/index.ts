// SMS reply bot: GoHighLevel sends a webhook when a lead texts back, this Worker
// reads the SMS thread from GHL, asks Claude for the next reply, and texts it back.
// When the lead is ready for a human (or asks for one), it tags them and goes quiet.
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt";

export interface Env {
  ANTHROPIC_API_KEY: string;
  SLACK_WEBHOOK_URL?: string; // optional: qualified leads are posted to this Slack channel
  APIFY_TOKEN?: string; // Zillow lookups through Apify (exact Zestimate + Zillow link)
  GHL_TOKEN: string;
  GHL_LOCATION_ID: string;
  WEBHOOK_SECRET: string; // must match ?key= on the webhook URL set in GHL
  BOT_GOAL: string; // plain-English goal, set in wrangler.toml
  SENDER_NAME: string; // the first name the bot signs as
  SENDER_EMAIL?: string; // given only when an agent would rather email documents than text them
  ARV_PERCENT: string; // max offer = ARV x this % - repairs - fee
  ASSIGNMENT_FEE: string; // our wholesale fee in dollars
  PROPERTY_TYPES: string; // what we buy
  QUALIFY_PERCENT: string; // qualified = asking at or under this % of Zestimate (off-market)
  LISTED_QUALIFY_PERCENT?: string; // listed on the MLS: seller must take this % of Zestimate or less
  DRY_RUN?: string; // "true" = log the reply instead of texting it
  SLACK_BOT_TOKEN?: string; // Slack app "Offer Bot": reads Zack's replies on lead cards (Zack 2026-10-29)
  SLACK_SIGNING_SECRET?: string;
  SLACK_ZACK_USER?: string; // only this Slack user's "yes" / number sends an offer
}

const GHL = "https://services.leadconnectorhq.com";
const MODEL = "claude-sonnet-5-5"; // Zack 2026-10-20: keep API costs down
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
const CHECKED_IN_TAG = "checked-in"; // got a check-in and hasn't replied yet
const CHECKED_IN_2_TAG = "checked-in-2"; // got a second unanswered check-in; one last one is scheduled
const CHECKINS_PER_RUN = 12; // each check-in uses ~8 Cloudflare subrequests (paid plan allows 1,000 per run)
const LOOKBACK_DAYS = 14; // also catch check-ins a missed or full run left behind

type Sms = { direction: "inbound" | "outbound"; body: string; at: string; media?: string[] };
const MAX_PHOTOS = 6; // newest photos the bot looks at each reply (each costs ~1-2k tokens)

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET") return new Response("sms bot ok");
    if (url.pathname === "/slack") return slackEvent(req, env, ctx);
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

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(event.cron === SWEEP_CRON ? answerMissed(env) : event.cron === OFFER_CRON ? runOfferFollowUps(env) : runCheckIns(env));
  },
};

const OUTREACH_TAG = "apify-daily-lead"; // the GHL bot workflow only fires for these contacts
const SWEEP_CRON = "*/3 * * * *"; // must match wrangler.toml
const SWEEP_PER_RUN = 3; // replies per sweep (stays within Cloudflare's per-run request limit)
const SWEEP_LOOKUPS = 15; // contact reads per sweep, for conversations GHL returns without tags
const SEEN_PREFIX = "bot-seen-"; // + the time of the last text the sweep handled
const OFFER_CRON = "5 14-23 * * *"; // must match wrangler.toml
// Zack's offer texts ("Offer on: ... Purchase Price: $46,500"). The bot itself never names a price.
const OFFER_RE = /purchase price|offer on:|\b(my|our) offer\b.{0,40}\$\s?\d|\boffer(ing)? (of |is |at )?\$\s?\d|\$\s?\d[\d,.]*k?\s+(cash )?offer\b/i;
const OFFER_CHECKS_PER_RUN = 12; // handed-off leads checked per hourly run (2 requests each)
const OFFER_NUDGES_PER_RUN = 3;

/** Safety net: answer agents whose text never reached us (GHL webhook missed or failed). */
async function answerMissed(env: Env): Promise<void> {
  const hour = Number(new Date().toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }));
  if (hour < 8 || hour >= 21) return; // no texts late at night
  // Ask GHL for conversations whose last message is an inbound text. The newest 40 conversations of any
  // kind weren't enough: right after the daily blast, 1,000 outbound texts push every reply out of that
  // window, and replies went unanswered for hours (Tajuania Lawson's off-market house, 2026-10-23).
  const base = `/conversations/search?locationId=${env.GHL_LOCATION_ID}&sortBy=last_message_date&sort=desc&limit=100`;
  let convs: any[] = [];
  try {
    convs = (await ghl(env, `${base}&lastMessageDirection=inbound`)).conversations ?? [];
  } catch (e) {
    console.warn("inbound filter refused, paging instead", e);
  }
  // If GHL ignored or refused the filter, page back through the last day of conversations instead.
  if (!convs.length || convs.some((c) => c.lastMessageDirection !== "inbound")) {
    convs = [];
    let after = "";
    for (let page = 0; page < 6; page++) {
      const batch: any[] = (await ghl(env, base + (after ? `&startAfterDate=${after}` : ""))).conversations ?? [];
      convs.push(...batch);
      const last = batch[batch.length - 1];
      if (batch.length < 100 || !last || Date.now() - Number(last.lastMessageDate) > 72 * 3600_000) break;
      after = String(last.lastMessageDate);
    }
  }
  // Only texts the bot actually worked on count toward the per-run limit, and each one is worked on once:
  // afterwards the sweep tags the contact bot-seen-<time of that text> and skips texts it already tagged.
  // Before (2026-10-23) the newest few (an opted-out "Stop", a hot lead, an "ok" the bot lets go) used up
  // every run's slots and were re-sent to Claude every 3 minutes, so older real replies went unanswered.
  // It used to mark the conversation read instead, but Zack uses unread to see who he hasn't answered
  // (2026-10-26), so the sweep never touches GHL's read status.
  let answered = 0;
  let lookups = 0;
  for (const c of convs) {
    if (answered >= SWEEP_PER_RUN || lookups >= SWEEP_LOOKUPS) break;
    const age = Date.now() - Number(c.lastMessageDate);
    if (c.lastMessageDirection !== "inbound" || !/SMS/i.test(c.lastMessageType ?? "")) continue;
    // Give the live webhook time first. A reply with Zillow and comp lookups can run past GHL's webhook
    // timeout and get cut off (David Lorrison, 2026-10-20), so this sweep is the backstop.
    if (!(age > 4 * 60_000 && age < 72 * 3600_000)) continue; // a late answer beats none; Claude skips "ok"/"thanks"
    if (c.tags && !c.tags.some((t: string) => t.toLowerCase() === OUTREACH_TAG)) continue;
    let tags: string[] = c.tags ?? [];
    if (!c.tags) {
      lookups++;
      try {
        tags = (await ghl(env, `/contacts/${c.contactId}`)).contact?.tags ?? [];
      } catch (e) {
        console.error("sweep couldn't read contact", c.contactId, e);
        continue;
      }
      if (!tags.some((t) => t.toLowerCase() === OUTREACH_TAG)) continue;
    }
    const seen = `${SEEN_PREFIX}${c.lastMessageDate}`;
    if (tags.includes(seen)) continue;
    try {
      console.log("sweep: answering missed text from", c.contactId);
      if (await handleReply(c.contactId, env, true)) answered++;
    } catch (e) {
      console.error("sweep reply failed", c.contactId, e);
    }
    try {
      const old = tags.filter((t) => t.startsWith(SEEN_PREFIX));
      if (old.length) await ghl(env, `/contacts/${c.contactId}/tags`, "DELETE", { tags: old });
      await ghl(env, `/contacts/${c.contactId}/tags`, "POST", { tags: [seen] });
    } catch (e) {
      console.error("couldn't tag contact as seen", c.contactId, e);
    }
  }
}

/** Zack 2026-10-20: after he texts an offer, follow up within 24 hours if the agent doesn't answer,
 *  once more 2 days after that, then stop. Any reply from the agent leaves it to Zack.
 *  Handed-off leads are few, so each hourly run checks a slice of them in rotation. */
async function runOfferFollowUps(env: Env): Promise<void> {
  const hour = Number(new Date().toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }));
  if (hour < 9 || hour >= 18) return;
  await sendPendingOffers(env).catch((e) => console.error("pending offers failed", e));
  const res = await ghl(env, "/contacts/search", "POST", {
    locationId: env.GHL_LOCATION_ID, page: 1, pageLimit: 100,
    filters: [{ field: "tags", operator: "contains", value: HANDOFF_TAG }],
  });
  const all: any[] = res.contacts ?? [];
  const start = all.length ? ((hour - 9) * OFFER_CHECKS_PER_RUN) % all.length : 0;
  const slice = [...all.slice(start), ...all.slice(0, start)].slice(0, OFFER_CHECKS_PER_RUN);
  let sent = 0;
  for (const c of slice) {
    if (sent >= OFFER_NUDGES_PER_RUN) break;
    try {
      if (await offerFollowUp(c, env)) sent++;
    } catch (e) {
      console.error("offer follow-up failed", c.id, e);
    }
  }
  console.log("offer follow-ups sent:", sent, "of", slice.length, "checked");
}

async function offerFollowUp(contact: any, env: Env): Promise<boolean> {
  const tags: string[] = (contact.tags ?? []).map((t: string) => t.toLowerCase());
  if (["bot-off", "dnd-skipped", OPTED_OUT_TAG].some((t) => tags.includes(t)) || contact.dnd ||
      contact.dndSettings?.SMS?.status === "active") return false;
  const thread = await smsThread(contact.id, env);
  let i = thread.length - 1;
  while (i >= 0 && !(thread[i].direction === "outbound" && OFFER_RE.test(thread[i].body))) i--;
  if (i < 0) return false; // no offer yet
  const after = thread.slice(i + 1);
  if (after.some((m) => m.direction === "inbound")) return false; // they answered: Zack's turn
  const nudges = after.length;
  if (nudges >= 2) return false;
  const quietFor = Date.now() - Date.parse(thread[thread.length - 1].at);
  if (quietFor < (nudges === 0 ? 22 : 48) * 3600_000 || quietFor > 10 * 86400_000) return false;
  const first = (contact.firstName || "").trim().split(/\s+/)[0] || "there";
  const name = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  const addr = (thread[i].body.match(/offer on:?\s*([^\n]+)/i)?.[1] || "").replace(/,?\s*[A-Z]{2}\s*\d{5}.*$/, "").trim();
  const text = nudges === 0
    ? `Hi ${name}, just following up on my offer${addr ? ` on ${addr}` : ""}. Has the seller had a chance to look at it?`
    : `Hi ${name}, checking back on ${addr || "my offer"}. Is the seller open to it, or is there a number that would get it done?`;
  if (env.DRY_RUN === "true") {
    await ghl(env, `/contacts/${contact.id}/notes`, "POST", { body: `SMS bot (test mode, not sent) offer follow-up: ${text}` });
  } else await sendSms(contact.id, text, thread, contact, env);
  return true;
}

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
  // Up to three check-ins in a row if they stay quiet (Zack 2026-10-27: keep hunting the "maybe soon" agents),
  // the last one at least two weeks out, so nobody gets chased forever.
  const second = tags.includes(CHECKED_IN_TAG), third = tags.includes(CHECKED_IN_2_TAG);
  const days = Math.min(Math.max(decision.follow_up_days || 7, second ? 14 : 7), 120);
  const add = [second ? CHECKED_IN_2_TAG : CHECKED_IN_TAG, ...(!third ? [FOLLOW_UP_PREFIX + centralDate(days)] : [])];
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

/** Answer the agent's newest text. outreachOnly: skip anyone not in the outreach (used by the sweep). */
async function handleReply(contactId: string, env: Env, outreachOnly = false): Promise<boolean> {
  const contact = (await ghl(env, `/contacts/${contactId}`)).contact ?? {};
  const tags: string[] = (contact.tags ?? []).map((t: string) => t.toLowerCase());
  if (outreachOnly && !tags.includes(OUTREACH_TAG)) return false;
  if (BOT_OFF_TAGS.some((t) => tags.includes(t)) || contact.dnd || contact.dndSettings?.SMS?.status === "active") {
    console.log("skip: bot off for", contactId);
    return false;
  }

  const thread = await smsThread(contactId, env);
  const last = thread[thread.length - 1];
  if (!last || last.direction !== "inbound") {
    console.log("skip: nothing new from", contactId); // already answered (duplicate webhook)
    return false;
  }
  if (OPT_OUT.test(last.body)) {
    await optOut(contactId, env, last.body);
    return true;
  }

  if (!tags.includes(REPLIED_TAG)) await ghl(env, `/contacts/${contactId}/tags`, "POST", { tags: [REPLIED_TAG] });
  // They texted back: any planned check-in is replaced by whatever this reply decides.
  const stale = tags.filter((t) => t.startsWith(FOLLOW_UP_PREFIX) || t === CHECKED_IN_TAG || t === CHECKED_IN_2_TAG);
  if (stale.length) await ghl(env, `/contacts/${contactId}/tags`, "DELETE", { tags: stale });

  let decision = await nextReply(thread, contact, env);
  if (!decision) return true;
  applyDealRules(decision, contactId, env);
  // "I'll run the numbers" is only for leads that go to Zack in Slack (Zack 2026-10-22). If the bot
  // promised numbers on anything else, have it rewrite: keep vetting or pass on the price.
  if (decision.deal !== "qualified" && PROMISED_NUMBERS.test(decision.reply || "")) {
    console.log("promised numbers on a non-qualified lead, rewriting", contactId, decision.reply);
    decision = (await nextReply(thread, contact, env, false, "", NO_PROMISE_FIX.replace("{{REPLY}}", decision.reply).replace("{{LISTED_PERCENT}}", env.LISTED_QUALIFY_PERCENT || "60"))) ?? decision;
    applyDealRules(decision, contactId, env);
    if (decision.deal !== "qualified" && PROMISED_NUMBERS.test(decision.reply || "")) decision.reply = ""; // never send an empty promise
  }
  if (decision.optout) {
    await optOut(contactId, env, last.body);
    return true;
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
    return true;
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
  // Only qualified leads go to Slack (Zack 2026-10-20, again 2026-10-22). A handoff about a house that
  // doesn't qualify still gets the card as a GHL note so he can see it there.
  const qualified = decision.deal === "qualified";
  if (qualified || (decision.handoff && decision.lead?.address?.trim())) {
    const card = qualifiedLeadCard(decision.lead, contact, contactId, env, qualified);
    await ghl(env, `/contacts/${contactId}/notes`, "POST", { body: card.replace(/[*_]/g, "") });
    if (qualified && env.SLACK_WEBHOOK_URL) {
      const res = await fetch(env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: card }),
      });
      if (!res.ok) console.error("slack post failed", res.status, await res.text());
    }
  }
  return true;
}

/** Hard check on Zack's rules, in case the model calls a lead qualified when it isn't. Listed houses
 *  never qualify (Zack 2026-10-25). Off-market price never blocks a lead: Zack offers at the card's max
 *  offer (Zack 2026-10-26: "I need leads so I can make offers"). */
function applyDealRules(decision: Decision, contactId: string, env: Env): void {
  // Zack 2026-10-27 evening: "don't send me stuff that's on market anymore". Listed houses never qualify.
  void env;
  if (decision.deal === "qualified" && isListed(decision.lead)) {
    console.log("listed house can't qualify", contactId, decision.lead?.market_status);
    decision.deal = "not_qualified";
    decision.handoff = false;
    decision.note = `Listed on the MLS, Zack only buys off-market. ${decision.note || ""}`;
  }
}

const NO_PROMISE_FIX = `Your draft was: "{{REPLY}}". Don't tell the agent you'll run numbers, send a number or get them an offer: that's only said on leads that qualify and go to Zack. Rewrite it. If you still need info (photos, condition, asking price, why they're selling, timeline), ask your next question. If there's a real house with an address and the seller might take less and it is OFF-MARKET (off-market with a price or reason, needs work, or motivated), it qualifies. A house listed on the MLS never qualifies: pass with a short thanks: set deal = "qualified" and say you're running the numbers. Otherwise ask your next question, or if it's junk (wholesaler, multifamily, auction, no property) end with a short thanks and no "send it my way".`;
// "I'll run the numbers", "let me crunch numbers", "I'll get you an offer", "get back to you with a number" ...
const PROMISED_NUMBERS =
  /\b(run(ning)?|crunch(ing)?|work(ing)? up|put together|look(ing)? at) (the |some )?(numbers|comps|an offer|a number|figures)\b|\b(get|send|have) (you |back to you with |over )?(an offer|a number|my number|numbers|an? (cash )?offer)\b|\bget back to you (shortly |soon |today |tomorrow )?with\b/i;

/** First dollar amount in a string like "$475,000", "475k", "unknown on Zillow, Redfin Estimate $240k". */
function dollars(s?: string): number | null {
  const m = (s || "").replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d+)?)\s*([km])?\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]) * (m[2]?.toLowerCase() === "m" ? 1e6 : m[2]?.toLowerCase() === "k" ? 1e3 : 1);
  return n >= 10000 ? n : null; // ignore things like "3 beds"
}

/** True when the house is clearly on the MLS (active, pending, coming soon, back on market). */
function isListed(lead: Lead | undefined): boolean {
  const st = lead?.market_status || "";
  return !/off/i.test(st) && /listed|active|mls|pending|coming soon|back on market|for sale/i.test(st);
}

type Lead = Record<(typeof LEAD_FIELDS)[number], string>;
const LEAD_FIELDS = [
  "address", "listing_url", "asking_price", "zestimate", "percent_of_zestimate", "market_status", "condition",
  "beds_baths_sqft", "sqft", "year_built", "occupancy", "motivation", "timeline", "arv_range", "arv_value", "arv_comps",
  "repair_level", "repairs",
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
    `${qualified ? "🏠 *New qualified lead*" : "🔥 *Agent wants you on this one*"}\n*${v("address")}*${listingLink(lead?.listing_url, lead?.address)}`,
    `💰 *Asking:* ${v("asking_price")}\n📊 *Zestimate:* ${v("zestimate")} (asking is ${v("percent_of_zestimate")})\n📍 *Status:* ${v("market_status")}`,
    `🔧 *Condition:* ${v("condition")}\n🏡 *Property:* ${v("beds_baths_sqft")} · built ${v("year_built")} · ${v("occupancy")}`,
    `🙋 *Seller:* ${v("motivation")}\n⏱️ *Timeline:* ${v("timeline")}`,
    dealReport(lead, env),
    `👤 *Agent:* ${agent || "unknown"}`,
    `${qualified ? "✅ *Why it qualifies:*" : "📝 *What's going on:*"} ${v("summary")}`,
    `<${link}|Open in GHL>`,
    ...(qualified ? ["💬 Reply *yes* in this thread to send the opening offer, or reply a number (like 150k) to offer that instead."] : []),
  ].join("\n\n");
}

const REPAIR_PSF: Record<string, number> = { light: 15, medium: 30, heavy: 45, full_gut: 65 }; // same levels as the deal calculator
const EMD_PERCENT = 1; // earnest money deposit, % of our offer price (Zack 2026-10-22)
const CALCULATOR_URL = "https://claude.ai/artifact/N7qkPw3VY59ugckT9AhMvV";
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Zack's deal calculator, run on what the bot learned (Zack 2026-10-22): ARV = comps (never under
 *  the Zestimate), repairs = level x sqft, buyer pays ARV x 70% - repairs, max offer = buyer - fee - EMD (1% of offer),
 *  open ~10% under max. Falls back to the bot's rough numbers when it doesn't have enough to calculate. */
function dealReport(lead: Lead, env: Env): string {
  const v = (k: keyof Lead) => (lead?.[k] || "").trim() || "unknown";
  const num = (s?: string) => { const n = parseFloat((s || "").replace(/[$,\s]/g, "").replace(/k$/i, "000")); return isFinite(n) && n > 0 ? n : null; };
  const zest = dollars(lead?.zestimate), comps = dollars(lead?.arv_value) ?? dollars(lead?.arv_range);
  const sqft = num(lead?.sqft) ?? num((lead?.beds_baths_sqft || "").match(/([\d,]{3,6})\s*(sq|sf)/i)?.[1]);
  const asking = dollars(lead?.asking_price);
  const arv = Math.max(comps || 0, zest || 0) || null;
  const level = (lead?.repair_level || "").toLowerCase().replace(/[\s-]+/g, "_");
  const psf = REPAIR_PSF[level] ?? null;
  const repairs = psf && sqft ? Math.round(psf * sqft / 500) * 500 : dollars(lead?.repairs);
  const script = (o: string) => v("call_script").replace(/\{OFFER\}/g, o);
  if (!arv || repairs == null) {
    return `🧮 *Rough numbers* (not enough to run the calculator)\nARV: ${v("arv_range")}\nRepairs: ${v("repairs")}\nMax offer: ${v("max_offer")}\n\n🤝 *Make the offer*\nOpen at: ${v("opening_offer")}\nWhat to say: ${script(/^\$/.test(v("opening_offer")) ? v("opening_offer") : "[your number]")}`;
  }
  const pct = Number(env.ARV_PERCENT || "70"), fee = Number(env.ASSIGNMENT_FEE || "10000");
  const buyer = arv * pct / 100 - repairs, max = (buyer - fee) / (1 + EMD_PERCENT / 100), open = Math.floor(max * 0.9 / 500) * 500;
  const arvHow = comps && comps >= (zest || 0) ? `from sold comps${sqft && comps ? `, ~$${Math.round(comps / sqft)}/sqft` : ""}` : "Zestimate (comps came in lower)";
  const repHow = psf && sqft ? `${level.replace("_", " ")}, $${psf}/sqft × ${sqft.toLocaleString("en-US")} sqft` : "bot's estimate";
  let verdict = "";
  if (asking) {
    const spread = buyer - asking * (1 + EMD_PERCENT / 100);
    verdict = asking <= max ? `✅ Asking ${usd(asking)} is under your max. Fee at asking: ${usd(spread)}`
      : spread > 0 ? `⚠️ Asking ${usd(asking)} is ${usd(asking - max)} over your max. Fee at asking only ${usd(spread)}`
      : `❌ Asking ${usd(asking)} is ${usd(asking - max)} over your max. Seller needs to come down to ${usd(max)}`;
  }
  return [
    `🧮 *Deal calculator*`,
    `ARV: ${usd(arv)} (${arvHow})`,
    ...(lead?.arv_comps?.trim() && !/^unknown/i.test(lead.arv_comps) ? [`Comps: ${lead.arv_comps.trim()}`] : []),
    `Repairs: ${usd(repairs)} (${repHow})`,
    `Buyer pays: ${usd(buyer)} (${pct}% of ARV minus repairs)`,
    `Your fee: ${usd(fee)} · EMD ${usd(max * EMD_PERCENT / 100)} (${EMD_PERCENT}% of offer)`,
    `*Max offer: ${usd(max)}*`,
    ...(verdict ? [verdict] : []),
    `<${CALCULATOR_URL}|Adjust in the calculator>`,
    ``,
    open > 0 ? `🤝 *Pitch to the agent*\nOpen at: *${usd(open)}*\nWhat to say: ${script(usd(open))}`
      : `🤝 *Pitch to the agent*\nThe numbers come out under $0 at this ARV and repair level, so pick your own number.`,
  ].join("\n");
}

/** Clickable listing link on its own line under the address (Zack 2026-10-20: always Zillow when
 *  possible). With no Zillow URL, links a Zillow search for the address, which opens the home page. */
function listingLink(url?: string, address?: string): string {
  const u = (url || "").trim();
  const ok = /^https?:\/\/[^\s<>|]+$/i.test(u);
  if (ok && /zillow\./i.test(u)) return `\n🔗 <${u}|Click here to view on Zillow>`;
  const a = (address || "").trim();
  const zillow = a && !/^unknown/i.test(a)
    ? `\n🔗 <https://www.zillow.com/homes/${encodeURIComponent(a.replace(/[,#]/g, " ").replace(/\s+/g, "-"))}_rb/|Click here to view on Zillow>`
    : "";
  if (!ok) return zillow;
  const site = /realtor\.com/i.test(u) ? "Realtor.com" : /redfin\./i.test(u) ? "Redfin" : "the listing";
  return zillow + `\n🔗 <${u}|View on ${site}>`;
}

type Decision = {
  reply: string; handoff: boolean; warm: boolean; optout: boolean; deal: string; note: string; lead: Lead;
  follow_up_days: number;
};

/** They asked us to stop: no reply, tag them, and turn on SMS Do Not Disturb so nothing texts them again. */
async function optOut(contactId: string, env: Env, text: string): Promise<void> {
  console.log("opt-out from", contactId);
  await ghl(env, `/contacts/${contactId}/tags`, "POST", { tags: [OPTED_OUT_TAG] });
  // GHL sometimes refuses the SMS DND setting (401 "permanent dnd", 2026-10-23); fall back to plain DND,
  // and never let it stop the note. The opted-out tag alone already keeps the bot and check-ins away.
  try {
    await ghl(env, `/contacts/${contactId}`, "PUT", { dndSettings: { SMS: { status: "active", message: "Opted out by text" } } });
  } catch (e) {
    console.warn("SMS DND refused, setting DND", contactId, e);
    await ghl(env, `/contacts/${contactId}`, "PUT", { dnd: true }).catch((e2) => console.error("DND refused", contactId, e2));
  }
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
        description: "Days until a check-in text if they don't text first, when they might have something later or need time: 'let me see what I can find' = 4, 'maybe soon' or 'maybe' = 7, 'next week' = 7, 'nothing now, I'll keep you in mind' = 14, 'next month' = 30, 'after the holidays' = until then (max 120). If we're vetting a specific house and are waiting on their answer to our question, 1 (follow up tomorrow). 0 = no check-in (handed off, not interested, opted out, or nothing pending).",
      },
      deal: {
        type: "string",
        enum: ["qualified", "not_qualified", "unknown"],
        description: "qualified = asking under the qualify % of Zestimate (stricter for listed houses) and we know why they are selling; not_qualified = we know enough and it fails; unknown = still learning.",
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
  thread: Sms[], contact: Record<string, any>, env: Env, checkIn = false, blocked = "", fix = "",
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

  const photos = await threadPhotos(thread);
  const userTurn: Anthropic.Beta.BetaMessageParam = {
    role: "user",
    content: [
      ...(photos.length ? [{ type: "text" as const, text: `Photos the agent texted (newest ${photos.length}, oldest first):` }, ...photos] : []),
      { type: "text" as const, text: `About this agent:\n${about || "(nothing on file)"}\n\nSMS thread so far, oldest first:\n${transcript}\n\n${checkIn ? CHECK_IN_ASK.replace("{{TODAY}}", centralDate()) : "Write our next text."}${blocked ? `\n\nThe carrier just blocked this text as spam: "${blocked}". Say the same thing in different, plain everyday words. Avoid "cash", "buy houses", "as-is", "close fast", "investor", "deal" and anything that sounds like an ad.` : ""}${fix ? `\n\n${fix}` : ""}` },
    ],
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
        ...(env.APIFY_TOKEN ? [ZILLOW_TOOL] : []),
        { type: "web_search_20260209", name: "web_search", max_uses: 4, user_location: { type: "approximate", city: contact.city || "Nashville", region: contact.state || "TN", country: "US" } },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 2 },
      ],
      output_config: { effort: "low", format: REPLY_FORMAT },
      // The rulebook is the same on every reply, so cache it (cached input costs ~10%).
      system: [{ type: "text", text: systemPrompt(env), cache_control: { type: "ephemeral" } }],
      messages,
    });
    if (response.stop_reason === "tool_use" && turn < 6) {
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const b of response.content) {
        if (b.type !== "tool_use" || b.name !== "zillow_lookup") continue;
        const out = await zillowLookup(String((b.input as any)?.address ?? ""), env);
        results.push({ type: "tool_result", tool_use_id: b.id, content: out });
      }
      messages = [...messages, { role: "assistant", content: response.content }, { role: "user", content: results }];
      continue;
    }
    // A long lookup can pause; resend with the partial turn and the server picks up where it left off.
    if (response.stop_reason !== "pause_turn" || turn >= 6) break;
    messages = [...messages, { role: "assistant", content: response.content }];
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

/** The newest photos the agent texted, as image blocks Claude can look at (Zack 2026-10-22: condition
 *  and repair level come from photos). Downloaded here so a dead or non-image link can't break the reply. */
async function threadPhotos(thread: Sms[]): Promise<Anthropic.Beta.BetaImageBlockParam[]> {
  const urls = thread.filter((m) => m.direction === "inbound").flatMap((m) => m.media ?? []).slice(-MAX_PHOTOS);
  const out: Anthropic.Beta.BetaImageBlockParam[] = [];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!res.ok || !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(type)) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > 4_500_000) continue; // over the API's 5 MB image limit once encoded
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      out.push({ type: "image", source: { type: "base64", media_type: type as "image/jpeg", data: btoa(bin) } });
    } catch (e) {
      console.warn("photo fetch failed", url, e);
    }
  }
  return out;
}

const ZILLOW_TOOL: Anthropic.Beta.BetaToolUnion = {
  name: "zillow_lookup",
  description: "Look up a US home on Zillow by full street address (street, city, state, ZIP if known). Returns Zillow's exact Zestimate, the Zillow page URL, list price and status, beds/baths/sqft, year built, days on Zillow, last sale and tax value. Use it first for every property address; web search is the fallback.",
  input_schema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
};

/** Zillow data via Apify (Zillow blocks direct page reads, which is why Zestimates kept coming back unknown). */
async function zillowLookup(address: string, env: Env): Promise<string> {
  if (!address.trim()) return "No address given.";
  try {
    const res = await fetch(`https://api.apify.com/v2/acts/maxcopell~zillow-detail-scraper/run-sync-get-dataset-items?token=${env.APIFY_TOKEN}&timeout=90`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: [address], propertyStatus: "FOR_SALE" }),
    });
    if (!res.ok) return `Zillow lookup failed (HTTP ${res.status}); use web search instead.`;
    const it = ((await res.json()) as any[])[0];
    if (!it || it.isValid === false) return "Not found on Zillow; use web search instead.";
    const money = (v: any) => (typeof v === "number" ? `$${v.toLocaleString("en-US")}` : v?.amount ? `$${Number(v.amount).toLocaleString("en-US")}` : "unknown");
    return JSON.stringify({
      address: it.listingAddress ?? it.addressOrUrlFromInput, zillow_url: it.propertyUrl,
      zestimate: it.zestimate != null ? money(it.zestimate) : "Zillow shows no Zestimate for this home",
      status: it.listingStatus, list_price: money(it.listingPrice), price_change: it.priceChange,
      days_on_zillow: it.daysOnZillow, home_type: it.homeType, beds: it.bedrooms, baths: it.bathrooms,
      sqft: it.livingArea, year_built: it.yearBuilt, last_sold_price: money(it.lastSoldPrice),
      stories: it.resoFacts?.stories ?? it.resoFacts?.levels, style: it.resoFacts?.architecturalStyle,
      construction: it.resoFacts?.constructionMaterials, foundation: it.resoFacts?.foundationDetails, basement: it.resoFacts?.basement,
      lot: it.lotArea ?? it.resoFacts?.lotSize,
      tax_assessed_value: money(it.taxAssessedValue), description: String(it.description ?? "").slice(0, 500),
      nearby_sold: nearbySold(it, money),
    });
  } catch (e) {
    return `Zillow lookup error (${e}); use web search instead.`;
  }
}

/** Sold homes near the subject from the Zillow scrape, closest first, same city only (Zack 2026-10-26: comps
 *  must be nearby, never from another city). Within a mile when there are 3+, otherwise within 2. */
function nearbySold(it: any, money: (v: any) => string): string[] {
  const lat = it.latitude, lng = it.longitude, city = String(it.address?.city ?? it.city ?? "").toLowerCase();
  const miles = (n: any) => {
    if (lat == null || lng == null || n.latitude == null || n.longitude == null) return null;
    const r = (x: number) => (x * Math.PI) / 180, dl = r(n.latitude - lat), dn = r(n.longitude - lng);
    const h = Math.sin(dl / 2) ** 2 + Math.cos(r(lat)) * Math.cos(r(n.latitude)) * Math.sin(dn / 2) ** 2;
    return 2 * 3958.8 * Math.asin(Math.sqrt(h));
  };
  const sold = (it.nearbyProperties ?? [])
    .filter((n: any) => /sold/i.test(n.homeStatus ?? "") && n.price > 10000 && n.livingArea)
    .filter((n: any) => !city || !n.address?.city || String(n.address.city).toLowerCase() === city)
    .map((n: any) => ({ n, d: miles(n) }))
    .sort((a: any, b: any) => (a.d ?? 99) - (b.d ?? 99));
  const radius = sold.filter((x: any) => x.d != null && x.d <= 1).length >= 3 ? 1 : 2;
  return sold.filter((x: any) => x.d == null || x.d <= radius).slice(0, 6).map(({ n, d }: any) =>
    `${n.address?.street ?? "nearby"}${n.address?.zipcode ? ` (${n.address.zipcode})` : ""}: sold ${money(n.price)}, ${n.livingArea} sqft ($${Math.round(n.price / n.livingArea)}/sqft)${d != null ? `, ${d.toFixed(1)} mi away` : ""}`);
}

const CHECK_IN_ASK = `Today is {{TODAY}}. The agent hasn't texted since, and it's time for the check-in you planned. Write one short, casual follow-up that picks up on what they said (for example "Hey Sarah, checking back on that seller who was thinking about selling. Anything firm up?"). Don't repeat earlier wording or re-introduce yourself. Ask about the specific house or seller they mentioned; if they never named one, ask about off-market situations (a house that needs work, an inherited place, a landlord who's done, a seller behind on payments). If a check-in no longer makes sense (they said a firm no, or they're not an agent anymore), return an empty reply. Set follow_up_days to when to check again if they stay quiet (7-14 days, or their own timing).`;

function systemPrompt(env: Env): string {
  return SYSTEM_PROMPT.replaceAll("{{GOAL}}", env.BOT_GOAL)
    .replaceAll("{{NAME}}", env.SENDER_NAME)
    .replaceAll("{{EMAIL}}", env.SENDER_EMAIL || "(no email on file: ask them to text it)")
    .replaceAll("{{ARV_PERCENT}}", env.ARV_PERCENT)
    .replaceAll("{{FEE}}", Number(env.ASSIGNMENT_FEE).toLocaleString("en-US"))
    .replaceAll("{{PROPERTY_TYPES}}", env.PROPERTY_TYPES)
    .replaceAll("{{QUALIFY_PERCENT}}", env.QUALIFY_PERCENT || "100")
    .replaceAll("{{LISTED_PERCENT}}", env.LISTED_QUALIFY_PERCENT || "60");
}

async function smsThread(contactId: string, env: Env): Promise<Sms[]> {
  const search = await ghl(env, `/conversations/search?locationId=${env.GHL_LOCATION_ID}&contactId=${contactId}`);
  const conv = (search.conversations ?? [])[0];
  if (!conv) return [];
  const data = await ghl(env, `/conversations/${conv.id}/messages?limit=${MAX_HISTORY}`);
  const list: any[] = data.messages?.messages ?? data.messages ?? [];
  return list
    .filter((m) => (m.messageType ?? "").includes("SMS") || m.type === 2)
    // Picture/video texts (MMS) have no words; keep them so the bot knows something was sent.
    .filter((m) => (m.body || m.attachments?.length) && m.status !== "failed" && m.status !== "undelivered")
    .map((m) => ({
      direction: m.direction,
      body: [m.body, m.attachments?.length ? `[sent ${m.attachments.length} attachment(s): photos are shown below]` : ""].filter(Boolean).join(" "),
      at: m.dateAdded,
      media: (m.attachments ?? []).map((a: any) => (typeof a === "string" ? a : a?.url)).filter((u: any) => typeof u === "string" && /^https:\/\//.test(u)),
    }))
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

// ---- Offers from Slack (Zack 2026-10-29): Zack replies "yes" or a number in a lead card's thread in
// #wholesaling-hot-lead and the bot sends his offer template to the agent by text (and email when we
// have one), with an investor-friendly title company it looks up near the house.
const OFFER_TAG = "offer-sent";
const PENDING_TAG = "offer-pending"; // decided after 8pm CT: the text goes out at 9am
const PENDING_NOTE = "PENDING OFFER TEXT";
const POF_URL = "http://api.leadconnectorhq.com/l/yE-UDeUgJ";

async function slackEvent(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await req.text();
  if (!env.SLACK_SIGNING_SECRET || !(await slackSigned(req, raw, env.SLACK_SIGNING_SECRET))) {
    return new Response("bad signature", { status: 401 });
  }
  const body = JSON.parse(raw || "{}");
  if (body.type === "url_verification") return new Response(body.challenge ?? "");
  if (req.headers.get("x-slack-retry-num")) return new Response("ok"); // already handling the first try
  const ev = body.event ?? {};
  const fromZack = !env.SLACK_ZACK_USER || ev.user === env.SLACK_ZACK_USER;
  if (ev.type === "message" && !ev.subtype && !ev.bot_id && ev.thread_ts && ev.thread_ts !== ev.ts && fromZack) {
    const price = offerPrice(ev.text || "");
    if (price !== null) ctx.waitUntil(offerFromSlack(ev.channel, ev.thread_ts, ev.ts, price, env).catch(async (e) => {
      console.error("slack offer failed", e);
      await slack(env, "chat.postMessage", { channel: ev.channel, thread_ts: ev.thread_ts, text: `⚠️ Offer not sent: ${String(e).slice(0, 300)}` });
    }));
  }
  return new Response("ok");
}

async function slackSigned(req: Request, raw: string, secret: string): Promise<boolean> {
  const ts = req.headers.get("x-slack-request-timestamp") || "", sig = req.headers.get("x-slack-signature") || "";
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${raw}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sig === `v0=${hex}`;
}

/** "yes" = 0 (use the card's opening offer); "150k", "$152,500", "152500" = that price; anything else = null. */
function offerPrice(text: string): number | null {
  const t = text.replace(/<[^>]*>/g, "").trim();
  if (/^(yes|yep|yeah|y|send( it)?|go|do it)\b/i.test(t) && !/\d/.test(t)) return 0;
  const m = t.match(/^(?:yes,?\s*)?(?:send|offer|do)?\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?\b/i);
  if (!m || !/^[\s.!,]*((cash|offer|send( it)?|please|pls|on (this|it)|for (this|it))[\s.!,]*)*$/i.test(t.slice(m[0].length))) return null;
  const n = parseFloat(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
  const price = Math.round(n < 1000 ? n * 1000 : n); // "150" means 150k
  return price >= 10000 ? price : null;
}

async function slack(env: Env, method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const out: any = await res.json();
  if (!out.ok) console.error("slack", method, out.error);
  return out;
}

async function offerFromSlack(channel: string, threadTs: string, ts: string, price: number, env: Env): Promise<void> {
  await slack(env, "reactions.add", { channel, timestamp: ts, name: "eyes" });
  const card: string = (await slack(env, "conversations.replies", { channel, ts: threadTs, limit: 1 })).messages?.[0]?.text ?? "";
  const contactId = card.match(/contacts\/detail\/([A-Za-z0-9]+)/)?.[1];
  const address = card.match(/lead\*\n\*([^*\n]+)\*/)?.[1]?.trim();
  if (!contactId || !address) throw new Error("couldn't find the lead's address and GHL contact on this card");
  if (!price) price = dollars(card.match(/Open at: \*(\$[\d,]+)\*/)?.[1]) ?? 0;
  if (!price) throw new Error("this card has no opening offer, reply with a number instead");
  const contact = (await ghl(env, `/contacts/${contactId}`)).contact ?? {};
  const email = (contact.email || card.match(/mailto:([^|>\s]+)/)?.[1] || "").trim();
  const title = await findTitleCompany(address, env);
  const first = (contact.firstName || "").trim().split(/\s+/)[0] || "there";
  const name = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  const terms = offerTerms(address, price, title);
  const text = `Hi ${name}, here's my offer:\n\n${terms}\n\nLet me know if you have any questions.\n\nThanks,\nZack Olabi\nZoGrow Media LLC`;

  const done: string[] = [];
  if (email) {
    if (!contact.email) await ghl(env, `/contacts/${contactId}`, "PUT", { email });
    try {
      await ghl(env, "/conversations/messages", "POST", {
        type: "Email", contactId, subject: `Offer on ${address}`, emailFrom: `Zack Olabi <${env.SENDER_EMAIL || "zack@zogrowmedia.com"}>`,
        html: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>"),
      });
      done.push(`emailed ${email}`);
    } catch (e) {
      done.push(`email failed (${String(e).slice(0, 120)})`);
    }
  }
  const hour = Number(new Date().toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }));
  const tags: string[] = (contact.tags ?? []).map((t: string) => t.toLowerCase());
  const noText = tags.includes(OPTED_OUT_TAG) || contact.dnd || contact.dndSettings?.SMS?.status === "active";
  if (noText) done.push("no text (opted out / DND)");
  else if (hour < 8 || hour >= 20) {
    await ghl(env, `/contacts/${contactId}/notes`, "POST", { body: `${PENDING_NOTE} [${channel} ${threadTs}]\n${text}` });
    await ghl(env, `/contacts/${contactId}/tags`, "POST", { tags: [PENDING_TAG] });
    done.push("text goes out at 9am CT (it's after hours)");
  } else {
    await ghl(env, "/conversations/messages", "POST", { type: "SMS", contactId, message: text });
    done.push(`texted ${contact.phone || "the agent"}`);
  }
  await ghl(env, `/contacts/${contactId}/tags`, "POST", { tags: [OFFER_TAG, HANDOFF_TAG] });
  await starConversation(contactId, env);
  await ghl(env, `/contacts/${contactId}/notes`, "POST", { body: `Offer ${usd(price)} on ${address} (from Slack). Title: ${title}. ${done.join(", ")}` });
  await slack(env, "reactions.remove", { channel, timestamp: ts, name: "eyes" });
  await slack(env, "reactions.add", { channel, timestamp: ts, name: "white_check_mark" });
  await slack(env, "chat.postMessage", { channel, thread_ts: threadTs,
    text: `✅ Offer ${usd(price)} on ${address} to ${name}: ${done.join(", ")}.\nTitle company: ${title} · EMD ${usd(price / 100)}` });
}

function offerTerms(address: string, price: number, title: string): string {
  return [
    `Offer on: ${address}`,
    `Purchase Price: ${usd(price)}`,
    `Funding: Cash or Hard Money - No financing contingency`,
    `As-is. No seller repairs`,
    `Buyer pays all closing costs`,
    `Closing date: 21 business days or sooner`,
    `Due diligence: 5 business days`,
    `EMD: ${usd(price * EMD_PERCENT / 100)}`,
    `Title company: ${title}`,
    `Email: zack@zogrowmedia.com`,
    `Buyer's name: ZoGrow Media LLC`,
    ``,
    `Special Stips:`,
    `Buyer will not request a price drop unless there is a major issue that would cost more than $10,000 to repair.`,
    `Property to be delivered vacant.`,
    ``,
    `Proof of funds: ${POF_URL}`,
  ].join("\n");
}

/** Zack 2026-10-29: star every conversation an offer went to, so offers are easy to find in GHL. */
async function starConversation(contactId: string, env: Env): Promise<void> {
  try {
    const q = new URLSearchParams({ locationId: env.GHL_LOCATION_ID, contactId });
    for (const c of (await ghl(env, `/conversations/search?${q}`)).conversations ?? []) {
      await ghl(env, `/conversations/${c.id}`, "PUT", { locationId: env.GHL_LOCATION_ID, starred: true });
    }
  } catch (e) {
    console.error("star failed", contactId, e);
  }
}

/** An investor-friendly title company near the house (Zack: "find the title info for that state"). Name only. */
async function findTitleCompany(address: string, env: Env): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const res = await client.beta.messages.create({
    model: MODEL, max_tokens: 2000,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
    messages: [{ role: "user", content: `Find a real, currently operating title company near ${address} that is investor-friendly (handles cash/investor and wholesale or assignment closings). Prefer one in the same city or county. Answer with only the company name and its city, like: Southeast Professional Title (Orlando). No other words.` }],
  });
  const texts = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text");
  const out = (texts[texts.length - 1]?.text || "").trim().split("\n").pop()!.replace(/^[*\s]+|[*\s.]+$/g, "");
  return out && out.length < 120 ? out : "TBD (buyer's choice of local title company)";
}

/** Morning: send the offer texts Zack approved after 8pm. */
async function sendPendingOffers(env: Env): Promise<void> {
  const res = await ghl(env, "/contacts/search", "POST", {
    locationId: env.GHL_LOCATION_ID, page: 1, pageLimit: 20, filters: [{ field: "tags", operator: "contains", value: PENDING_TAG }],
  });
  for (const c of res.contacts ?? []) {
    const notes: any[] = (await ghl(env, `/contacts/${c.id}/notes`)).notes ?? [];
    const note = notes.find((n) => (n.body || "").startsWith(PENDING_NOTE));
    await ghl(env, `/contacts/${c.id}/tags`, "DELETE", { tags: [PENDING_TAG] });
    if (!note) continue;
    const [head, ...rest] = note.body.split("\n");
    await ghl(env, "/conversations/messages", "POST", { type: "SMS", contactId: c.id, message: rest.join("\n") });
    await ghl(env, `/contacts/${c.id}/notes/${note.id}`, "DELETE");
    const [, channel, threadTs] = head.match(/\[(\S+) (\S+)\]/) ?? [];
    if (channel && env.SLACK_BOT_TOKEN) await slack(env, "chat.postMessage", { channel, thread_ts: threadTs, text: `📤 Morning: offer text sent to ${c.phone || "the agent"}.` });
  }
}
