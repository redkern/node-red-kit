'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readonlyMap } = require('../../lib/collections');

test('readonlyMap is a frozen snapshot with standard readonly iteration', () => {
  const source = new Map([['a', 1], ['b', 2]]);
  const view = readonlyMap(source);
  source.set('c', 3);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(view.size, 2);
  assert.equal(view.get('a'), 1);
  assert.equal(view.has('b'), true);
  assert.deepEqual([...view.keys()], ['a', 'b']);
  assert.deepEqual([...view.values()], [1, 2]);
  assert.deepEqual([...view.entries()], [['a', 1], ['b', 2]]);
  assert.deepEqual([...view], [['a', 1], ['b', 2]]);
  const visited = [];
  view.forEach((value, key, current) => visited.push([key, value, current === view]));
  assert.deepEqual(visited, [['a', 1, true], ['b', 2, true]]);
  assert.equal(view.set, undefined);
  assert.equal(view.delete, undefined);
  assert.equal(view.clear, undefined);
});