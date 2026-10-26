/**
 * Trusted, read-only (apart from tagging elements and drawing the cursor) scripts
 * evaluated inside the remote page by our own code. They are plain JS strings so
 * bundler transforms can't break them when Playwright serializes them.
 * The model can never supply code to evaluate.
 */

/** Tags interactive elements with data-agent-ref and returns a compact snapshot. */
export const OBSERVE_SCRIPT = String.raw`
(({ prefix, maxElements, maxText }) => {
  const vh = window.innerHeight, vw = window.innerWidth;
  document.querySelectorAll('[data-agent-ref]').forEach((el) => el.removeAttribute('data-agent-ref'));
  const selector = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=option], [role=searchbox], [role=combobox], [contenteditable=true]';
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    return tag;
  };
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const t = labelledby.split(' ').map((id) => document.getElementById(id)?.innerText || '').join(' ');
      if (clean(t)) return clean(t);
    }
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label && clean(label.innerText)) return clean(label.innerText);
    }
    const parentLabel = el.closest('label');
    if (parentLabel && clean(parentLabel.innerText)) return clean(parentLabel.innerText);
    const text = clean(el.innerText || el.textContent);
    if (text) return text;
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.querySelector('img')?.getAttribute('alt') || el.getAttribute('name') || el.getAttribute('value') || '');
  };
  const visible = (el, r) => {
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };
  const candidates = [];
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const inViewport = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    candidates.push({ el, r, inViewport });
  }
  candidates.sort((a, b) => (a.inViewport === b.inViewport ? a.r.top - b.r.top : a.inViewport ? -1 : 1));
  const elements = [];
  for (const [i, c] of candidates.slice(0, maxElements).entries()) {
    const el = c.el;
    const ref = prefix + '-' + i;
    el.setAttribute('data-agent-ref', ref);
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const form = el.closest('form');
    elements.push({
      ref,
      role: roleOf(el),
      name: nameOf(el).slice(0, 120),
      tag,
      inputType: tag === 'input' ? (type || 'text') : undefined,
      href: tag === 'a' ? (el.href || undefined) : undefined,
      inViewport: c.inViewport,
      isSubmit: (tag === 'button' && (type === 'submit' || (!type && !!form))) || (tag === 'input' && (type === 'submit' || type === 'image')),
      inForm: !!form,
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
    });
  }
  const blocks = [];
  let total = 0;
  const seen = new Set();
  for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,blockquote,figcaption,label,summary,[role=heading],[role=alert],[role=status]')) {
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= vh || r.width < 2 || r.height < 2) continue;
    const t = clean(el.innerText);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    const tag = el.tagName.toLowerCase();
    const line = /^h[1-6]$/.test(tag) ? '#'.repeat(Number(tag[1])) + ' ' + t : t;
    blocks.push(line.slice(0, 400));
    total += line.length;
    if (total > maxText) break;
  }
  const se = document.scrollingElement || document.documentElement;
  return {
    title: document.title,
    url: location.href,
    scroll: { y: Math.round(se.scrollTop), maxY: Math.max(0, Math.round(se.scrollHeight - vh)), viewportHeight: vh },
    elements,
    text: blocks.join('\n').slice(0, maxText),
  };
})
`;

/**
 * Installs (idempotently) an animated, labelled cursor overlay.
 * Built only with DOM + CSSOM + Web Animations APIs (no innerHTML, no <style>),
 * so it also works on sites with strict CSP / Trusted Types (e.g. YouTube).
 * pointer-events:none everywhere: it can never intercept the real input,
 * which Playwright performs separately. Exposed as `window.__agentCursor`.
 * Arg: { x, y } start position (carried over from the previous page).
 */
export const INSTALL_CURSOR_SCRIPT = String.raw`
(({ x, y }) => {
  if (window.__agentCursor && document.getElementById('__agent_cursor')) return true;
  if (!document.documentElement) return false;
  const ORANGE = '#f97316';
  const SVG = 'http://www.w3.org/2000/svg';
  const el = (tag, css) => { const n = document.createElement(tag); n.style.cssText = css; return n; };
  const base = 'pointer-events:none;box-sizing:border-box;margin:0;padding:0;border:0;';

  const root = el('div', base + 'position:fixed;left:0;top:0;z-index:2147483647;will-change:transform;opacity:0;transition:opacity .25s ease;');
  root.id = '__agent_cursor';
  root.setAttribute('aria-hidden', 'true');

  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('width', '32');
  svg.setAttribute('height', '32');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.style.cssText = base + 'display:block;overflow:visible;transform-origin:4px 3px;transition:transform .12s ease;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));';
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M3 2l7.5 19 2.6-7.9L21 10.5z');
  path.setAttribute('fill', ORANGE);
  path.setAttribute('stroke', '#fff');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);

  const label = el('div', base + 'position:absolute;left:24px;top:24px;display:flex;align-items:center;gap:6px;background:' + ORANGE + ';color:#fff;font:600 13px/1 system-ui,-apple-system,Segoe UI,sans-serif;letter-spacing:0;padding:6px 11px 6px 8px;border-radius:999px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.25);transition:transform .2s cubic-bezier(.34,1.56,.64,1);');
  const dot = el('span', base + 'display:inline-block;width:7px;height:7px;border-radius:50%;background:#fff;');
  const text = el('span', base + 'display:inline;color:#fff;font:inherit;');
  text.textContent = 'Assistant';
  label.appendChild(dot);
  label.appendChild(text);
  root.appendChild(svg);
  root.appendChild(label);

  const ring = el('div', base + 'position:fixed;z-index:2147483646;border:2px solid ' + ORANGE + ';border-radius:8px;background:rgba(249,115,22,.08);opacity:0;transition:opacity .2s ease,left .3s ease,top .3s ease,width .3s ease,height .3s ease;');
  ring.id = '__agent_ring';
  document.documentElement.appendChild(ring);
  document.documentElement.appendChild(root);

  const anim = (node, frames, opts) => { try { return node.animate(frames, opts); } catch (e) { return null; } };
  anim(dot, [{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], { duration: 1200, iterations: Infinity, easing: 'ease-in-out' });
  let glow = null;

  const state = { x: x, y: y, anim: 0, ringTimer: 0 };
  const place = (px, py) => { root.style.transform = 'translate(' + px + 'px,' + py + 'px)'; };
  place(state.x, state.y);
  requestAnimationFrame(() => { root.style.opacity = '1'; });
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  window.__agentCursor = {
    get pos() { return { x: state.x, y: state.y }; },
    label(value) { text.textContent = value || 'Assistant'; },
    // Curved, eased glide; resolves when it arrives.
    moveTo(tx, ty) {
      cancelAnimationFrame(state.anim);
      const sx = state.x, sy = state.y;
      const dx = tx - sx, dy = ty - sy;
      const dist = Math.hypot(dx, dy);
      if (dist < 2) { state.x = tx; state.y = ty; place(tx, ty); return Promise.resolve(); }
      const duration = Math.min(950, Math.max(380, dist * 0.75));
      // Control point offset perpendicular to the path gives a natural arc.
      const bend = Math.min(120, dist * 0.22) * (dx >= 0 ? -1 : 1);
      const cx = sx + dx / 2 - (dy / dist) * bend;
      const cy = sy + dy / 2 + (dx / dist) * bend;
      label.style.transform = 'translate(4px,2px) scale(.96)';
      return new Promise((resolve) => {
        const t0 = performance.now();
        const step = (now) => {
          const t = Math.min(1, (now - t0) / duration);
          const e = ease(t), u = 1 - e;
          state.x = u * u * sx + 2 * u * e * cx + e * e * tx;
          state.y = u * u * sy + 2 * u * e * cy + e * e * ty;
          place(state.x, state.y);
          if (t < 1) state.anim = requestAnimationFrame(step);
          else { label.style.transform = ''; resolve(); }
        };
        state.anim = requestAnimationFrame(step);
      });
    },
    highlight(box) {
      if (!box) return;
      ring.style.left = (box.x - 4) + 'px';
      ring.style.top = (box.y - 4) + 'px';
      ring.style.width = (box.width + 8) + 'px';
      ring.style.height = (box.height + 8) + 'px';
      ring.style.opacity = '1';
      if (glow) glow.cancel();
      glow = anim(ring, [{ boxShadow: '0 0 0 0 rgba(249,115,22,.4)' }, { boxShadow: '0 0 0 10px rgba(249,115,22,0)' }], { duration: 1000, iterations: Infinity, easing: 'ease-out' });
      clearTimeout(state.ringTimer);
      state.ringTimer = setTimeout(() => { ring.style.opacity = '0'; if (glow) glow.cancel(); }, 1600);
    },
    // Press + ripple, purely visual; the real click comes from Playwright.
    press() {
      svg.style.transform = 'scale(.82)';
      const r = el('div', base + 'position:fixed;z-index:2147483646;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid ' + ORANGE + ';background:rgba(249,115,22,.25);left:' + state.x + 'px;top:' + state.y + 'px;');
      document.documentElement.appendChild(r);
      const a = anim(r, [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(4.2)', opacity: 0 }], { duration: 600, easing: 'ease-out', fill: 'forwards' });
      setTimeout(() => r.remove(), 650);
      if (!a) r.style.opacity = '0';
      return new Promise((resolve) => setTimeout(() => { svg.style.transform = ''; resolve(); }, 140));
    },
  };
  return true;
})
`;

/** Runs one cursor step: { x, y, box?, label?, press? }. Resolves after the animation. */
export const MOVE_CURSOR_SCRIPT = String.raw`
(async ({ x, y, box, label, press }) => {
  const c = window.__agentCursor;
  if (!c) return null;
  c.label(label);
  if (box) c.highlight(box);
  await c.moveTo(x, y);
  if (press) await c.press();
  return c.pos;
})
`;

/** Scroll position of the window or of the main scroll container under the viewport centre. */
export const SCROLL_STATE_SCRIPT = String.raw`
(() => {
  const se = document.scrollingElement || document.documentElement;
  let el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  while (el && el !== document.body && el !== document.documentElement) {
    const st = getComputedStyle(el);
    if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 4) {
      return { y: Math.round(el.scrollTop), maxY: Math.round(el.scrollHeight - el.clientHeight), inner: true };
    }
    el = el.parentElement;
  }
  return { y: Math.round(se.scrollTop), maxY: Math.max(0, Math.round(se.scrollHeight - window.innerHeight)), inner: false };
})
`;
