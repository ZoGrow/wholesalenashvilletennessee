# SMS reply bot

When a lead texts back, GoHighLevel calls this Cloudflare Worker. It reads the SMS
thread from GHL, asks Claude (`claude-opus-5-5`) for the next reply, and texts it
back through GHL. When an agent sends a listing or address, it looks it up online (web search)
and asks about condition and the seller's asking price. Once it has both, or the agent wants an offer or a call, it
tags them `hot-lead`, leaves a note, and stops replying to them. Agents who might have
something later get tagged `warm-lead` with a note, and the bot keeps the conversation going.

- Bot instructions: `src/prompt.ts`. Goal and sender name: `wrangler.toml` `[vars]`.
- `DRY_RUN = "true"` (test mode) texts nothing: each reply the bot would send is saved as a note
  on the contact in GHL ("SMS bot (test mode, not sent) would reply: ..."). Set it to `"false"` to go live.
- The bot never replies to contacts tagged `hot-lead`, `bot-off`, `dnd-skipped` or `opted-out`, or to DND contacts.
- Opt-outs ("STOP", "remove me", "don't text me", "wrong number", or anything Claude reads as asking us to stop)
  get no reply: the contact is tagged `opted-out`, SMS Do Not Disturb is turned on, and a note is left.
- Qualified lead = seller asking under `QUALIFY_PERCENT` (100) % of the Zestimate, after the bot tries to learn why
  they're selling (it also asks timeline, listing/contract status, occupancy, condition). Those get
  `hot-lead` + `qualified-lead` and a note; the bot hands off. Clear misses get `not-qualified` and a note.
- Each qualified lead also gets a "New qualified lead" card (address, asking vs Zestimate, condition,
  numbers, agent, GHL link) as a note, posted to Slack when the `SLACK_WEBHOOK_URL` repo secret is set
  (a Slack Incoming Webhook URL; rerun the deploy after adding it).
- Check-ins: when an agent says "let me see what I can find", "maybe next month" and so on, the bot tags them
  `follow-up-YYYY-MM-DD` (a date matching their timing). A cron (weekdays, hourly 10am-5pm Central, up to 5 per run)
  texts a short check-in on that date if they haven't texted since, and tags `checked-in`. At most one more
  check-in follows if they stay quiet. Any reply from them clears these tags. Remove the tag to cancel one.
- Agents who text back get `agent-replied`; bot texts a carrier blocks get rewritten once and tagged `carrier-blocked`.
  The "Weekly scorecard" workflow (Mondays) posts sent / replied / warm / qualified / blocked counts to Slack.
- Qualified-lead cards include an opening offer (about 10% under max offer) and a short call script.
  Tag a contact `bot-off` to take a conversation over yourself.

## Setup

1. GitHub repo secrets (Settings > Secrets and variables > Actions):
   `CLOUDFLARE_API_TOKEN` (Cloudflare "Edit Cloudflare Workers" template),
   `CLOUDFLARE_ACCOUNT_ID`, `ANTHROPIC_API_KEY`, `SMS_BOT_WEBHOOK_SECRET` (any long random
   string you make up). `GHL_TOKEN` and `GHL_LOCATION_ID` are reused from the lead pipeline;
   the GHL token needs the conversations message write scope.
2. Run the "Deploy SMS reply bot" workflow from the Actions tab. Its log prints the
   Worker URL, like `https://nashville-sms-bot.<you>.workers.dev`.
3. In GHL, create a workflow: trigger **Customer Replied** (channel SMS), filter tag
   `apify-daily-lead`, action **Webhook** (POST) to
   `https://nashville-sms-bot.<you>.workers.dev/?key=<SMS_BOT_WEBHOOK_SECRET>`.
4. In "Wholesaling Outbound", add a goal or exit for "Customer Replied" so the follow-up
   text stops once someone answers.

Logs: `npx wrangler tail` in this folder, or Workers > nashville-sms-bot > Logs in Cloudflare.
