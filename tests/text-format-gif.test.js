const test = require('node:test');
const assert = require('node:assert');
const TextFormat = require('../public/js/text-format.js');

test('detects Tenor share links', () => {
  const r = TextFormat.detectProvider('https://tenor.com/view/dance-cat-gif-12345678');
  assert.strictEqual(r.provider, 'tenor');
  assert.strictEqual(r.mediaType, 'gif');
});

test('detects Tenor locale share links', () => {
  const r = TextFormat.detectProvider('https://tenor.com/en-US/view/dance-cat-gif-12345678');
  assert.strictEqual(r.provider, 'tenor');
});

test('detects Giphy gifs links', () => {
  const r = TextFormat.detectProvider('https://giphy.com/gifs/funny-cat-abc123XYZ');
  assert.strictEqual(r.provider, 'giphy');
  assert.strictEqual(r.mediaType, 'gif');
});

test('detects Giphy media links', () => {
  const r = TextFormat.detectProvider('https://giphy.com/media/abc123XYZ');
  assert.strictEqual(r.provider, 'giphy');
});

test('detects direct media CDN links', () => {
  assert.strictEqual(TextFormat.detectProvider('https://media.tenor.com/abc/tenor.gif').provider, 'tenor');
  assert.strictEqual(TextFormat.detectProvider('https://media.giphy.com/media/abc/giphy.gif').provider, 'giphy');
  assert.strictEqual(TextFormat.detectProvider('https://i.giphy.com/abc.gif').provider, 'giphy');
});

test('does not misclassify unrelated URLs', () => {
  assert.strictEqual(TextFormat.detectProvider('https://example.com/view/x-1').provider, null);
  assert.strictEqual(TextFormat.detectProvider('https://notgiphy.com/gifs/x').provider, null);
});

test('tokenizeMessage tags Giphy link', () => {
  const tokens = TextFormat.tokenizeMessage('nice https://giphy.com/gifs/cat-abc123XYZ please');
  const urlToken = tokens.find(t => t.type === 'url');
  assert.strictEqual(urlToken.provider, 'giphy');
});
