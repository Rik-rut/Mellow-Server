(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    global.TextFormat = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const URL_RE = /https?:\/\/[^\s<>"'()]+/gi;
  const TRAILING_PUNCT = /[.,;:!?)\]}]+$/;

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function stripTrailingPunctuation(url) {
    const trimmed = url.replace(TRAILING_PUNCT, '');
    return trimmed.length > 10 ? trimmed : url;
  }

  function detectProvider(url) {
    let m;
    // YouTube
    if ((m = /youtu\.be\/([\w-]{6,20})/.exec(url))) {
      return { provider: 'youtube', videoId: m[1], mediaType: 'video' };
    }
    if ((m = /youtube\.com\/shorts\/([\w-]{6,20})/.exec(url))) {
      return { provider: 'youtube', videoId: m[1], mediaType: 'video' };
    }
    if ((m = /youtube\.com\/watch\?[^#\s]*v=([\w-]{6,20})/.exec(url))) {
      return { provider: 'youtube', videoId: m[1], mediaType: 'video' };
    }

    // TikTok
    if ((m = /tiktok\.com\/@[\w.-]+\/video\/(\d{8,30})/.exec(url))) {
      return { provider: 'tiktok', videoId: m[1], mediaType: 'video' };
    }
    if ((m = /(?:vm|vt)\.tiktok\.com\/([\w-]{6,30})/.exec(url)) || (m = /tiktok\.com\/(?:t|vm)\/([\w-]{6,30})/.exec(url))) {
      return { provider: 'tiktok', videoId: m[1], mediaType: 'video' };
    }

    // Instagram
    if ((m = /instagram\.com\/reel[s]?\/([\w-]{5,40})/.exec(url))) {
      return { provider: 'instagram', videoId: m[1], mediaType: 'reel' };
    }
    if ((m = /instagram\.com\/p\/([\w-]{5,40})/.exec(url))) {
      return { provider: 'instagram', videoId: m[1], mediaType: 'post' };
    }

    // Facebook
    if ((m = /facebook\.com\/watch\/?\?[^#\s]*v=(\d+)/.exec(url)) || (m = /fb\.watch\/([\w-]{6,30})/.exec(url))) {
      return { provider: 'facebook', videoId: m[1], mediaType: 'video' };
    }
    if ((m = /facebook\.com\/reel\/(\d+)/.exec(url))) {
      return { provider: 'facebook', videoId: m[1], mediaType: 'reel' };
    }
    if ((m = /facebook\.com\/[^\s/]+\/videos\/(\d+)/.exec(url))) {
      return { provider: 'facebook', videoId: m[1], mediaType: 'video' };
    }
    if ((m = /facebook\.com\/[^\s/]+\/posts\/([\w.-]+)/.exec(url)) ||
        (m = /facebook\.com\/photo\.php\?[^#\s]*fbid=(\d+)/.exec(url)) ||
        (m = /facebook\.com\/permalink\.php\?[^#\s]*story_fbid=([\w.-]+)/.exec(url))) {
      return { provider: 'facebook', videoId: m[1], mediaType: 'post' };
    }

    return { provider: null, videoId: null, mediaType: null };
  }

  function formatMarkdown(escapedHtml) {
    if (!escapedHtml) return '';

    const placeholders = [];
    function save(html) {
      const idx = placeholders.length;
      placeholders.push(html);
      return `\x00PH_${idx}\x00`;
    }

    // 1. Code blocks: ```lang\ncode\n``` or ```code```
    let text = escapedHtml.replace(/```(?:([a-zA-Z0-9_-]+)?\n)?([\s\S]*?)```/g, (match, lang, code) => {
      const langClass = lang ? ` class="language-${lang}"` : '';
      return save(`<pre class="code-block"><code${langClass}>${code}</code></pre>`);
    });

    // 2. Inline code: `code`
    text = text.replace(/`([^`\n]+)`/g, (match, code) => {
      return save(`<code class="inline-code">${code}</code>`);
    });

    // 3. Blockquotes: lines starting with &gt; 
    const lines = text.split('\n');
    let inQuote = false;
    let quoteLines = [];
    const resultLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('&gt; ') || line === '&gt;') {
        inQuote = true;
        quoteLines.push(line.startsWith('&gt; ') ? line.slice(5) : '');
      } else {
        if (inQuote) {
          resultLines.push(`<blockquote>${quoteLines.join('<br>')}</blockquote>`);
          quoteLines = [];
          inQuote = false;
        }
        resultLines.push(line);
      }
    }
    if (inQuote) {
      resultLines.push(`<blockquote>${quoteLines.join('<br>')}</blockquote>`);
    }
    text = resultLines.join('\n');

    // 4. Strikethrough: ~~text~~
    text = text.replace(/~~([\s\S]+?)~~/g, '<del>$1</del>');

    // 5. Bold: **text**
    text = text.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');

    // 6. Underline: __text__
    text = text.replace(/__([\s\S]+?)__/g, '<u>$1</u>');

    // 7. Italic: *text* or _text_
    text = text.replace(/(^|[^\w*])\*([^*\n]+)\*([^\w*]|$)/g, '$1<em>$2</em>$3');
    text = text.replace(/(^|[^\w_])_([^_\n]+)_([^\w_]|$)/g, '$1<em>$2</em>$3');

    // 8. Spoilers: ||text||
    text = text.replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoiler" onclick="this.classList.toggle(\'revealed\')">$1</span>');

    // Restore placeholders
    text = text.replace(/\x00PH_(\d+)\x00/g, (match, idx) => {
      return placeholders[Number(idx)] || '';
    });

    return text;
  }

  function tokenizeMessage(text) {
    const tokens = [];
    let lastIndex = 0;
    let match;
    URL_RE.lastIndex = 0;
    while ((match = URL_RE.exec(text)) !== null) {
      if (match.index > lastIndex) {
        tokens.push({ type: 'text', text: text.slice(lastIndex, match.index) });
      }
      const url = stripTrailingPunctuation(match[0]);
      const detected = detectProvider(url);
      const token = { type: 'url', url, provider: detected.provider, videoId: detected.videoId };
      if (detected.mediaType) token.mediaType = detected.mediaType;
      tokens.push(token);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      tokens.push({ type: 'text', text: text.slice(lastIndex) });
    }
    if (tokens.length === 0) tokens.push({ type: 'text', text });
    return tokens;
  }

  return { escapeHtml, escapeRegex, formatMarkdown, tokenizeMessage, detectProvider };
});
