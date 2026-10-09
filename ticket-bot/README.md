# Selyn Support Tickets

A Discord ticket bot for Selyn.

- **AI first** – when the AI is on, it reads the ticket's title and description and answers (or asks for details) before any staff are bothered. Staff are only asked when the AI hands over, it errors, or the opener presses **Talk to a human**. With no `GROQ_API_KEY`, staff are asked immediately.
- **DM offers** – a new ticket is offered by DM to the next support member in a fair rotation, with **Accept** / **Skip** buttons. They have 3 hours (`OFFER_TIMEOUT_HOURS`); if they skip, ignore it, or have DMs closed, it moves on to the next person. They only get access to the ticket channel once they accept.
- **Fair rotation** – whoever has accepted the fewest tickets gets the next offer; anyone level is picked at random, so the same person isn't always asked first (pending offers count, so simultaneous tickets go to different people). New staff start at the current minimum so they aren't flooded.
- **Nobody accepted?** – once everyone has been asked, the ticket opens to the whole support team and anyone can claim it from `/staffpanel`.
- **Anti-ping** – nobody may ping the protected users/roles (defaults: user `880060587697123370`, roles `1556917397280260167` and `1556917485733941280`) or anyone who holds one of those roles. The bot deletes the message, times the pinger out for 5 minutes, replies in the channel ("please don't ping … open a ticket"), and DMs the people who were pinged (and the pinger). Mentions inside code blocks and reply-pings don't count; members of the protected roles can ping freely. Override with `PROTECTED_USER_IDS`, `PROTECTED_ROLE_IDS`, `PING_EXEMPT_ROLE_IDS`, `PING_TIMEOUT_MINUTES`.
- **Chat moderation (local model, no word list)** – a local toxic-bert model scores every message. It deletes **racism / hatred of a group** and **strong profanity aimed at a person**; venting ("fucking hell, I forgot to do this") and mild insults ("dumb", "stupid", "idiot") are left alone. The user gets a DM saying why, and `MOD_LOG_CHANNEL_ID` (optional) gets a card with the message and scores so you can spot false positives. Disguised spellings (`n1gg3r`, `sh1t`) are undone before scoring. It runs on your machine (first start downloads ~110 MB; ~15–30 ms per message on a fast PC) and needs no API. If the model isn't installed or can't load, moderation is simply off. Settings: `MODERATION=off`, `MODERATION_DRY_RUN=true` (only log what it *would* delete), `MOD_TIMEOUT_MINUTES`, `MOD_HATE_THRESHOLD`, `MOD_INSULT_THRESHOLD`, `MOD_OBSCENE_THRESHOLD`. **CPU guard:** if moderation uses more than 25% of the whole machine's CPU (averaged over 30 s; `MOD_CPU_LIMIT_PERCENT`) it pauses itself for 5 minutes (`MOD_CPU_PAUSE_MINUTES`) and then switches back on; the moderation log channel is told when it pauses/resumes. **`/moderation on|off|status`** (only people with role `1556268367659147284`, `MOD_COMMAND_ROLE_ID`) turns it on or off - the choice is remembered across restarts - and `status` shows the state, current CPU use and how many messages were checked/deleted. **Test mode:** protected users and role members are normally exempt; `/moderation` → *test mode on* checks them too for 30 minutes (so you can try it with your own account - it applies to the anti-ping as well, and switches itself off). **`MOD_LOG_SCORES=true`** prints every checked message with its scores in the console, to help tune the thresholds. Known limit: "fuck this launcher" scores like abuse and is deleted at the default settings.
- **Backup Groq key** – set `GROQ_API_KEY_BACKUP`; if the main key is rate limited (or rejected) the bot switches to it automatically.
- **Support role** – staff are everyone with role `1556338723958816778` (override with `SUPPORT_ROLE_ID`).
- **AI helper (Groq)** – text turns use `openai/gpt-oss-120b`; when a message has an image, just that reply switches to the vision model `qwen/qwen3.8-27b` (with the full conversation as context) and then it switches back.  answers the ticket opener's questions until a staff member speaks (or staff pause it). It only knows what you put in [`knowledge.md`](knowledge.md).
- **Call other staff** – `/staffpanel` → **Call Staff** adds more support members to a ticket.
- **Containers UI** – the panel, tickets and AI replies use Discord Components V2 containers.
- **Transcripts** – a Discord-style HTML replica of the ticket (dark theme, avatars, markdown, attachments, and the bot's own cards). Set `LOG_CHANNEL_ID` and every closed ticket's transcript is saved there. **Close + send transcript** and `/staffpanel` → **Send Transcript** DM it to the ticket opener and the staff (the ticket stays open for the latter). The AI can also close a ticket itself (`[ Close ticket ]` / `[ Close ticket with transcript ]`) once the user confirms it's fixed; it never closes on its first reply.

## Setup

1. Create an application at <https://discord.com/developers/applications>, add a bot, name it **Selyn Support Tickets**.
2. Under **Bot → Privileged Gateway Intents** enable **Server Members Intent** and **Message Content Intent**.
3. Invite it with the `bot` and `applications.commands` scopes and the permissions *View Channels, Manage Channels, Manage Roles, Manage Messages, Moderate Members, Send Messages, Read Message History, Attach Files, Embed Links* (permission integer `1099780189200`). Put the bot's role **above** the roles of the people it should be able to time out..
4. `cp .env.example .env` and fill in `DISCORD_TOKEN` (plus `GUILD_ID`, and `GROQ_API_KEY` from <https://console.groq.com/keys>).
5. `npm install && npm start` (or double-click `start.bat` on Windows)
6. In your server run `/ticketpanel` to post the panel.

## Commands

| Command | Who | What |
|---|---|---|
| `/ticketpanel [channel]` | Admins | Posts the "Open a Ticket" panel |
| `/staffpanel` | Support staff | Inside a ticket: private controls: **Claim** / **Take Over**, **Call Staff**, **Pause/Resume AI**, and **Send Transcript**, and **Close Ticket** (the ticket opener never sees these) |
| `/moderation on\|off\|status` | Moderation role | Turn chat moderation on/off, switch test mode, or see its state and CPU use |
| `/ticketstats` | Support staff | Shows open / total tickets per staff member |

## Teaching the AI about Selyn

Edit `knowledge.md` – it's re-read on every AI reply, so no restart is needed. Write `[CALL STAFF]` wherever the AI should hand over to a human: the bot hides the marker, pauses the AI and pings the ticket's handler (or the support team if nobody has it yet).

## Notes

- Ticket state lives in `data/tickets.json` (gitignored). Keep that folder on persistent storage when you host the bot.
- Tickets are private to the opener, the staff member who accepted, and anyone called in with **Call Staff** (plus admins).
- Support members must allow DMs from server members, otherwise their offer is skipped automatically.
- Run the tests with `npm test`.

## Hosting on Railway (or any Docker host)

The repo has a `Dockerfile` and `railway.json` (at the top level and inside `ticket-bot/`), so Railway builds it without extra settings - the branch just has to contain them (`main` does).

1. New Project -> **Deploy from GitHub repo** -> pick this repo.
2. **Variables** -> **Raw Editor** -> paste the whole contents of your `.env` (the `.env` file is not in the repo, so Railway needs the values here).
3. **Volumes** -> add a volume mounted at **`/app/data`** so open tickets and the `/moderation` on/off switch survive redeploys.
4. Deploy. The moderation model is baked into the image; the bot logs `Logged in as ...` when it is up.

Notes: the moderation model needs ~700 MB of RAM. If the container has less than 900 MB (`MOD_MIN_MEMORY_MB`) the bot starts with moderation OFF instead of crashing - give it more memory, or set `MODERATION=on` to force it. The CPU guard still applies. Everything else (tickets, AI, anti-ping) runs in well under 200 MB.

