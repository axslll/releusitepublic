/**
 * Fair ticket assignment.
 *
 * Staff with the fewest tickets handed out so far get the next one, so over time
 * everybody receives the same amount. Ties are broken by who currently has the fewest
 * open tickets, then by who was assigned longest ago.
 *
 * Staff who have never been assigned anything (new hires) start at the current minimum
 * instead of 0, so they don't get flooded while "catching up".
 */
export function pickStaff(staffIds, openTickets, totals = {}, lastAssigned = {}) {
  if (!staffIds.length) return null;

  const known = staffIds.filter((id) => totals[id] !== undefined).map((id) => totals[id]);
  const baseline = known.length ? Math.min(...known) : 0;
  const total = (id) => totals[id] ?? baseline;

  const open = {};
  for (const t of openTickets) if (t.staffId) open[t.staffId] = (open[t.staffId] || 0) + 1;

  return [...staffIds].sort(
    (a, b) =>
      total(a) - total(b) ||
      (open[a] || 0) - (open[b] || 0) ||
      (lastAssigned[a] || 0) - (lastAssigned[b] || 0) ||
      a.localeCompare(b),
  )[0];
}
