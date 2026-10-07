'use strict';

function readonlyMap(source) {
  const snapshot = new Map(source);
  return Object.freeze({
    get size() { return snapshot.size; },
    get(key) { return snapshot.get(key); },
    has(key) { return snapshot.has(key); },
    entries() { return snapshot.entries(); },
    keys() { return snapshot.keys(); },
    values() { return snapshot.values(); },
    forEach(callback, thisArg) {
      snapshot.forEach((value, key) => callback.call(thisArg, value, key, this));
    },
    [Symbol.iterator]() { return snapshot[Symbol.iterator](); }
  });
}

module.exports = { readonlyMap };