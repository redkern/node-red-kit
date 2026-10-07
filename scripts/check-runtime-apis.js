'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const lib = path.join(root, 'lib');
const files = fs.readdirSync(lib).filter((name) => name.endsWith('.js'));
const violations = [];

function isFreezeCall(node, source) {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.expression.getText(source) === 'Object'
    && node.expression.name.text === 'freeze'
    && node.arguments.length === 1;
}

function immutableValue(node, source) {
  if (isFreezeCall(node, source)) {
    const value = node.arguments[0];
    if (ts.isArrayLiteralExpression(value)) return value.elements.every((element) => immutableValue(element, source));
    if (ts.isObjectLiteralExpression(value)) return value.properties.every((property) => (
      ts.isPropertyAssignment(property) ? immutableValue(property.initializer, source) : true
    ));
    return false;
  }
  if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) return false;
  if (ts.isNewExpression(node) && ['Map', 'Set', 'WeakMap', 'WeakSet'].includes(node.expression.getText(source))) return false;
  return true;
}

const stateFixture = ts.createSourceFile('state-fixture.js', [
  'const safe = Object.freeze({ values: Object.freeze([]) });',
  'const nestedMutable = Object.freeze({ values: [] });',
  'const registry = new Set();'
].join('\n'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const fixtureResults = stateFixture.statements.map((statement) => immutableValue(statement.declarationList.declarations[0].initializer, stateFixture));
if (fixtureResults[0] !== true || fixtureResults[1] !== false || fixtureResults[2] !== false) {
  throw new Error('module-state immutability check does not reject mutable collection fixtures');
}

for (const name of files) {
  const source = fs.readFileSync(path.join(lib, name), 'utf8');
  const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) violations.push(`${name}: module-level variables must be const`);
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (initializer && !immutableValue(initializer, sourceFile)) {
        violations.push(`${name}: mutable module-level state in ${declaration.name.getText(sourceFile)}`);
      }
    }
  }
  const forbidden = [
    ['global singleton', /\b(?:global|globalThis)\s*\./g],
    ['Symbol.for', /\bSymbol\.for\s*\(/g],
    ['direct console output', /\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(/g],
    ['direct process output', /\bprocess\.(?:stdout|stderr)\.write\s*\(/g],
    ['process listener', /\bprocess\.(?:on|once|addListener)\s*\(/g],
    ['Node-RED runtime import', /require\s*\(\s*['"](?:node-red|@node-red\/)/g],
    ['private integration field', /\b(?:RED|node|app)\._[A-Za-z][A-Za-z0-9_]*/g]
  ];
  for (const [label, pattern] of forbidden) {
    if (pattern.test(source)) violations.push(`${name}: forbidden ${label}`);
  }
  const envReads = source.match(/\bprocess\.env\b/g) || [];
  if (envReads.length && name !== 'config.js') violations.push(`${name}: process.env is only allowed in config.js readEnv`);
  if (name === 'config.js' && envReads.length !== 1) violations.push('config.js: readEnv must be the only process.env reader');
}

if (violations.length) throw new Error(violations.join('\n'));
console.log(`lint:runtime: checked ${files.length} runtime modules`);