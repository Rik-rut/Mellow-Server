(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    global.Embed = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function buildYouTubeUrl(videoId) {
    return 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(videoId);
  }

  function buildTikTokUrl(videoId) {
    return 'https://www.tiktok.com/player/v1/' + encodeURIComponent(videoId);
  }

  function isSafeTikTokEmbedUrl(url) {
    return /^https:\/\/(?:www\.)?tiktok\.com\/(?:player\/v1|embed\/v2)\/\d+(?:\?.*)?$/.test(url);
  }

  function buildInstagramUrl(shortcode, mediaType) {
    const path = mediaType === 'reel' ? 'reel' : 'p';
    return 'https://www.instagram.com/' + path + '/' + encodeURIComponent(shortcode) + '/embed/';
  }

  function isSafeInstagramEmbedUrl(url) {
    return /^https:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels)\/[\w-]+\/embed\/?(?:\?.*)?$/.test(url);
  }

  function buildFacebookUrl(originalUrl, mediaType) {
    const plugin = mediaType === 'post' ? 'post.php' : 'video.php';
    const showText = mediaType === 'post' ? 'true' : 'false';
    return 'https://www.facebook.com/plugins/' + plugin + '?href=' + encodeURIComponent(originalUrl) + '&show_text=' + showText;
  }

  function isSafeFacebookEmbedUrl(url) {
    return /^https:\/\/(?:www\.)?facebook\.com\/plugins\/(?:video|post)\.php\?href=https?%3A%2F%2F.*$/.test(url);
  }

  function isDirectGifMediaUrl(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return /^media\d*\.tenor\.com$/.test(host)
        || /^(?:media\d*|i)\.giphy\.com$/.test(host);
    } catch (_) {
      return false;
    }
  }

  function getProviderMeta(provider, mediaType) {
    switch (provider) {
      case 'youtube':
        return {
          name: 'YouTube',
          iconClass: 'ph-youtube-logo',
          typeLabel: mediaType === 'shorts' ? 'Shorts' : 'Video',
          themeClass: 'embed-youtube'
        };
      case 'tiktok':
        return {
          name: 'TikTok',
          iconClass: 'ph-tiktok-logo',
          typeLabel: 'Video',
          themeClass: 'embed-tiktok'
        };
      case 'instagram':
        return {
          name: 'Instagram',
          iconClass: 'ph-instagram-logo',
          typeLabel: mediaType === 'reel' ? 'Reel' : (mediaType === 'post' ? 'Post' : 'Media'),
          themeClass: 'embed-instagram'
        };
      case 'facebook':
        return {
          name: 'Facebook',
          iconClass: 'ph-facebook-logo',
          typeLabel: mediaType === 'reel' ? 'Reel' : (mediaType === 'post' ? 'Post' : 'Video'),
          themeClass: 'embed-facebook'
        };
      case 'tenor':
        return {
          name: 'Tenor',
          iconClass: 'ph-gif',
          typeLabel: 'GIF',
          themeClass: 'embed-tenor'
        };
      case 'giphy':
        return {
          name: 'Giphy',
          iconClass: 'ph-gif',
          typeLabel: 'GIF',
          themeClass: 'embed-giphy'
        };
      default:
        return {
          name: 'Media',
          iconClass: 'ph-play-circle',
          typeLabel: 'Embed',
          themeClass: 'embed-generic'
        };
    }
  }

  function createUnifiedCard(opts) {
    if (typeof document === 'undefined') return null;
    const provider = opts.provider;
    const id = opts.id;
    const url = opts.url;
    const mediaType = opts.mediaType || 'video';
    const meta = getProviderMeta(provider, mediaType);

    const isVertical = (mediaType === 'reel' || mediaType === 'shorts' || provider === 'tiktok');
    const card = document.createElement('div');
    card.className = 'embed-card ' + meta.themeClass + ' embed-type-' + mediaType + (isVertical ? ' is-vertical' : '');

    // ── Header Bar ──────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'embed-card-header';

    const badge = document.createElement('div');
    badge.className = 'embed-card-badge';
    badge.innerHTML = '<i class="ph-bold ' + meta.iconClass + '"></i>' +
      '<span class="embed-brand-name">' + meta.name + '</span>' +
      '<span class="embed-type-chip">' + meta.typeLabel + '</span>';

    const actions = document.createElement('div');
    actions.className = 'embed-card-actions';

    // External link button
    const linkBtn = document.createElement('a');
    linkBtn.className = 'embed-btn embed-ext-btn';
    linkBtn.href = url;
    linkBtn.target = '_blank';
    linkBtn.rel = 'noopener noreferrer';
    linkBtn.title = 'Open on ' + meta.name;
    linkBtn.innerHTML = '<i class="ph-bold ph-arrow-square-out"></i>';

    // Collapse toggle button
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'embed-btn embed-collapse-btn';
    collapseBtn.type = 'button';
    collapseBtn.title = 'Collapse embed';
    collapseBtn.innerHTML = '<i class="ph-bold ph-caret-up"></i>';

    actions.appendChild(linkBtn);
    actions.appendChild(collapseBtn);

    header.appendChild(badge);
    header.appendChild(actions);
    card.appendChild(header);

    // ── Body Container ──────────────────────────────────────────
    const body = document.createElement('div');
    body.className = 'embed-card-body';
    card.appendChild(body);

    collapseBtn.addEventListener('click', function () {
      const isCollapsed = card.classList.toggle('is-collapsed');
      collapseBtn.innerHTML = isCollapsed ? '<i class="ph-bold ph-caret-down"></i>' : '<i class="ph-bold ph-caret-up"></i>';
      collapseBtn.title = isCollapsed ? 'Expand embed' : 'Collapse embed';
    });

    // ── Mount Provider Specific Content ─────────────────────────
    if (provider === 'youtube' && id) {
      // YouTube Facade
      const facade = document.createElement('div');
      facade.className = 'embed-facade';

      const thumb = document.createElement('img');
      thumb.className = 'embed-thumb';
      thumb.loading = 'lazy';
      thumb.alt = 'Play video on YouTube';
      thumb.src = 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/hqdefault.jpg';
      thumb.onerror = function () {
        thumb.src = 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/default.jpg';
      };

      const play = document.createElement('button');
      play.className = 'embed-play';
      play.type = 'button';
      play.setAttribute('aria-label', 'Play video');

      play.addEventListener('click', function () {
        const iframe = document.createElement('iframe');
        iframe.src = buildYouTubeUrl(id) + '?autoplay=1';
        iframe.className = 'embed-frame embed-frame-youtube';
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen';
        iframe.loading = 'lazy';
        body.innerHTML = '';
        body.appendChild(iframe);
      });

      facade.appendChild(thumb);
      facade.appendChild(play);
      body.appendChild(facade);

    } else if (provider === 'tiktok' && id) {
      // Native TikTok Player with built-in volume and controls
      const embedUrl = buildTikTokUrl(id) + '?volume_control=1&music_info=1';
      const iframe = document.createElement('iframe');
      iframe.src = embedUrl;
      iframe.className = 'embed-frame embed-frame-tiktok';
      iframe.loading = 'lazy';
      iframe.allow = 'autoplay; encrypted-media; fullscreen; accelerometer; gyroscope';
      iframe.setAttribute('allowtransparency', 'true');
      body.appendChild(iframe);

    } else if (provider === 'instagram') {
      // Clean Rich Media Card with inline HTML5 video player (avoids redirecting to Instagram)
      const igCard = document.createElement('div');
      igCard.className = 'embed-ig-card';

      const typeName = mediaType === 'reel' ? 'Reel' : 'Post';
      const actionText = mediaType === 'reel' ? 'Watch on Instagram' : 'View on Instagram';

      igCard.innerHTML = `
        <div class="embed-ig-media-wrap">
          <div class="embed-ig-placeholder">
            <i class="ph-bold ph-instagram-logo"></i>
            <span>Loading Instagram preview...</span>
          </div>
        </div>
        <div class="embed-ig-content">
          <div class="embed-ig-header">
            <span class="embed-ig-author">Instagram ${typeName}</span>
          </div>
          <div class="embed-ig-caption"></div>
          <a class="embed-ig-cta-btn" href="${url}" target="_blank" rel="noopener noreferrer">
            <i class="ph-bold ph-arrow-square-out"></i> ${actionText}
          </a>
        </div>
      `;
      body.appendChild(igCard);

      const mediaWrap = igCard.querySelector('.embed-ig-media-wrap');

      function mountInlineVideo(videoSrc) {
        if (!mediaWrap) return;
        mediaWrap.innerHTML = '';
        const video = document.createElement('video');
        video.className = 'embed-ig-video';
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.src = videoSrc;
        video.onerror = function () {
          mediaWrap.innerHTML = '<div class="embed-ig-placeholder"><i class="ph-bold ph-warning-circle"></i><span>Unable to play video inline. <a href="' + url + '" target="_blank" rel="noopener noreferrer" style="color:#e1306c;text-decoration:underline;">Watch on Instagram</a></span></div>';
        };
        mediaWrap.appendChild(video);
        video.play().catch(function () {
          // If browser restricts unmuted autoplay, mute and continue playing
          video.muted = true;
          video.play().catch(function () {});
        });
      }

      // If user clicks placeholder before preview metadata finishes loading
      if (mediaType === 'reel' && mediaWrap) {
        const placeholder = igCard.querySelector('.embed-ig-placeholder');
        if (placeholder) {
          placeholder.style.cursor = 'pointer';
          placeholder.title = 'Play Reel inline';
          placeholder.addEventListener('click', function () {
            mountInlineVideo('/api/embed/video?url=' + encodeURIComponent(url));
          });
        }
      }

      // Asynchronously fetch rich metadata from backend
      if (typeof fetch !== 'undefined') {
        fetch('/api/embed/preview?url=' + encodeURIComponent(url))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (!data) {
              const placeholder = igCard.querySelector('.embed-ig-placeholder');
              if (placeholder) {
                placeholder.innerHTML = '<i class="ph-bold ph-instagram-logo"></i><span>Instagram ' + typeName + '</span>';
              }
              return;
            }
            const authorEl = igCard.querySelector('.embed-ig-author');
            const captionEl = igCard.querySelector('.embed-ig-caption');
            const ctaBtn = igCard.querySelector('.embed-ig-cta-btn');

            if (data.author && authorEl) {
              authorEl.textContent = data.author;
            }
            if (data.description && captionEl) {
              captionEl.textContent = data.description;
            } else if (data.title && captionEl) {
              captionEl.textContent = data.title;
            }

            if (data.image && mediaWrap) {
              const isVideo = (mediaType === 'reel' || data.hasVideo || !!data.video);

              if (isVideo) {
                // Interactive facade that plays inline video upon click
                const facade = document.createElement('div');
                facade.className = 'embed-ig-media-facade';
                facade.setAttribute('role', 'button');
                facade.setAttribute('tabindex', '0');
                facade.setAttribute('aria-label', 'Play Instagram video inline');

                const img = document.createElement('img');
                img.src = data.image;
                img.alt = data.title || 'Instagram preview';
                img.className = 'embed-ig-image';
                img.loading = 'lazy';
                facade.appendChild(img);

                const playOverlay = document.createElement('div');
                playOverlay.className = 'embed-ig-play-overlay';
                playOverlay.innerHTML = '<div class="embed-ig-play-badge"><i class="ph-fill ph-play"></i><span>Play Inline</span></div>';
                facade.appendChild(playOverlay);

                const videoSrc = data.video || ('/api/embed/video?url=' + encodeURIComponent(url));
                facade.addEventListener('click', function () {
                  mountInlineVideo(videoSrc);
                });
                facade.addEventListener('keydown', function (e) {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    mountInlineVideo(videoSrc);
                  }
                });

                mediaWrap.innerHTML = '';
                mediaWrap.appendChild(facade);
              } else {
                // Photo post
                mediaWrap.innerHTML = '';
                const imgLink = document.createElement('a');
                imgLink.href = url;
                imgLink.target = '_blank';
                imgLink.rel = 'noopener noreferrer';
                imgLink.className = 'embed-ig-img-link';

                const img = document.createElement('img');
                img.src = data.image;
                img.alt = data.title || 'Instagram preview';
                img.className = 'embed-ig-image';
                img.loading = 'lazy';
                imgLink.appendChild(img);

                mediaWrap.appendChild(imgLink);
              }
            }

            if (ctaBtn) {
              ctaBtn.innerHTML = '<i class="ph-bold ph-arrow-square-out"></i> ' + actionText;
            }
          })
          .catch(function () {
            const placeholder = igCard.querySelector('.embed-ig-placeholder');
            if (placeholder) {
              placeholder.innerHTML = '<i class="ph-bold ph-instagram-logo"></i><span>Instagram ' + typeName + '</span>';
            }
          });
      }

    } else if (provider === 'tenor' || provider === 'giphy') {
      const gifWrap = document.createElement('div');
      gifWrap.className = 'embed-gif';
      const loading = document.createElement('div');
      loading.className = 'embed-gif-placeholder';
      loading.textContent = 'Loading GIF...';
      gifWrap.appendChild(loading);
      body.appendChild(gifWrap);

      function showGif(src, title) {
        gifWrap.innerHTML = '';
        const img = document.createElement('img');
        img.className = 'embed-gif-image';
        img.loading = 'lazy';
        img.alt = title || ((provider === 'tenor' ? 'Tenor' : 'Giphy') + ' GIF');
        img.src = src;
        img.onerror = function () {
          gifWrap.innerHTML = '<div class="embed-gif-placeholder">GIF unavailable</div>';
        };
        gifWrap.appendChild(img);
      }

      if (isDirectGifMediaUrl(url)) {
        showGif(url, '');
      } else if (typeof fetch !== 'undefined') {
        fetch('/api/embed/gif?url=' + encodeURIComponent(url))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (data && data.image) showGif(data.image, data.title);
            else gifWrap.innerHTML = '<div class="embed-gif-placeholder">GIF unavailable</div>';
          })
          .catch(function () {
            gifWrap.innerHTML = '<div class="embed-gif-placeholder">GIF unavailable</div>';
          });
      }
    } else if (provider === 'facebook') {
      const embedUrl = buildFacebookUrl(url, mediaType);
      const iframe = document.createElement('iframe');
      iframe.src = embedUrl;
      iframe.className = 'embed-frame embed-frame-facebook' + (mediaType === 'reel' ? ' embed-frame-reel' : '');
      iframe.loading = 'lazy';
      iframe.allow = 'autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share; fullscreen';
      iframe.setAttribute('scrolling', 'no');
      iframe.setAttribute('allowtransparency', 'true');
      body.appendChild(iframe);
    }

    return card;
  }

  // Legacy facade support for existing tests
  function makeYouTubeFacade(slot, videoId) {
    const card = createUnifiedCard({ provider: 'youtube', id: videoId, url: 'https://youtu.be/' + videoId, mediaType: 'video' });
    slot.innerHTML = '';
    slot.appendChild(card);
  }

  function initEmbeds(root) {
    const slots = (root || document).querySelectorAll('.embed-slot:not([data-embed-done])');
    if (!slots.length) return;

    function renderSlot(slot) {
      slot.setAttribute('data-embed-done', '1');
      const provider = slot.getAttribute('data-provider');
      const id = slot.getAttribute('data-id');
      const url = slot.getAttribute('data-url');
      const mediaType = slot.getAttribute('data-media-type') || 'video';

      if (provider) {
        const card = createUnifiedCard({ provider, id, url, mediaType });
        if (card) {
          slot.appendChild(card);
        }
      }
    }

    if (!('IntersectionObserver' in window)) {
      slots.forEach(renderSlot);
      return;
    }

    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        const slot = entry.target;
        io.unobserve(slot);
        renderSlot(slot);
      });
    }, { rootMargin: '400px' });

    slots.forEach(function (slot) { io.observe(slot); });
  }

  return {
    buildYouTubeUrl,
    buildTikTokUrl,
    buildInstagramUrl,
    buildFacebookUrl,
    isSafeTikTokEmbedUrl,
    isSafeInstagramEmbedUrl,
    isSafeFacebookEmbedUrl,
    createUnifiedCard,
    initEmbeds,
    makeYouTubeFacade
  };
});
