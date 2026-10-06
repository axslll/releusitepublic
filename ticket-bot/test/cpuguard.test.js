import test from 'node:test';
import assert from 'node:assert/strict';
import { CpuGuard } from '../src/cpuguard.js';

const make = (cores = 4) => {
  const clock = { t: 0 };
  const g = new CpuGuard({ limitPercent: 25, windowMs: 30_000, cores, now: () => clock.t });
  return { g, clock };
};
const capacityUs = (cores) => 30_000 * 1000 * cores; // CPU microseconds available in the window

test('reports CPU as a percentage of the whole machine', () => {
  const { g } = make(4);
  g.record(capacityUs(4) * 0.1);
  assert.ok(Math.abs(g.percent() - 10) < 1e-9);
  assert.equal(g.exceeded(), false);
});

test('over the limit is detected', () => {
  const { g } = make(4);
  g.record(capacityUs(4) * 0.26);
  assert.equal(g.exceeded(), true);
});

test('old samples fall out of the window', () => {
  const { g, clock } = make(2);
  g.record(capacityUs(2) * 0.5);
  assert.equal(g.exceeded(), true);
  clock.t = 31_000;
  assert.equal(g.percent(), 0);
  assert.equal(g.exceeded(), false);
});

test('the same work is a smaller share on a bigger machine', () => {
  const small = make(2).g; const big = make(16).g;
  small.record(10_000_000); big.record(10_000_000);
  assert.ok(small.percent() > big.percent() * 7.9);
});

test('reset clears everything', () => {
  const { g } = make(4);
  g.record(capacityUs(4));
  g.reset();
  assert.equal(g.percent(), 0);
});
