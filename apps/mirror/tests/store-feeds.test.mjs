import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MirrorStore } from '../dist/store.js';

const hex = (n) => `0x${n.toString(16).padStart(64, '0')}`;

test('feed catalogue stays exact across committees, out-of-order history, pruning and reopen without historical scans', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-feeds-'));
  const path = join(dir, 'mirror.db');
  let store = new MirrorStore(path);
  const db = new DatabaseSync(path);
  try {
    assert.deepEqual(store.feeds(), []);
    db.exec('BEGIN');
    const insert = db.prepare('INSERT INTO feed_ticks VALUES (?, ?, ?)');
    // Interleaved committees, an inactive feed and backfilled older ticks: a cached
    // latest value or a single max per feed would give the wrong catalogue.
    for (const [feed, committee, ticks] of [[1, 1, [300, 100, 200]], [1, 2, [150, 250]], [2, 1, [50]], [3, 2, [400]]]) {
      for (const tick of ticks) insert.run(hex(feed), hex(committee), tick);
    }
    // Model history growth without a wall-clock assertion that flakes on busy CI.
    for (let tick = 1000; tick < 11000; tick++) insert.run(hex(4), hex(1), tick);
    db.exec('COMMIT');
    const expected = () => db.prepare('SELECT feed_id, committee, MAX(tick_ms) AS tick FROM feed_ticks GROUP BY feed_id, committee ORDER BY feed_id, committee').all()
      .map(r => ({ feedId: r.feed_id, committee: r.committee, latestTickMs: BigInt(r.tick) }));
    const queries = [];
    const original = DatabaseSync.prototype.prepare;
    let actual;
    try {
      DatabaseSync.prototype.prepare = function(sql) { queries.push(sql); return original.call(this, sql); };
      actual = store.feeds();
    } finally { DatabaseSync.prototype.prepare = original; }
    assert.deepEqual(actual, expected());
    assert.ok(queries.length > 0);
    for (const sql of queries) {
      const plans = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array((sql.match(/\?/g) ?? []).length).fill(''));
      const details = plans.map(p => p.detail).join('\n');
      assert.doesNotMatch(details, /SCAN feed_ticks|USE TEMP B-TREE/, `catalogue must seek by key, not walk history: ${sql}\n${details}`);
      assert.match(details, /SEARCH feed_ticks USING COVERING INDEX/);
    }
    store.prune(200n);
    assert.deepEqual(store.feeds(), expected());
    assert.ok(!store.feeds().some(f => f.feedId === hex(2)), 'pruned inactive feeds disappear');
    store.close();
    store = new MirrorStore(path);
    assert.deepEqual(store.feeds(), expected(), 'existing stores need no migration or auxiliary cache');
    store.prune(20000n);
    assert.deepEqual(store.feeds(), []);
  } finally {
    store.close(); db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
