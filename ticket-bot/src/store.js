import fs from 'node:fs';
import path from 'node:path';
import { pickStaff } from './assign.js';

const FILE = path.resolve('data', 'tickets.json');
let db = { counter: 0, tickets: {}, totals: {}, lastAssigned: {} };

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
  openByUser: (userId) => Object.values(db.tickets).filter((t) => t.userId === userId),
  totals: () => db.totals,

  /** Synchronously reserves a ticket number and a staff member so concurrent opens stay fair. */
  create({ userId, subject, description, staffIds }) {
    const staffId = pickStaff(staffIds, this.all(), db.totals, db.lastAssigned);
    const number = ++db.counter;
    if (staffId) {
      // Staff with no history start at the current minimum (same baseline pickStaff uses).
      const known = staffIds.filter((id) => db.totals[id] !== undefined).map((id) => db.totals[id]);
      db.totals[staffId] = (db.totals[staffId] ?? (known.length ? Math.min(...known) : 0)) + 1;
      db.lastAssigned[staffId] = Date.now();
    }
    const ticket = {
      number,
      userId,
      staffId,
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

  /** Undo a reservation when the channel could not be created. */
  abort(ticket) {
    delete db.tickets[ticket.number];
    if (ticket.staffId && db.totals[ticket.staffId]) db.totals[ticket.staffId]--;
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
