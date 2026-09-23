const test = require('node:test');
const assert = require('node:assert');
const Gif = require('../server/gif-embed.js');

test('detectGifProvider recognizes providers and media hosts', () => {
  assert.strictEqual(Gif.detectGifProvider('tenor.com'), 'tenor');
  assert.strictEqual(Gif.detectGifProvider('www.tenor.com'), 'tenor');
  assert.strictEqual(Gif.detectGifProvider('media.tenor.com'), 'tenor');
  assert.strictEqual(Gif.detectGifProvider('giphy.com'), 'giphy');
  assert.strictEqual(Gif.detectGifProvider('media.giphy.com'), 'giphy');
  assert.strictEqual(Gif.detectGifProvider('i.giphy.com'), 'giphy');
  assert.strictEqual(Gif.detectGifProvider('evil.com'), null);
  assert.strictEqual(Gif.detectGifProvider('notgiphy.com'), null);
  assert.strictEqual(Gif.detectGifProvider('giphy.com.evil.com'), null);
});

test('isAllowedGifMediaHost only allows media CDN hosts', () => {
  assert.strictEqual(Gif.isAllowedGifMediaHost('media.tenor.com'), true);
  assert.strictEqual(Gif.isAllowedGifMediaHost('media.giphy.com'), true);
  assert.strictEqual(Gif.isAllowedGifMediaHost('media3.giphy.com'), true);
  assert.strictEqual(Gif.isAllowedGifMediaHost('i.giphy.com'), true);
  assert.strictEqual(Gif.isAllowedGifMediaHost('giphy.com'), false);
  assert.strictEqual(Gif.isAllowedGifMediaHost('www.giphy.com'), false);
  assert.strictEqual(Gif.isAllowedGifMediaHost('tenor.com'), false);
  assert.strictEqual(Gif.isAllowedGifMediaHost('evil.com'), false);
  assert.strictEqual(Gif.isAllowedGifMediaHost('giphy.com.evil.com'), false);
});

test('buildOembedUrl builds provider endpoints and rejects unknown hosts', () => {
  assert.ok(Gif.buildOembedUrl('https://tenor.com/view/x-12345678').startsWith('https://tenor.com/oembed?url='));
  assert.ok(Gif.buildOembedUrl('https://giphy.com/gifs/x-abc123XYZ').startsWith('https://giphy.com/services/oembed?url='));
  assert.strictEqual(Gif.buildOembedUrl('https://evil.com/x'), null);
  assert.strictEqual(Gif.buildOembedUrl('http://giphy.com/gifs/x'), null);
  assert.strictEqual(Gif.buildOembedUrl('not a url'), null);
});

test('extractMediaUrl returns only allowed https media URLs', () => {
  assert.strictEqual(
    Gif.extractMediaUrl({ url: 'https://media.giphy.com/media/abc/giphy.gif' }),
    'https://media.giphy.com/media/abc/giphy.gif'
  );
  assert.strictEqual(
    Gif.extractMediaUrl({ thumbnail_url: 'https://media.tenor.com/abc/tenor.gif' }),
    'https://media.tenor.com/abc/tenor.gif'
  );
  assert.strictEqual(Gif.extractMediaUrl({ url: 'https://evil.com/x.gif' }), null);
  assert.strictEqual(Gif.extractMediaUrl({ url: 'http://media.giphy.com/x.gif' }), null);
  assert.strictEqual(Gif.extractMediaUrl(null), null);
});
