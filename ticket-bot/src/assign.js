/** Staff with no history start at the current minimum instead of 0, so new hires aren't flooded. */
export function baselineTotal(staffIds, totals) {
  const known = staffIds.filter((id) => totals[id] !== undefined).map((id) => totals[id]);
  return known.length ? Math.min(...known) : 0;
}

/**
 * Fair ticket assignment.
 *
 * Whoever has accepted the fewest tickets so far gets the next offer, so over time everybody
 * handles the same amount. Offers still waiting for an answer count as tentative tickets, so
 * simultaneous tickets go to different people. Ties: fewest open tickets, then longest since
 * their last accepted ticket.
 *
 * `exclude` lists staff who already declined / let this ticket's offer expire.
 */
export function pickStaff(staffIds, tickets, totals = {}, lastAssigned = {}, exclude = []) {
  const pool = staffIds.filter((id) => !exclude.includes(id));
  if (!pool.length) return null;

  const baseline = baselineTotal(staffIds, totals);
  const open = {};
  const pending = {};
  for (const t of tickets) {
    if (t.staffId) open[t.staffId] = (open[t.staffId] || 0) + 1;
    else if (t.offer?.staffId) pending[t.offer.staffId] = (pending[t.offer.staffId] || 0) + 1;
  }
  const total = (id) => (totals[id] ?? baseline) + (pending[id] || 0);

  return [...pool].sort(
    (a, b) =>
      total(a) - total(b) ||
      (open[a] || 0) - (open[b] || 0) ||
      (lastAssigned[a] || 0) - (lastAssigned[b] || 0) ||
      a.localeCompare(b),
  )[0];
}
