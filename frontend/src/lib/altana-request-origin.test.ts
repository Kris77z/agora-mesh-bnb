import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedAltanaOrigin } from './altana-request-origin';

test('accepts the configured HTTPS origin behind an internal HTTP reverse proxy', () => {
  assert.equal(isAllowedAltanaOrigin('https://demo.example', 'http://localhost:3000/api/altana/rpc', 'https://demo.example'), true);
});
test('rejects foreign and internal origins when a public origin is configured', () => {
  for (const origin of ['https://attacker.example', 'http://localhost:3000', 'https://demo.example.attacker.example']) {
    assert.equal(isAllowedAltanaOrigin(origin, 'http://localhost:3000/api/altana/rpc', 'https://demo.example'), false);
  }
});
test('keeps local development and non-browser requests working and fails closed on malformed configuration', () => {
  assert.equal(isAllowedAltanaOrigin('http://localhost:3000', 'http://localhost:3000/api/altana/rpc'), true);
  assert.equal(isAllowedAltanaOrigin(null, 'http://localhost:3000/api/altana/rpc'), true);
  assert.equal(isAllowedAltanaOrigin('https://demo.example', 'http://localhost:3000', 'invalid'), false);
});
