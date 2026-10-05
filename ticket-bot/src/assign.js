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
 * simultaneous tickets go to different people. Among people who are level on that, the one with
 * the fewest open tickets wins, and anyone still tied is picked at random, so the same person
 * isn't always asked first.
 *
 * `exclude` lists staff who already declined / let this ticket's offer expire.
 */
export function pickStaff(staffIds, tickets, totals = {}, exclude = [], random = Math.random) {
  const pool = staffIds.filter((id) => !exclude.includes(id));
  if (!pool.length) return null;

  const baseline = baselineTotal(staffIds, totals);
  const open = {};
  const pending = {};
  for (const t of tickets) {
    if (t.staffId) open[t.staffId] = (open[t.staffId] || 0) + 1;
    else if (t.offer?.staffId) pending[t.offer.staffId] = (pending[t.offer.staffId] || 0) + 1;
  }
  const score = (id) => [(totals[id] ?? baseline) + (pending[id] || 0), open[id] || 0];
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1];

  let best = [];
  for (const id of pool) {
    const c = best.length ? cmp(score(id), score(best[0])) : -1;
    if (c < 0) best = [id];
    else if (c === 0) best.push(id);
  }
  return best[Math.floor(random() * best.length)];
}
