"use strict";

/**
 * Rewind v0.5
 *
 * Main fixes:
 * - Per-URL snapshot candidates.
 * - Capture before navigation intent, not only after mutation.
 * - Do not let blank/current SPA shells overwrite the previous page.
 * - Native styled overlay + fallback clickable recovery grid.
 */

(() => {
  const STORAGE_KEYS = {
    SETTINGS: "pageRestorerSettings",
    SNAPSHOTS: "pageRestorerSnapshots",
    PREVIOUS_URL: "pageRestorerPreviousUrl",
    LAST_ACTIVE_URL: "pageRestorerLastActiveUrl",
    SCHEMA_VERSION: "pageRestorerSchemaVersion"
  };

  const SCHEMA_VERSION = 5;
  const OVERLAY_ID = "page-restorer-overlay-root";

  const DEFAULT_SETTINGS = {
    enabled: true,

    // 10 seconds was too unforgiving while debugging SPA timing.
    snapshotTtlMs: 60_000,

    maxSnapshots: 8,
    maxHtmlChars: 1_500_000,
    maxInlineStyleChars: 650_000,
    maxFallbackItems: 150,

    mutationDebounceMs: 250,
    mutationMaxWaitMs: 750,
    urlPollMs: 100,

    // Prevent empty black SPA shells from replacing useful snapshots.
    minQualityScore: 20
  };

  let settings = { ...DEFAULT_SETTINGS };
  let enabled = true;

  let lastKnownUrl = location.href;
  let observer = null;
  let urlPollTimer = null;
  let mutationDebounceTimer = null;
  let mutationMaxWaitTimer = null;
  let writeQueue = Promise.resolve();

  const bestSnapshotByUrl = new Map();
  const savedSignatureByUrl = new Map();

  let lifecycleListenersStarted = false;
  let hasBooted = false;
  let activeRestoreCleanup = null;

  function isHttpPage() {
    return location.protocol === "http:" || location.protocol === "https:";
  }

  function hasBody() {
    return Boolean(document.body);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function migrateOldStorageIfNeeded() {
    const data = await browser.storage.local.get(STORAGE_KEYS.SCHEMA_VERSION);

    if (data[STORAGE_KEYS.SCHEMA_VERSION] === SCHEMA_VERSION) {
      return;
    }

    await browser.storage.local.remove([
      STORAGE_KEYS.SNAPSHOTS,
      STORAGE_KEYS.PREVIOUS_URL,
      STORAGE_KEYS.LAST_ACTIVE_URL
    ]);

    await browser.storage.local.set({
      [STORAGE_KEYS.SCHEMA_VERSION]: SCHEMA_VERSION
    });
  }

  async function loadSettings() {
    const data = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
    const stored = data[STORAGE_KEYS.SETTINGS] || {};

    settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      snapshotTtlMs: Math.max(
        Number(stored.snapshotTtlMs || DEFAULT_SETTINGS.snapshotTtlMs),
        30_000
      )
    };

    enabled = Boolean(settings.enabled);
  }

  function enqueueStorageWrite(task) {
    writeQueue = writeQueue.then(task).catch((error) => {
      console.error("[Page Restorer] Storage write failed:", error);
    });

    return writeQueue;
  }

  function textOf(element) {
    return String(element?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function absolutizeUrl(value, baseUrl = location.href) {
    if (!value) return "";

    try {
      const url = new URL(value, baseUrl);

      if (url.protocol === "javascript:") {
        return "";
      }

      return url.toString();
    } catch {
      return value;
    }
  }

  function isVisibleElement(element) {
    if (!element || !(element instanceof Element)) return false;

    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return (
      rect.width > 8 &&
      rect.height > 8 &&
      rect.bottom > -250 &&
      rect.top < window.innerHeight + 1400 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || 1) > 0
    );
  }

  function rewriteCssUrls(cssText, baseUrl = location.href) {
    if (!cssText) return "";

    let output = cssText.replace(
      /url\(\s*(['"]?)(?!data:|blob:|https?:|chrome:|moz-extension:|about:|#)([^'")]+)\1\s*\)/gi,
      (_match, _quote, rawUrl) => {
        return `url("${absolutizeUrl(rawUrl, baseUrl)}")`;
      }
    );

    output = output.replace(
      /@import\s+(['"])(?!https?:|data:|blob:|chrome:|moz-extension:)([^'"]+)\1/gi,
      (_match, quote, rawUrl) => {
        return `@import ${quote}${absolutizeUrl(rawUrl, baseUrl)}${quote}`;
      }
    );

    return output;
  }

  function absolutizeSrcset(srcset, baseUrl = location.href) {
    if (!srcset) return "";

    return srcset
      .split(",")
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return "";

        const pieces = trimmed.split(/\s+/);
        const url = pieces.shift();

        if (!url) return trimmed;

        if (/^(https?:|data:|blob:)/i.test(url)) {
          return trimmed;
        }

        return [absolutizeUrl(url, baseUrl), ...pieces].join(" ");
      })
      .filter(Boolean)
      .join(", ");
  }

  function sanitizeHtml(html, baseUrl = location.href) {
    const template = document.createElement("template");
    template.innerHTML = html || "";

    template.content.querySelectorAll("script").forEach((node) => node.remove());
    template.content.querySelectorAll(`#${OVERLAY_ID}`).forEach((node) => node.remove());

    for (const element of template.content.querySelectorAll("*")) {
      for (const attr of Array.from(element.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value || "";

        if (name.startsWith("on")) {
          element.removeAttribute(attr.name);
          continue;
        }

        if (name === "href") {
          const absolute = absolutizeUrl(value, baseUrl);

          if (!absolute || absolute.startsWith("javascript:")) {
            element.removeAttribute(attr.name);
          } else {
            element.setAttribute(attr.name, absolute);
          }

          continue;
        }

        if (["src", "poster", "action", "formaction"].includes(name)) {
          const absolute = absolutizeUrl(value, baseUrl);

          if (!absolute || absolute.startsWith("javascript:")) {
            element.removeAttribute(attr.name);
          } else {
            element.setAttribute(attr.name, absolute);
          }

          continue;
        }

        if (name === "srcset") {
          element.setAttribute(attr.name, absolutizeSrcset(value, baseUrl));
          continue;
        }

        if (name === "style") {
          element.setAttribute(attr.name, rewriteCssUrls(value, baseUrl));
        }
      }

      if (
        element.matches?.(
          "input[type='password'], input[autocomplete='current-password'], input[autocomplete='new-password']"
        )
      ) {
        element.setAttribute("value", "");
      }
    }

    return template.innerHTML;
  }

  function getCleanBodyHtml() {
    if (!document.body) return "";

    let cleanHtml = sanitizeHtml(document.body.innerHTML || "", location.href);

    if (cleanHtml.length > settings.maxHtmlChars) {
      cleanHtml =
        cleanHtml.slice(0, settings.maxHtmlChars) +
        "\n<!-- Page Restorer: snapshot truncated. -->";
    }

    return cleanHtml;
  }

  function mediaMatches(mediaText) {
    const media = String(mediaText || "").trim();

    if (!media || media.toLowerCase() === "all") return true;

    try {
      return window.matchMedia(media).matches;
    } catch {
      return true;
    }
  }

  function captureStyleData() {
    const head = document.head;

    if (!head) {
      return {
        links: [],
        inlineStyles: []
      };
    }

    const seenLinks = new Set();

    const links = Array.from(head.querySelectorAll("link[rel][href]"))
      .filter((link) => {
        const rel = String(link.getAttribute("rel") || "").toLowerCase();
        const media = link.getAttribute("media") || "";

        return (
          rel.split(/\s+/).includes("stylesheet") &&
          !link.disabled &&
          mediaMatches(media)
        );
      })
      .map((link) => {
        return {
          href: absolutizeUrl(link.getAttribute("href"), location.href),
          media: link.getAttribute("media") || "",
          crossOrigin: link.getAttribute("crossorigin") || "",
          referrerPolicy: link.getAttribute("referrerpolicy") || ""
        };
      })
      .filter((item) => {
        if (!item.href || seenLinks.has(item.href)) return false;
        seenLinks.add(item.href);
        return true;
      });

    let usedInlineChars = 0;

    const inlineStyles = Array.from(head.querySelectorAll("style"))
      .map((styleNode) => {
        const cssText = rewriteCssUrls(styleNode.textContent || "", location.href);

        if (!cssText.trim()) return null;

        usedInlineChars += cssText.length;

        if (usedInlineChars > settings.maxInlineStyleChars) return null;

        return {
          cssText,
          media: styleNode.getAttribute("media") || ""
        };
      })
      .filter(Boolean)
      .filter((style) => mediaMatches(style.media));

    return {
      links,
      inlineStyles
    };
  }

  function copySafeAttributes(element) {
    if (!element) return [];

    return Array.from(element.attributes)
      .filter((attr) => {
        const name = attr.name.toLowerCase();
        return !name.startsWith("on") && name !== "src" && name !== "href";
      })
      .map((attr) => [attr.name, attr.value]);
  }

  function getCustomProperties(element) {
    if (!element) return {};

    const computed = getComputedStyle(element);
    const output = {};
    let count = 0;

    for (let i = 0; i < computed.length; i += 1) {
      const propertyName = computed[i];

      if (!propertyName || !propertyName.startsWith("--")) continue;

      output[propertyName] = computed.getPropertyValue(propertyName).trim();
      count += 1;

      if (count >= 700) break;
    }

    return output;
  }

  function captureDocumentInfo() {
    const bodyStyle = document.body ? getComputedStyle(document.body) : null;

    return {
      url: location.href,
      title: document.title || location.href,
      htmlAttributes: copySafeAttributes(document.documentElement),
      bodyAttributes: copySafeAttributes(document.body),
      htmlClass: document.documentElement?.className || "",
      bodyClass: document.body?.className || "",
      rootCustomProperties: getCustomProperties(document.documentElement),
      bodyCustomProperties: getCustomProperties(document.body),
      backgroundColor: bodyStyle?.backgroundColor || "#0f0f0f",
      color: bodyStyle?.color || "#ffffff",
      fontFamily: bodyStyle?.fontFamily || "system-ui, sans-serif"
    };
  }
  function collectDeep(root, selector, limit = 1800) {
    const results = [];
    const seen = new Set();

    function addAllFrom(scope) {
      if (!scope || !scope.querySelectorAll || results.length >= limit) return;

      for (const element of scope.querySelectorAll(selector)) {
        if (results.length >= limit) break;

        if (!seen.has(element)) {
          seen.add(element);
          results.push(element);
        }
      }

      for (const element of scope.querySelectorAll("*")) {
        if (results.length >= limit) break;

        if (element.shadowRoot) {
          addAllFrom(element.shadowRoot);
        }
      }
    }

    addAllFrom(root);
    return results;
  }

  function firstUsefulText(value, max = 260) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  }

  function pickBestSrcFromSrcset(srcset, baseUrl = location.href) {
    if (!srcset) return "";

    const candidates = srcset
      .split(",")
      .map((part) => {
        const pieces = part.trim().split(/\s+/);
        const url = pieces[0];
        const descriptor = pieces[1] || "";

        let score = 0;

        if (descriptor.endsWith("w")) {
          score = Number.parseInt(descriptor, 10) || 0;
        } else if (descriptor.endsWith("x")) {
          score = Math.round((Number.parseFloat(descriptor) || 1) * 1000);
        }

        return {
          url: absolutizeUrl(url, baseUrl),
          score
        };
      })
      .filter((item) => item.url);

    candidates.sort((a, b) => b.score - a.score);

    return candidates[0]?.url || "";
  }

  function getImageUrl(img) {
    if (!img) return "";

    const direct =
      img.currentSrc ||
      img.src ||
      img.getAttribute("src") ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-lazy-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-url") ||
      img.getAttribute("content") ||
      "";

    if (direct && !direct.startsWith("blob:")) {
      return absolutizeUrl(direct, location.href);
    }

    const srcset =
      img.getAttribute("srcset") ||
      img.getAttribute("data-srcset") ||
      "";

    return pickBestSrcFromSrcset(srcset, location.href);
  }

  function getVideoData(video) {
    if (!video) {
      return {
        videoSrc: "",
        poster: ""
      };
    }

    const rawVideoSrc =
      video.currentSrc ||
      video.src ||
      video.getAttribute("src") ||
      video.querySelector("source[src]")?.getAttribute("src") ||
      "";

    const poster =
      video.poster ||
      video.getAttribute("poster") ||
      video.getAttribute("data-poster") ||
      "";

    let videoSrc = "";

    /**
     * Blob URLs usually die after navigation and cannot be replayed.
     * Direct mp4/webm/ogg URLs are often restorable.
     */
    if (
      rawVideoSrc &&
      !rawVideoSrc.startsWith("blob:") &&
      /\.(mp4|webm|ogg)(\?|#|$)/i.test(rawVideoSrc)
    ) {
      videoSrc = absolutizeUrl(rawVideoSrc, location.href);
    }

    return {
      videoSrc,
      poster: poster ? absolutizeUrl(poster, location.href) : ""
    };
  }

  function extractCssBackgroundUrl(element) {
    if (!element) return "";

    const values = [
      element.style?.backgroundImage || "",
      getComputedStyle(element).backgroundImage || ""
    ];

    for (const value of values) {
      if (!value || value === "none") continue;

      const match = value.match(/url\((['"]?)(.*?)\1\)/i);
      if (!match || !match[2]) continue;

      const url = match[2];

      if (
        url.startsWith("data:") ||
        url.startsWith("blob:") ||
        url.includes("gradient")
      ) {
        continue;
      }

      return absolutizeUrl(url, location.href);
    }

    return "";
  }

  function isLikelyNoiseElement(element) {
    if (!element || !(element instanceof Element)) return true;

    return Boolean(
      element.closest(
        [
          `#${OVERLAY_ID}`,
          "nav",
          "header",
          "footer",
          "[role='navigation']",
          "[role='banner']",
          "[aria-label='Primary']",
          "[aria-label='Sidebar']",
          "#masthead",
          "#guide",
          "ytd-masthead",
          "ytd-mini-guide-renderer"
        ].join(",")
      )
    );
  }

  function getCardContainer(element) {
    if (!element || !(element instanceof Element)) return null;

    return (
      element.closest("article") ||
      element.closest("[role='article']") ||
      element.closest("shreddit-post") ||
      element.closest("[data-testid*='post']") ||
      element.closest("[data-testid*='Post']") ||
      element.closest("[data-testid*='tweet']") ||
      element.closest("[data-click-id='body']") ||
      element.closest("[slot='post-container']") ||
      element.closest("li") ||
      element.closest(".post") ||
      element.closest(".Post") ||
      element.closest(".thing") ||
      element.closest(".card") ||
      element.closest("[class*='card']") ||
      element.closest("[class*='Card']") ||
      element.closest("ytd-rich-item-renderer") ||
      element.closest("ytd-video-renderer") ||
      element.closest("ytd-compact-video-renderer") ||
      element.closest("div")
    );
  }

  function findTitleInCard(card, anchor, mediaElement) {
    const titleCandidates = [
      anchor?.getAttribute("title"),
      anchor?.getAttribute("aria-label"),
      mediaElement?.getAttribute("alt"),
      mediaElement?.getAttribute("aria-label"),
      textOf(anchor),
      textOf(card?.querySelector?.("h1,h2,h3,h4,[role='heading']")),
      textOf(card?.querySelector?.("[slot='title']")),
      textOf(card?.querySelector?.("[data-testid*='title']")),
      textOf(card?.querySelector?.("[class*='title']")),
      textOf(card?.querySelector?.("[class*='Title']"))
    ];

    for (const candidate of titleCandidates) {
      const clean = firstUsefulText(candidate, 240);

      if (clean && clean.length >= 3) {
        return clean;
      }
    }

    const cardText = firstUsefulText(textOf(card), 240);

    if (cardText.length >= 3) {
      return cardText;
    }

    return "Restored item";
  }

  function findPrimaryLink(card, fallbackElement) {
    const link =
      fallbackElement?.closest?.("a[href]") ||
      card?.querySelector?.("a[href]") ||
      null;

    if (!link) return "";

    const raw = link.getAttribute("href") || "";

    if (!raw || raw.startsWith("#") || raw.startsWith("javascript:")) {
      return "";
    }

    return absolutizeUrl(raw, location.href);
  }

  function findMediaInCard(card, seedElement) {
    const searchRoots = [seedElement, card].filter(Boolean);

    for (const root of searchRoots) {
      if (!root || !root.querySelector) continue;

      const video = root.matches?.("video") ? root : root.querySelector("video");

      if (video && isVisibleElement(video)) {
        const videoData = getVideoData(video);

        if (videoData.videoSrc || videoData.poster) {
          return {
            mediaType: "video",
            image: videoData.poster,
            videoSrc: videoData.videoSrc
          };
        }
      }

      const pictureImg =
        root.querySelector("picture img") ||
        root.querySelector("img[src], img[srcset], img[data-src], img[data-lazy-src]");

      if (pictureImg && isVisibleElement(pictureImg)) {
        const src = getImageUrl(pictureImg);

        if (src) {
          return {
            mediaType: "image",
            image: src,
            videoSrc: ""
          };
        }
      }
    }

    const backgroundCandidates = [
      seedElement,
      card,
      ...(card?.querySelectorAll?.("[style*='background'], [class]") || [])
    ].filter(Boolean);

    for (const element of backgroundCandidates.slice(0, 80)) {
      if (!isVisibleElement(element)) continue;

      const bg = extractCssBackgroundUrl(element);

      if (bg) {
        return {
          mediaType: "image",
          image: bg,
          videoSrc: ""
        };
      }
    }

    return {
      mediaType: "text",
      image: "",
      videoSrc: ""
    };
  }

  function cardToFallbackItem(card, seedElement) {
    if (!card || !isVisibleElement(card) || isLikelyNoiseElement(card)) {
      return null;
    }

    const link = findPrimaryLink(card, seedElement);
    const media = findMediaInCard(card, seedElement);

    const possibleAnchor =
      seedElement?.closest?.("a[href]") ||
      card.querySelector?.("a[href]") ||
      null;

    const possibleMedia =
      seedElement?.matches?.("img,video") ? seedElement :
        card.querySelector?.("img,video") ||
        null;

    const title = findTitleInCard(card, possibleAnchor, possibleMedia);

    const fullText = firstUsefulText(textOf(card), 420);
    const meta = firstUsefulText(
      fullText.replace(title, "").replace(/\s+/g, " "),
      280
    );

    if (!link && !media.image && !media.videoSrc && title === "Restored item") {
      return null;
    }

    return {
      href: link || media.image || media.videoSrc || "",
      title,
      meta,
      image: media.image || "",
      videoSrc: media.videoSrc || "",
      mediaType: media.mediaType || "text"
    };
  }

  function dedupeFallbackItems(items) {
    const seen = new Set();
    const output = [];

    for (const item of items) {
      const key = [
        item.href || "",
        item.image || "",
        item.videoSrc || "",
        item.title || ""
      ].join("|");

      if (seen.has(key)) continue;
      seen.add(key);

      output.push(item);

      if (output.length >= settings.maxFallbackItems) {
        break;
      }
    }

    return output;
  }

  function scoreFallbackItem(item) {
    let score = 0;

    if (item.href) score += 8;
    if (item.image) score += 18;
    if (item.videoSrc) score += 24;
    if (item.mediaType === "video") score += 12;
    if (item.title && item.title.length > 10) score += 10;
    if (item.meta && item.meta.length > 20) score += 4;

    return score;
  }

  function extractVisibleFallbackItems() {
    const candidateItems = [];

    /**
     * 1. First pass: obvious content cards.
     * This catches Reddit posts, Twitter/X posts, YouTube cards, news cards,
     * product cards, forum cards, etc.
     */
    const cardSelector = [
      "article",
      "[role='article']",
      "shreddit-post",
      "[data-testid*='post']",
      "[data-testid*='Post']",
      "[data-testid*='tweet']",
      "[data-click-id='body']",
      "[slot='post-container']",
      ".post",
      ".Post",
      ".thing",
      ".card",
      "[class*='card']",
      "[class*='Card']",
      "ytd-rich-item-renderer",
      "ytd-video-renderer",
      "ytd-compact-video-renderer"
    ].join(",");

    const cards = collectDeep(document, cardSelector, 1000);

    for (const card of cards) {
      const item = cardToFallbackItem(card, card);

      if (item) {
        candidateItems.push(item);
      }
    }

    /**
     * 2. Second pass: visible links.
     */
    const anchors = collectDeep(document, "a[href]", 1600);

    for (const anchor of anchors) {
      if (!isVisibleElement(anchor) || isLikelyNoiseElement(anchor)) continue;

      const card = getCardContainer(anchor);
      const item = cardToFallbackItem(card || anchor, anchor);

      if (item) {
        candidateItems.push(item);
      }
    }

    /**
     * 3. Third pass: standalone visible images/videos.
     * This is important for Reddit, image galleries, blogs, shopping sites,
     * and pages where media is not wrapped in a normal anchor.
     */
    const mediaElements = collectDeep(
      document,
      [
        "img",
        "picture img",
        "video",
        "[style*='background-image']",
        "[style*='background']"
      ].join(","),
      1600
    );

    for (const mediaElement of mediaElements) {
      if (!isVisibleElement(mediaElement) || isLikelyNoiseElement(mediaElement)) continue;

      const card = getCardContainer(mediaElement) || mediaElement;
      const item = cardToFallbackItem(card, mediaElement);

      if (item) {
        candidateItems.push(item);
      }
    }

    candidateItems.sort((a, b) => scoreFallbackItem(b) - scoreFallbackItem(a));

    return {
      url: location.href,
      title: document.title || location.href,
      items: dedupeFallbackItems(candidateItems),
      capturedAt: Date.now()
    };
  }

  function createFallbackView(snapshot) {
    const items = snapshot.fallback?.items || [];

    const wrapper = document.createElement("div");

    Object.assign(wrapper.style, {
      minHeight: "100vh",
      padding: "76px 24px 32px",
      background: "#0f0f0f",
      color: "#fff",
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    });

    const header = document.createElement("div");

    const title = document.createElement("div");
    title.textContent = "Restored clickable media and content";
    Object.assign(title.style, {
      fontSize: "22px",
      fontWeight: "900",
      marginBottom: "6px"
    });

    const subtitle = document.createElement("div");
    subtitle.textContent =
      "The site’s raw SPA snapshot was blank or unstable, so Rewind rebuilt a recovery view from visible images, videos, links, titles, and text captured before navigation.";
    Object.assign(subtitle.style, {
      fontSize: "13px",
      color: "#aaa",
      marginBottom: "20px",
      lineHeight: "1.45"
    });

    header.append(title, subtitle);

    const grid = document.createElement("div");
    Object.assign(grid.style, {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
      gap: "18px"
    });

    if (!items.length) {
      const empty = document.createElement("div");
      empty.textContent =
        "No visible media/content was captured. Wait until the page fully paints images/posts, then navigate away again.";

      Object.assign(empty.style, {
        color: "#ddd",
        fontSize: "14px",
        padding: "20px",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: "16px",
        background: "rgba(255,255,255,0.06)"
      });

      grid.append(empty);
    }

    for (const item of items) {
      const href = item.href || item.image || item.videoSrc || "#";

      const card = document.createElement(href && href !== "#" ? "a" : "div");

      if (card.tagName.toLowerCase() === "a") {
        card.href = href;
        card.target = "_self";
        card.rel = "noopener noreferrer";
      }

      Object.assign(card.style, {
        display: "block",
        color: "inherit",
        textDecoration: "none",
        borderRadius: "16px",
        overflow: "hidden",
        background: "#181818",
        border: "1px solid rgba(255,255,255,0.10)",
        boxShadow: "0 12px 30px rgba(0,0,0,0.22)"
      });

      const mediaBox = document.createElement("div");
      Object.assign(mediaBox.style, {
        aspectRatio: "16 / 9",
        background: "#242424",
        overflow: "hidden",
        display: "grid",
        placeItems: "center"
      });

      if (item.videoSrc) {
        const video = document.createElement("video");
        video.src = item.videoSrc;
        video.controls = true;
        video.muted = true;
        video.preload = "metadata";

        if (item.image) {
          video.poster = item.image;
        }

        Object.assign(video.style, {
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block"
        });

        mediaBox.append(video);
      } else if (item.image) {
        const img = document.createElement("img");
        img.src = item.image;
        img.alt = item.title || "Restored image";
        img.loading = "lazy";

        Object.assign(img.style, {
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block"
        });

        mediaBox.append(img);
      } else {
        const placeholder = document.createElement("div");
        placeholder.textContent = item.mediaType === "video" ? "Video link" : "Text item";

        Object.assign(placeholder.style, {
          color: "#aaa",
          fontSize: "13px",
          fontWeight: "700"
        });

        mediaBox.append(placeholder);
      }

      const body = document.createElement("div");
      Object.assign(body.style, {
        padding: "12px"
      });

      const itemTitle = document.createElement("div");
      itemTitle.textContent = item.title || "Restored item";

      Object.assign(itemTitle.style, {
        fontSize: "14px",
        lineHeight: "1.38",
        fontWeight: "800",
        marginBottom: "7px"
      });

      const meta = document.createElement("div");
      meta.textContent = item.meta || item.href || item.image || "";

      Object.assign(meta.style, {
        fontSize: "12px",
        lineHeight: "1.38",
        color: "#aaa",
        display: "-webkit-box",
        WebkitLineClamp: "3",
        WebkitBoxOrient: "vertical",
        overflow: "hidden"
      });

      body.append(itemTitle, meta);
      card.append(mediaBox, body);
      grid.append(card);
    }

    wrapper.append(header, grid);
    return wrapper;
  }

  function nativeSnapshotLooksWrong(container) {
    const textLength = textOf(container).length;
    const visibleImages = Array.from(container.querySelectorAll("img")).filter(isVisibleElement).length;
    const visibleVideos = Array.from(container.querySelectorAll("video")).filter(isVisibleElement).length;
    const visibleLinks = Array.from(container.querySelectorAll("a[href]")).filter(isVisibleElement).length;

    return (
      textLength < 100 &&
      visibleImages < 1 &&
      visibleVideos < 1 &&
      visibleLinks < 2
    );
  }
  

  function scoreSnapshot(html, fallback) {
    const bodyTextLength = textOf(document.body).length;
    const fallbackCount = fallback?.items?.length || 0;
    const imageCount = fallback?.items?.filter((item) => item.image).length || 0;

    let score = 0;

    if (html && html.length > 5000) score += 5;
    if (bodyTextLength > 120) score += 10;
    if (bodyTextLength > 500) score += 10;

    score += Math.min(fallbackCount * 4, 40);
    score += Math.min(imageCount * 3, 30);

    return {
      score,
      bodyTextLength,
      fallbackCount,
      imageCount
    };
  }

  function makeSnapshotSignature(snapshot) {
    const html = snapshot.html || "";
    const styleLinks = snapshot.styles?.links?.map((item) => item.href).join("|") || "";
    const fallbackLinks =
      snapshot.fallback?.items?.map((item) => item.href).slice(0, 25).join("|") || "";

    return [
      html.length,
      html.slice(0, 100),
      html.slice(-100),
      styleLinks,
      fallbackLinks
    ].join("::");
  }

  function buildSnapshot(url, reason) {
    if (!hasBody()) return null;

    const html = getCleanBodyHtml();
    const styles = captureStyleData();
    const documentInfo = captureDocumentInfo();
    const fallback = extractVisibleFallbackItems();
    const quality = scoreSnapshot(html, fallback);

    if (!html || !html.trim()) return null;

    return {
      url,
      title: document.title || url,
      html,
      styles,
      documentInfo,
      fallback,
      timestamp: Date.now(),
      reason,
      length: html.length,
      styleCount: (styles.links?.length || 0) + (styles.inlineStyles?.length || 0),
      fallbackCount: fallback.items?.length || 0,
      quality
    };
  }

  function rememberBestSnapshot(snapshot) {
    if (!snapshot?.url) return false;

    const old = bestSnapshotByUrl.get(snapshot.url);

    if (!old || snapshot.quality.score >= old.quality.score) {
      bestSnapshotByUrl.set(snapshot.url, snapshot);
      return true;
    }

    return false;
  }

  function pruneSnapshots(snapshots) {
    const currentTime = Date.now();

    return Object.fromEntries(
      Object.entries(snapshots || {})
        .filter(([, snapshot]) => {
          const timestamp = Number(snapshot?.timestamp || 0);
          return timestamp > 0 && currentTime - timestamp <= settings.snapshotTtlMs;
        })
        .sort((a, b) => Number(b[1].timestamp || 0) - Number(a[1].timestamp || 0))
        .slice(0, settings.maxSnapshots)
    );
  }

  async function saveSnapshotObject(snapshot, options = {}) {
    if (!snapshot || !enabled) return null;

    const force = Boolean(options.force);
    const markAsPrevious = Boolean(options.markAsPrevious);

    if (!force && snapshot.quality.score < settings.minQualityScore) {
      return null;
    }

    const signature = makeSnapshotSignature(snapshot);

    if (!force && savedSignatureByUrl.get(snapshot.url) === signature) {
      return null;
    }

    savedSignatureByUrl.set(snapshot.url, signature);
    rememberBestSnapshot(snapshot);

    return enqueueStorageWrite(async () => {
      const data = await browser.storage.local.get([
        STORAGE_KEYS.SNAPSHOTS,
        STORAGE_KEYS.PREVIOUS_URL
      ]);

      const snapshots = pruneSnapshots(data[STORAGE_KEYS.SNAPSHOTS] || {});

      const savedSnapshot = {
        ...snapshot,
        timestamp: Date.now()
      };

      snapshots[snapshot.url] = savedSnapshot;

      const payload = {
        [STORAGE_KEYS.SNAPSHOTS]: pruneSnapshots(snapshots),
        [STORAGE_KEYS.LAST_ACTIVE_URL]: snapshot.url
      };

      if (markAsPrevious) {
        payload[STORAGE_KEYS.PREVIOUS_URL] = snapshot.url;
      }

      await browser.storage.local.set(payload);
      return savedSnapshot;
    });
  }

  async function captureCurrentUrl(reason, options = {}) {
    if (!enabled || !isHttpPage() || !hasBody()) return null;

    const url = location.href;
    const snapshot = buildSnapshot(url, reason);

    if (!snapshot) return null;

    rememberBestSnapshot(snapshot);

    return saveSnapshotObject(snapshot, options);
  }

  async function freezeCurrentUrlBeforeNavigation(reason) {
    if (!enabled || !isHttpPage() || !hasBody()) return null;

    const url = location.href;
    const snapshot = buildSnapshot(url, reason);

    if (!snapshot) return null;

    rememberBestSnapshot(snapshot);

    // Force-mark this exact URL as previous before SPA can mutate to the next route.
    return saveSnapshotObject(snapshot, {
      force: true,
      markAsPrevious: true
    });
  }

  async function lockPreviousUrlSnapshot(previousUrl, reason) {
    if (!enabled || !previousUrl) return null;

    const candidate = bestSnapshotByUrl.get(previousUrl);

    if (!candidate) {
      return null;
    }

    return saveSnapshotObject(
      {
        ...candidate,
        reason
      },
      {
        force: true,
        markAsPrevious: true
      }
    );
  }

  async function handleUrlChange(newUrl) {
    const previousUrl = lastKnownUrl;

    if (!previousUrl || previousUrl === newUrl) return;

    // Critical: lock the snapshot stored for the previous URL.
    // Do NOT capture the current DOM here, because it may already be the new page.
    await lockPreviousUrlSnapshot(previousUrl, "spa-url-change");

    lastKnownUrl = newUrl;
    clearMutationTimers();

    // Delay new-page capture so it doesn't instantly overwrite weak/blank state.
    setTimeout(() => {
      captureCurrentUrl("after-spa-url-change").catch(console.error);
    }, 1000);
  }

  function getEventElement(event) {
    const target = event.target;

    if (target instanceof Element) return target;
    return target?.parentElement || null;
  }

  function shouldCaptureNavigationIntent(event) {
    const element = getEventElement(event);
    if (!element) return false;

    if (element.closest(`#${OVERLAY_ID}`)) return false;

    if (event.type === "pointerdown" || event.type === "mousedown") {
      const clickable = element.closest(
        "a[href], button, [role='button'], input[type='submit']"
      );

      if (!clickable) return false;

      if (clickable.matches("a[href]")) {
        const href = absolutizeUrl(clickable.getAttribute("href"), location.href);
        return Boolean(href && href !== location.href);
      }

      return true;
    }

    if (event.type === "keydown") {
      if (event.key !== "Enter") return false;

      return Boolean(
        element.closest(
          "input, textarea, [contenteditable='true'], [role='searchbox'], [role='textbox']"
        )
      );
    }

    if (event.type === "submit") {
      return true;
    }

    return false;
  }

  function startNavigationIntentCapture() {
    const handler = (event) => {
      if (!shouldCaptureNavigationIntent(event)) return;

      freezeCurrentUrlBeforeNavigation(`before-${event.type}`).catch(console.error);
    };

    document.addEventListener("pointerdown", handler, {
      capture: true,
      passive: true
    });

    document.addEventListener("mousedown", handler, {
      capture: true,
      passive: true
    });

    document.addEventListener("keydown", handler, {
      capture: true
    });

    document.addEventListener("submit", handler, {
      capture: true
    });
  }

  function startUrlPolling() {
    stopUrlPolling();

    lastKnownUrl = location.href;

    urlPollTimer = setInterval(() => {
      const currentUrl = location.href;

      if (currentUrl !== lastKnownUrl) {
        handleUrlChange(currentUrl).catch(console.error);
      }
    }, settings.urlPollMs);
  }

  function stopUrlPolling() {
    if (urlPollTimer) {
      clearInterval(urlPollTimer);
      urlPollTimer = null;
    }
  }

  function clearMutationTimers() {
    if (mutationDebounceTimer) {
      clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = null;
    }

    if (mutationMaxWaitTimer) {
      clearTimeout(mutationMaxWaitTimer);
      mutationMaxWaitTimer = null;
    }
  }

  function runMutationCapture(reason) {
    clearMutationTimers();

    if (!enabled) return;

    captureCurrentUrl(reason).catch(console.error);
  }

  function scheduleMutationCapture() {
    if (!enabled || !hasBody()) return;

    if (mutationDebounceTimer) {
      clearTimeout(mutationDebounceTimer);
    }

    mutationDebounceTimer = setTimeout(() => {
      runMutationCapture("mutation-debounce");
    }, settings.mutationDebounceMs);

    if (!mutationMaxWaitTimer) {
      mutationMaxWaitTimer = setTimeout(() => {
        runMutationCapture("mutation-max-wait");
      }, settings.mutationMaxWaitMs);
    }
  }

  function startMutationObserver() {
    stopMutationObserver();

    if (!document.documentElement) return;

    observer = new MutationObserver((mutations) => {
      const onlyOverlayChanged = mutations.every((mutation) => {
        const target = mutation.target;
        return target?.nodeType === Node.ELEMENT_NODE && target.closest?.(`#${OVERLAY_ID}`);
      });

      if (onlyOverlayChanged) return;

      scheduleMutationCapture();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
  }

  function stopMutationObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }

    clearMutationTimers();
  }

  function snapshotElementAttributes(element) {
    return Array.from(element.attributes).map((attr) => [attr.name, attr.value]);
  }

  function restoreElementAttributes(element, attrs) {
    while (element.attributes.length) {
      element.removeAttribute(element.attributes[0].name);
    }

    for (const [name, value] of attrs) {
      element.setAttribute(name, value);
    }
  }

  function applyAttributes(element, attributes) {
    if (!element || !Array.isArray(attributes)) return;

    for (const [name, value] of attributes) {
      if (!name || name.toLowerCase().startsWith("on")) continue;

      try {
        element.setAttribute(name, value);
      } catch {
        // Ignore invalid attributes.
      }
    }
  }

  function applyCustomProperties(element, properties) {
    if (!element || !properties) return;

    for (const [name, value] of Object.entries(properties)) {
      if (name.startsWith("--")) {
        element.style.setProperty(name, value);
      }
    }
  }

  function removeOverlay() {
    if (activeRestoreCleanup) {
      activeRestoreCleanup();
      activeRestoreCleanup = null;
      return;
    }

    const existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();
  }

  function createCachedStyleNodes(snapshot) {
    const fragment = document.createDocumentFragment();
    const styles = snapshot.styles || {};

    for (const item of styles.links || []) {
      if (!item.href) continue;

      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = item.href;

      if (item.media) link.media = item.media;
      if (item.crossOrigin) link.crossOrigin = item.crossOrigin;
      if (item.referrerPolicy) link.referrerPolicy = item.referrerPolicy;

      fragment.append(link);
    }

    for (const item of styles.inlineStyles || []) {
      if (!item.cssText) continue;

      const style = document.createElement("style");

      if (item.media) style.media = item.media;

      style.textContent = item.cssText;
      fragment.append(style);
    }

    return fragment;
  }

  function createCloseButton(cleanup) {
    const wrap = document.createElement("div");

    Object.assign(wrap.style, {
      position: "fixed",
      top: "14px",
      right: "14px",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "8px",
      border: "1px solid rgba(255,255,255,0.16)",
      borderRadius: "999px",
      background: "rgba(2, 6, 23, 0.92)",
      backdropFilter: "blur(10px)",
      boxShadow: "0 16px 50px rgba(0,0,0,0.35)",
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    });

    const label = document.createElement("span");
    label.textContent = "Restored view";

    Object.assign(label.style, {
      color: "#cbd5e1",
      fontSize: "12px",
      fontWeight: "700",
      paddingLeft: "8px"
    });

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Close Restore View";

    Object.assign(button.style, {
      border: "0",
      borderRadius: "999px",
      padding: "9px 13px",
      cursor: "pointer",
      color: "#f8fafc",
      background: "linear-gradient(135deg, #60a5fa, #2563eb)",
      fontSize: "12px",
      fontWeight: "900",
      boxShadow: "0 10px 28px rgba(37,99,235,0.35)"
    });

    button.addEventListener("click", cleanup);

    wrap.append(label, button);
    return wrap;
  }

  async function getPreviousSnapshot() {
    const data = await browser.storage.local.get([
      STORAGE_KEYS.SNAPSHOTS,
      STORAGE_KEYS.PREVIOUS_URL
    ]);

    const snapshots = pruneSnapshots(data[STORAGE_KEYS.SNAPSHOTS] || {});
    const previousUrl = data[STORAGE_KEYS.PREVIOUS_URL];

    if (!previousUrl || !snapshots[previousUrl]) return null;

    await browser.storage.local.set({
      [STORAGE_KEYS.SNAPSHOTS]: snapshots
    });

    return {
      url: previousUrl,
      ...snapshots[previousUrl]
    };
  }

  async function getPreviousSnapshotStatus() {
    const snapshot = await getPreviousSnapshot();

    return {
      enabled,
      currentUrl: location.href,
      previousUrl: snapshot?.url || null,
      hasPreviousSnapshot: Boolean(snapshot),
      timestamp: snapshot?.timestamp || null,
      title: snapshot?.title || "",
      length: snapshot?.length || 0,
      styleCount: snapshot?.styleCount || 0,
      fallbackCount: snapshot?.fallbackCount || 0,
      qualityScore: snapshot?.quality?.score || 0,
      ttlMs: settings.snapshotTtlMs
    };
  }

  async function restorePreviousSnapshot() {
    if (!enabled) {
      return {
        ok: false,
        reason: "Rewind is turned off."
      };
    }

    const snapshot = await getPreviousSnapshot();

    if (!snapshot) {
      return {
        ok: false,
        reason: "No recent previous-page snapshot exists."
      };
    }

    removeOverlay();

    const originalHtmlAttrs = snapshotElementAttributes(document.documentElement);
    const originalBodyAttrs = document.body ? snapshotElementAttributes(document.body) : [];

    const documentInfo = snapshot.documentInfo || {};

    applyAttributes(document.documentElement, documentInfo.htmlAttributes);
    if (document.body) applyAttributes(document.body, documentInfo.bodyAttributes);

    const root = document.createElement("div");
    root.id = OVERLAY_ID;

    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      width: "100vw",
      height: "100vh",
      overflow: "auto",
      background: documentInfo.backgroundColor || "#0f0f0f",
      color: documentInfo.color || "#fff",
      fontFamily: documentInfo.fontFamily || "inherit",
      pointerEvents: "auto",
      isolation: "isolate"
    });

    applyCustomProperties(root, documentInfo.rootCustomProperties);
    applyCustomProperties(root, documentInfo.bodyCustomProperties);

    const cleanup = () => {
      const existing = document.getElementById(OVERLAY_ID);
      if (existing) existing.remove();

      restoreElementAttributes(document.documentElement, originalHtmlAttrs);
      if (document.body) restoreElementAttributes(document.body, originalBodyAttrs);

      activeRestoreCleanup = null;
    };

    activeRestoreCleanup = cleanup;

    const restoredBody = document.createElement("div");
    restoredBody.setAttribute("data-page-restorer-restored-body", "true");

    restoredBody.className = [
      documentInfo.htmlClass || "",
      documentInfo.bodyClass || ""
    ]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    restoredBody.innerHTML = sanitizeHtml(snapshot.html || "", snapshot.url);

    restoredBody.querySelectorAll("a[href]").forEach((anchor) => {
      const href = anchor.getAttribute("href");

      if (!href || href.startsWith("javascript:")) {
        anchor.removeAttribute("href");
        return;
      }

      anchor.setAttribute("href", absolutizeUrl(href, snapshot.url));
    });

    restoredBody.addEventListener(
      "click",
      (event) => {
        const element = getEventElement(event);
        const anchor = element?.closest?.("a[href]");

        if (anchor) {
          // Let the link work normally, but remove overlay immediately.
          setTimeout(cleanup, 0);
        }
      },
      true
    );

    root.append(
      createCachedStyleNodes(snapshot),
      restoredBody,
      createCloseButton(cleanup)
    );

    document.body.append(root);

    setTimeout(() => {
      const existing = document.getElementById(OVERLAY_ID);
      if (!existing) return;

      if (nativeSnapshotLooksWrong(restoredBody)) {
        restoredBody.replaceWith(createFallbackView(snapshot));
      }
    }, 700);

    return {
      ok: true,
      url: snapshot.url,
      timestamp: snapshot.timestamp,
      styleCount: snapshot.styleCount || 0,
      fallbackCount: snapshot.fallbackCount || 0,
      qualityScore: snapshot.quality?.score || 0
    };
  }

  function handlePageBecomingHidden() {
    if (!enabled || !hasBody()) return;

    freezeCurrentUrlBeforeNavigation("page-hidden").catch(() => {});
  }

  function startLifecycleListeners() {
    if (lifecycleListenersStarted) return;
    lifecycleListenersStarted = true;

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        handlePageBecomingHidden();
      }
    });

    window.addEventListener("pagehide", handlePageBecomingHidden, {
      capture: true
    });

    window.addEventListener("beforeunload", handlePageBecomingHidden, {
      capture: true
    });
  }

  function startAllWatchers() {
    if (!enabled || !isHttpPage()) return;

    startUrlPolling();
    startMutationObserver();
    startLifecycleListeners();
    startNavigationIntentCapture();
  }

  function stopAllWatchers() {
    stopUrlPolling();
    stopMutationObserver();
    removeOverlay();
  }

  async function waitForBodyThenInitialCapture() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (hasBody()) break;
      await sleep(50);
    }

    if (!hasBody()) return;

    await captureCurrentUrl("initial");

    setTimeout(() => captureCurrentUrl("early-250ms").catch(console.error), 250);
    setTimeout(() => captureCurrentUrl("early-750ms").catch(console.error), 750);
    setTimeout(() => captureCurrentUrl("early-1500ms").catch(console.error), 1500);
    setTimeout(() => captureCurrentUrl("early-3000ms").catch(console.error), 3000);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return undefined;

    if (message.type === "PAGE_RESTORER_GET_STATUS") {
      return getPreviousSnapshotStatus();
    }

    if (message.type === "PAGE_RESTORER_RESTORE_PREVIOUS") {
      return restorePreviousSnapshot();
    }

    return undefined;
  });

  browser.storage.local.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes[STORAGE_KEYS.SETTINGS]) return;

    settings = {
      ...DEFAULT_SETTINGS,
      ...(changes[STORAGE_KEYS.SETTINGS].newValue || {})
    };

    enabled = Boolean(settings.enabled);

    if (enabled) {
      startAllWatchers();
      waitForBodyThenInitialCapture().catch(console.error);
    } else {
      stopAllWatchers();
    }
  });

  async function boot() {
    if (hasBooted) return;
    hasBooted = true;

    await migrateOldStorageIfNeeded();
    await loadSettings();

    if (!enabled || !isHttpPage()) return;

    startAllWatchers();
    await waitForBodyThenInitialCapture();
  }

  boot().catch((error) => {
    console.error("[Page Restorer] Boot failed:", error);
  });
})();