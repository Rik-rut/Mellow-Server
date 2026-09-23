'use strict';

const TENOR_PAGE_DOMAINS = ['tenor.com'];
const GIPHY_PAGE_DOMAINS = ['giphy.com'];
const TENOR_MEDIA_DOMAINS = ['media.tenor.com'];
const GIPHY_MEDIA_RE = /^(?:media\d*|i)\.giphy\.com$/;

function hostMatches(host, domains) {
  const h = String(host || '').toLowerCase();
  return domains.some(d => h === d || h.endsWith('.' + d));
}

function detectGifProvider(host) {
  if (hostMatches(host, TENOR_PAGE_DOMAINS)) return 'tenor';
  if (hostMatches(host, GIPHY_PAGE_DOMAINS)) return 'giphy';
  return null;
}

// Media URLs must live on a provider media subdomain, never the bare page
// domain (a bare giphy.com/tenor.com URL is a web page, not an image). Giphy
// media is served from `media*.giphy.com` and `i.giphy.com` only.
function isAllowedGifMediaHost(host) {
  const h = String(host || '').toLowerCase();
  if (hostMatches(h, TENOR_MEDIA_DOMAINS)) return true;
  return GIPHY_MEDIA_RE.test(h);
}

function buildOembedUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const provider = detectGifProvider(parsed.hostname);
  if (provider === 'tenor') return 'https://tenor.com/oembed?url=' + encodeURIComponent(url);
  if (provider === 'giphy') return 'https://giphy.com/services/oembed?url=' + encodeURIComponent(url);
  return null;
}

function extractMediaUrl(oembed) {
  if (!oembed || typeof oembed !== 'object') return null;
  const candidates = [oembed.url, oembed.thumbnail_url];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'https:' && isAllowedGifMediaHost(parsed.hostname)) {
        return parsed.toString();
      }
    } catch (_) {}
  }
  return null;
}

module.exports = { detectGifProvider, isAllowedGifMediaHost, buildOembedUrl, extractMediaUrl };
