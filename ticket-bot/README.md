# Selyn Support Tickets

A Discord ticket bot for Selyn.

- **DM offers** – a new ticket is offered by DM to the next support member in a fair rotation, with **Accept** / **Skip** buttons. They have 3 hours (`OFFER_TIMEOUT_HOURS`); if they skip, ignore it, or have DMs closed, it moves on to the next person. They only get access to the ticket channel once they accept.
- **Fair rotation** – whoever has accepted the fewest tickets gets the next offer; anyone level is picked at random, so the same person isn't always asked first (pending offers count, so simultaneous tickets go to different people). New staff start at the current minimum so they aren't flooded.
- **Nobody accepted?** – once everyone has been asked, the ticket opens to the whole support team and anyone can claim it from `/staffpanel`.
- **Support role** – staff are everyone with role `1556338723958816778` (override with `SUPPORT_ROLE_ID`).
- **AI helper (Groq)** – answers the ticket opener's questions until a staff member speaks (or staff pause it). It only knows what you put in [`knowledge.md`](knowledge.md).
- **Call other staff** – `/staffpanel` → **Call Staff** adds more support members to a ticket.
- **Containers UI** – the panel, tickets and AI replies use Discord Components V2 containers.
- **Transcripts** – on close, a transcript is posted to `LOG_CHANNEL_ID` (optional).

## Setup

1. Create an application at <https://discord.com/developers/applications>, add a bot, name it **Selyn Support Tickets**.
2. Under **Bot → Privileged Gateway Intents** enable **Server Members Intent** and **Message Content Intent**.
3. Invite it with the `bot` and `applications.commands` scopes and the permissions *View Channels, Manage Channels, Manage Roles, Send Messages, Read Message History, Attach Files, Embed Links* (permission integer `268553232`).
4. `cp .env.example .env` and fill in `DISCORD_TOKEN` (plus `GUILD_ID`, and `GROQ_API_KEY` from <https://console.groq.com/keys>).
5. `npm install && npm start` (or double-click `start.bat` on Windows)
6. In your server run `/ticketpanel` to post the panel.

## Commands

| Command | Who | What |
|---|---|---|
| `/ticketpanel [channel]` | Admins | Posts the "Open a Ticket" panel |
| `/staffpanel` | Support staff | Inside a ticket: private controls: **Claim** / **Take Over**, **Call Staff**, **Pause/Resume AI**, and **Close Ticket** (the ticket opener never sees these) |
| `/ticketstats` | Support staff | Shows open / total tickets per staff member |

## Teaching the AI about Selyn

Edit `knowledge.md` – it's re-read on every AI reply, so no restart is needed. Write `[CALL STAFF]` wherever the AI should hand over to a human: the bot hides the marker, pauses the AI and pings the ticket's handler (or the support team if nobody has it yet).

## Notes

- Ticket state lives in `data/tickets.json` (gitignored). Keep that folder on persistent storage when you host the bot.
- Tickets are private to the opener, the staff member who accepted, and anyone called in with **Call Staff** (plus admins).
- Support members must allow DMs from server members, otherwise their offer is skipped automatically.
- Run the tests with `npm test`.
