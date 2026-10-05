import fs from 'node:fs';
import path from 'node:path';
import { baselineTotal, pickStaff } from './assign.js';

const FILE = path.resolve('data', 'tickets.json');
let db = { counter: 0, tickets: {}, totals: {} };

try {
  db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch {
  /* first run */
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

export const store = {
  all: () => Object.values(db.tickets),
  byChannel: (channelId) => Object.values(db.tickets).find((t) => t.channelId === channelId),
  byNumber: (n) => db.tickets[n],
  openByUser: (userId) => Object.values(db.tickets).filter((t) => t.userId === userId),
  totals: () => db.totals,

  create({ guildId, userId, subject, description }) {
    const number = ++db.counter;
    const ticket = {
      number,
      guildId,
      userId,
      staffId: null, // set when a staff member accepts / claims
      offer: null, // { staffId, expiresAt, dmChannelId, dmMessageId } while waiting for an answer
      offered: [], // everyone this ticket has already been offered to
      staffCalled: false, // false while the AI is handling the ticket on its own; true once staff are being asked
      escalated: false, // nobody accepted: opened up to the whole support team
      subject,
      description,
      channelId: null,
      messageId: null,
      helpers: [],
      ai: true,
      history: [],
      createdAt: Date.now(),
    };
    db.tickets[number] = ticket;
    save();
    return ticket;
  },

  /** Picks the next staff member in the fair rotation who hasn't been offered this ticket yet. */
  nextOffer(ticket, staffIds, timeoutMs) {
    const staffId = pickStaff(staffIds, this.all(), db.totals, ticket.offered);
    ticket.offer = staffId ? { staffId, expiresAt: Date.now() + timeoutMs, dmChannelId: null, dmMessageId: null } : null;
    if (staffId) ticket.offered.push(staffId);
    save();
    return staffId;
  },

  /** Records an accepted / claimed ticket against the staff member's fair-share count. */
  assign(ticket, staffId, staffIds) {
    db.totals[staffId] = (db.totals[staffId] ?? baselineTotal(staffIds, db.totals)) + 1;
    ticket.staffId = staffId;
    ticket.offer = null;
    save();
  },

  update(ticket, patch) {
    Object.assign(ticket, patch);
    save();
  },

  remove(ticket) {
    delete db.tickets[ticket.number];
    save();
  },
};
