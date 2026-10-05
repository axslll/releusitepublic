# Selyn Support Tickets

A Discord ticket bot for Selyn.

- **Fair assignment** – every new ticket goes to the support member who has received the fewest tickets so far (ties: fewest open, then longest since last assignment). New staff start at the current minimum so they aren't flooded.
- **Support role** – staff are everyone with role `1556339601067741247` (override with `SUPPORT_ROLE_ID`).
- **AI helper (Groq)** – answers the ticket opener's questions until a staff member speaks (or staff pause it). It only knows what you put in [`knowledge.md`](knowledge.md).
- **Call other staff** – the **Call Staff** button adds more support members to a ticket.
- **Containers UI** – the panel, tickets and AI replies use Discord Components V2 containers.
- **Transcripts** – on close, a transcript is posted to `LOG_CHANNEL_ID` (optional).

## Setup

1. Create an application at <https://discord.com/developers/applications>, add a bot, name it **Selyn Support Tickets**.
2. Under **Bot → Privileged Gateway Intents** enable **Server Members Intent** and **Message Content Intent**.
3. Invite it with the `bot` and `applications.commands` scopes and the permissions *Manage Channels, View Channels, Send Messages, Read Message History, Attach Files, Embed Links*.
4. `cp .env.example .env` and fill in `DISCORD_TOKEN` (plus `GUILD_ID`, and `GROQ_API_KEY` from <https://console.groq.com/keys>).
5. `npm install && npm start`
6. In your server run `/ticketpanel` to post the panel.

## Commands

| Command | Who | What |
|---|---|---|
| `/ticketpanel [channel]` | Admins | Posts the "Open a Ticket" panel |
| `/ticketstats` | Support staff | Shows open / total tickets per staff member |

## Teaching the AI about Selyn

Edit `knowledge.md` – it's re-read on every AI reply, so no restart is needed.

## Notes

- Ticket state lives in `data/tickets.json` (gitignored). Keep that folder on persistent storage when you host the bot.
- Tickets are private to the opener, the assigned staff member, and anyone called in with **Call Staff** (plus admins).
- Run the tests with `npm test`.
