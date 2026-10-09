# SMS reply bot

When a lead texts back, GoHighLevel calls this Cloudflare Worker. It reads the SMS
thread from GHL, asks Claude (`claude-opus-5-5`) for the next reply, and texts it
back through GHL. When the lead shares a deal, wants a call, or needs a human, it
tags them `hot-lead`, leaves a note, and stops replying to them.

- Bot instructions: `src/prompt.ts`. Goal and sender name: `wrangler.toml` `[vars]`.
- `DRY_RUN = "true"` logs replies instead of sending them. Set it to `"false"` to go live.
- The bot never replies to contacts tagged `hot-lead`, `bot-off`, or `dnd-skipped`, or to DND contacts.
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
