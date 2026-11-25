// ==UserScript==
// @name         TikTok DM Counter
// @namespace    local.tiktok.dmcounter
// @version      7.2.0
// @description  Đếm chính xác tổng số tin nhắn với từng người trên TikTok web, phân tích chủ đề hay nói, đoán mối quan hệ (bạn bè, mập mờ, lốp, người yêu…), cập nhật nhanh chỉ tin mới, xếp hạng, lưu ảnh kết quả và spam nhãn dán / emoji (chọn nhãn dán & tốc độ). Mọi phân tích chạy ngay trên máy bạn.
// @match        https://www.tiktok.com/*
// @match        https://tiktok.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window.self) return;
  if (window.__dmcV7) return;
  window.__dmcV7 = true;

  const VERSION = '7.2.0';
  const SPEED = Number(window.__dmcTestSpeed) || 1; // chỉ dùng khi test tự động
  const sleep = ms => new Promise(r => setTimeout(r, ms * SPEED));
  const tick0 = () => new Promise(r => setTimeout(r, 0));
  const fmt = n => Number(n || 0).toLocaleString('vi-VN');
  const MARK = 'data-dmc';      // gắn lên hàng tin đã đếm: me / th / me+ / th+ / sk
  const CONV = 'data-dmc-conv'; // gắn lên khung chat: các dấu trên thuộc cuộc trò chuyện nào
  const HIDE = 'data-dmc-h';    // tin đã đếm được ẩn tạm trong lúc đếm để trang luôn nhẹ
  const KEEP = 80;              // số tin đã đếm vẫn để hiện (giữ cho khung còn cuộn được)
  const ANCHOR_N = 6;           // số tin mới nhất được nhớ (dạng mã băm) để lần sau chỉ đếm tin mới
  let HOST = null;

  /* ═══════════════════════ LƯU TRỮ & CÀI ĐẶT ═══════════════════════ */

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const CFG = Object.assign({ speed: 'normal', analyze: true, quick: true }, store.get('dmcCfg') || {});
  const saveCfg = () => store.set('dmcCfg', CFG);
  // tốc độ: thời gian chờ tối đa khi TikTok không gửi thêm tin (càng lâu càng chắc chắn tới tin đầu tiên)
  const SPEEDS = {
    fast: { patience: 7000, wake: 900, label: 'Nhanh', desc: 'Mạng khoẻ, muốn nhanh' },
    normal: { patience: 12000, wake: 1200, label: 'Chuẩn', desc: 'Cân bằng nhanh & chắc' },
    safe: { patience: 25000, wake: 1700, label: 'Kỹ', desc: 'Mạng chậm, cần chắc 100%' },
  };

  /* ═══════════════════════ TIỆN ÍCH ═══════════════════════ */

  const KNOWN = {
    rows: ['[data-e2e="chat-item"]', '[class*="DivChatItemWrapper"]'],
    convItems: ['[data-e2e="chat-list-item"]'],
    convName: ['[data-e2e="chat-nickname"]', '[class*="PInfoNickname"]', '[class*="InfoNickname"]'],
  };

  const rectOf = el => el.getBoundingClientRect();
  const visible = el => { const r = rectOf(el); return r.width > 1 && r.height > 1; };
  const ours = el => !!HOST && (el === HOST || HOST.contains(el));
  const qsa = (root, s) => { try { return [...root.querySelectorAll(s)]; } catch { return []; } };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const docOrder = (a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  // tên chỉ toàn emoji / ký hiệu (vd "🌸🌸", "?") vẫn so được
  const normName = s => { const t = String(s || '').normalize('NFC').toLowerCase().trim(); return t.replace(/[^\p{L}\p{N}]+/gu, '') || t.replace(/\s+/g, ''); };
  const sameName = (a, b) => !!normName(a) && normName(a) === normName(b);
  const hashStr = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h; };
  const avKey = src => { try { const u = new URL(src, location.href); return u.protocol === 'data:' ? 'd' + hashStr(src) : u.pathname.replace(/~[^/]*$/, ''); } catch { return ''; } };
  const imgSrc = im => (im && (im.currentSrc || im.src)) || '';

  function alpha(c) {
    if (!c || c === 'transparent') return 0;
    const m = c.match(/^rgba?\(([^)]*)\)/i);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean);
      if (p.length >= 4) return p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
      return 1;
    }
    const m2 = c.match(/\/\s*([\d.]+%?)\s*\)$/);
    if (m2) return m2[1].endsWith('%') ? parseFloat(m2[1]) / 100 : parseFloat(m2[1]);
    return 1;
  }

  // phần tử (hoặc khung bọc sát nó) hình tròn → avatar
  function isRound(el, stop) {
    for (let e = el, i = 0; e && e !== stop && i < 4; e = e.parentElement, i++) {
      const r = rectOf(e);
      if (r.width < 4) continue;
      if (Math.abs(r.width - r.height) > Math.max(r.width, r.height) * 0.15) { if (i > 0) break; continue; }
      const br = getComputedStyle(e).borderTopLeftRadius || '0';
      if (br.endsWith('%') ? parseFloat(br) >= 40 : parseFloat(br) >= Math.min(r.width, r.height) / 2 - 1) return true;
    }
    return false;
  }

  /* ═══════════════════════ MỐC THỜI GIAN ("Hôm qua 21:30", "12/03/2024 09:10"…) ═══════════════════════ */

  const VI_LOC = /^vi/i.test(document.documentElement.lang || '') || /^vi/i.test(navigator.language || '');
  const WDS = [['chủ nhật', 0], ['thứ hai', 1], ['thứ ba', 2], ['thứ tư', 3], ['thứ năm', 4], ['thứ sáu', 5], ['thứ bảy', 6],
    ['thứ 2', 1], ['thứ 3', 2], ['thứ 4', 3], ['thứ 5', 4], ['thứ 6', 5], ['thứ 7', 6], ['cn', 0], ['t2', 1], ['t3', 2], ['t4', 3], ['t5', 4], ['t6', 5], ['t7', 6],
    ['sunday', 0], ['monday', 1], ['tuesday', 2], ['wednesday', 3], ['thursday', 4], ['friday', 5], ['saturday', 6],
    ['sun', 0], ['mon', 1], ['tue', 2], ['wed', 3], ['thu', 4], ['fri', 5], ['sat', 6]];
  const MONS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const STAMP_HINT = /\d{1,2}[:h]\d{2}|\d{1,2}[\/.-]\d{1,2}|hôm qua|hôm nay|yesterday|today|thg|tháng/i;
  const STAMP_JUNK = /(\d{1,2}[:h]\d{2})|(\d{1,4}[\/.-]\d{1,2}([\/.-]\d{2,4})?)|hôm qua|hôm nay|yesterday|today|chủ nhật|thứ (hai|ba|tư|năm|sáu|bảy|\d)|\b(t[2-7]|cn)\b|\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?|\b(am|pm|sa|ch|lúc|at|năm|thg|tháng|sáng|chiều|tối|ngày)\b|\d+|[\s,.·•:/-]+/gi;
  function parseStamp(raw) {
    const s = String(raw || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!s || s.length > 48 || !STAMP_HINT.test(s)) return 0;
    if (s.replace(STAMP_JUNK, '').length > 3) return 0; // còn chữ khác → không phải mốc giờ (vd. tin nhắn "hẹn 7:30 nhé")
    let h = 12, mi = 0, hasTime = false;
    const tm = s.match(/(\d{1,2})[:h](\d{2})(?:\s*(am|pm|sa|ch|sáng|chiều|tối))?/);
    if (tm) {
      h = +tm[1]; mi = +tm[2];
      const ap = tm[3];
      if (ap) { if (/pm|ch|chiều|tối/.test(ap) && h < 12) h += 12; if (/am|sa|sáng/.test(ap) && h === 12) h = 0; }
      if (h > 23 || mi > 59) return 0;
      hasTime = true;
    }
    const rest = tm ? s.replace(tm[0], ' ') : s;
    const now = new Date();
    let Y = now.getFullYear(), M = now.getMonth(), D = now.getDate(), hasDate = false, noYear = false, m;
    if ((m = rest.match(/(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/))) { Y = +m[1]; M = +m[2] - 1; D = +m[3]; hasDate = true; }
    else if ((m = rest.match(/(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?/))) {
      const a = +m[1], b = +m[2];
      if (b > 12 && a <= 12) { M = a - 1; D = b; } else if (VI_LOC || a > 12) { D = a; M = b - 1; } else { M = a - 1; D = b; }
      if (m[3]) { Y = +m[3]; if (Y < 100) Y += 2000; } else noYear = true;
      hasDate = true;
    } else if ((m = rest.match(/(\d{1,2})\s*(?:thg|tháng)\s*(\d{1,2})(?:,?\s*(?:năm\s*)?(\d{4}))?/))) {
      D = +m[1]; M = +m[2] - 1; if (m[3]) Y = +m[3]; else noYear = true; hasDate = true;
    } else if ((m = rest.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?/))) {
      M = MONS.indexOf(m[1]); D = +m[2]; if (m[3]) Y = +m[3]; else noYear = true; hasDate = true;
    } else if ((m = rest.match(/(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s*(\d{4}))?/))) {
      D = +m[1]; M = MONS.indexOf(m[2]); if (m[3]) Y = +m[3]; else noYear = true; hasDate = true;
    } else if (/hôm qua|yesterday/.test(rest)) { D -= 1; hasDate = true; }
    else if (/hôm nay|today/.test(rest)) hasDate = true;
    else {
      for (const [k, v] of WDS) {
        if (!new RegExp('(^|[^\\p{L}])' + k + '($|[^\\p{L}\\p{N}])', 'u').test(rest)) continue;
        let diff = (now.getDay() - v + 7) % 7; if (diff === 0) diff = 7;
        D -= diff; hasDate = true; break;
      }
    }
    if (!hasTime && !hasDate) return 0;
    if (M < 0 || M > 11 || D > 31) return 0;
    let t = new Date(Y, M, D, h, mi).getTime();
    if (noYear && t > Date.now() + 864e5) t = new Date(Y - 1, M, D, h, mi).getTime();
    if (!t || t > Date.now() + 864e5 || Y < 2016) return 0;
    return t;
  }

  /* ═══════════════════════ ENGINE: bong bóng & hàng tin nhắn ═══════════════════════ */

  const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'PICTURE']);
  function isMedia(el, cs, r, stop) {
    if (r.width < 48 || r.height < 48) return false;
    const tag = el.tagName.toUpperCase();
    const ok = MEDIA_TAGS.has(tag) || (tag === 'SVG' && r.width >= 64 && r.height >= 64) ||
      (cs.backgroundImage.includes('url(') && !el.textContent.trim());
    return ok && !isRound(el, stop);
  }
  function hasBigMedia(el, stop) {
    for (const m of el.querySelectorAll('img,video,canvas')) {
      const r = rectOf(m);
      if (r.width >= 48 && r.height >= 48 && !isRound(m, stop)) return true;
    }
    return false;
  }
  function nextSkip(tw, root) {
    for (;;) {
      const s = tw.nextSibling(); if (s) return s;
      const p = tw.parentNode(); if (!p || p === root) return null;
    }
  }

  // 1 phần tử có phải bong bóng / ảnh / sticker không. Trả về true = bỏ qua phần bên trong
  function evalEl(n, sc, W, out) {
    const r = rectOf(n);
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(n);
    if (cs.visibility === 'hidden' || cs.opacity === '0') return true;
    if (isMedia(n, cs, r, sc)) { out.push({ el: n, media: true, minor: false }); return true; }
    if ((alpha(cs.backgroundColor) > 0.08 || cs.backgroundImage.includes('gradient')) && r.width < W * 0.92 && r.height >= 12) {
      const txt = n.textContent.trim();
      const inner = n.querySelector('img,video,canvas,svg');
      // khối tròn nhỏ KHÔNG có chữ = avatar/chấm trạng thái; có chữ thì là bong bóng (kể cả tin 1 chữ như "ừ", "k")
      if ((txt || inner) && !(!txt && r.width < 64 && isRound(n, sc))) {
        const media = !!inner && hasBigMedia(n, sc);
        const minor = !media && r.height <= 32 && r.width <= 100 && txt.length <= 8 && !/\p{L}/u.test(txt); // thả tim ❤️
        out.push({ el: n, media, minor });
        return true;
      }
    }
    return false;
  }
  const skipFilter = { acceptNode: n => (n === HOST || n.hasAttribute(MARK) || n.hasAttribute(HIDE) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) };
  // gom bong bóng trong root; skipMarked = bỏ qua hàng đã đếm (đếm cuốn chiếu)
  function collect(root, sc, skipMarked) {
    const W = rectOf(sc).width, out = [];
    if (root !== sc) {
      if (skipMarked && (root.hasAttribute(MARK) || root.hasAttribute(HIDE))) return out;
      if (evalEl(root, sc, W, out)) return out;
    }
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, skipMarked ? skipFilter : null);
    let n = tw.nextNode();
    while (n) n = evalEl(n, sc, W, out) ? nextSkip(tw, root) : tw.nextNode();
    return out;
  }

  const normSig = el => {
    const c = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    return el.tagName + '|' + c.replace(/\bcss-[a-z0-9]+-/gi, 'css-').trim().split(/\s+/).filter(Boolean).sort().join(' ');
  };
  const hasCls = s => s.split('|')[1].length > 0;
  function detectSelector(sc) {
    for (const s of KNOWN.rows) { try { if (sc.querySelector(s)) return s; } catch {} }
    return null;
  }

  // tìm hàng tin nhắn (mỗi hàng = 1 tin) trong các vùng roots
  function findRows(sc, cands, { roots = [sc], selector = null, skipMarked = false } = {}) {
    if (selector) {
      const found = new Set();
      for (const r0 of roots) {
        if (r0 !== sc) { const up = r0.closest(selector); if (up && sc.contains(up)) found.add(up); }
        for (const e of qsa(r0, selector)) found.add(e);
      }
      const rows = []; let last = null;
      for (const e of [...found].sort(docOrder)) {
        if (last && last.contains(e)) continue;
        last = e;
        if (!(skipMarked && e.hasAttribute(MARK))) rows.push(e);
      }
      return { rows, method: 'selector', selector };
    }
    const majors = cands.filter(c => !c.minor).map(c => c.el);
    if (!majors.length) return { rows: cands.map(c => c.el), method: 'auto' };

    const cnt = new Map();
    for (const el of majors) for (let e = el; e && e !== sc; e = e.parentElement) cnt.set(e, (cnt.get(e) || 0) + 1);
    const childMap = new Map();
    for (const e of cnt.keys()) { const p = e.parentElement; if (!childMap.has(p)) childMap.set(p, []); childMap.get(p).push(e); }
    const kidsOf = p => childMap.get(p) || [];
    // mỗi bong bóng "bỏ phiếu" cho tầng có nhiều anh em nhất → đó là tầng danh sách tin
    const P = new Set(), rowSigs = new Set();
    for (const el of majors) {
      let bestP = sc, bestE = null, bestN = 0;
      for (let e = el; e && e !== sc; e = e.parentElement) {
        const p = e.parentElement, k = kidsOf(p).length;
        if (k >= bestN) { bestN = k; bestP = p; bestE = e; }
      }
      P.add(bestP); if (bestE) rowSigs.add(normSig(bestE));
    }
    const pSigs = new Set();
    for (const p of P) if (p !== sc) { const s = normSig(p); if (hasCls(s) && !rowSigs.has(s)) pSigs.add(s); }
    if (pSigs.size) for (const e of cnt.keys()) if (pSigs.has(normSig(e))) P.add(e);
    const anc = new Set();
    for (const p of P) for (let e = p; e && e !== sc && !anc.has(e); e = e.parentElement) anc.add(e);

    let rows = [];
    const walk = node => { for (const ch of kidsOf(node)) { if (anc.has(ch)) walk(ch); else rows.push(ch); } };
    walk(sc);
    // tách nhóm nhiều tin liên tiếp của cùng một người
    const split = r => {
      let d = r;
      for (;;) {
        const ks = kidsOf(d);
        if (ks.length === 1) { d = ks[0]; continue; }
        if (ks.length >= 2) {
          const s0 = normSig(ks[0]);
          if (hasCls(s0) && ks.every(k => normSig(k) === s0)) return ks.flatMap(k => (cnt.get(k) > 1 ? split(k) : [k]));
        }
        return [r];
      }
    };
    // khung chứa (chứa hàng đã đếm, hoặc quá nhiều bong bóng) → mở ra
    const expand = r => {
      if ((skipMarked && r.querySelector(`[${MARK}]`)) || (cnt.get(r) || 0) > 8) {
        const ks = kidsOf(r);
        if (ks.length) return ks.flatMap(expand);
      }
      return [r];
    };
    rows = rows.flatMap(r => (cnt.get(r) > 1 ? split(r) : [r])).flatMap(expand);
    // tin chỉ có emoji nhỏ nằm ngoài mọi hàng → tự là một tin
    const set = new Set(rows);
    for (const c of cands) {
      if (!c.minor) continue;
      let inRow = false;
      for (let e = c.el; e && e !== sc; e = e.parentElement) if (set.has(e)) { inRow = true; break; }
      if (!inRow) { rows.push(c.el); set.add(c.el); }
    }
    // dòng chữ nhỏ nằm ngoài mọi hàng (mốc giờ) → giữ lại để biết thời gian
    rows.sort(docOrder);
    return { rows, method: 'auto' };
  }

  function unionRect(rs) {
    let u = null;
    for (const r of rs) {
      if (!r || r.width < 1 || r.height < 1) continue;
      if (!u) u = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      else { u.left = Math.min(u.left, r.left); u.top = Math.min(u.top, r.top); u.right = Math.max(u.right, r.right); u.bottom = Math.max(u.bottom, r.bottom); }
    }
    if (u) { u.width = u.right - u.left; u.height = u.bottom - u.top; }
    return u;
  }
  function avatarRects(row, sc) {
    const out = [];
    for (const im of row.querySelectorAll('img')) {
      const r = rectOf(im);
      if (r.width >= 16 && r.width <= 72 && isRound(im, sc)) out.push(r);
    }
    return out;
  }
  function fallbackRect(row) {
    const rs = [];
    for (const e of row.querySelectorAll('*')) if (!e.children.length && e.textContent.trim()) rs.push(rectOf(e));
    for (const e of row.querySelectorAll('img,video,canvas')) rs.push(rectOf(e));
    return unionRect(rs.length ? rs : [rectOf(row)]);
  }
  function smallText(row) {
    const tw = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n; (n = tw.nextNode());) if (n.nodeValue.trim() && n.parentElement) return parseFloat(getComputedStyle(n.parentElement).fontSize) <= 13.5;
    return true;
  }
  const vKey = (row, sc) => {
    const a = row.closest('[data-index],[data-item-index]');
    const k = a && sc.contains(a) ? a : row.querySelector('[data-index],[data-item-index]');
    return k ? (k.getAttribute('data-index') ?? k.getAttribute('data-item-index')) : null;
  };

  // phân loại từng hàng: của bạn / của họ / bỏ qua (mốc giờ, thông báo hệ thống)
  function classify(sc, rows, cands, method, ctx) {
    const idx = new Map(rows.map((r, i) => [r, i]));
    const per = rows.map(() => []);
    for (const c of cands) {
      for (let e = c.el; e && e !== sc; e = e.parentElement) {
        const i = idx.get(e);
        if (i !== undefined) { per[i].push(c); break; }
      }
    }
    const R = rectOf(sc), W = R.width;
    const info = rows.map((row, i) => {
      const cs = per[i], main = cs.filter(c => !c.minor);
      let b = unionRect((main.length ? main : cs).map(c => rectOf(c.el)));
      if (!b && method === 'selector') b = fallbackRect(row);
      const av = avatarRects(row, sc);
      let avSide = 0; // -1: avatar bên trái bong bóng (của họ), 1: bên phải (của bạn)
      if (b) for (const a of av) { const cx = (a.left + a.right) / 2; if (cx < b.left) avSide = -1; else if (cx > b.right && !avSide) avSide = 1; }
      const media = cs.some(c => c.media) || (method === 'selector' && hasBigMedia(row, sc));
      return { row, b, avSide, hasAv: av.length > 0, media, cs };
    });
    const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    for (const it of info) {
      if (!it.b) continue;
      const lg = it.b.left - R.left, rg = R.right - it.b.right;
      if (it.avSide < 0 || (!it.avSide && lg < rg - W * 0.1)) inc(ctx.lb, Math.round(it.b.left / 4));
      if (it.avSide > 0 || (!it.avSide && rg < lg - W * 0.1)) inc(ctx.rb, Math.round(it.b.right / 4));
    }
    const mode = m => { let k = null, v = 0; for (const [a, b] of m) if (b > v) { v = b; k = a; } return k; };
    const mL = mode(ctx.lb), mR = mode(ctx.rb);
    return info.map(it => {
      const { row, b } = it;
      if (!b) return { row, skip: true, y: rectOf(row).top };
      const lg = b.left - R.left, rg = R.right - b.right;
      const atL = mL !== null && Math.abs(Math.round(b.left / 4) - mL) <= 2;
      const atR = mR !== null && Math.abs(Math.round(b.right / 4) - mR) <= 2;
      if (!atL && !atR && !it.hasAv && !it.media && Math.abs(lg - rg) < W * 0.1 && lg > W * 0.06 && rg > W * 0.06 &&
          b.height <= 48 && row.textContent.trim().length <= 80 && smallText(row)) return { row, skip: true, y: b.top };
      const me = it.avSide ? it.avSide > 0 : atR !== atL ? atR : rg < lg;
      const key = vKey(row, sc);
      return { row, me, media: it.media, key, cs: it.cs, y: b.top, h: key === null ? 0 : hashStr(row.textContent.slice(0, 300) + '|' + row.querySelectorAll('img').length) };
    });
  }

  // phân tích một lần, không đánh dấu (xem nhanh / chẩn đoán)
  function analyze(sc) {
    const ctx = { lb: new Map(), rb: new Map() };
    const cands = collect(sc, sc, false);
    const fr = findRows(sc, cands, { selector: detectSelector(sc) });
    const items = classify(sc, fr.rows, cands, fr.method, ctx);
    const c = items.filter(o => !o.skip), me = c.filter(o => o.me).length;
    return { total: c.length, me, them: c.length - me, media: c.filter(o => o.media).length, skipped: items.length - c.length, method: fr.method, selector: fr.selector };
  }

  // đếm từ các dấu đã gắn (rất nhanh, kể cả 100k hàng)
  function tally(sc) {
    const c = { total: 0, me: 0, them: 0, media: 0, marked: 0 };
    for (const e of sc.querySelectorAll(`[${MARK}]`)) {
      c.marked++;
      const v = e.getAttribute(MARK);
      if (v === 'sk') continue;
      c.total++;
      if (v[0] === 'm') c.me++; else c.them++;
      if (v.endsWith('+')) c.media++;
    }
    return c;
  }
  function clearMarks(sc) { for (const e of sc.querySelectorAll(`[${MARK}],[${HIDE}]`)) { e.removeAttribute(MARK); e.removeAttribute(HIDE); } }

  /* ---------- đọc nội dung từng tin (để phân tích chủ đề & mối quan hệ) ---------- */
  const normText = s => String(s || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  const sigOf = (me, kind, text) => hashStr((me ? '1' : '0') + kind[0] + '|' + normText(text).slice(0, 160));
  function rowStamp(row, bubbles) {
    const tw = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n, k = 0; (n = tw.nextNode()) && k < 24; k++) {
      const v = n.nodeValue.trim();
      if (!v || v.length > 40 || !STAMP_HINT.test(v)) continue;
      const p = n.parentElement;
      if (!p || bubbles.some(c => c.el.contains(p))) continue;
      const t = parseStamp(v);
      if (t) return t;
    }
    return 0;
  }
  function entryOf(it) {
    if (it.skip) {
      const tx = it.row.textContent.trim();
      const t = tx.length <= 60 ? parseStamp(tx) : 0;
      return { sep: t, y: it.y };
    }
    const cs = it.cs || [], main = cs.filter(c => !c.minor), use = main.length ? main : cs;
    let text = '';
    for (const c of use) { const t = c.el.textContent; if (t && t.trim()) text += (text ? '\n' : '') + t.trim(); }
    if (!text && !cs.length) text = (it.row.innerText || '').trim();
    text = text.replace(/[ \t\r\f\v]+/g, ' ').slice(0, 800);
    const kind = it.media ? (text.replace(/\s/g, '').length > 1 ? 'share' : 'media') : 'text';
    return { me: it.me, kind, text, ts: rowStamp(it.row, use), y: it.y, key: it.key, row: it.row, sig: sigOf(it.me, kind, text) };
  }

  // xử lý phần mới tải; full = cả khung, còn lại chỉ các nút TikTok vừa chèn (ctx.pending)
  function step(sc, ctx, full) {
    let roots;
    if (full) { roots = [sc]; ctx.pending.clear(); }
    else {
      roots = [];
      for (const n of ctx.pending) if (n.isConnected && n !== sc && sc.contains(n) && !n.closest(`[${MARK}]`)) roots.push(n);
      ctx.pending.clear();
      roots.sort(docOrder);
      const top = [];
      for (const n of roots) if (!top.length || !top[top.length - 1].contains(n)) top.push(n);
      roots = top;
    }
    if (!roots.length) return 0;
    const cands = [];
    for (const r of roots) for (const c of collect(r, sc, true)) cands.push(c);
    const fr = findRows(sc, cands, { roots, selector: ctx.selector, skipMarked: true });
    let added = 0;
    if (fr.rows.length) {
      const items = classify(sc, fr.rows, cands, fr.method, ctx);
      const batch = [];
      for (const it of items) {
        const v = it.skip ? 'sk' : (it.me ? 'me' : 'th') + (it.media ? '+' : '');
        it.row.setAttribute(MARK, v);
        ctx.vis.push(it.row);
        const e = entryOf(it);
        ctx.ent.set(it.row, e);
        batch.push(e);
        if (it.skip) continue;
        added++;
        ctx.c.total++; if (it.me) ctx.c.me++; else ctx.c.them++; if (it.media) ctx.c.media++;
        if (it.key !== null) {
          const old = ctx.keys.get(it.key);
          if (old && old.h !== it.h) ctx.keyClash++;
          ctx.keys.set(it.key, { v, h: it.h, e });
        }
      }
      // thứ tự trong trang có ngược với thứ tự hiển thị không (danh sách đảo)
      const vis = items.filter(it => it.y);
      if (vis.length >= 2) { const a = vis[0].y, b = vis[vis.length - 1].y; if (a > b + 1) ctx.rev++; else if (a < b - 1) ctx.rev--; }
      // danh sách phẳng mới nhất → cũ nhất (để tìm chỗ đếm lần trước)
      const msgs = batch.filter(e => e.sig !== undefined).sort((a, b) => b.y - a.y);
      for (const e of msgs) ctx.flat.push(e);
    }
    // dòng mốc giờ ("Hôm qua 21:30") nằm xen giữa các tin, không phải bong bóng → nhặt riêng để biết thời gian
    const pool = full ? [...new Set(fr.rows.map(r => r.parentElement).filter(Boolean))].flatMap(p => [...p.children]) : roots.flatMap(r => [r, ...r.children]);
    for (const el of pool) {
      if (el.nodeType !== 1 || el.hasAttribute(MARK) || el.hasAttribute(HIDE) || el.closest(`[${MARK}]`)) continue;
      const tx = el.textContent;
      if (!tx || tx.length > 60 || el.querySelector('img,video') || !STAMP_HINT.test(tx)) continue;
      const t = parseStamp(tx.trim());
      if (!t) continue;
      el.setAttribute(MARK, 'sk');
      ctx.ent.set(el, { sep: t, y: rectOf(el).top });
    }
    // ảnh/sticker chưa tải xong (kích thước 0) → xét lại ở lượt sau
    for (const r of roots) {
      const ms = qsa(r, 'img,video');
      if (r.matches && r.matches('img,video')) ms.push(r);
      for (const m of ms) {
        if (m.closest(`[${MARK}]`) || rectOf(m).width >= 2) continue;
        const k = (ctx.retry.get(m) || 0) + 1;
        if (k <= 20) { ctx.retry.set(m, k); ctx.pending.add(m); }
      }
    }
    return added;
  }

  // ẩn tạm các tin đã đếm cũ (chỉ giữ KEEP tin gần nhất) → mỗi lượt trình duyệt chỉ phải xử lý phần mới
  function trim(ctx) {
    while (ctx.vis.length > KEEP) {
      const row = ctx.vis.shift();
      if (!row.isConnected || row.hasAttribute(HIDE)) continue;
      row.setAttribute(HIDE, '');
      ctx.hidStack.push(row); ctx.hidden++;
      // mốc giờ / dòng hệ thống ngay phía trên hàng vừa ẩn
      for (let p = row.previousElementSibling, i = 0; p && i < 2; p = p.previousElementSibling, i++) {
        if (p.hasAttribute(MARK) || p.hasAttribute(HIDE) || p.querySelector('img,video,canvas') || p.textContent.length > 80) break;
        p.setAttribute(HIDE, '');
      }
    }
    if (ctx.hidStack.length > 6000) ctx.hidStack.splice(0, ctx.hidStack.length - 3000);
  }
  // khung hết chỗ cuộn vì ẩn quá nhiều → hiện lại vài tin gần nhất
  function unhideSome(ctx, st) {
    for (let round = 0; round < 12 && ctx.hidStack.length && !canScroll(st); round++) {
      for (let i = 0; i < 30 && ctx.hidStack.length; i++) { const r = ctx.hidStack.pop(); r.removeAttribute(HIDE); ctx.hidden = Math.max(0, ctx.hidden - 1); }
    }
  }
  function setHiding(on) {
    let st = document.getElementById('dmc-hide');
    if (on && !st) {
      st = document.createElement('style');
      st.id = 'dmc-hide';
      st.textContent = `[${HIDE}]{display:none!important}`;
      (document.head || document.documentElement).appendChild(st);
    }
    if (!on && st) st.remove();
  }
  function ensureLightCss() {
    if (document.getElementById('dmc-light')) return;
    const st = document.createElement('style');
    st.id = 'dmc-light';
    st.textContent = `[${MARK}]{content-visibility:auto;contain-intrinsic-size:auto 64px}`;
    (document.head || document.documentElement).appendChild(st);
  }

  // hàng đã đếm bị gỡ khỏi trang → TikTok vẽ lại khung, hoặc danh sách "ảo"
  function checkRemoval(sc, ctx) {
    if (!ctx.removed) return;
    ctx.removed = false;
    const t = tally(sc);
    if (t.total >= ctx.maxTotal * 0.9) { ctx.c = { total: t.total, me: t.me, them: t.them, media: t.media }; return; }
    if (ctx.keys.size) { ctx.virtual = true; return; }
    ctx.lossy = true;
    ctx.c = { total: t.total, me: t.me, them: t.them, media: t.media };
  }
  function observe(sc, ctx) {
    if (ctx.mo) ctx.mo.disconnect();
    ctx.mo = new MutationObserver(recs => {
      let any = false;
      for (const rec of recs) {
        for (const n of rec.addedNodes) {
          if (n.nodeType === 1) { ctx.pending.add(n); ctx.muts++; any = true; }
          else if (n.parentElement) ctx.pending.add(n.parentElement);
        }
        if (!ctx.removed) for (const n of rec.removedNodes) {
          if (n.nodeType === 1 && (n.hasAttribute(MARK) || n.querySelector(`[${MARK}]`))) { ctx.removed = true; break; }
        }
      }
      if (any && ctx.wake) ctx.wake(); // có tin mới → xử lý ngay, không chờ
    });
    ctx.mo.observe(sc, { childList: true, subtree: true });
  }
  function fromKeys(ctx) {
    const c = { total: 0, me: 0, them: 0, media: 0 };
    for (const { v } of ctx.keys.values()) { c.total++; if (v[0] === 'm') c.me++; else c.them++; if (v.endsWith('+')) c.media++; }
    return c;
  }
  const current = ctx => (ctx.virtual ? fromKeys(ctx) : ctx.c);

  // toàn bộ tin theo thứ tự thời gian (cũ → mới), kèm mốc giờ suy ra từ các dòng "Hôm qua 21:30"…
  function timeline(sc, ctx) {
    let list = [];
    if (ctx.virtual) {
      const ks = [...ctx.keys.keys()];
      const num = ks.every(k => /^-?\d+$/.test(k));
      for (const k of num ? ks.sort((a, b) => a - b) : ks) list.push(ctx.keys.get(k).e);
      if (num && ctx.rev > 0) list.reverse();
    } else {
      for (const row of sc.querySelectorAll(`[${MARK}]`)) { const e = ctx.ent.get(row); if (e) list.push(e); }
      if (ctx.rev > 0) list.reverse();
    }
    const out = [];
    let cur = 0, gap = true;
    for (const e of list) {
      if (!e) continue;
      if (e.sig === undefined) { if (e.sep) { cur = e.sep; gap = true; } continue; }
      if (e.ts) cur = e.ts;
      out.push({ me: e.me, kind: e.kind, text: e.text, t: cur, gap, sig: e.sig });
      gap = false;
    }
    return out;
  }
  // tìm vị trí của "dấu mốc" (các tin mới nhất lần đếm trước) trong danh sách mới→cũ
  function findAnchor(list, A, from) {
    const K = A.length;
    for (let i = Math.max(0, from); i + K <= list.length; i++) {
      let ok = true;
      for (let j = 0; j < K; j++) if (list[i + j].sig !== A[j]) { ok = false; break; }
      if (ok) return i;
    }
    return -1;
  }

  /* ═══════════════════════ ENGINE: tìm khung chat ═══════════════════════ */

  let manualSc = null;
  function ctxText(el) {
    let e = el;
    for (let i = 0; i < 4 && e.parentElement; i++) { e = e.parentElement; const t = e.textContent; if (t && t.trim() && t.length < 80) return t; }
    return '';
  }
  // ô "Gửi tin nhắn…" của khung chat đang mở
  function findInput() {
    let best = null, bestS = 0;
    for (const el of qsa(document, 'textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[contenteditable=""],[role="textbox"],input[type="text"],input:not([type])')) {
      if (ours(el) || !visible(el)) continue;
      const hint = [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('aria-placeholder'),
        el.getAttribute('data-placeholder'), el.getAttribute('data-e2e'), ctxText(el)].join(' ').toLowerCase();
      let s = 1;
      if (/tin nhắn|nhắn tin|message|gửi|send|chat/.test(hint)) s += 10;
      if (/tìm|search|bình luận|comment/.test(hint)) s -= 8;
      if (s > bestS) { bestS = s; best = el; }
    }
    return bestS >= 5 ? best : null;
  }
  const scrollable = el => { const o = getComputedStyle(el).overflowY; return o === 'auto' || o === 'scroll' || o === 'overlay'; };
  const canScroll = el => el.scrollHeight > el.clientHeight + 4;

  // có giống khung tin nhắn không: bong bóng ở cả hai bên (hoặc rất nhiều bong bóng hẹp)
  function chatLike(el) {
    const R = rectOf(el), mid = R.left + R.width / 2;
    let L = 0, Rt = 0;
    for (const c of collect(el, el, false)) {
      if (c.minor) continue;
      const r = rectOf(c.el);
      if (r.width > R.width * 0.8) continue;
      const cx = (r.left + r.right) / 2;
      if (cx < mid - R.width * 0.05) L++; else if (cx > mid + R.width * 0.05) Rt++;
    }
    return { L, R: Rt, ok: (L >= 1 && Rt >= 1 && L + Rt >= 3) || L + Rt >= 10 };
  }

  // khung tin nhắn = vùng cuộn phía trên ô nhập; ưu tiên vùng CUỘN ĐƯỢC THẬT
  function findScroller() {
    if (manualSc && manualSc.isConnected && visible(manualSc)) return manualSc;
    const inp = findInput();
    if (inp) {
      const ir = rectOf(inp);
      let fallback = null;
      let a = inp.parentElement;
      for (let lvl = 0; a && a !== document.documentElement && lvl < 12; lvl++, a = a.parentElement) {
        let best = null, bestH = 0, still = null, stillH = 0;
        const tw = document.createTreeWalker(a, NodeFilter.SHOW_ELEMENT, skipFilter);
        for (let el = tw.nextNode(); el; el = tw.nextNode()) {
          const r = rectOf(el);
          if (r.height < 80 || r.width < 120 || r.top > ir.top) continue;
          const ov = Math.min(r.right, ir.right) - Math.max(r.left, ir.left);
          if (ov < Math.min(r.width, ir.width) * 0.5) continue;
          if (el.contains(inp) || !scrollable(el)) continue;
          if (canScroll(el)) { if (r.height > bestH) { best = el; bestH = r.height; } }
          else if (r.height > stillH) { still = el; stillH = r.height; }
        }
        if (best) return best;
        if (!fallback && still) fallback = still;
      }
      if (fallback) return fallback; // chat ngắn, chưa cần cuộn
    }
    // không thấy ô nhập: chỉ nhận vùng cuộn thật sự giống khung tin nhắn (tránh nhầm danh sách hội thoại)
    const list = [];
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, skipFilter);
    for (let el = tw.nextNode(); el; el = tw.nextNode()) {
      const r = rectOf(el);
      if (r.width < 150 || r.height < 120 || el.scrollHeight <= el.clientHeight + 4) continue;
      if (scrollable(el)) list.push({ el, a: r.width * r.height });
    }
    let best = null, bestN = 0;
    for (const { el } of list.sort((x, y) => y.a - x.a).slice(0, 6)) {
      const c = chatLike(el);
      if (c.ok && c.L + c.R > bestN) { bestN = c.L + c.R; best = el; }
    }
    return best;
  }

  const STATUS_RE = /^(đang hoạt động|hoạt động|active|online|truy cập|đã xem|seen|typing|đang nhập)/i;
  function findTitle(sc) {
    const R = rectOf(sc);
    for (const s of KNOWN.convName) {
      for (const el of qsa(document, s)) {
        const r = rectOf(el);
        if (r.width && r.bottom <= R.top + 6 && r.top >= R.top - 160 && r.left >= R.left - 20 && r.right <= R.right + 20 && el.textContent.trim()) return el.textContent.trim().slice(0, 60);
      }
    }
    let a = sc.parentElement;
    for (let lvl = 0; a && lvl < 6; lvl++, a = a.parentElement) {
      let best = null, bestS = 0;
      const tw = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
      for (let n; (n = tw.nextNode());) {
        const v = n.nodeValue.trim();
        if (!v || v.length > 50 || STATUS_RE.test(v) || isTimeLine(v)) continue;
        const el = n.parentElement;
        if (!el || sc.contains(el) || ours(el) || el.closest('button,[role="button"],a[href*="/video/"]')) continue;
        const r = rectOf(el);
        if (!r.width || r.bottom > R.top + 6 || r.top < R.top - 160) continue;
        // tên nằm ở nửa trái/giữa đầu khung chat; chữ lệch hẳn sang phải thường là của trang khác (video, gợi ý follow…)
        if (r.right < R.left - 10 || r.left > R.left + R.width * 0.65) continue;
        const cs = getComputedStyle(el);
        const s = parseFloat(cs.fontSize) * (parseInt(cs.fontWeight, 10) >= 600 ? 1.15 : 1) - Math.max(0, r.left - R.left) / 200;
        if (s > bestS) { bestS = s; best = el; }
      }
      if (best) return best.textContent.trim().slice(0, 60);
    }
    return '';
  }
  // tên người đang chat: chữ to ở đầu khung, nếu không có thì lấy mục đang sáng trong danh sách
  function chatName(sc) {
    const t = findTitle(sc);
    if (t) return t;
    const it = scanItems(sc).find(x => x.active && x.name);
    return it ? it.name : '';
  }
  // avatar ở đầu khung chat (cạnh tên người kia)
  function headerAvatar(sc) {
    const R = rectOf(sc);
    for (let a = sc.parentElement, l = 0; a && a !== document.body && l < 5; a = a.parentElement, l++) {
      for (const im of a.querySelectorAll('img')) {
        if (sc.contains(im) || ours(im)) continue;
        const r = rectOf(im);
        if (r.width < 20 || r.width > 96 || r.bottom > R.top + 8 || r.top < R.top - 180 || r.right < R.left - 10 || r.left > R.right + 10) continue;
        if (isRound(im, a)) return imgSrc(im);
      }
    }
    return '';
  }
  // avatar của NGƯỜI KIA trong khung chat: avatar đầu khung, hoặc avatar nằm bên trái (bên phải là của bạn)
  function sideAvatars(sc, max) {
    const R = rectOf(sc), mid = R.left + R.width / 2, keys = new Map();
    const ims = sc.querySelectorAll('img');
    for (let i = ims.length - 1, n = 0; i >= 0 && n < max; i--) {
      const im = ims[i], r = rectOf(im);
      if (r.width < 16 || r.width > 72 || (r.left + r.right) / 2 >= mid || !isRound(im, sc)) continue;
      const src = imgSrc(im), k = avKey(src);
      if (k && !keys.has(k)) keys.set(k, src);
      n++;
    }
    return keys;
  }
  function chatAvatar(sc) {
    if (!sc) return '';
    const h = headerAvatar(sc);
    if (h) return h;
    const ks = sideAvatars(sc, 80);
    return ks.size ? [...ks.values()][0] : '';
  }

  /* ═══════════════════════ ENGINE: danh sách hội thoại ═══════════════════════ */

  const TIME_RE = /(^|[\s·•])(\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}(\/\d{2,4})?|hôm qua|yesterday|\d+\s*(phút|giờ|ngày|tuần|tháng|năm)(\s*trước)?|\d+\s*[mhdw])(?=$|[\s·•])/i;
  const isTimeLine = s => /^(\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}(\/\d{2,4})?|hôm qua|yesterday|\d+\s*(phút|giờ|ngày|tuần|tháng|năm)(\s*trước)?|\d+\s*[mhdw])$/i.test(s);
  const isBadge = s => /^\d{1,3}\+?$/.test(s);
  const imgOf = el => imgSrc(el && el.querySelector('img'));

  function itemName(el) {
    for (const s of KNOWN.convName) { const n = el.querySelector(s); if (n && n.textContent.trim()) return n.textContent.trim().slice(0, 40); }
    const it = el.innerText || '';
    for (const s of it.split('\n').map(x => x.trim()).filter(Boolean)) if (!isTimeLine(s) && !isBadge(s)) return s.slice(0, 40);
    // danh sách thu gọn (chỉ avatar): chữ bị ẩn → lấy dòng chữ đầu tiên (thường là tên), KHÔNG gộp cả tin nhắn cuối
    if (!it.trim()) {
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n; (n = tw.nextNode());) { const v = n.nodeValue.trim(); if (v && !isTimeLine(v) && !isBadge(v)) return v.slice(0, 40); }
    }
    const img = el.querySelector('img');
    if (img && img.alt && img.alt.trim()) return img.alt.trim().slice(0, 40);
    return (el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 40);
  }

  // gom các phần tử cùng cha mà mỗi cái chứa một avatar tròn → ứng viên danh sách
  function avatarGroups(scope, sc, R) {
    const groups = new Map();
    const tw = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT, {
      acceptNode: n => (n === sc || n === HOST || n.hasAttribute(MARK) || n.hasAttribute(HIDE) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let el = tw.nextNode(); el; el = tw.nextNode()) {
      const tag = el.tagName;
      if (tag !== 'IMG' && tag !== 'DIV' && tag !== 'SPAN' && tag !== 'PICTURE') continue;
      const r = rectOf(el);
      if (r.width < 24 || r.width > 96 || Math.abs(r.width - r.height) > 4) continue;
      if (R && r.right > R.left + 8) continue; // đang mở chat: danh sách nằm bên trái khung chat
      if (tag !== 'IMG') {
        const cs = getComputedStyle(el);
        if (!(alpha(cs.backgroundColor) > 0.05 || cs.backgroundImage !== 'none' || el.querySelector('img'))) continue;
      }
      if (!isRound(el, scope)) continue;
      for (let e = el, k = 0; e.parentElement && e !== scope && k < 7; e = e.parentElement, k++) {
        const p = e.parentElement;
        let set = groups.get(p);
        if (!set) groups.set(p, (set = new Set()));
        set.add(e);
      }
    }
    return groups;
  }
  function pickGroup(groups, sc, R) {
    let best = null, bestScore = null;
    const better = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
    for (const [, set] of groups) {
      if (set.size < 2) continue;
      const arr = [...set];
      if (sc && arr.some(e => e.contains(sc))) continue;
      const rs = arr.map(rectOf);
      const lefts = rs.map(r => r.left), hs = rs.map(r => r.height), ws = rs.map(r => r.width);
      if (Math.max(...lefts) - Math.min(...lefts) > 24) continue;                       // xếp dọc thẳng hàng
      if (Math.max(...hs) > Math.min(...hs) * 2.2 || Math.max(...hs) > 160) continue;
      if (Math.max(...ws) > Math.min(...ws) * 1.6) continue;
      const linkOut = arr.filter(e => { const a = e.closest('a[href]') || e.querySelector('a[href]'); return a && !/messages/i.test(a.getAttribute('href') || ''); }).length;
      if (linkOut * 2 > arr.length) continue;                                            // thanh menu (link sang trang khác)
      const named = arr.filter(e => (e.innerText || '').trim() && itemName(e)).length;
      const timed = arr.filter(e => TIME_RE.test((e.innerText || '').replace(/\n/g, ' '))).length;
      const tier = named >= 2 && timed >= Math.max(2, Math.ceil(arr.length * 0.4)) ? 2 : named >= 2 ? 1 : 0;
      if (!sc && tier < 2) continue; // chưa mở chat: phải đúng là danh sách hội thoại (có tên + giờ)
      const gap = R ? R.left - Math.max(...rs.map(r => r.right)) : 0;
      const score = [tier, arr.length, -Math.abs(gap)];
      if (!bestScore || better(score, bestScore)) { best = { items: arr.sort(docOrder), method: 'auto', named }; bestScore = score; }
    }
    return best;
  }
  function findConvList(sc) {
    for (const s of KNOWN.convItems) {
      const r = qsa(document, s).filter(e => visible(e) && !ours(e));
      if (r.length) return { items: r, method: 'selector', named: r.filter(e => (e.innerText || '').trim()).length };
    }
    const R = sc ? rectOf(sc) : null;
    const scopes = [];
    if (sc) { let a = sc.parentElement; for (let i = 0; a && a !== document.documentElement && i < 9; i++, a = a.parentElement) scopes.push(a); }
    else if (document.body) scopes.push(document.body);
    for (const scope of scopes) {
      const g = pickGroup(avatarGroups(scope, sc, R), sc, R);
      if (g) return g;
    }
    return { items: [], method: 'none', named: 0 };
  }

  // mục đang được chọn (TikTok tô nền khác cho người đang mở)
  function bgOf(el) {
    const R = rectOf(el);
    const cands = [el, ...el.children];
    if (el.parentElement && el.parentElement.children.length === 1) cands.push(el.parentElement);
    for (const e of cands) {
      const r = rectOf(e);
      if (r.width * r.height < R.width * R.height * 0.6) continue;
      const c = getComputedStyle(e).backgroundColor;
      if (alpha(c) > 0.03) return c;
    }
    return '';
  }
  function activeItem(items) {
    if (!items.length) return null;
    for (const x of items) {
      const el = x.el || x;
      if (el.matches('[aria-selected="true"],[aria-current="true"],[aria-current="page"]') || el.querySelector('[aria-selected="true"],[aria-current="true"]')) return el;
    }
    if (items.length < 2) return null;
    const bgs = items.map(x => bgOf(x.el || x)), cnt = new Map();
    for (const b of bgs) cnt.set(b, (cnt.get(b) || 0) + 1);
    const odd = bgs.map((b, i) => [b, i]).filter(([b]) => b && cnt.get(b) === 1);
    return odd.length === 1 ? (items[odd[0][1]].el || items[odd[0][1]]) : null;
  }

  /* ═══════════════════════ ENGINE: mở đúng người ═══════════════════════ */

  // nhớ tên theo ảnh đại diện → cột avatar thu gọn vẫn biết ai là ai. [key, tên, đã xác minh?]
  const nameByAv = new Map();
  for (const e of store.get('dmcNames') || []) if (Array.isArray(e) && e[0]) nameByAv.set(e[0], { n: e[1], v: !!e[2] });
  const saveNames = () => store.set('dmcNames', [...nameByAv.entries()].slice(-500).map(([k, x]) => [k, x.n, x.v ? 1 : 0]));
  const learnName = (k, n, verified) => { if (!k || !n) return; const o = nameByAv.get(k); if (o && o.v && !verified) return; nameByAv.set(k, { n, v: !!verified }); };
  let ORDER = null; // thứ tự tên ở danh sách đầy đủ gần nhất

  // quét danh sách người: tên lấy từ chữ trên mục, hoặc từ ảnh đại diện đã nhớ, hoặc đoán theo thứ tự
  function scanItems(sc) {
    const c = findConvList(sc);
    const items = c.items.map(el => {
      const img = imgOf(el), k = img ? avKey(img) : '';
      const shown = !!(el.innerText || '').trim();
      let name = itemName(el), sure = !!name && shown;
      if (name && shown && k) learnName(k, name, true);
      if ((!name || !shown) && k && nameByAv.has(k)) { const x = nameByAv.get(k); if (!name || x.v) { name = x.n; sure = x.v; } }
      return { el, img, k, name, sure };
    });
    if (items.length && c.named === items.length) ORDER = items.map(x => x.name);
    else if (ORDER && ORDER.length === items.length && items.some(x => x.name) && items.every((x, i) => !x.name || sameName(x.name, ORDER[i])))
      items.forEach((x, i) => { if (!x.name) { x.name = ORDER[i]; x.sure = false; } });
    // còn đúng 1 người chưa biết tên và đúng 1 tên chưa ai nhận → chính là người đó (vd. avatar mặc định)
    const unnamed = items.filter(x => !x.name);
    if (ORDER && unnamed.length === 1 && ORDER.length === items.length) {
      const used = new Set(items.filter(x => x.name).map(x => normName(x.name)));
      const left = ORDER.filter(n => !used.has(normName(n)));
      if (left.length === 1) { unnamed[0].name = left[0]; unnamed[0].sure = false; }
    }
    const act = activeItem(items);
    items.forEach((x, i) => { x.id = x.k ? 'k:' + x.k : x.name ? 'n:' + normName(x.name) : 'i:' + i; x.active = x.el === act; });
    return items;
  }
  // khung chat đang mở → nhớ: avatar của người kia = tên trên đầu khung
  function learnFromChat(sc, title) {
    if (!sc || !title) return;
    const h = headerAvatar(sc);
    if (h) { learnName(avKey(h), title, true); saveNames(); return; }
    const ks = sideAvatars(sc, 60);
    if (ks.size === 1) { learnName([...ks.keys()][0], title, true); saveNames(); }
  }
  // khung đang mở có đúng là người cần đếm không (tên, avatar, hoặc mục đang được tô sáng)
  function isTargetChat(sc, title, tg, act) {
    if (!sc) return false;
    if (tg.name && title && sameName(title, tg.name)) return true;
    if (tg.k) { const a = chatAvatar(sc); if (a && avKey(a) === tg.k) return true; }
    if (act && tg.el && (act === tg.el || (tg.k && avKey(imgOf(act)) === tg.k))) return true;
    return false;
  }
  // tìm lại đúng người trong danh sách hiện tại (TikTok hay đảo thứ tự sau mỗi lần mở chat)
  function refind(tg, items) {
    items = items || scanItems(findScroller());
    if (tg.k) { const m = items.find(x => x.k === tg.k); if (m) return m; }
    if (tg.name) { const m = items.filter(x => x.name && sameName(x.name, tg.name)); if (m.length === 1) return m[0]; }
    if (tg.el && tg.el.isConnected) { const m = items.find(x => x.el === tg.el); if (m) return m; }
    return null;
  }
  const deepEnd = (e, first) => { for (let i = 0; i < 60; i++) { const c = first ? e.firstElementChild : e.lastElementChild; if (!c) break; e = c; } return e; };
  function contentSig(sc) {
    const a = deepEnd(sc, true), b = deepEnd(sc, false);
    return { a, b, ta: (a.textContent || '').slice(0, 80), tb: (b.textContent || '').slice(0, 80) };
  }
  function sigChanged(sc, sig) {
    const gone = el => !el.isConnected || !sc.contains(el);
    return gone(sig.a) || gone(sig.b) || (sig.a.textContent || '').slice(0, 80) !== sig.ta || (sig.b.textContent || '').slice(0, 80) !== sig.tb;
  }
  function clickItem(el, attempt) {
    try { el.scrollIntoView({ block: 'center' }); } catch {}
    const r = rectOf(el);
    const x = attempt === 1 ? r.left + r.width / 2 : r.left + Math.min(r.width / 2, 34), y = r.top + r.height / 2;
    let t = null;
    if (attempt < 2) {
      const prev = HOST ? HOST.style.visibility : '';
      if (HOST) HOST.style.visibility = 'hidden'; // không để giao diện của script che chỗ bấm
      t = document.elementFromPoint(x, y);
      if (HOST) HOST.style.visibility = prev;
    }
    if (!t || !el.contains(t)) t = el;
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
    try { t.dispatchEvent(new PointerEvent('pointerdown', { ...o, pointerId: 1, isPrimary: true, pointerType: 'touch' })); } catch {}
    t.dispatchEvent(new MouseEvent('mousedown', o));
    try { t.dispatchEvent(new PointerEvent('pointerup', { ...o, pointerId: 1, isPrimary: true, pointerType: 'touch' })); } catch {}
    t.dispatchEvent(new MouseEvent('mouseup', o));
    if (attempt === 2) { const c = t.closest('a[href],[role="button"],[role="link"],[tabindex],button') || t; if (typeof c.click === 'function') c.click(); else c.dispatchEvent(new MouseEvent('click', o)); }
    else t.dispatchEvent(new MouseEvent('click', o));
  }
  async function waitFor(fn, ms, shouldStop) {
    const end = Date.now() + ms * SPEED;
    for (;;) {
      try { if (fn()) return true; } catch {}
      if (Date.now() >= end || (shouldStop && shouldStop())) return false;
      await new Promise(r => setTimeout(r, 120));
    }
  }
  async function openTarget(tg, onPhase, shouldStop) {
    const sc0 = findScroller(), t0 = sc0 ? findTitle(sc0) : '';
    const items0 = scanItems(sc0);
    const m0 = refind(tg, items0);
    if (m0) tg.el = m0.el;
    // đang mở đúng người rồi → không bấm nữa (lỗi cũ: so nhầm với avatar của chính bạn nên bấm mãi)
    if (sc0 && isTargetChat(sc0, t0, tg, activeItem(items0))) { learnFromChat(sc0, t0); return; }
    const sig0 = sc0 ? contentSig(sc0) : null;
    let opened = false;
    for (let attempt = 0; attempt < 3 && !opened; attempt++) {
      if (shouldStop()) throw new Error('Đã dừng.');
      const m = refind(tg);
      if (!m) throw new Error(`Không còn thấy ${tg.name || 'người này'} trong danh sách. Hãy bấm ⟳ rồi chọn lại.`);
      tg.el = m.el;
      onPhase(attempt ? `Đang thử mở lại ${tg.name || ''}…` : `Đang mở ${tg.name || 'cuộc trò chuyện'}…`);
      clickItem(m.el, attempt);
      opened = await waitFor(() => {
        const s = findScroller(); if (!s) return false;
        const t = findTitle(s);
        const items = scanItems(s), act = activeItem(items), mine = refind(tg, items);
        const actMine = !!act && !!mine && act === mine.el;
        if (t && isTargetChat(s, t, tg, act)) return true;
        const moved = !sc0 || (t && t0 && !sameName(t, t0)) || (sig0 && sigChanged(s, sig0));
        if (actMine && moved) return true;                 // mục vừa bấm đã sáng lên & nội dung đã đổi
        if (tg.name && tg.sure) return false;               // biết chắc tên: phải khớp tên mới được đếm
        return !!t && moved;                                // chưa chắc tên: chỉ cần đã chuyển khỏi người cũ
      }, 4500, shouldStop);
    }
    if (!opened) {
      // lần cuối: khung đang mở có đúng người không (TikTok phản hồi chậm)
      const s = findScroller(), t = s ? findTitle(s) : '';
      if (!(s && isTargetChat(s, t, tg, activeItem(scanItems(s))))) throw new Error(`Không mở được cuộc trò chuyện với ${tg.name || 'người này'}. Hãy tự bấm vào người đó trong TikTok rồi bấm “Đếm người đang mở”.`);
    }
    onPhase('Đang chờ tin nhắn hiện ra…');
    await waitFor(() => {
      const s = findScroller();
      return !!s && (!sig0 || sigChanged(s, sig0)) && collect(s, s, true).length > 0;
    }, 6000, shouldStop);
    await sleep(250);
    const s = findScroller(), t = s ? findTitle(s) : '';
    learnFromChat(s, t);
    if (tg.k && t) { learnName(tg.k, t, true); saveNames(); }
  }

  /* ═══════════════════════ ENGINE: tự cuộn & đếm ═══════════════════════ */

  const isRev = el => getComputedStyle(el).flexDirection === 'column-reverse';
  const isDocEl = el => el === document.scrollingElement || el === document.documentElement || el === document.body;
  // phần tử thật sự cuộn được: chính khung, vùng con bên trong, khung bên ngoài, hoặc cả trang
  function scrollTarget(sc) {
    if (canScroll(sc) && (scrollable(sc) || isDocEl(sc))) return sc;
    let best = null, bestH = 0;
    const tw = document.createTreeWalker(sc, NodeFilter.SHOW_ELEMENT, skipFilter);
    for (let el = tw.nextNode(); el; el = tw.nextNode()) {
      const r = rectOf(el);
      if (r.height < 80 || r.height <= bestH) continue;
      if (canScroll(el) && scrollable(el)) { best = el; bestH = r.height; }
    }
    if (best) return best;
    for (let e = sc.parentElement; e && !isDocEl(e); e = e.parentElement) if (canScroll(e) && scrollable(e)) return e;
    const d = document.scrollingElement;
    return d && canScroll(d) ? d : sc;
  }
  // danh sách lật bằng transform scaleY(-1) → tin cũ nằm ở scrollTop lớn nhất
  const flippedY = el => { const m = getComputedStyle(el).transform.match(/^matrix\(([^)]+)\)/); return !!m && parseFloat(m[1].split(',')[3]) < 0; };
  function toEnd(st, older, dirMax) {
    if (older === dirMax) st.scrollTop = 1e9;
    else { st.scrollTop = -1e9; if (st.scrollTop > 0) st.scrollTop = 0; } // column-reverse dùng scrollTop âm
  }
  async function nudgeOlder(st, dirMax) {
    const before = st.scrollTop;
    toEnd(st, true, dirMax);
    if (Math.abs(st.scrollTop - before) < 2) {
      // đã ở sẵn đầu → lùi ra một đoạn rồi kéo lại, để TikTok nhận sự kiện cuộn mới
      st.scrollTop = before + (dirMax ? -280 : 280);
      await new Promise(r => setTimeout(r, 30 * SPEED));
      toEnd(st, true, dirMax);
    }
    try { st.dispatchEvent(new WheelEvent('wheel', { deltaY: dirMax ? 600 : -600, bubbles: true })); } catch {}
  }
  // TikTok đang tải thêm (vòng xoay ở đầu khung) → chờ thêm, đừng kết luận đã hết tin
  function loadingNear(st) {
    const R = rectOf(st);
    for (const el of qsa(st, '[class*="oading"],[class*="pinner"],[class*="Spin"],[class*="spin"],[role="progressbar"],svg[class*="oad"]')) {
      if (ours(el)) continue;
      const r = rectOf(el);
      if (r.width < 6 || r.width > 120 || r.height > 120) continue;
      if (r.bottom < R.top - 40 || r.top > R.top + 220) continue;
      return true;
    }
    return false;
  }
  // chờ TikTok chèn tin (MutationObserver đánh thức ngay) hoặc hết giờ
  function waitWake(ctx, st, h0, ms, shouldStop) {
    return new Promise(resolve => {
      let done = false, iv = 0, to = 0;
      const fin = v => { if (done) return; done = true; clearInterval(iv); clearTimeout(to); ctx.wake = null; resolve(v); };
      ctx.wake = () => fin(true);
      to = setTimeout(() => fin(false), ms * SPEED);
      iv = setInterval(() => { if (shouldStop() || !st.isConnected || st.scrollHeight !== h0) fin(true); }, 120);
    });
  }

  const LOST = 'Khung chat bị đóng hoặc đã chuyển sang người khác trong lúc đếm. Hãy mở lại rồi bấm “Đếm tiếp”.';
  // anchor: các mã tin mới nhất của lần đếm trước (mới → cũ) → chỉ đếm phần tin mới rồi dừng
  async function countAll({ onProgress, shouldStop, anchor }) {
    let sc = findScroller();
    if (!sc) throw new Error('Chưa thấy khung tin nhắn. Hãy chọn một người trong danh sách (hoặc tự mở cuộc trò chuyện) rồi bấm Đếm.');
    const title = findTitle(sc);
    const prep = s => { clearMarks(s); s.setAttribute(CONV, title || '?'); };
    prep(sc);
    ensureLightCss();
    const SP = SPEEDS[CFG.speed] || SPEEDS.normal;
    const ctx = { lb: new Map(), rb: new Map(), keys: new Map(), keyClash: 0, retry: new WeakMap(), pending: new Set(), mo: null, muts: 0, wake: null,
      removed: false, virtual: false, lossy: false, maxTotal: 0, selector: detectSelector(sc),
      c: { total: 0, me: 0, them: 0, media: 0 }, vis: [], hidStack: [], hidden: 0, ent: new Map(), flat: [], rev: 0 };
    const A = anchor && anchor.length ? anchor : null;
    let found = -1, searched = 0;
    // đã gặp lại đúng chỗ đếm lần trước chưa (xác minh lại theo thứ tự thật trong trang)
    const checkAnchor = () => {
      if (!A || ctx.virtual) return false;
      const i = findAnchor(ctx.flat, A, searched - A.length + 1);
      searched = ctx.flat.length;
      if (i < 0) return false;
      const tl = timeline(sc, ctx).reverse();
      const j = findAnchor(tl, A, 0);
      if (j < 0) return false;
      found = j; ctx.newer = tl.slice(0, j);
      return true;
    };
    let st = sc, dirMax = false;
    const reattach = () => {
      const s = findScroller();
      if (!s || (title && !sameName(findTitle(s), title))) return false;
      sc = s; prep(sc);
      ctx.c = { total: 0, me: 0, them: 0, media: 0 };
      ctx.maxTotal = 0; ctx.vis = []; ctx.hidStack = []; ctx.flat = []; searched = 0;
      observe(sc, ctx); step(sc, ctx, true);
      st = scrollTarget(sc);
      return true;
    };
    setHiding(true);
    let loadSince = 0;
    try {
      observe(sc, ctx);
      step(sc, ctx, true);
      trim(ctx);
      st = scrollTarget(sc); dirMax = flippedY(st);
      onProgress(current(ctx), 'load', Math.ceil(SP.patience / 1000));
      let lastNew = Date.now(), lastNudge = 0, probe = 0;
      while (!shouldStop() && !checkAnchor()) {
        if (!sc.isConnected && !reattach()) throw new Error(LOST);
        if (!st.isConnected) st = scrollTarget(sc);
        if (!canScroll(st)) { if (ctx.hidStack.length) unhideSome(ctx, st); else if (!ctx.hidden) st = scrollTarget(sc); }
        const gap = Date.now() - lastNudge;
        if (gap < 45) await new Promise(r => setTimeout(r, 45 - gap));
        const h0 = st.scrollHeight;
        await nudgeOlder(st, dirMax);
        lastNudge = Date.now();
        await waitWake(ctx, st, h0, SP.wake, shouldStop);
        if (!sc.isConnected && !reattach()) throw new Error(LOST);
        await new Promise(r => setTimeout(r, 12)); // gom trọn một đợt TikTok chèn vào
        const added = step(sc, ctx, false);
        trim(ctx);
        checkRemoval(sc, ctx);
        ctx.maxTotal = Math.max(ctx.maxTotal, ctx.c.total);
        if (added) { lastNew = Date.now(); loadSince = 0; }
        else if (loadingNear(st)) {
          // vòng xoay của TikTok vẫn đang chạy → chưa hết tin, chờ thêm (tối đa 45 giây liền)
          if (!loadSince) loadSince = Date.now();
          if (Date.now() - loadSince < 45000 * SPEED) lastNew = Math.max(lastNew, Date.now() - SP.patience * SPEED * 0.5);
        }
        const idle = (Date.now() - lastNew) / SPEED;
        onProgress(current(ctx), idle > 1800 ? 'wait' : 'load', Math.max(0, Math.ceil((SP.patience - idle) / 1000)));
        // kẹt lâu: thử kéo về phía ngược lại (danh sách bị lật, trình duyệt tính toạ độ khác…)
        if (idle > SP.patience * 0.33 && probe === 0) { dirMax = !dirMax; probe = 1; }
        else if (idle > SP.patience * 0.66 && probe === 1) { dirMax = !dirMax; probe = 2; }
        if (idle >= SP.patience) break;
        if (!ctx.hidden && !canScroll(st) && idle > 2500) break; // cả cuộc trò chuyện nằm gọn trong màn hình
      }
      // danh sách "ảo" (TikTok chỉ giữ tin đang thấy): quét xuống từng đoạn để gom đủ
      if (ctx.virtual && found < 0 && !shouldStop()) {
        toEnd(st, true, dirMax); await sleep(300);
        for (let i = 0; i < 1e6 && !shouldStop(); i++) {
          await tick0();
          step(sc, ctx, false); trim(ctx);
          onProgress(current(ctx), 'sweep', 0);
          const before = st.scrollTop;
          st.scrollTop += (dirMax ? -1 : 1) * st.clientHeight * 0.7;
          await sleep(160);
          if (Math.abs(st.scrollTop - before) < 2) { await sleep(200); await tick0(); step(sc, ctx, false); break; }
        }
      }
    } finally {
      if (ctx.mo) ctx.mo.disconnect();
      setHiding(false);
    }
    await tick0();
    checkRemoval(sc, ctx);
    const base = { title, avatar: chatAvatar(sc), virtual: ctx.virtual, lossy: (ctx.lossy && !ctx.virtual) || ctx.keyClash > 0,
      scrollInfo: st === sc ? 'khung' : isDocEl(st) ? 'cả trang' : sc.contains(st) ? 'vùng con' : 'khung ngoài' };
    const tl = timeline(sc, ctx);
    const newest = tl.slice(-ANCHOR_N).reverse().map(e => e.sig);
    try { toEnd(st, false, dirMax); } catch {} // trả khung chat về tin mới nhất
    const fin = ctx.virtual ? fromKeys(ctx) : tally(sc);
    ctx.ent.clear(); ctx.keys.clear(); ctx.flat = [];
    if (found >= 0) {
      // chế độ cập nhật nhanh: chỉ phần tin mới
      const nw = ctx.newer, c = { total: nw.length, me: 0, them: 0, media: 0 };
      for (const e of nw) { if (e.me) c.me++; else c.them++; if (e.kind !== 'text') c.media++; }
      return { ...base, ...c, incremental: true, msgs: nw.reverse(), anchor: newest, complete: true };
    }
    return { ...base, total: fin.total, me: fin.me, them: fin.them, media: fin.media, msgs: tl, anchor: newest, complete: !shouldStop(), incremental: false };
  }

  /* ═══════════════════════ PHÂN TÍCH NỘI DUNG (chạy hoàn toàn trên máy bạn) ═══════════════════════ */

  const AN = (() => {
    const NF = s => String(s || '').normalize('NFC').toLowerCase();
    // gõ tắt / teencode → từ chuẩn
    const TEEN = {
      k: 'không', ko: 'không', kh: 'không', hk: 'không', hok: 'không', khum: 'không', hông: 'không', hong: 'không', hem: 'không', khong: 'không', kg: 'không', kô: 'không',
      dc: 'được', đc: 'được', duoc: 'được', j: 'gì', gi: 'gì', iu: 'yêu', yeu: 'yêu', thuong: 'thương', r: 'rồi', ròi: 'rồi', rùi: 'rồi', roi: 'rồi',
      z: 'vậy', v: 'vậy', zậy: 'vậy', dzậy: 'vậy', vs: 'với', ms: 'mới', cx: 'cũng', cg: 'cũng', mk: 'mình', mik: 'mình', mn: 'mọi người',
      bt: 'biết', ng: 'người', ngta: 'người ta', uk: 'ừ', uh: 'ừ', um: 'ừ', ừm: 'ừ', ukm: 'ừ', ừa: 'ừ', ờm: 'ờ', oke: 'ok', okie: 'ok', oki: 'ok', okay: 'ok', okela: 'ok', okê: 'ok', okii: 'ok',
      ah: 'à', ntn: 'như thế nào', dth: 'dễ thương', thik: 'thích', thjk: 'thích', nhìu: 'nhiều', lm: 'làm', đag: 'đang', dag: 'đang', e: 'em', a: 'anh',
      hix: 'hic', huhu: 'huhu', tks: 'cảm ơn', thanks: 'cảm ơn', camon: 'cảm ơn', cảmơn: 'cảm ơn', bik: 'biết', bjk: 'biết', wa: 'quá', qá: 'quá', ik: 'đi', đy: 'đi',
    };
    // dấu thanh kiểu cũ/mới: hoà → hòa, thuý → thúy
    const TONE = { 'oà': 'òa', 'oá': 'óa', 'oả': 'ỏa', 'oã': 'õa', 'oạ': 'ọa', 'oè': 'òe', 'oé': 'óe', 'oẻ': 'ỏe', 'oẽ': 'õe', 'oẹ': 'ọe', 'uỳ': 'ùy', 'uý': 'úy', 'uỷ': 'ủy', 'uỹ': 'ũy', 'uỵ': 'ụy' };
    const fixTone = w => { if (w.length < 2) return w; const e = w.slice(-2); return TONE[e] && w.slice(-3, -2) !== 'q' ? w.slice(0, -2) + TONE[e] : w; };
    function tokens(text) {
      const out = [];
      for (let w of NF(text).replace(/https?:\/\/\S+/g, ' ').split(/[^\p{L}\p{N}]+/u)) {
        if (!w) continue;
        w = TEEN[w] || fixTone(w);
        if (w.includes(' ')) out.push(...w.split(' ')); else out.push(w);
      }
      return out;
    }

    // chủ đề hiển thị: [id, emoji, tên, từ khoá ("từ:trọng số")]
    const TOPICS = [
      ['love', '💕', 'Yêu đương', 'yêu|thương|yêu em|yêu anh|thương em|thương anh|nhớ em|nhớ anh|nhớ quá|nhớ ghê|người yêu|ny|nyc|bae|baby|honey|cưng|cục cưng|bảo bối|vợ|chồng|vợ yêu|chồng yêu|ông xã|bà xã|hôn|ôm|moah|chụt|muah|love|love you|kiss|hun|ghen|thả thính|thính|crush|hẹn hò|bồ|tỏ tình|nắm tay|sến|thích em|thích anh|thích cậu|thích tớ|anh yêu|em yêu|bé yêu|yêu nhiều'],
      ['date', '🗓️', 'Hẹn hò, đi chơi', 'đi chơi|hẹn|gặp|gặp nhau|đón|đưa|chở|rảnh|cuối tuần|tối nay|chiều nay|sáng mai|mai:0.4|đi đâu|đi dạo|đi ăn|xem phim|cà phê|cafe|công viên|phố đi bộ|biển|du lịch|phượt|karaoke|chụp ảnh|qua nhà|đến nhà|đợi|chờ:0.5|đi xem'],
      ['care', '🌙', 'Hỏi han, chúc ngủ ngon', 'ngủ ngon|ngủ chưa|ngủ đi|đi ngủ|ngủ sớm|ngủ ngoan|mơ đẹp|dậy chưa|dậy:0.5|buồn ngủ|thức khuya|ăn cơm chưa|ăn chưa|ăn gì chưa|ăn sáng chưa|đang làm gì|làm gì đó|làm gì vậy|ldg|về chưa|về nhà chưa|tới nhà chưa|đến nơi chưa|cẩn thận|giữ ấm|mặc ấm|uống thuốc|ốm|mệt không|có sao không|khỏe không|ổn không|good night|gn|good morning|chào buổi sáng|ngu ngon|an com chua|dang lam gi|nghỉ ngơi|nhớ ăn|ăn uống đầy đủ|ngủ sớm đi'],
      ['study', '📚', 'Học hành', 'học|bài|bài tập|btvn|làm bài|kiểm tra|ktra|thi|thi cử|điểm|môn|toán|lý|hóa|văn|tiếng anh|sinh học|lịch sử|địa lý|gdcd|tin học|cô giáo|thầy|lớp|trường|ôn|ôn thi|đề|đề cương|giữa kỳ|cuối kỳ|học kỳ|học thêm|gia sư|thời khóa biểu|tkb|đại học|thpt|ielts|toeic|học bài|chép bài|vở|giáo viên|nộp bài|thuyết trình|định luật|công thức|câu:0.3|hoc|bai tap|kiem tra'],
      ['work', '💼', 'Công việc', 'làm việc|đi làm|công việc|công ty|sếp|lương|tăng ca|ca làm|họp|dự án|khách|khách hàng|đồng nghiệp|văn phòng|nghỉ phép|phỏng vấn|cv|part time|parttime|làm thêm|chấm công|hợp đồng|báo cáo|task|meeting|thực tập|deadline|kpi|ca sáng|ca tối'],
      ['game', '🎮', 'Game', 'game|chơi game|liên quân|lq|free fire|ff|pubg|valorant|liên minh|lmht|genshin|tốc chiến|rank|leo rank|solo|gánh|gánh team|acc|nạp|skin|tướng|trận|vào game|on game|on|roblox|minecraft|play together|fifa|fo4|đột kích|mobile legends|cày|feed|afk|lag|ping|vô game|đánh rank|rank vàng|rank kim cương|cao thủ'],
      ['food', '🍜', 'Ăn uống', 'ăn:0.4|uống:0.4|đói|thèm|trà sữa|ts:0.5|cơm:0.6|bún|phở|lẩu|nướng|gà rán|bánh mì|bánh|cà phê|trà|nhậu|bia|quán|món|ngon|đồ ăn|ăn vặt|kem|pizza|mì cay|mì|bánh tráng|xiên|ốc|chè|sữa|nấu ăn|nấu|bữa tối|bữa trưa|ăn tối|ăn trưa|đồ uống|matcha|trà chanh|bún bò|bún chả|cơm tấm|hủ tiếu|bánh xèo|đặt đồ ăn|grabfood|shopeefood|buffet'],
      ['ent', '🎬', 'Phim, nhạc, MXH', 'phim|xem phim|netflix|anime|manga|truyện|đọc truyện|nhạc|bài hát|nghe nhạc|playlist|spotify|idol|kpop|bts|blackpink|concert|ca sĩ|rap|show|series|drama|youtube|livestream|stream|tiktok|video|clip|trend|reels|instagram|ins|facebook|fb|story|đăng|follow|meme|mv|vpop|phim ma|tập mới|xem chưa|hay lắm|fyp'],
      ['fun', '😂', 'Tấu hài, cà khịa', 'haha|hihi|hehe|hjhj|kaka|kkk|kk|lmao|vcl|vl|vãi|cười|buồn cười|hài|hài vl|hề|troll|cà khịa|xàm|nhảm|ảo|ảo ma|đùa|giỡn|đùa thôi|trời ơi|ối dồi ôi|chầm zn|chết cười|cười xỉu|gà|ngáo'],
      ['vent', '🥺', 'Tâm sự, buồn vui', 'buồn|mệt|chán|stress|áp lực|khóc|cô đơn|tâm sự|thất tình|tổn thương|lo lắng|sợ|tủi thân|nản|khó chịu|đau lòng|suy|overthinking|trầm cảm|không ổn|huhu|hic|buồn quá|mệt quá|chán quá|tâm trạng'],
      ['fight', '😤', 'Giận dỗi, cãi nhau', 'giận|dỗi|xin lỗi|sorry|sr|ghét|cãi|cãi nhau|im đi|kệ|mặc kệ|chia tay|block|chặn|seen|không thèm|phiền|tức|điên|bực|bực mình|nói dối|lừa|ích kỷ|vô tâm|đủ rồi|hết thương|thôi khỏi|tùy|tuỳ'],
      ['family', '👨‍👩‍👧', 'Gia đình', 'bố|mẹ|ba mẹ|bố mẹ|má|anh trai|chị gái|em gái|em trai|gia đình|họ hàng|chú|bác|cháu|về quê|quê|tết|giỗ|đám cưới|ông bà|ông nội|bà nội|ông ngoại|bà ngoại|dì|con:0.3'],
      ['money', '💸', 'Tiền, mua sắm', 'tiền|mua|bán|shopee|lazada|tiki|ship|giao hàng|giá|bao nhiêu tiền|triệu|nghìn|chuyển khoản|stk|momo|banking|sale|order|đặt hàng|nợ|trả tiền|vay|mượn tiền|tiêu|xài|đắt|rẻ|freeship|voucher|mã giảm giá|hàng|chốt đơn|tiền nhà|lì xì|chuyển tiền|xin tiền|đóng học'],
      ['sport', '⚽', 'Thể thao, gym', 'bóng đá|đá bóng|đá banh|sân bóng|mu|man city|real|barca|messi|ronaldo|cr7|world cup|euro|gym|tập gym|chạy bộ|cầu lông|bóng rổ|bơi|yoga|thể dục|giảm cân|tăng cân|cơ bụng|whey|bóng chuyền|pickleball|tennis|đá phủi|sân cũ'],
      ['pet', '🐶', 'Thú cưng', 'mèo|chó|cún|pet|boss|mèo con|chó con|hamster|thỏ|nuôi|sen|hoàng thượng|meo'],
      ['style', '💄', 'Làm đẹp, thời trang', 'son|makeup|trang điểm|skincare|mụn|tóc|cắt tóc|nhuộm|nail|váy|áo|quần|giày|outfit|mặc:0.5|style|nước hoa|túi|lens|uốn tóc|gội đầu'],
      ['tech', '📱', 'Điện thoại, công nghệ', 'điện thoại|iphone|samsung|ip|laptop|máy tính|pin|sạc|wifi|mạng|4g|app|ứng dụng|cài|update|cập nhật|lỗi|hack|code|chatgpt|ipad|tai nghe|airpods|màn hình'],
    ];
    // tín hiệu ẩn để đoán mối quan hệ
    const FEATS = {
      pet: 'bé ơi|bé yêu|em bé:0.5|baby|bae|honey|cưng|cục cưng|bảo bối|người yêu:0.5|vợ|chồng|vợ ơi|chồng ơi|vợ yêu|chồng yêu|ông xã|bà xã|anh yêu|em yêu|mình ơi|cục vàng|công chúa|hoàng tử|bé:0.4|vk|ck:0.3|yêu ơi|anh yêu ơi|darling|béo ơi',
      love: 'yêu|thương|love|love you|ily|yêu em|yêu anh|thương em|thương anh|yêu cậu|nhớ em|nhớ anh|nhớ cậu|nhớ tớ|nhớ bé|nhớ quá|nhớ ghê|hôn|moah|chụt|muah|ôm|kiss|hun|thơm má|yêu nhiều|thương nhiều',
      flirt: 'thích:0.6|crush|nhớ:0.4|ghen|dễ thương|đáng yêu|cute|xinh|xinh quá|đẹp trai|thính|tán|đổ|cưa|nắm tay|hẹn hò|rảnh không|có nhớ|nhớ không|nghĩ về|mơ thấy|ngại|làm người yêu|quen nhau|tỏ tình|xinh xắn|dễ thương ghê|đi chơi không|đi xem phim không',
      care: TOPICS[2][3],
      sorry: 'xin lỗi|sorry|sr|lỗi tại',
      thanks: 'cảm ơn|cám ơn|thank|thank you',
      swear: 'vl|vcl|vãi|đm|dm|đcm|dcm|vkl|đéo|éo|vc|cc|clm|đmm|loz|cl|đờ mờ|vờ lờ',
      p_taomay: 'tao|mày|tau|bọn tao|chúng mày|tụi mày',
      p_cauto: 'cậu|tớ',
      p_anhem: 'anh|em',
      p_banminh: 'bạn|mình',
      p_toi: 'tôi',
      p_ongba: 'ông|bà|tui|bả|ổng',
      p_fam: 'con:0.25|bố|mẹ|ba:0.3|má:0.6|bố mẹ|ba mẹ|con ăn|con về|mẹ ơi|bố ơi',
      p_formal: 'ạ|dạ|vâng|thưa',
      p_chiem: 'chị',
    };
    const SWEAR = new Set(FEATS.swear.split('|'));
    const LEX = new Map();
    let MAXN = 1;
    const addLex = (id, list) => {
      for (const raw of list.split('|')) {
        const [p, w] = raw.split(':');
        const ph = tokens(p).join(' ');
        if (!ph) continue;
        MAXN = Math.max(MAXN, ph.split(' ').length);
        if (!LEX.has(ph)) LEX.set(ph, []);
        LEX.get(ph).push([id, w ? parseFloat(w) : 1]);
      }
    };
    for (const t of TOPICS) addLex(t[0], t[3]);
    for (const k in FEATS) addLex('f_' + k, FEATS[k]);

    const STOP = new Set(('và là có không của cho thì mà này đó kia với để được cũng nhưng rồi nữa đi ra vào lên xuống một những các cái con ai gì sao vậy thế nha nhé nhá nè á à ạ ơi ừ ờ ok hả hở ha he hi ừm ' +
      'mình bạn tôi tao mày anh em chị cậu tớ ông bà tui đang sẽ đã vẫn còn chưa lại luôn rất quá lắm hơn nhất chỉ cứ khi nếu vì nên thôi đấy đây ấy kìa nhỉ chứ hay hoặc bị trong ngoài trên dưới từ đến tới ' +
      'theo như thấy biết làm muốn nói có thể phải cần nào đâu mấy bao nhiêu thật thực ghê luôn cả mọi người ta họ nó chúng tụi bọn kiểu kia vô ra coi xem lúc giờ thời hôm nay mai qua sau trước rồi ' +
      'được rùi dc ko k vs j z v r e a t m b mk ng thì là cơ chắc vậy à vậy thế à tại vậy mà nhiều ít to nhỏ mới cũ đúng sai thôi ạ dạ vâng ơi nhé the to and you i a of in is it my me u lol').split(' '));
    const DRY = new Set(['ừ', 'ừ ừ', 'ờ', 'ờ ờ', 'ok', 'ok ok', 'à', 'ồ', 'vậy', 'vậy à', 'thế à', 'hmm', 'hm', 'được', 'không', 'có', 'rồi', 'ừ ok', 'ok rồi', 'ơ', 'ừ rồi',
      'ok bạn', 'biết rồi', 'ừ biết rồi', 'kệ', 'tùy', 'tuỳ', 'thì sao', 'sao', 'ok luôn', 'ờ ok', 'à ok', 'ừ vậy', 'vậy hả', 'hả', 'ừ ngủ đây', 'bận', 'bận rồi', 'để xem', 'cảm ơn']);
    const POLITE = new Set(['dạ', 'vâng', 'ạ', 'dà']);
    const Q_END = new Set(['không', 'chưa', 'hả', 'hở', 'à', 'nhỉ', 'sao', 'gì', 'đâu', 'nào', 'chứ', 'hông', 'ta']);
    const LAUGH = /(?:ha){2,}|(?:hi){2,}|(?:he){2,}|hjhj|k{3,}|=\)+|:\)\)+|:v|lmao|\bxd+\b|🤣|😂|😆|😹|cười xỉu/i;
    const EMO = /\p{Extended_Pictographic}/gu;
    const side = m => (m.me ? 0 : 1);
    const dayKey = t => { const d = new Date(t); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };

    function newAcc() {
      return { v: 1, n: [0, 0], ch: [0, 0], q: [0, 0], emo: [0, 0], med: [0, 0], sh: [0, 0], dry: [0, 0], lau: [0, 0], st: [0, 0], mr: [0, 0], rn: [0, 0], ng: [0, 0], ml: [0, 0],
        f: {}, w: {}, e: {}, hr: new Array(24).fill(0), dw: new Array(7).fill(0), dy: {}, ad: 0, bd: 0, bn: 0, t0: 0, t1: 0, ts: 0, run: 0, rs: -1, lt: 0 };
    }
    const bump = (o, k, s, by = 1) => { const a = o[k] || (o[k] = [0, 0]); a[s] += by; };
    function add(acc, m) {
      const s = side(m), text = m.text || '';
      acc.n[s]++;
      if (m.kind === 'media') acc.med[s]++;
      if (m.kind === 'share') acc.sh[s]++;
      // chuỗi nhắn liền tay & người mở lời
      if (acc.rs === s) acc.run++; else { if (acc.rs >= 0) { acc.rn[acc.rs]++; acc.mr[acc.rs] = Math.max(acc.mr[acc.rs], acc.run); } acc.rs = s; acc.run = 1; }
      const first = acc.n[0] + acc.n[1] === 1;
      if (first || (m.t && acc.lt ? m.t - acc.lt >= 3 * 3600e3 : m.gap)) acc.st[s]++;
      if (m.t) {
        acc.lt = m.t; acc.ts++;
        const d = new Date(m.t), h = d.getHours();
        acc.hr[h]++; acc.dw[d.getDay()]++;
        if (h >= 22 || h < 4) acc.ng[s]++;
        const k = dayKey(m.t); acc.dy[k] = (acc.dy[k] || 0) + 1;
        if (!acc.t0 || m.t < acc.t0) acc.t0 = m.t;
        if (m.t > acc.t1) acc.t1 = m.t;
      }
      if (m.kind !== 'text' && m.kind !== 'share') return;
      const len = text.length;
      acc.ch[s] += len; acc.ml[s] = Math.max(acc.ml[s], len);
      const em = text.match(EMO);
      if (em) { acc.emo[s] += em.length; for (const x of em.slice(0, 6)) bump(acc.e, x, s); }
      if (LAUGH.test(text)) acc.lau[s]++;
      if (m.kind === 'share') return; // chú thích video chia sẻ không phải lời của hai người
      const T = tokens(text);
      const whole = T.join(' ');
      if (!T.length) return;
      if (DRY.has(whole) || (T.length === 1 && T[0].length <= 2 && !POLITE.has(T[0]))) acc.dry[s]++;
      if (/\?\s*$/.test(text) || Q_END.has(T[T.length - 1])) acc.q[s]++;
      // từ khoá chủ đề / tín hiệu (tối đa 2 lần mỗi loại / tin)
      const hit = {};
      for (let n = 1; n <= MAXN; n++) {
        for (let i = 0; i + n <= T.length; i++) {
          const L = LEX.get(n === 1 ? T[i] : T.slice(i, i + n).join(' '));
          if (L) for (const [id, w] of L) hit[id] = Math.min(2, (hit[id] || 0) + w);
        }
      }
      for (const id in hit) bump(acc.f, id, s, hit[id]);
      // từ hay dùng (bỏ từ đệm, từ tục)
      let prev = null;
      for (const t of T) {
        const ok = t.length >= 2 && !STOP.has(t) && !SWEAR.has(t) && !/^\d+$/.test(t);
        if (ok) { bump(acc.w, t, s); if (prev) bump(acc.w, prev + ' ' + t, s); }
        prev = ok ? t : null;
      }
    }
    // gom kết quả cuối (đóng chuỗi đang dở, tóm tắt theo ngày)
    function close(acc) {
      if (acc.rs >= 0) { acc.mr[acc.rs] = Math.max(acc.mr[acc.rs], acc.run); acc.rn[acc.rs]++; }
      acc.rs = -1; acc.run = 0;
      const ks = Object.keys(acc.dy);
      if (ks.length) {
        acc.ad += ks.length;
        for (const k of ks) if (acc.dy[k] > acc.bn) { acc.bn = acc.dy[k]; acc.bd = +k; }
      }
      acc.dy = {};
      return acc;
    }
    // cắt gọn để lưu vào máy (giữ từ & emoji phổ biến nhất)
    function compact(acc) {
      const top = (o, n) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1][0] + b[1][1] - a[1][0] - a[1][1]).slice(0, n));
      const c = { ...acc, w: top(acc.w, 260), e: top(acc.e, 40), dy: {} };
      for (const k in c.f) c.f[k] = c.f[k].map(x => Math.round(x * 10) / 10);
      return c;
    }
    async function build(msgs, onTick) {
      const acc = newAcc();
      for (let i = 0; i < msgs.length; i++) {
        add(acc, msgs[i]);
        if (i % 2500 === 2499) { if (onTick) onTick(i / msgs.length); await tick0(); }
      }
      return compact(close(acc));
    }
    // cộng dồn lần trước + phần tin mới (cập nhật nhanh)
    function merge(a, b) {
      if (!a) return b; if (!b) return a;
      const r = newAcc();
      for (const k of ['n', 'ch', 'q', 'emo', 'med', 'sh', 'dry', 'lau', 'st', 'rn', 'ng']) r[k] = [a[k][0] + b[k][0], a[k][1] + b[k][1]];
      for (const k of ['mr', 'ml']) r[k] = [Math.max(a[k][0], b[k][0]), Math.max(a[k][1], b[k][1])];
      for (const k of ['f', 'w', 'e']) { r[k] = JSON.parse(JSON.stringify(a[k] || {})); for (const x in b[k] || {}) { const t = r[k][x] || (r[k][x] = [0, 0]); t[0] += b[k][x][0]; t[1] += b[k][x][1]; } }
      r.hr = a.hr.map((x, i) => x + b.hr[i]); r.dw = a.dw.map((x, i) => x + b.dw[i]);
      r.ts = a.ts + b.ts; r.t0 = Math.min(a.t0 || Infinity, b.t0 || Infinity); if (r.t0 === Infinity) r.t0 = 0; r.t1 = Math.max(a.t1, b.t1);
      r.ad = a.ad + b.ad - (a.t1 && b.t0 && dayKey(a.t1) === dayKey(b.t0) ? 1 : 0);
      if (a.bn >= b.bn) { r.bd = a.bd; r.bn = a.bn; } else { r.bd = b.bd; r.bn = b.bn; }
      return compact(r);
    }

    /* ---------- suy ra kết quả để hiển thị ---------- */
    const sat = (x, k) => 1 - Math.exp(-Math.max(0, x) / k);
    const REL = {
      lover: ['💑', 'Người yêu', 'Gọi nhau ngọt xớt, nhớ nhung, chúc ngủ ngon đều đặn — đích thị một cặp!', ['#FE2C55', '#ff8fab']],
      crush: ['🌫️', 'Mập mờ', 'Quan tâm hơn mức bạn bè, thả thính qua lại nhưng chưa ai chịu nói ra.', ['#8B5CF6', '#f472b6']],
      lop: ['🛞', 'Lốp dự phòng', '', ['#FFC53D', '#ff8a3d']],
      bestie: ['🤜🤛', 'Bạn thân chí cốt', 'Mày–tao, cà khịa, cười như điên — tình bạn bền vững.', ['#25F4EE', '#0ea5e9']],
      friend: ['👫', 'Bạn bè', 'Nói chuyện vui vẻ, thoải mái, đúng chuẩn bạn bè.', ['#34d399', '#25F4EE']],
      family: ['👨‍👩‍👧', 'Người nhà', 'Xưng hô, hỏi han như người trong gia đình.', ['#fb923c', '#FFC53D']],
      work: ['💼', 'Bạn học / đồng nghiệp', 'Chủ yếu bàn chuyện học hành, công việc.', ['#60a5fa', '#8B5CF6']],
      known: ['🤝', 'Người quen xã giao', 'Ít tương tác, giữ khoảng cách lịch sự.', ['#94a3b8', '#64748b']],
    };
    const relMeta = (id, who) => {
      const m = REL[id] || REL.friend;
      if (id !== 'lop') return { emoji: m[0], label: m[1], desc: m[2], grad: m[3] };
      return who === 0
        ? { emoji: '🛞', label: 'Bạn đang làm lốp', desc: 'Bạn nhắn nhiều, hỏi han đủ điều, còn họ trả lời nhạt nhẽo. Cân nhắc nha 😅', grad: m[3] }
        : { emoji: '🛞', label: 'Họ đang làm lốp', desc: 'Họ nhắn nhiều và quan tâm bạn hơn hẳn, còn bạn trả lời khá hờ hững.', grad: m[3] };
    };
    function derive(acc, them) {
      if (!acc || !acc.n) return null;
      them = them || 'Họ';
      const tx = s => Math.max(0, acc.n[s] - acc.med[s] - acc.sh[s]) || acc.n[s];
      const n0 = tx(0), n1 = tx(1), N = Math.max(1, n0 + n1), NS = [Math.max(1, n0), Math.max(1, n1)];
      const F = id => acc.f['f_' + id] || acc.f[id] || [0, 0];
      const tot = id => { const f = F(id); return f[0] + f[1]; };
      const per = (id, s) => { const f = F(id); return s === undefined ? (f[0] + f[1]) / N * 100 : f[s] / NS[s] * 100; };
      const both = id => Math.min(per(id, 0), per(id, 1));
      // chủ đề
      const FT = id => acc.f[id] || [0, 0]; // số đếm của CHỦ ĐỀ (khác tín hiệu f_… cùng tên)
      const tsum = TOPICS.reduce((a, t) => a + FT(t[0])[0] + FT(t[0])[1], 0);
      const topics = TOPICS.map(t => { const f = FT(t[0]); return { id: t[0], icon: t[1], name: t[2], me: f[0], them: f[1], n: f[0] + f[1], pct: tsum ? (f[0] + f[1]) / tsum : 0 }; })
        .filter(t => t.n >= 1).sort((a, b) => b.n - a.n);
      const share = id => { const t = topics.find(x => x.id === id); return t ? t.pct : 0; };
      // từ khoá: ưu tiên cụm 2 từ, bỏ từ đơn đã nằm trong cụm
      const ws = Object.entries(acc.w).map(([w, a]) => ({ w, me: a[0], them: a[1], n: a[0] + a[1], s: (a[0] + a[1]) * (w.includes(' ') ? 1.7 : 1) }))
        .filter(x => x.n >= (N > 200 ? 3 : 2)).sort((a, b) => b.s - a.s);
      const words = [];
      for (const x of ws) {
        if (words.length >= 18) break;
        if (!x.w.includes(' ') && words.some(y => y.w.includes(' ') && y.w.split(' ').includes(x.w) && y.n >= x.n * 0.6)) continue;
        if (x.w.includes(' ') && words.some(y => y.w.includes(' ') && y.w.split(' ').some(p => x.w.split(' ').includes(p)) && x.n >= y.n * 0.75)) continue;
        if (x.w.includes(' ')) { const parts = x.w.split(' '); for (let i = words.length - 1; i >= 0; i--) if (!words[i].w.includes(' ') && parts.includes(words[i].w) && x.n >= words[i].n * 0.6) words.splice(i, 1); }
        words.push(x);
      }
      const emojis = Object.entries(acc.e).map(([e, a]) => ({ e, me: a[0], them: a[1], n: a[0] + a[1] })).sort((a, b) => b.n - a.n).slice(0, 10);
      const catchOf = s => { const c = ws.filter(x => (s ? x.them : x.me) >= 4 && (s ? x.them : x.me) / x.n >= 0.68).sort((a, b) => (s ? b.them - a.them : b.me - a.me))[0]; return c ? c.w : null; };

      // mối quan hệ
      const bal = Math.min(n0, n1) / Math.max(1, Math.max(n0, n1));
      const share0 = n0 / N;
      const dry0 = acc.dry[0] / Math.max(1, n0), dry1 = acc.dry[1] / Math.max(1, n1);
      const len0 = acc.ch[0] / Math.max(1, n0), len1 = acc.ch[1] / Math.max(1, n1);
      const inv = share0 >= 0.5 ? 0 : 1, oth = 1 - inv;
      const imb = (Math.max(0, Math.abs(share0 - 0.5) - 0.08) / 0.42) * sat(N, 80);
      const dryGap = Math.max(0, (inv ? dry0 : dry1) - (inv ? dry1 : dry0));
      const lenR = Math.max(1, inv ? len1 : len0) / Math.max(1, inv ? len0 : len1);
      const warm = s => per('love', s) + per('care', s) + per('flirt', s) * 0.6;
      const oneSided = sat(warm(inv) - warm(oth) * 1.5, 3);
      const hasTs = acc.ts > N * 0.3;
      const night = hasTs ? (acc.ng[0] + acc.ng[1]) / Math.max(1, acc.ts) : 0;
      const lau = (acc.lau[0] + acc.lau[1]) / N * 100;
      const informal = per('p_taomay') + per('p_ongba') * 0.6;
      const fam = per('p_fam') + per('p_formal') * 0.5;
      const S = {
        lover: 2.4 * sat(both('pet'), 0.8) + 1.6 * sat(both('love'), 1.2) + 0.9 * sat(both('care'), 3) + 0.6 * sat(night, 0.25) + 0.4 * bal - 1.0 * sat(informal, 4) - 1.4 * sat(fam, 6)
          - 1.0 * imb - 1.4 * sat(dryGap, 0.25) - 1.0 * oneSided,
        crush: 1.1 * sat(both('flirt'), 1.5) + 0.5 * sat(per('flirt'), 3) + 0.8 * sat(both('care'), 3) + 0.6 * sat(per('p_anhem') + per('p_cauto'), 8) + 0.5 * sat(per('love'), 1.5) + 0.5 * sat(night, 0.25) + 0.5 * bal
          - 1.5 * sat(both('pet'), 0.8) - 0.9 * sat(informal, 4) - 1.2 * sat(fam, 6) - 1.2 * imb - 1.4 * sat(dryGap, 0.25) - 0.8 * oneSided,
        lop: 1.8 * imb + 1.6 * sat(dryGap, 0.2) + 0.5 * sat(Math.log2(lenR), 1) + 1.4 * oneSided - 0.9,
        bestie: 1.5 * sat(informal, 3) + 1.0 * sat(per('swear'), 2) + 0.8 * sat(lau, 10) + 0.5 * sat(share('game') + share('fun'), 0.3) + 0.4 * bal + 0.3 * sat(N, 1500)
          - 1.4 * sat(both('pet'), 0.8) - 0.6 * sat(both('love'), 1.5) - 0.6 * imb,
        friend: 0.9 + 0.5 * sat(per('p_cauto') + per('p_banminh'), 5) + 0.4 * sat(lau, 6) + 0.4 * sat(share('study') + share('ent') + share('game') + share('food'), 0.4) + 0.3 * bal
          - 1.0 * sat(both('love'), 1.2) - 0.8 * sat(both('pet'), 0.8) - 0.5 * sat(per('flirt'), 3) - 0.5 * imb,
        family: 2.6 * sat(fam, 5) + 0.8 * sat(share('family'), 0.25) - 0.8 * sat(per('flirt'), 3) - 0.6 * sat(informal, 4),
        work: 2.0 * sat(share('work') + share('study') * 0.8, 0.35) + 0.4 * sat(per('p_banminh') + per('p_toi'), 4) + 0.3 * sat(per('thanks'), 2) - 0.7 * sat(lau, 6) - 0.8 * sat(per('love'), 1.5) - 0.4 * sat(per('p_taomay'), 3),
        known: 1.8 * (1 - sat(N, 60)) + 0.5 * sat(per('thanks'), 3) + 0.3 * sat(per('p_toi') + per('p_banminh'), 4) - 0.6 * sat(lau, 6) - 0.6 * sat(per('love'), 1.5),
      };
      const ex = Object.entries(S).map(([k, v]) => [k, Math.exp(v * 1.5)]);
      const Z = ex.reduce((a, x) => a + x[1], 0);
      const probs = ex.map(([k, v]) => ({ id: k, p: v / Z, ...relMeta(k, inv) })).sort((a, b) => b.p - a.p);
      const best = probs[0];
      // lý do
      const R = [];
      const add2 = (txt, tags, w) => R.push({ txt, tags, w });
      const fmt1 = x => fmt(Math.round(x));
      if (tot('pet') >= 2) add2(`Gọi nhau “vợ/chồng/bé/baby…” ${fmt1(tot('pet'))} lần`, ['lover', 'crush'], 9);
      if (tot('love') >= 2) add2(`Nói yêu / thương / nhớ ${fmt1(tot('love'))} lần (bạn ${fmt1(F('love')[0])} · ${them} ${fmt1(F('love')[1])})`, ['lover', 'crush', 'lop'], 8);
      if (tot('care') >= 3) add2(`Hỏi han, chúc ngủ ngon ${fmt1(tot('care'))} lần`, ['lover', 'crush', 'lop', 'family'], 7);
      if (tot('flirt') >= 3) add2(`Thả thính, khen nhau ${fmt1(tot('flirt'))} lần`, ['crush', 'lover', 'lop'], 6);
      const prons = [['p_taomay', 'mày – tao'], ['p_cauto', 'cậu – tớ'], ['p_anhem', 'anh – em'], ['p_banminh', 'bạn – mình'], ['p_ongba', 'ông – bà – tui'], ['p_fam', 'bố mẹ – con'], ['p_toi', 'tôi – bạn'], ['p_chiem', 'chị – em']]
        .map(([id, l]) => [id, l, tot(id)]).sort((a, b) => b[2] - a[2]);
      if (prons[0][2] >= 3) add2(`Xưng hô chủ yếu: ${prons[0][1]}`, ['bestie', 'friend', 'crush', 'lover', 'family', 'work'], 6);
      const ratio = Math.max(n0, n1) / Math.max(1, Math.min(n0, n1));
      if (ratio >= 1.35) add2(`${inv === 0 ? 'Bạn' : them} nhắn gấp ${ratio.toLocaleString('vi-VN', { maximumFractionDigits: 1 })} lần ${inv === 0 ? them : 'bạn'}`, ['lop'], 9);
      else add2('Hai bên nhắn qua lại khá đều', ['lover', 'crush', 'bestie', 'friend'], 3);
      const dryO = inv === 0 ? dry1 : dry0;
      if (dryO >= 0.12) add2(`${inv === 0 ? them : 'Bạn'} trả lời cụt lủn (ừ, ok, k…) ${Math.round(dryO * 100)}% số tin`, ['lop', 'known'], 8);
      if (night >= 0.12) add2(`${Math.round(night * 100)}% tin nhắn lúc đêm khuya (22h–4h)`, ['lover', 'crush'], 5);
      if (lau >= 6) add2(`Cười haha, =)) ${fmt(acc.lau[0] + acc.lau[1])} lần`, ['bestie', 'friend'], 5);
      if (per('swear') >= 0.8) add2('Nói chuyện “mặn”, văng tục kiểu bạn thân', ['bestie'], 6);
      if (topics.length) add2(`Hay nói về ${topics.slice(0, 2).map(t => t.name.toLowerCase()).join(', ')}`, ['work', 'family', 'friend', 'bestie', 'known'], 4);
      if (N < 60) add2(`Mới có ${fmt(N)} tin nên máy đoán còn hơi non`, ['known'], 5);
      const reasons = R.sort((a, b) => (b.tags.includes(best.id) ? 10 : 0) + b.w - (a.tags.includes(best.id) ? 10 : 0) - a.w).slice(0, 5).map(x => x.txt);
      const st0 = acc.st[0], st1 = acc.st[1];
      const gauges = {
        close: Math.round(100 * clamp(0.3 * sat(N, 900) + 0.2 * sat(lau, 8) + 0.2 * sat(informal + per('p_cauto') + per('pet') * 2, 4) + 0.2 * sat(per('care'), 4) + 0.1 * sat((acc.emo[0] + acc.emo[1]) / N * 100, 15), 0, 1)),
        romance: Math.round(100 * clamp(0.35 * sat(both('pet'), 0.8) + 0.3 * sat(per('love'), 1.5) + 0.2 * sat(per('flirt'), 2.5) + 0.15 * sat(night, 0.25) - 0.3 * sat(fam, 6), 0, 1)),
        balance: Math.round(100 * clamp(bal * (1 - Math.min(1, dryGap * 1.5)), 0, 1)),
        init: st0 + st1 >= 4 ? Math.round((st0 / (st0 + st1)) * 100) : Math.round(share0 * 100),
      };
      // thói quen
      const hrSum = acc.hr.reduce((a, b) => a + b, 0);
      const peak = hrSum ? acc.hr.indexOf(Math.max(...acc.hr)) : -1;
      const habits = {
        hasTs, hr: acc.hr, dw: acc.dw, peak, night, first: acc.t0, last: acc.t1, active: acc.ad, busiest: acc.bn ? { d: acc.bd, n: acc.bn } : null,
        perDay: acc.ad ? N / acc.ad : 0, len: [len0, len1], q: [acc.q[0], acc.q[1]], dry: [dry0, dry1], run: acc.mr, st: [st0, st1], lau: acc.lau, emo: acc.emo, ml: acc.ml,
        sh: acc.sh, med: acc.med,
      };
      return { N, topics: topics.slice(0, 8), words, emojis, catch: [catchOf(0), catchOf(1)], rel: { ...best, conf: Math.min(0.96, best.p * (N < 60 ? 0.75 : 1)), probs, reasons, gauges, who: inv }, habits };
    }
    return { build, merge, derive, relMeta, TOPICS };
  })();

  /* ═══════════════════════ CHẨN ĐOÁN ═══════════════════════ */

  function diagnose() {
    const L = [];
    L.push(`Ô nhập tin nhắn: ${findInput() ? '✓' : '✗ không thấy (chưa mở cuộc trò chuyện?)'}`);
    const sc = findScroller();
    if (sc) {
      const r = rectOf(sc), st = scrollTarget(sc);
      L.push(`Khung tin nhắn: ✓ ${Math.round(r.width)}×${Math.round(r.height)}${manualSc === sc ? ' (chọn tay)' : ''}${isRev(sc) ? ' · đảo ngược' : ''}`);
      L.push(`Vùng cuộn: ${st === sc ? 'chính khung' : isDocEl(st) ? 'cả trang' : sc.contains(st) ? 'vùng con bên trong' : 'khung bên ngoài'} · ${canScroll(st) ? 'cuộn được' : 'chưa cần cuộn'}${flippedY(st) ? ' · bị lật' : ''}`);
      const a = analyze(sc);
      L.push(`Tin đang hiển thị: ${a.total} (bạn ${a.me} · họ ${a.them}) · bỏ qua ${a.skipped}`);
      L.push(`Cách nhận diện tin: ${a.method === 'selector' ? 'selector ' + a.selector : 'tự động theo cấu trúc'}`);
      L.push(`Tên đang mở: ${findTitle(sc) || '—'} · avatar người kia: ${chatAvatar(sc) ? '✓' : '—'}`);
    } else L.push('Khung tin nhắn: ✗ chưa mở cuộc trò chuyện nào');
    const items = scanItems(sc);
    const act = items.find(x => x.active);
    L.push(`Danh sách người: ${items.length} (${items.filter(x => x.name).length} biết tên${act ? ' · đang sáng: ' + (act.name || '?') : ''})`);
    L.push(`Tốc độ: ${SPEEDS[CFG.speed].label} · phân tích nội dung: ${CFG.analyze ? 'bật' : 'tắt'}`);
    L.push(`Phiên bản ${VERSION}`);
    return L.join('\n');
  }
  // báo cáo cấu trúc trang để gửi người sửa script (không chứa nội dung tin nhắn)
  function buildReport() {
    const desc = e => {
      const de = e.getAttribute('data-e2e');
      const cls = (typeof e.className === 'string' ? e.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
        .map(c => (c.length > 30 ? c.slice(0, 30) + '…' : c)).join('.');
      return e.tagName.toLowerCase() + (de ? `[e2e=${de}]` : '') + (cls ? '.' + cls : '');
    };
    const path = el => { const p = []; for (let e = el, i = 0; e && e !== document.body && i < 5; e = e.parentElement, i++) p.unshift(desc(e)); return p.join(' > '); };
    const box = el => { const r = rectOf(el); return `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`; };
    const outline = (el, depth, out, ind, max) => {
      if (out.length >= max) return;
      const cs = getComputedStyle(el);
      const t = [...el.childNodes].filter(n => n.nodeType === 3 && n.nodeValue.trim()).reduce((a, n) => a + n.nodeValue.trim().length, 0);
      const br = parseInt(cs.borderTopLeftRadius, 10) || 0;
      out.push(`${ind}${desc(el)} ${box(el)}${alpha(cs.backgroundColor) > 0.08 ? ' bg' : ''}${/gradient/.test(cs.backgroundImage) ? ' grad' : ''}${br ? ' r' + br : ''}${t ? ' T' + t : ''}${el.hasAttribute(MARK) ? ' [' + el.getAttribute(MARK) + ']' : ''}`);
      if (depth <= 0) return;
      let i = 0;
      for (const ch of el.children) { if (i++ >= 5) { out.push(ind + '  …(' + el.children.length + ')'); break; } outline(ch, depth - 1, out, ind + '  ', max); }
    };
    const L = [];
    L.push(`DMC ${VERSION} · ${location.pathname.replace(/\/@[^/]+/, '/@…')} · ${innerWidth}x${innerHeight} · ${/iPhone|iPad|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document ? 'iOS' : 'other'}`);
    const inp = findInput();
    L.push('INPUT: ' + (inp ? `${path(inp)} ${box(inp)}` : 'none'));
    const sc = findScroller();
    if (sc) {
      const cs = getComputedStyle(sc), st = scrollTarget(sc);
      L.push(`SC: ${path(sc)} ${box(sc)} oy=${cs.overflowY} fd=${cs.flexDirection} tf=${cs.transform} sh=${sc.scrollHeight} ch=${sc.clientHeight} top=${Math.round(sc.scrollTop)} kids=${sc.children.length}`);
      L.push(`ST: ${st === sc ? 'same' : path(st)} sh=${st.scrollHeight} ch=${st.clientHeight} top=${Math.round(st.scrollTop)} flip=${flippedY(st)} last=${S.lastScroll || '-'}`);
      const a = analyze(sc);
      L.push(`ROWS: ${a.method}${a.selector ? ' ' + a.selector : ''} total=${a.total} me=${a.me} them=${a.them} skip=${a.skipped}`);
      L.push(`TITLE: "${findTitle(sc)}" NAME: "${chatName(sc)}" HAV: ${headerAvatar(sc) ? 'ok' : 'none'} SIDEAV: ${sideAvatars(sc, 40).size}`);
      const R0 = rectOf(sc), hc = [];
      for (let a = sc.parentElement, l = 0; a && l < 4; a = a.parentElement, l++) {
        const tw = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
        for (let n; (n = tw.nextNode()) && hc.length < 12;) { const v = n.nodeValue.trim(), el = n.parentElement; if (!v || !el || sc.contains(el) || ours(el)) continue; const r = rectOf(el); if (!r.width || r.bottom > R0.top + 6 || r.top < R0.top - 200) continue; const k = `${v.slice(0, 24)}@${Math.round(r.left)},${Math.round(r.top)}/${getComputedStyle(el).fontSize}`; if (!hc.includes(k)) hc.push(k); }
      }
      L.push('HEAD: ' + hc.join(' | '));
      const fi = findInput(); L.push(`FILE-INPUT: ${fi ? qsa(document, 'input[type="file"]').map(x => (x.accept || '*') + (ours(x) ? '(dmc)' : '')).join(',') : '-'} SEND: ${fi ? (() => { const b = findSendBtn(fi); return b ? desc(b) + ' ' + box(b) : 'none'; })() : '-'}`);
    } else L.push('SC: none');
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, skipFilter);
    let ns = 0;
    for (let el = tw.nextNode(); el && ns < 8; el = tw.nextNode()) {
      const r = rectOf(el);
      if (r.width >= 120 && r.height >= 100 && el.scrollHeight > el.clientHeight + 4 && scrollable(el)) { const c = chatLike(el); L.push(`  scroll: ${path(el)} ${box(el)} L${c.L}/R${c.R}`); ns++; }
    }
    const cl = findConvList(sc);
    const its = scanItems(sc);
    L.push(`LIST: ${cl.method} n=${cl.items.length} named=${cl.named} active=${its.findIndex(x => x.active)}${cl.items[0] ? ' parent=' + path(cl.items[0].parentElement) : ''}`);
    const e2e = new Set();
    for (const e of document.querySelectorAll('[data-e2e]')) { if (e2e.size >= 90) break; if (!ours(e)) e2e.add(e.getAttribute('data-e2e')); }
    L.push('E2E: ' + [...e2e].join(','));
    const labels = new Set();
    for (const e of document.querySelectorAll('[class*="css-"]')) {
      if (labels.size >= 90) break;
      const m = (typeof e.className === 'string' ? e.className : '').match(/css-[a-z0-9]+-([A-Za-z]+)/);
      if (m && /chat|message|conversation|inbox|im[A-Z]|dm/i.test(m[1])) labels.add(m[1]);
    }
    L.push('LABELS: ' + [...labels].join(','));
    if (sc) { const o = []; outline(sc, 7, o, '', 70); L.push('OUTLINE SC:'); L.push(...o); }
    if (cl.items[0]) { const o = []; outline(cl.items[0], 5, o, '', 25); L.push('OUTLINE ITEM:'); L.push(...o); }
    return L.join('\n');
  }

  /* ═══════════════════════ GIAO DIỆN ═══════════════════════ */

  const I = {
    logo: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 6.2A3.2 3.2 0 0 1 7.2 3h9.6A3.2 3.2 0 0 1 20 6.2v6.9a3.2 3.2 0 0 1-3.2 3.2H11l-4.3 3.6c-.6.5-1.5.1-1.5-.7v-2.9A3.2 3.2 0 0 1 4 13.1z" fill="#fff"/><path d="M8.6 12.2V9.8M12 12.2V7.6M15.4 12.2v-1.4" stroke="#0b0b10" stroke-width="2.1" stroke-linecap="round"/></svg>',
    close: '<svg width="16" height="16" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    refresh: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    trophy: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    gear: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3.9a7.5 7.5 0 0 0-2.6-1.5L14 2.6h-4l-.4 2.4A7.5 7.5 0 0 0 7 6.5l-2.3-.9-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-.9a7.5 7.5 0 0 0 2.6 1.5l.4 2.4h4l.4-2.4a7.5 7.5 0 0 0 2.6-1.5l2.3.9 2-3.4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    chat: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V16h-.5A2.5 2.5 0 0 1 4 13.5z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    search: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="2.2"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="#0b0b10" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    up: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 19V5M6 11l6-6 6 6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bolt: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M13 2L4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg>',
    back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    share: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 15V3M7.5 7.5L12 3l4.5 4.5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="8" y="8" width="12" height="12" rx="3" stroke="currentColor" stroke-width="2.2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="2.2"/></svg>',
    bubbles: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h7A2.5 2.5 0 0 1 15 6.5v4a2.5 2.5 0 0 1-2.5 2.5H9l-3 2.5V13h-.5A2.5 2.5 0 0 1 3 10.5z" fill="#25F4EE"/><path d="M10 15.5A2.5 2.5 0 0 0 12.5 18H16l3 2.5V18h.5a2.5 2.5 0 0 0 2.5-2.5v-4A2.5 2.5 0 0 0 19.5 9H17v1.5A4.5 4.5 0 0 1 12.5 15H10z" fill="#FE2C55"/></svg>',
  };

  const CSS = `
  :host{all:initial;--c:#25F4EE;--p:#FE2C55;--v:#8B5CF6;--y:#FFC53D;--g:#2BD67B;--glass:rgba(14,14,20,.82);--line:rgba(255,255,255,.09);--card:rgba(255,255,255,.055);
    --txt:#F5F5F7;--mut:#9A9AA6;--ease:cubic-bezier(.2,.9,.25,1);--spring:cubic-bezier(.2,1.25,.35,1)}
  *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-tap-highlight-color:transparent;-webkit-font-smoothing:antialiased}
  button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;-webkit-user-select:none;user-select:none;touch-action:manipulation}
  [hidden]{display:none!important}
  svg{display:block;flex:none}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes pop{0%{transform:scale(.4);opacity:0}100%{transform:none;opacity:1}}
  @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  @keyframes float{0%{transform:translate(0,0) scale(1)}100%{transform:translate(36px,26px) scale(1.18)}}
  @keyframes shine{0%,45%{transform:translateX(-120%)}100%{transform:translateX(120%)}}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(43,214,123,.55)}100%{box-shadow:0 0 0 7px rgba(43,214,123,0)}}
  @keyframes drop{from{transform:translate(-50%,-140%)}to{transform:translate(-50%,0)}}
  @keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
  @keyframes grow{from{transform:scaleY(0)}to{transform:none}}

  .av{position:relative;width:44px;height:44px;border-radius:50%;flex:none;display:grid;place-items:center;overflow:hidden;font-weight:800;font-size:17px;color:#fff;
    background:linear-gradient(135deg,#3a3a46,#24242c)}
  .av img{width:100%;height:100%;object-fit:cover;display:block}

  /* nút nổi */
  .fab{position:fixed;right:18px;bottom:calc(18px + env(safe-area-inset-bottom));width:58px;height:58px;border-radius:50%;display:grid;place-items:center;touch-action:none;
    background:#0c0c11;box-shadow:0 14px 34px rgba(0,0,0,.55);animation:pop .6s var(--spring) both}
  .fab::before{content:"";position:absolute;inset:-3px;border-radius:50%;padding:3px;background:conic-gradient(var(--c),var(--v),var(--p),var(--c));
    -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:spin 5s linear infinite}
  .fab::after{content:"";position:absolute;inset:6px;border-radius:50%;background:radial-gradient(circle at 30% 25%,rgba(37,244,238,.35),transparent 55%),radial-gradient(circle at 75% 80%,rgba(254,44,85,.35),transparent 55%)}
  .fab svg{position:relative;z-index:1}

  /* bảng chính */
  .scrim{position:fixed;inset:0;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .35s}
  .scrim.on{opacity:1;pointer-events:auto}
  .sheet{position:fixed;left:0;right:0;bottom:0;max-height:92vh;max-height:92dvh;display:flex;flex-direction:column;color:var(--txt);
    background:var(--glass);-webkit-backdrop-filter:blur(30px) saturate(180%);backdrop-filter:blur(30px) saturate(180%);
    border-radius:30px 30px 0 0;border:1px solid var(--line);border-bottom:0;box-shadow:0 -24px 70px rgba(0,0,0,.6);overflow:hidden;
    transform:translateY(105%);transition:transform .55s var(--spring);padding-bottom:env(safe-area-inset-bottom)}
  .sheet.on{transform:none}
  .sheet.drag{transition:none}
  .sheet.wide{left:auto;right:16px;top:16px;bottom:16px;width:420px;max-height:none;border-radius:30px;border-bottom:1px solid var(--line);transform:translateX(calc(100% + 40px))}
  .sheet.wide.on{transform:none}
  .aurora{position:absolute;inset:0 0 auto 0;height:230px;pointer-events:none;overflow:hidden;-webkit-mask:linear-gradient(#000 35%,transparent);mask:linear-gradient(#000 35%,transparent)}
  .aurora i{position:absolute;width:250px;height:250px;border-radius:50%;filter:blur(55px);opacity:.5;animation:float 11s ease-in-out infinite alternate}
  .aurora .b1{background:var(--c);left:-70px;top:-130px}
  .aurora .b2{background:var(--p);right:-70px;top:-120px;animation-delay:-4s}
  .aurora .b3{background:var(--v);left:30%;top:-170px;animation-delay:-8s}
  .grab{position:relative;width:40px;height:5px;border-radius:99px;background:rgba(255,255,255,.25);margin:9px auto 0;flex:none}
  .top{position:relative;flex:none;display:flex;align-items:center;gap:12px;padding:12px 16px 10px;touch-action:none}
  .logo{width:42px;height:42px;border-radius:14px;display:grid;place-items:center;flex:none;background:linear-gradient(135deg,var(--c),var(--v) 55%,var(--p));box-shadow:0 10px 26px rgba(139,92,246,.4)}
  .brand{min-width:0}
  .brand b{display:block;font-size:19px;font-weight:850;letter-spacing:-.5px}
  .brand small{display:block;font-size:12px;color:var(--mut);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .acts{margin-left:auto;display:flex;gap:8px}
  .ib{width:38px;height:38px;border-radius:13px;display:grid;place-items:center;background:rgba(255,255,255,.09);color:#e2e2ea}
  .ib:active{transform:scale(.92)}

  /* menu chính dạng tab */
  .seg{position:relative;flex:none;display:grid;grid-template-columns:repeat(4,1fr);margin:0 16px 10px;padding:4px;border-radius:16px;background:rgba(255,255,255,.07);border:1px solid var(--line)}
  .seg button{position:relative;z-index:1;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;gap:7px;font-size:13.5px;font-weight:750;color:#b9b9c4;transition:color .25s}
  .seg button.on{color:#fff}
  .seg .pill{position:absolute;z-index:0;top:4px;bottom:4px;left:4px;width:calc((100% - 8px)/4);border-radius:12px;
    background:linear-gradient(120deg,rgba(37,244,238,.22),rgba(139,92,246,.22),rgba(254,44,85,.22));border:1px solid rgba(255,255,255,.14);transition:transform .45s var(--spring)}
  .body{position:relative;flex:1 1 auto;min-height:0;overflow-y:auto;padding:2px 16px 18px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}

  .hero{position:relative;padding:14px;border-radius:24px;overflow:hidden;isolation:isolate;
    background:linear-gradient(135deg,rgba(37,244,238,.13),rgba(139,92,246,.10) 50%,rgba(254,44,85,.13));border:1px solid rgba(255,255,255,.11)}
  .hrow{display:flex;align-items:center;gap:14px}
  .ring{position:relative;width:60px;height:60px;flex:none;display:grid;place-items:center}
  .ring::before{content:"";position:absolute;inset:0;border-radius:50%;padding:2.5px;background:conic-gradient(var(--c),var(--v),var(--p),var(--c));
    -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:spin 6s linear infinite}
  .ring .av{width:50px;height:50px}
  .hero.empty .ring::before{opacity:.35}
  .hero.empty .ring .av{background:rgba(255,255,255,.06);animation:bob 2.6s ease-in-out infinite}
  .hm{flex:1;min-width:0}
  .live{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:850;letter-spacing:.8px;text-transform:uppercase;color:var(--g)}
  .live i{width:7px;height:7px;border-radius:50%;background:var(--g);animation:pulse 1.8s infinite}
  .hero.empty .live{color:var(--y)}
  .hero.empty .live i{background:var(--y);animation:none}
  .hn{font-size:18px;font-weight:800;letter-spacing:-.4px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hs{font-size:12.5px;color:#b9b9c4;margin-top:2px;line-height:1.35}
  .hb{display:flex;gap:8px;margin-top:12px}
  .hb button{flex:1;height:44px;border-radius:14px;font-weight:850;font-size:14px;display:flex;align-items:center;justify-content:center;gap:6px}
  .hgo{background:#fff;color:#0b0b10;box-shadow:0 8px 20px rgba(255,255,255,.12)}
  .hq{background:linear-gradient(100deg,rgba(255,197,61,.25),rgba(254,44,85,.25));border:1px solid rgba(255,197,61,.45);color:#FFE08A}
  .hb button:active{transform:scale(.96)}
  .hlast{display:flex;align-items:center;gap:8px;margin-top:10px;padding:9px 10px 9px 12px;border-radius:14px;background:rgba(0,0,0,.25);font-size:12.5px;color:#d6d6de}
  .hlast span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hlast button{flex:none;height:28px;padding:0 10px;border-radius:9px;background:rgba(255,255,255,.12);font-size:12px;font-weight:750}

  .search{display:flex;align-items:center;gap:10px;height:46px;margin:14px 0 4px;padding:0 14px;border-radius:16px;background:rgba(255,255,255,.075);border:1px solid transparent;color:var(--mut);transition:border-color .2s}
  .search:focus-within{border-color:rgba(37,244,238,.55)}
  .search input{flex:1;min-width:0;background:none;border:0;outline:none;color:#fff;font-size:16px;font-family:inherit}
  .search input::placeholder{color:#7d7d89}
  .filt{display:flex;gap:6px;margin-top:12px;overflow-x:auto;scrollbar-width:none}
  .filt::-webkit-scrollbar{display:none}
  .filt button{flex:none;height:32px;padding:0 13px;border-radius:99px;font-size:12.5px;font-weight:750;color:#c9c9d3;background:rgba(255,255,255,.06);border:1px solid var(--line)}
  .filt button.on{color:#0b0b10;background:#fff;border-color:#fff}
  .rh{display:flex;align-items:center;justify-content:space-between;margin:14px 2px 8px}
  .rh>span{font-size:12px;font-weight:850;letter-spacing:.9px;text-transform:uppercase;color:#8a8a97}
  .rh div{display:flex;gap:4px}
  .lnk{font-size:13px;font-weight:750;color:var(--c);padding:6px 9px;border-radius:10px;display:flex;align-items:center;gap:5px}
  .lnk:active{background:rgba(37,244,238,.1)}
  .people{display:flex;flex-direction:column;gap:7px}
  .pr{display:flex;align-items:center;gap:12px;width:100%;min-height:64px;padding:9px 12px;border-radius:19px;text-align:left;background:var(--card);border:1px solid var(--line);
    transition:transform .2s var(--ease),background .25s,border-color .25s}
  .people.anim .pr{animation:rise .5s var(--ease) both}
  .pr:active{transform:scale(.98)}
  .pr.sel{background:linear-gradient(90deg,rgba(37,244,238,.15),rgba(254,44,85,.11));border-color:rgba(37,244,238,.6)}
  .pm{flex:1;min-width:0}
  .pn{display:flex;align-items:center;gap:7px;min-width:0;font-size:15.5px;font-weight:700;letter-spacing:-.2px}
  .pn .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tag{flex:none;font-size:10px;font-weight:850;color:#062b17;background:var(--g);border-radius:99px;padding:2px 7px;letter-spacing:.2px}
  .rtag{flex:none;font-size:11px;font-weight:750;color:#fff;background:rgba(255,255,255,.1);border-radius:99px;padding:2px 7px}
  .ps{font-size:12.5px;color:var(--mut);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ps b{color:#e6e6ee;font-weight:700}
  .ck{width:26px;height:26px;border-radius:50%;border:2px solid rgba(255,255,255,.22);display:grid;place-items:center;flex:none;transition:all .25s var(--spring)}
  .ck svg{opacity:0;transform:scale(.4);transition:all .25s var(--spring)}
  .pr.sel .ck{border-color:transparent;background:linear-gradient(135deg,var(--c),var(--p));transform:scale(1.06)}
  .pr.sel .ck svg{opacity:1;transform:none}
  .empty{font-size:13px;color:var(--mut);line-height:1.55;padding:18px 14px;border:1px dashed rgba(255,255,255,.14);border-radius:18px;text-align:center}

  .cta{position:relative;flex:none;padding:10px 16px 14px;border-top:1px solid var(--line)}
  .mode{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:9px}
  .mode button{height:34px;border-radius:11px;font-size:12.5px;font-weight:750;color:#c9c9d3;background:rgba(255,255,255,.06);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;gap:5px}
  .mode button.on{color:#FFE08A;border-color:rgba(255,197,61,.5);background:rgba(255,197,61,.12)}
  .mode button.on[data-m="full"]{color:#bff9f7;border-color:rgba(37,244,238,.5);background:rgba(37,244,238,.1)}
  .go{position:relative;width:100%;height:56px;border-radius:19px;overflow:hidden;font-size:16.5px;font-weight:850;color:#fff;letter-spacing:-.2px;padding:0 18px;
    background:linear-gradient(100deg,#FE2C55,#ff4d7d 45%,#8B5CF6);box-shadow:0 14px 32px rgba(254,44,85,.38),inset 0 1px 0 rgba(255,255,255,.28);
    display:flex;align-items:center;justify-content:center;gap:10px;transition:transform .2s var(--ease),filter .2s}
  .go:active{transform:scale(.97)}
  .go .sh{position:absolute;inset:0;background:linear-gradient(105deg,transparent 35%,rgba(255,255,255,.38) 50%,transparent 65%);animation:shine 2.6s ease-in-out infinite}
  .go:disabled{background:#25252c;box-shadow:none;color:#6e6e79}
  .go:disabled .sh{display:none}
  .go span{position:relative;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .go svg{position:relative}
  .hint{font-size:11.5px;color:var(--mut);text-align:center;margin-top:8px}

  .back{display:inline-flex;align-items:center;gap:4px;font-size:14px;font-weight:700;color:#d6d6de;padding:6px 10px 6px 4px;border-radius:11px;margin:0 0 8px -4px}
  h3.ttl{font-size:24px;font-weight:850;letter-spacing:-.6px}
  p.sub{font-size:13px;color:var(--mut);margin-top:3px}

  /* tab kết quả */
  .tabs{position:sticky;top:-2px;z-index:3;display:flex;gap:4px;margin:0 -16px 12px;padding:6px 16px 8px;overflow-x:auto;scrollbar-width:none;
    background:linear-gradient(rgba(14,14,20,.96),rgba(14,14,20,.85));-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}
  .tabs::-webkit-scrollbar{display:none}
  .tabs button{flex:none;height:34px;padding:0 14px;border-radius:99px;font-size:13px;font-weight:800;color:#b5b5c0;background:rgba(255,255,255,.06)}
  .tabs button.on{color:#0b0b10;background:linear-gradient(100deg,var(--c),#a5f3fc)}

  /* thẻ kết quả */
  .wrap{position:relative;border-radius:30px;padding:20px 18px 18px;overflow:hidden;isolation:isolate;background:#0b0b12;border:1px solid rgba(255,255,255,.12);animation:pop .55s var(--spring) both}
  .mesh{position:absolute;inset:-25%;z-index:-2;filter:blur(42px);opacity:.8}
  .mesh i{position:absolute;width:62%;height:62%;border-radius:50%;animation:float 9s ease-in-out infinite alternate}
  .mesh i:nth-child(1){background:var(--c);left:-8%;top:-6%}
  .mesh i:nth-child(2){background:var(--p);right:-8%;top:8%;animation-delay:-3s}
  .mesh i:nth-child(3){background:var(--v);left:22%;bottom:-12%;animation-delay:-6s}
  .wrap::after{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(9,9,15,.2),rgba(9,9,15,.78) 70%)}
  .wtop{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .badge{font-size:10.5px;font-weight:900;letter-spacing:1.7px;padding:6px 11px;border-radius:99px;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.2)}
  .date{font-size:12px;color:rgba(255,255,255,.78)}
  .duo{display:flex;justify-content:center;margin-top:18px}
  .duo .av{width:66px;height:66px;font-size:25px;box-shadow:0 0 0 3px #0b0b12}
  .duo .av+.av{margin-left:-16px}
  .duo .me{background:linear-gradient(135deg,var(--c),#0ea5b7);color:#00262a}
  .wn{text-align:center;font-size:16px;font-weight:750;margin-top:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .wn span{opacity:.6;margin:0 5px}
  .wbig{text-align:center;font-size:66px;font-weight:900;letter-spacing:-2.6px;line-height:1;margin-top:14px;font-variant-numeric:tabular-nums;
    background:linear-gradient(90deg,#fff,#c6fbf9 45%,#ffd0dc);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 6px 24px rgba(37,244,238,.25))}
  .wu{text-align:center;font-size:13px;color:rgba(255,255,255,.8);margin-top:7px}
  .inc{display:table;margin:10px auto 0;font-size:12px;font-weight:800;color:#FFE08A;background:rgba(255,197,61,.14);border:1px solid rgba(255,197,61,.35);padding:5px 11px;border-radius:99px}
  .tug{display:flex;gap:4px;height:14px;margin-top:20px}
  .tug i{display:block;height:100%;border-radius:99px;width:50%;transition:width 1.2s var(--spring)}
  .tug .a,.a{background:linear-gradient(90deg,#0ee6e0,var(--c))}
  .tug .b,.b{background:linear-gradient(90deg,var(--p),#ff6b8e)}
  .tl{display:flex;justify-content:space-between;gap:10px;margin-top:10px}
  .tl b{display:block;font-size:23px;font-weight:850;font-variant-numeric:tabular-nums;letter-spacing:-.6px}
  .tl small{display:block;font-size:12px;color:rgba(255,255,255,.78);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}
  .tl .r{text-align:right}
  .tl .r small{margin-left:auto}
  .crown{margin-top:14px;text-align:center;font-size:13.5px;font-weight:750;padding:10px 12px;border-radius:15px;background:rgba(255,197,61,.12);color:#FFD66B;border:1px solid rgba(255,197,61,.28)}
  .wrel{display:flex;align-items:center;gap:10px;width:100%;margin-top:10px;padding:10px 12px;border-radius:15px;text-align:left;background:rgba(0,0,0,.32);border:1px solid rgba(255,255,255,.16)}
  .wrel .e{font-size:24px;line-height:1}
  .wrel div{flex:1;min-width:0}
  .wrel small{display:block;font-size:10.5px;font-weight:800;letter-spacing:.8px;color:rgba(255,255,255,.65);text-transform:uppercase}
  .wrel b{display:block;font-size:15px;font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .wrel i{font-style:normal;font-size:13px;font-weight:850;color:#fff;background:rgba(255,255,255,.14);padding:4px 9px;border-radius:99px}
  .wtp{display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin-top:10px}
  .wtp span{font-size:12px;font-weight:750;padding:5px 10px;border-radius:99px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.12)}
  .chips{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:12px}
  .chip{border-radius:15px;padding:10px 4px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.1);text-align:center;min-width:0}
  .chip b{display:block;font-size:15px;font-weight:850;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .chip small{display:block;font-size:10px;color:rgba(255,255,255,.72);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ok{margin-top:12px;text-align:center;font-size:12px;font-weight:700;color:#7CE3A9}
  .warn{font-size:12.5px;color:#FFD38A;background:rgba(255,176,32,.1);border:1px solid rgba(255,176,32,.2);border-radius:15px;padding:10px 12px;margin-top:12px;line-height:1.5}
  .racts{display:grid;grid-template-columns:1.35fr 1fr 1fr;gap:8px;margin-top:14px}
  .racts button{height:48px;border-radius:16px;font-weight:800;font-size:14px;display:flex;align-items:center;justify-content:center;gap:7px}
  .racts .w{background:#fff;color:#0b0b10}
  .racts .g{background:rgba(255,255,255,.1)}
  .racts button:active{transform:scale(.96)}

  /* các trang phân tích */
  .card{border-radius:22px;padding:14px;background:var(--card);border:1px solid var(--line);margin-top:10px;animation:rise .45s var(--ease) both}
  .ch{display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:850;letter-spacing:.8px;text-transform:uppercase;color:#9a9aa8;margin-bottom:10px}
  .lg{display:flex;gap:10px;font-size:11px;font-weight:700;letter-spacing:0;text-transform:none;color:#c9c9d3}
  .lg span{display:flex;align-items:center;gap:4px}
  .lg i{width:9px;height:9px;border-radius:3px;display:block}
  .sum{font-size:15px;line-height:1.5;font-weight:650;padding:14px;border-radius:20px;background:linear-gradient(120deg,rgba(37,244,238,.12),rgba(254,44,85,.12));border:1px solid rgba(255,255,255,.1)}
  .sum b{font-weight:850}
  .trow{display:flex;align-items:center;gap:10px;padding:6px 0}
  .ti{width:34px;height:34px;flex:none;border-radius:11px;display:grid;place-items:center;font-size:18px;background:rgba(255,255,255,.07)}
  .tm{flex:1;min-width:0}
  .tn{display:flex;justify-content:space-between;gap:8px;font-size:13.5px}
  .tn b{font-weight:750;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tn span{color:var(--mut);font-weight:750;font-variant-numeric:tabular-nums}
  .tb{display:flex;height:7px;margin-top:6px;border-radius:99px;overflow:hidden;background:rgba(255,255,255,.06)}
  .tb i{display:block;height:100%;transform-origin:left;animation:grow .8s var(--ease) both}
  .cloud{display:flex;flex-wrap:wrap;gap:6px}
  .cloud span{padding:5px 10px;border-radius:99px;font-weight:750;background:rgba(255,255,255,.07);border:1px solid var(--line);white-space:nowrap}
  .cloud span.m{background:rgba(37,244,238,.12);border-color:rgba(37,244,238,.3);color:#c8fbf9}
  .cloud span.t{background:rgba(254,44,85,.12);border-color:rgba(254,44,85,.3);color:#ffd0dc}
  .cloud small{opacity:.6;font-weight:700;margin-left:4px;font-size:.8em}
  .emos{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}
  .emos div{text-align:center;padding:8px 0;border-radius:14px;background:rgba(255,255,255,.05)}
  .emos b{display:block;font-size:24px;line-height:1.2}
  .emos small{font-size:11px;color:var(--mut);font-weight:700}
  .cp{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .cp div{padding:12px;border-radius:16px;background:rgba(255,255,255,.05);min-width:0}
  .cp small{display:block;font-size:11px;color:var(--mut);font-weight:750;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cp b{display:block;font-size:16px;font-weight:850;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .na{font-size:13px;color:var(--mut);line-height:1.55;padding:22px 14px;border:1px dashed rgba(255,255,255,.14);border-radius:18px;text-align:center;margin-top:6px}
  .na button{display:block;margin:12px auto 0;height:40px;padding:0 16px;border-radius:13px;background:#fff;color:#0b0b10;font-weight:800}

  .relc{position:relative;border-radius:26px;padding:22px 18px 18px;text-align:center;overflow:hidden;isolation:isolate;border:1px solid rgba(255,255,255,.16);
    background:linear-gradient(150deg,var(--g1),var(--g2));animation:pop .55s var(--spring) both}
  .relc::after{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(10,10,16,.15),rgba(10,10,16,.62))}
  .rele{font-size:54px;line-height:1;filter:drop-shadow(0 8px 20px rgba(0,0,0,.35))}
  .rell{font-size:11px;font-weight:850;letter-spacing:1.6px;margin-top:12px;opacity:.85}
  .reln{font-size:30px;font-weight:900;letter-spacing:-.8px;margin-top:4px}
  .reld{font-size:13.5px;line-height:1.5;opacity:.92;margin-top:6px}
  .relp{display:flex;align-items:center;gap:10px;margin-top:14px;font-size:12px;font-weight:800}
  .relp div{flex:1;height:8px;border-radius:99px;background:rgba(0,0,0,.3);overflow:hidden}
  .relp i{display:block;height:100%;border-radius:99px;background:#fff;transform-origin:left;animation:grow 1s var(--ease) both}
  .gg{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
  .gauge{text-align:center;min-width:0}
  .gr{position:relative;width:62px;height:62px;margin:0 auto;border-radius:50%;display:grid;place-items:center;
    background:conic-gradient(var(--gc,var(--c)) calc(var(--v)*1%),rgba(255,255,255,.08) 0)}
  .gr::before{content:"";position:absolute;inset:6px;border-radius:50%;background:#15151c}
  .gr b{position:relative;font-size:16px;font-weight:850;font-variant-numeric:tabular-nums}
  .gauge small{display:block;font-size:11px;color:#c9c9d3;font-weight:700;margin-top:6px;line-height:1.25}
  .why{list-style:none;display:flex;flex-direction:column;gap:7px}
  .why li{position:relative;padding:9px 12px 9px 32px;border-radius:13px;background:rgba(255,255,255,.05);font-size:13px;line-height:1.45}
  .why li::before{content:"✓";position:absolute;left:12px;top:9px;color:var(--c);font-weight:900}
  .prow{display:flex;align-items:center;gap:9px;padding:5px 0;font-size:13px}
  .prow .pe{width:26px;text-align:center;font-size:16px}
  .prow .pl{width:42%;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .prow .pb{flex:1;height:7px;border-radius:99px;background:rgba(255,255,255,.07);overflow:hidden}
  .prow .pb i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--c),var(--v),var(--p));transform-origin:left;animation:grow .8s var(--ease) both}
  .prow .pv{width:38px;text-align:right;font-weight:800;color:var(--mut);font-variant-numeric:tabular-nums}
  .disc{font-size:11.5px;color:#7d7d89;text-align:center;margin-top:12px;line-height:1.5}

  .tiles{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .tile{padding:12px;border-radius:17px;background:var(--card);border:1px solid var(--line);min-width:0;animation:rise .45s var(--ease) both}
  .tile small{display:block;font-size:11px;color:var(--mut);font-weight:750}
  .tile b{display:block;font-size:17px;font-weight:850;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
  .tile span{display:block;font-size:11px;color:#c9c9d3;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bars{display:flex;align-items:flex-end;gap:3px;height:92px}
  .bars i{flex:1;min-height:3px;border-radius:5px 5px 2px 2px;background:linear-gradient(180deg,var(--v),rgba(139,92,246,.35));transform-origin:bottom;animation:grow .8s var(--ease) both}
  .bars i.pk{background:linear-gradient(180deg,var(--p),rgba(254,44,85,.4))}
  .axis{display:flex;justify-content:space-between;font-size:10.5px;color:var(--mut);margin-top:5px;font-weight:700}
  .axis.d7 span{flex:1;text-align:center}
  .cmp{display:grid;grid-template-columns:58px 1fr 58px;align-items:center;gap:8px;padding:6px 0}
  .cmp .l,.cmp .r{font-size:13.5px;font-weight:850;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cmp .r{text-align:right}
  .cmp .mid small{display:block;text-align:center;font-size:11px;color:#c9c9d3;font-weight:700;margin-bottom:4px}
  .cmp .cb{display:flex;gap:2px;height:6px}
  .cmp .cb i{display:block;height:100%;border-radius:99px;min-width:3px}
  .cmph{display:grid;grid-template-columns:58px 1fr 58px;font-size:11px;font-weight:850;color:var(--mut);margin-bottom:4px}
  .cmph span:last-child{text-align:right}

  /* bảng xếp hạng */
  .rsum{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
  .rsum span{font-size:12px;font-weight:750;padding:5px 10px;border-radius:99px;background:rgba(255,255,255,.07);border:1px solid var(--line)}
  .podium{display:grid;grid-template-columns:1fr 1.18fr 1fr;align-items:end;gap:8px;margin:18px 0 12px}
  .pod{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;min-width:0;animation:rise .55s var(--ease) both}
  .pod .av{width:52px;height:52px}
  .pod.p1 .av{width:68px;height:68px;box-shadow:0 0 0 3px #0e0e14,0 0 0 5px var(--y)}
  .pod.p2 .av{box-shadow:0 0 0 3px #0e0e14,0 0 0 5px #c9ced6}
  .pod.p3 .av{box-shadow:0 0 0 3px #0e0e14,0 0 0 5px #d9925a}
  .pod .nm{font-size:12.5px;font-weight:750;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pod .n{font-size:13px;font-weight:850;font-variant-numeric:tabular-nums}
  .pod .base{width:100%;border-radius:16px 16px 8px 8px;display:grid;place-items:center;font-size:22px;background:linear-gradient(180deg,rgba(255,255,255,.15),rgba(255,255,255,.03));border:1px solid var(--line)}
  .pod.p1 .base{height:88px;background:linear-gradient(180deg,rgba(255,197,61,.3),rgba(255,197,61,.04))}
  .pod.p2 .base{height:64px}
  .pod.p3 .base{height:50px}
  .rl{display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:10px 12px;border-radius:17px;background:var(--card);border:1px solid var(--line);margin-top:7px;animation:rise .5s var(--ease) both}
  .rl .rk{width:22px;text-align:center;font-weight:850;color:var(--mut);font-variant-numeric:tabular-nums}
  .rl .av{width:40px;height:40px;font-size:15px}
  .rl .rm{flex:1;min-width:0}
  .rl .nm{font-size:14.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rl .bar{height:5px;border-radius:99px;background:rgba(255,255,255,.08);margin-top:7px;overflow:hidden}
  .rl .bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--c),var(--v),var(--p))}
  .rl .n{font-size:15px;font-weight:850;font-variant-numeric:tabular-nums;text-align:right}
  .rl .n small{display:block;font-size:14px;font-weight:400}
  .rl.err .n{color:#FFB4B4;font-size:12px;font-weight:700}
  .danger{color:#ff7a90!important;margin:16px auto 0}

  /* cài đặt */
  .grp{font-size:12px;font-weight:850;letter-spacing:.9px;text-transform:uppercase;color:#8a8a97;margin:18px 2px 2px}
  .segs{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:10px}
  .segs button{padding:10px 6px;border-radius:15px;background:var(--card);border:1px solid var(--line);text-align:center}
  .segs button b{display:block;font-size:14px;font-weight:850}
  .segs button small{display:block;font-size:10.5px;color:var(--mut);margin-top:3px;line-height:1.3}
  .segs button.on{border-color:rgba(37,244,238,.7);background:rgba(37,244,238,.1)}
  .set{display:flex;align-items:center;gap:12px;padding:13px 14px;border-radius:17px;background:var(--card);border:1px solid var(--line);margin-top:10px}
  .set div{flex:1;min-width:0}
  .set b{display:block;font-size:14.5px}
  .set small{display:block;font-size:12px;color:var(--mut);margin-top:2px;line-height:1.4}
  .set button{flex:none;height:36px;padding:0 14px;border-radius:12px;background:rgba(255,255,255,.1);font-weight:750;font-size:13px}
  .set button.dg{color:#ff8fa3;background:rgba(254,44,85,.14)}
  .set input{position:absolute;opacity:0;pointer-events:none}
  .sw{position:relative;flex:none;width:50px;height:30px;border-radius:99px;background:rgba(255,255,255,.16);transition:background .25s;cursor:pointer}
  .sw::after{content:"";position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.35);transition:transform .3s var(--spring)}
  .set input:checked+.sw{background:var(--g)}
  .set input:checked+.sw::after{transform:translateX(20px)}
  .diag{font:11px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c8c8d2;background:rgba(0,0,0,.38);border:1px solid var(--line);border-radius:14px;padding:11px 12px;white-space:pre-wrap;margin-top:10px}
  .rep{display:block;width:100%;height:140px;margin-top:10px;font:10.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#cfcfd6;background:rgba(0,0,0,.4);border:1px solid var(--line);border-radius:12px;padding:9px;resize:vertical}
  .priv{font-size:12px;line-height:1.5;color:#b9e8cf;background:rgba(43,214,123,.08);border:1px solid rgba(43,214,123,.22);border-radius:15px;padding:10px 12px;margin-top:14px}
  .ver{text-align:center;font-size:11.5px;color:#6e6e7a;margin-top:18px}

  /* đảo trạng thái khi đang đếm */
  .island{position:fixed;left:50%;top:max(10px,env(safe-area-inset-top));transform:translate(-50%,0);width:min(384px,calc(100vw - 16px));color:#fff;
    background:#000;border-radius:30px;box-shadow:0 20px 50px rgba(0,0,0,.65);animation:drop .55s var(--spring) both;transition:width .45s var(--spring),border-radius .45s var(--spring)}
  .island::before{content:"";position:absolute;inset:-2px;border-radius:inherit;padding:2px;background:conic-gradient(var(--c),var(--v),var(--p),var(--y),var(--c));
    -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;opacity:.85;pointer-events:none}
  .island.mini{width:auto;border-radius:99px}
  .imini{display:none;align-items:center;gap:10px;height:46px;padding:0 18px 0 7px;font-weight:800}
  .island.mini .imini{display:flex}
  .island.mini .ifull{display:none}
  .imini .av{width:32px;height:32px;font-size:13px}
  .imini .u{font-size:12px;color:var(--mut);font-weight:700}
  .ifull{padding:14px 16px 14px}
  .ir{display:flex;align-items:center;gap:11px}
  .ir .av{width:40px;height:40px;font-size:15px}
  .fm{flex:1;min-width:0}
  .fn{display:flex;align-items:center;font-size:15px;font-weight:800;min-width:0}
  .fn>span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .fs{font-size:12px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
  .ftm{font-size:12.5px;color:#cfcfd8;font-variant-numeric:tabular-nums;font-weight:700}
  .fq{flex:none;font-size:11px;font-weight:850;color:#0b0b10;background:var(--c);border-radius:99px;padding:2px 8px;margin-left:6px}
  .fq.q{background:var(--y)}
  .odo{display:flex;align-items:flex-end;font-weight:850;font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:1}
  .odo.big{font-size:54px;margin:14px 0 2px;letter-spacing:-1.5px;text-shadow:0 0 28px rgba(37,244,238,.3)}
  .odo.sm{font-size:17px}
  .oc{display:inline-block;height:1em;overflow:hidden}
  .os{display:flex;flex-direction:column;transition:transform .55s cubic-bezier(.2,.9,.25,1.05)}
  .os span{display:block;height:1em;line-height:1em}
  .osep{display:inline-block;height:1em;line-height:1em;opacity:.5}
  .ounit{font-size:14px;font-weight:700;color:var(--mut);margin:0 0 6px 8px;letter-spacing:0}
  .fb{display:flex;gap:3px;height:8px;margin-top:12px}
  .fb i{display:block;height:100%;border-radius:99px;transition:width .6s var(--ease);min-width:4px}
  .fl{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:#d2d2da;margin-top:6px;font-variant-numeric:tabular-nums}
  .fl span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .spark{position:relative;margin-top:12px;height:56px;border-radius:16px;background:rgba(255,255,255,.045);overflow:hidden}
  .spark canvas{width:100%;height:100%;display:block}
  .rate{position:absolute;left:12px;top:9px}
  .rate b{display:block;font-size:21px;font-weight:850;font-variant-numeric:tabular-nums;line-height:1}
  .rate small{font-size:10.5px;color:var(--mut);font-weight:700}
  .fa{display:flex;gap:8px;margin-top:12px}
  .stop{flex:1;height:44px;border-radius:15px;background:var(--p);font-weight:850;font-size:14.5px;color:#fff}
  .minb{height:44px;padding:0 18px;border-radius:15px;background:rgba(255,255,255,.11);font-weight:750;font-size:13.5px}
  .stop:active,.minb:active{transform:scale(.96)}

  .fx{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none}
  .toast{position:fixed;left:50%;top:max(12px,env(safe-area-inset-top));transform:translate(-50%,-20px);opacity:0;transition:opacity .25s,transform .35s var(--spring);max-width:min(92vw,420px);
    display:flex;align-items:center;gap:10px;background:rgba(14,14,20,.94);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);color:#fff;font-size:13px;font-weight:600;line-height:1.4;
    padding:11px 14px;border-radius:16px;border:1px solid rgba(255,255,255,.12);box-shadow:0 14px 34px rgba(0,0,0,.5);pointer-events:none}
  .toast.on{opacity:1;transform:translate(-50%,0)}
  .toast button{pointer-events:auto;height:30px;padding:0 11px;border-radius:10px;background:rgba(255,255,255,.12);font-size:12.5px;font-weight:750}
  /* spam */
  .seg button{gap:5px;font-size:13px}
  .segs.two{grid-template-columns:1fr 1fr}
  .segs.four{grid-template-columns:repeat(4,1fr)}
  .segs button.on{border-color:rgba(37,244,238,.7);background:rgba(37,244,238,.1)}
  .spto{display:flex;align-items:center;gap:10px;margin-top:14px;padding:11px 12px;border-radius:16px;background:var(--card);border:1px solid var(--line);font-size:13.5px}
  .spto .av{width:36px;height:36px;font-size:14px}
  .spto small{display:block;font-size:11.5px;color:var(--mut)}
  .spto b{display:block;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .spto>div:last-child{min-width:0}
  .spto.bad{color:#FFD38A;border-color:rgba(255,176,32,.3);background:rgba(255,176,32,.08)}
  .stk{display:grid;grid-template-columns:repeat(auto-fill,minmax(68px,1fr));gap:8px;margin-top:12px}
  .stk .it{position:relative;aspect-ratio:1;border-radius:16px;background:var(--card);border:1.5px solid var(--line);display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;font-size:30px}
  .stk .it img{width:78%;height:78%;object-fit:contain}
  .stk .it.on{border-color:var(--c);box-shadow:0 0 0 3px rgba(37,244,238,.2)}
  .stk .it small{font-size:11px;padding:4px;text-align:center;color:var(--mut);line-height:1.2}
  .stk .x{position:absolute;top:3px;right:3px;width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,.6);font-size:13px;display:grid;place-items:center;color:#fff;cursor:pointer}
  .stk .add{border-style:dashed;color:var(--c);font-weight:800}
  .stk .add span{font-size:24px;line-height:1}
  .note{font-size:12px;color:var(--mut);margin-top:10px;line-height:1.5}
  .note b{color:#e6e6ee}
  .emo{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
  .emo button{min-width:46px;height:46px;padding:0 10px;border-radius:14px;font-size:22px;background:var(--card);border:1.5px solid var(--line)}
  .emo button.on{border-color:var(--c);background:rgba(37,244,238,.1)}
  .emo button.rnd{font-size:13px;font-weight:800}
  .sptxt{margin-top:10px}
  .cnt{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap}
  .cnt>button{width:44px;height:44px;border-radius:14px;background:var(--card);border:1px solid var(--line);font-size:20px;font-weight:800}
  .cnt input{width:76px;height:44px;border-radius:14px;border:1px solid var(--line);background:rgba(255,255,255,.06);color:#fff;font-size:18px;font-weight:800;text-align:center;font-family:inherit;outline:none}
  .cq{display:flex;gap:6px;flex-wrap:wrap}
  .cq button{height:32px;padding:0 11px;border-radius:99px;font-size:12.5px;font-weight:750;background:rgba(255,255,255,.06);border:1px solid var(--line);color:#c9c9d3}
  .cq button.on{background:#fff;color:#0b0b10}
  .spwarn{font-size:12.5px;line-height:1.5;color:#FFD38A;background:rgba(255,176,32,.1);border:1px solid rgba(255,176,32,.22);border-radius:15px;padding:10px 12px;margin-top:14px}
  #spGo{margin-top:14px}
  .sprow{display:flex;align-items:center;justify-content:space-between;margin-top:12px;font-size:12px;font-weight:850;letter-spacing:.6px;text-transform:uppercase;color:#8a8a97}
  .sprow .lnk{text-transform:none;letter-spacing:0}
  .sprow .lnk.on{background:rgba(37,244,238,.16)}
  .spmake{display:flex;gap:10px;align-items:center;margin-top:10px;padding:10px;border-radius:16px;background:var(--card);border:1px solid var(--line)}
  .spmake img{width:84px;height:84px;flex:none;border-radius:12px;background:repeating-conic-gradient(rgba(255,255,255,.07) 0 25%,transparent 0 50%) 0 0/16px 16px}
  .spmake>div{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
  .spmake input{height:36px;border-radius:10px;border:1px solid var(--line);background:rgba(255,255,255,.06);color:#fff;padding:0 10px;font-family:inherit;font-size:14px;outline:none;min-width:0}
  .spmk{height:36px;border-radius:10px;background:#fff;color:#0b0b10;font-weight:800;font-size:13.5px}
  .stk .it.add small{color:var(--c);font-weight:750}
  .stk .it.add span{font-size:22px;line-height:1.1}
  @media (max-width:400px){.seg button svg{display:none}}
  @media (max-width:370px){.chips{grid-template-columns:repeat(2,1fr)}.gg{grid-template-columns:repeat(2,1fr);row-gap:12px}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
  `;

  const HTML = `
  <div class="scrim" id="scrim"></div>
  <section class="sheet" id="sheet" role="dialog" aria-label="Đếm tin nhắn">
    <div class="aurora"><i class="b1"></i><i class="b2"></i><i class="b3"></i></div>
    <div class="grab" id="grab"></div>
    <header class="top" id="top">
      <div class="logo">${I.logo}</div>
      <div class="brand"><b>DM Counter</b><small>Đếm · chủ đề · đoán mối quan hệ</small></div>
      <div class="acts"><button class="ib" id="bClose" aria-label="Đóng">${I.close}</button></div>
    </header>
    <nav class="seg" id="nav"><i class="pill" id="navPill"></i>
      <button data-v="home" class="on">${I.chat}<span>Đếm</span></button><button data-v="rank">${I.trophy}<span>Xếp hạng</span></button><button data-v="spam">${I.bolt}<span>Spam</span></button><button data-v="set">${I.gear}<span>Cài đặt</span></button>
    </nav>
    <div class="body" id="body">
      <div id="vHome">
        <div class="hero" id="hero">
          <div class="hrow">
            <div class="ring"><div class="av" id="hAv"></div></div>
            <div class="hm"><div class="live"><i></i><span id="hLbl"></span></div><div class="hn" id="hName"></div><div class="hs" id="hSub"></div></div>
          </div>
          <div class="hb" id="hBtns"><button class="hgo" id="hGo">${I.up}<span id="hGoT">Đếm</span></button><button class="hq" id="hQuick" hidden>${I.bolt}Chỉ tin mới</button></div>
          <div class="hlast" id="hLast" hidden><span id="hLastT"></span><button id="hLastB">Xem</button></div>
        </div>
        <div class="search" id="srch" hidden>${I.search}<input id="q" placeholder="Tìm người…" autocomplete="off" autocorrect="off" spellcheck="false"></div>
        <div class="filt" id="filt" hidden><button data-f="all" class="on">Tất cả</button><button data-f="todo">Chưa đếm</button><button data-f="done">Đã đếm</button></div>
        <div class="rh"><span>Chọn người</span><div><button class="lnk" id="selAll">Chọn tất cả</button><button class="lnk" id="rescan" aria-label="Quét lại">${I.refresh}</button></div></div>
        <div class="people" id="people"></div>
      </div>

      <div id="vRes" hidden>
        <button class="back" id="rBack">${I.back}<span id="rBackT">Quay lại</span></button>
        <div class="tabs" id="tabs"><button data-t="ov" class="on">📊 Tổng quan</button><button data-t="tp">💬 Chủ đề</button><button data-t="rl">💞 Quan hệ</button><button data-t="hb">⏰ Thói quen</button></div>
        <div id="tOv">
          <div class="wrap" id="wrap">
            <div class="mesh"><i></i><i></i><i></i></div>
            <div class="wtop"><span class="badge">TIN NHẮN</span><span class="date" id="wDate"></span></div>
            <div class="duo"><div class="av me">B</div><div class="av" id="wAv"></div></div>
            <div class="wn">Bạn<span>&amp;</span><b id="wName"></b></div>
            <div class="wbig" id="wBig">0</div>
            <div class="wu">tin nhắn đã gửi cho nhau</div>
            <div class="inc" id="wInc" hidden></div>
            <div class="tug"><i class="a" id="wA"></i><i class="b" id="wB"></i></div>
            <div class="tl"><div><b id="wMe">0</b><small id="wMeL">Bạn</small></div><div class="r"><b id="wThem">0</b><small id="wThemL"></small></div></div>
            <div class="crown" id="wCrown"></div>
            <button class="wrel" id="wRel" hidden><span class="e" id="wRelE"></span><div><small>Máy đoán hai bạn là</small><b id="wRelL"></b></div><i id="wRelP"></i></button>
            <div class="wtp" id="wTp"></div>
            <div class="chips" id="wChips"></div>
            <div class="ok" id="wOk"></div>
          </div>
          <div class="warn" id="wWarn" hidden></div>
          <div class="racts"><button class="w" id="rShare">${I.share}Lưu ảnh</button><button class="g" id="rCopy">${I.copy}Chép</button><button class="g" id="rAgain">${I.refresh}<span id="rAgainT">Đếm lại</span></button></div>
        </div>
        <div id="tTp" hidden></div>
        <div id="tRl" hidden></div>
        <div id="tHb" hidden></div>
      </div>

      <div id="vRank" hidden>
        <h3 class="ttl">Bảng xếp hạng</h3>
        <p class="sub" id="kSub">Những người bạn đã đếm, nhiều tin nhất ở trên</p>
        <div class="rsum" id="kSum"></div>
        <div class="podium" id="podium"></div>
        <div id="rlist"></div>
        <button class="lnk danger" id="kClear">Xoá lịch sử</button>
      </div>

      <div id="vSpam" hidden>
        <h3 class="ttl">Spam nhãn dán</h3>
        <p class="sub">Gửi liên tục vào cuộc trò chuyện đang mở trên TikTok.</p>
        <div class="spto" id="spTo"></div>
        <div class="grp">Gửi gì</div>
        <div class="segs two" id="spKind"><button data-k="sticker"><b>🧸 Nhãn dán</b><small>Có sẵn + tự tạo, gửi như ảnh</small></button><button data-k="text"><b>😀 Emoji / chữ</b><small>Gõ sẵn rồi gửi liên tục</small></button></div>
        <div id="spStkBox">
          <div class="sprow"><span>Chọn nhãn dán</span><button class="lnk" id="spStkRand">🎲 Ngẫu nhiên mỗi lần</button></div>
          <div class="spmake" id="spMake" hidden><img id="spMkPrev" alt=""><div><input id="spMkE" maxlength="8" placeholder="Emoji" value="😴" aria-label="Emoji"><input id="spMkC" maxlength="28" placeholder="Chữ trên nhãn dán (vd: goodnight :3)" aria-label="Chữ trên nhãn dán"><button class="spmk" id="spMkGo">Tạo nhãn dán</button></div></div>
          <div class="stk" id="spStk"></div>
          <input type="file" id="spFile" accept="image/*" hidden>
          <p class="note">TikTok bản web không có nhãn dán, nên script <b>tự vẽ nhãn dán</b> rồi gửi như một tấm ảnh qua nút gửi ảnh 🖼️ của TikTok. Muốn nhãn dán riêng: <b>Tải ảnh lên</b>, <b>Tự tạo</b>, hoặc <b>Lấy từ chat</b> (chạm vào nhãn dán ai đó đã gửi).</p>
        </div>
        <div id="spTxtBox" hidden>
          <div class="emo" id="spEmo"></div>
          <div class="search sptxt"><input id="spText" maxlength="200" placeholder="Hoặc gõ nội dung muốn spam…" autocomplete="off"></div>
        </div>
        <div class="grp">Số lần (tối đa 100)</div>
        <div class="cnt"><button id="spMinus" aria-label="Bớt">−</button><input id="spN" type="number" min="1" max="100" inputmode="numeric" aria-label="Số lần"><button id="spPlus" aria-label="Thêm">＋</button><div class="cq" id="spCq"><button data-n="5">5</button><button data-n="10">10</button><button data-n="20">20</button><button data-n="50">50</button><button data-n="100">100</button></div></div>
        <div class="grp">Tốc độ</div>
        <div class="segs four" id="spSpd"></div>
        <label class="set"><div><b>Nhịp tự nhiên</b><small>Mỗi lần gửi lệch ±25% cho giống người thật</small></div><input type="checkbox" id="spJit"><i class="sw"></i></label>
        <div class="spwarn">⚠️ Gửi quá nhiều, quá nhanh có thể khiến TikTok tạm khoá tính năng nhắn tin của bạn. Mỗi lượt tối đa 100 lần, tự dừng nếu bạn chuyển sang người khác — dùng vui với bạn bè thôi nhé.</div>
        <button class="go" id="spGo"><i class="sh"></i>${I.bolt}<span id="spGoT">Bắt đầu spam</span></button>
      </div>

      <div id="vSet" hidden>
        <h3 class="ttl">Cài đặt</h3>
        <div class="grp">Tốc độ đếm</div>
        <div class="segs" id="spd"></div>
        <div class="grp">Tính năng</div>
        <label class="set"><div><b>Phân tích nội dung</b><small>Chủ đề hay nói, từ khoá, emoji, thói quen và đoán mối quan hệ</small></div><input type="checkbox" id="cAn"><i class="sw"></i></label>
        <label class="set"><div><b>Ưu tiên “Chỉ tin mới”</b><small>Người đã đếm đủ lần trước: chỉ tải phần tin mới rồi cộng dồn — nhanh hơn rất nhiều</small></div><input type="checkbox" id="cQk"><i class="sw"></i></label>
        <div class="priv">🔒 Mọi thứ chạy ngay trên trình duyệt của bạn. Nội dung tin nhắn không được lưu lại hay gửi đi đâu — chỉ lưu con số thống kê.</div>
        <div class="grp">Sửa lỗi</div>
        <div class="set"><div><b>Chẩn đoán</b><small>Script đang nhận ra những gì trên trang</small></div><button id="sDiag">Xem</button></div>
        <pre class="diag" id="diag" hidden></pre>
        <div class="set"><div><b>Báo cáo lỗi</b><small>Chép cấu trúc trang (không có nội dung tin nhắn) để gửi người sửa script</small></div><button id="sRep">Chép</button></div>
        <textarea class="rep" id="repT" readonly hidden></textarea>
        <div class="set"><div><b>Chọn khung chat thủ công</b><small>Khi đã mở cuộc trò chuyện mà script không tự nhận ra</small></div><button id="sPick">Chọn</button></div>
        <div class="set"><div><b>Quên tên đã nhớ</b><small>Khi danh sách thu gọn hiện sai tên người</small></div><button id="sForget">Quên</button></div>
        <div class="grp">Dữ liệu</div>
        <div class="set"><div><b>Xoá toàn bộ dữ liệu</b><small>Lịch sử đếm, tên đã nhớ, cài đặt</small></div><button class="dg" id="sWipe">Xoá</button></div>
        <div class="ver">TikTok DM Counter ${VERSION}</div>
      </div>
    </div>
    <footer class="cta" id="cta">
      <div class="mode" id="mode" hidden><button data-m="quick">${I.bolt}Chỉ tin mới</button><button data-m="full">${I.refresh}Đếm lại từ đầu</button></div>
      <button class="go" id="go" disabled><i class="sh"></i>${I.up}<span id="goT">Chọn người để đếm</span></button>
      <div class="hint" id="hint">Tự mở · tự cuộn tới tin đầu tiên · nhớ giữ màn hình sáng</div>
    </footer>
  </section>

  <div class="island" id="island" hidden>
    <div class="imini" id="imini"><div class="av" id="iAv"></div><div class="odo sm" id="iOdo"></div><span class="u">tin</span></div>
    <div class="ifull">
      <div class="ir"><div class="av" id="fAv"></div><div class="fm"><div class="fn"><span id="fName"></span><span class="fq q" id="fMode" hidden>⚡ TIN MỚI</span><span class="fq" id="fQ" hidden></span></div><div class="fs" id="fStep">Đang chuẩn bị…</div></div><div class="ftm" id="fTime">0:00</div></div>
      <div class="odo big" id="fOdoWrap"><span id="fOdo" style="display:flex"></span><span class="ounit" id="fUnit">tin</span></div>
      <div class="fb"><i class="a" id="fA" style="width:50%"></i><i class="b" id="fB" style="width:50%"></i></div>
      <div class="fl"><span id="fMe">Bạn 0</span><span id="fThem">Họ 0</span></div>
      <div class="spark"><canvas id="spark" width="720" height="112"></canvas><div class="rate"><b id="fRate">0</b><small>tin/giây</small></div></div>
      <div class="fa"><button class="stop" id="fStop">Dừng</button><button class="minb" id="fMin">Thu gọn</button></div>
    </div>
  </div>

  <button class="fab" id="fab" aria-label="Đếm tin nhắn">${I.logo}</button>
  <canvas class="fx" id="fx" hidden></canvas>
  <div class="toast" id="toast"><span id="tT"></span><button id="tB" hidden>Huỷ</button></div>`;

  function mount() {
    HOST = document.createElement('div');
    HOST.id = 'dmc-root';
    HOST.setAttribute('style', 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;');
    const root = HOST.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>${HTML}`;
    document.documentElement.appendChild(HOST);
    ['keydown', 'keyup', 'keypress', 'wheel'].forEach(t => HOST.addEventListener(t, e => e.stopPropagation()));
    return root;
  }
  const root = mount();
  const $ = id => root.getElementById(id);
  const sheet = $('sheet'), scrim = $('scrim'), fab = $('fab'), island = $('island');

  /* ---------- trạng thái & lịch sử ---------- */
  const S = { sc: null, title: '', items: [], sel: new Set(), snap: '', visible: 0, view: 'home', poll: 0, filter: 'all', mode: CFG.quick ? 'quick' : 'full',
    running: false, stop: false, last: null, lastScroll: '', anim: true, from: 'home', tab: 'ov' };
  let history = Array.isArray(store.get('dmcHistory')) ? store.get('dmcHistory') : [];
  function persistHistory() {
    for (let tries = 0; tries < 6; tries++) {
      if (store.set('dmcHistory', history)) return;
      // hết chỗ lưu → bỏ bớt phần phân tích của người đếm lâu nhất
      const old = history.filter(x => x.an).sort((a, b) => a.at - b.at).slice(0, Math.max(3, Math.ceil(history.length / 4)));
      if (!old.length) { history = history.slice(-60); continue; }
      for (const x of old) delete x.an;
    }
  }
  const histIdx = it => history.findIndex(x => (it.k && x.k === it.k) || (it.name && x.name && sameName(x.name, it.name)));
  const histFor = it => { const i = histIdx(it); return i >= 0 ? history[i] : null; };
  const canQuick = h => !!(h && h.complete !== false && Array.isArray(h.anchor) && h.anchor.length && h.total);
  function saveHistory(rec) {
    const i = histIdx(rec);
    const keep = { name: rec.name, k: rec.k, img: rec.img, total: rec.total, me: rec.me, them: rec.them, media: rec.media, share: rec.share || 0, secs: rec.secs, at: rec.at,
      complete: rec.complete, anchor: rec.anchor, an: rec.an, rel: rec.rel, tp: rec.tp, added: rec.added, prevAt: rec.prevAt, anPartial: rec.anPartial };
    if (i >= 0) history[i] = keep; else history.push(keep);
    history = history.slice(-150);
    persistHistory();
  }

  /* ---------- tiện ích giao diện ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let toastTimer = 0;
  function toast(msg, ms = 2600, action) {
    $('tT').textContent = msg;
    const b = $('tB');
    b.hidden = !action;
    if (action) { b.textContent = action.label; b.onclick = action.fn; }
    $('toast').classList.add('on');
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => $('toast').classList.remove('on'), ms);
  }
  const hideToast = () => $('toast').classList.remove('on');
  const initial = s => (String(s || '?').trim().match(/\p{L}|\p{N}/u) || [String(s || '?').trim().slice(0, 2) || '?'])[0].toUpperCase();
  const GRADS = [['#25F4EE', '#0ea5b7'], ['#FE2C55', '#ff7a5c'], ['#8B5CF6', '#6366f1'], ['#FFC53D', '#ff8a3d'], ['#34d399', '#0ea5e9'], ['#f472b6', '#8B5CF6']];
  function setAv(el, src, name) {
    el.textContent = '';
    const g = GRADS[Math.abs(hashStr(normName(name) || '?')) % GRADS.length];
    el.style.background = `linear-gradient(135deg,${g[0]},${g[1]})`;
    if (src) {
      const im = document.createElement('img');
      im.src = src; im.alt = '';
      im.onerror = () => { im.remove(); el.textContent = initial(name); };
      el.appendChild(im);
    } else if (name === null) { el.style.background = ''; el.innerHTML = I.bubbles; }
    else el.textContent = initial(name);
  }
  const mmss = s => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
  const durShort = s => { s = Math.round(s); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}p${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`; };
  const ago = t => { const s = (Date.now() - t) / 1000; return s < 90 ? 'vừa xong' : s < 3600 ? `${Math.round(s / 60)} phút trước` : s < 86400 ? `${Math.round(s / 3600)} giờ trước` : `${Math.round(s / 86400)} ngày trước`; };
  const short = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
  const dstr = t => new Date(t).toLocaleDateString('vi-VN');
  const dkey = k => (k ? `${k % 100}/${Math.floor(k / 100) % 100}/${Math.floor(k / 10000)}` : '—');
  const relOf = r => (r && r.rel && r.rel.id ? AN.relMeta(r.rel.id, r.rel.who) : null);

  // số chạy kiểu đồng hồ cơ
  function makeOdo(el) {
    let shown = null;
    return n => {
      const s = fmt(n);
      if (s === shown) return;
      if (shown === null || shown.length !== s.length) {
        el.textContent = '';
        for (const ch of s) {
          if (ch >= '0' && ch <= '9') {
            const cell = document.createElement('span'); cell.className = 'oc';
            const strip = document.createElement('span'); strip.className = 'os';
            for (let d = 0; d <= 9; d++) { const x = document.createElement('span'); x.textContent = d; strip.appendChild(x); }
            cell.appendChild(strip); el.appendChild(cell);
          } else { const sp = document.createElement('span'); sp.className = 'osep'; sp.textContent = ch; el.appendChild(sp); }
        }
      }
      const strips = el.querySelectorAll('.os');
      let k = 0;
      for (const ch of s) if (ch >= '0' && ch <= '9') strips[k++].style.transform = `translateY(${-Number(ch) * 10}%)`;
      shown = s;
    };
  }
  const odoBig = makeOdo($('fOdo')), odoMini = makeOdo($('iOdo'));

  /* ---------- bố cục & kéo thả ---------- */
  function layout() {
    const wide = window.innerWidth >= 600;
    sheet.classList.toggle('wide', wide);
    $('grab').hidden = wide;
    if (fab.classList.contains('moved')) { const r = fab.getBoundingClientRect(); placeFab(r.left, r.top); }
  }
  function placeFab(x, y) {
    x = clamp(x, 6, window.innerWidth - 64); y = clamp(y, 6, window.innerHeight - 64);
    Object.assign(fab.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
  }
  (() => {
    let id = null, sx = 0, sy = 0, ox = 0, oy = 0, moved = false;
    fab.addEventListener('pointerdown', e => { id = e.pointerId; moved = false; sx = e.clientX; sy = e.clientY; const r = fab.getBoundingClientRect(); ox = r.left; oy = r.top; try { fab.setPointerCapture(id); } catch {} });
    fab.addEventListener('pointermove', e => { if (e.pointerId !== id) return; const dx = e.clientX - sx, dy = e.clientY - sy; if (!moved && Math.hypot(dx, dy) < 8) return; moved = true; placeFab(ox + dx, oy + dy); });
    fab.addEventListener('pointerup', e => {
      if (e.pointerId !== id) return; id = null;
      if (moved) { const r = fab.getBoundingClientRect(); store.set('dmcFab', { x: r.left, y: r.top }); fab.classList.add('moved'); }
      else openSheet('home');
    });
    fab.addEventListener('pointercancel', () => { id = null; });
    const p = store.get('dmcFab');
    if (p) requestAnimationFrame(() => { placeFab(p.x, p.y); fab.classList.add('moved'); });
  })();
  // vuốt xuống để đóng (màn hình dọc)
  (() => {
    let id = null, sy = 0, dy = 0;
    const down = e => { if (sheet.classList.contains('wide') || e.target.closest('button')) return; id = e.pointerId; sy = e.clientY; dy = 0; sheet.classList.add('drag'); try { e.currentTarget.setPointerCapture(id); } catch {} };
    const move = e => { if (e.pointerId !== id) return; dy = Math.max(0, e.clientY - sy); sheet.style.transform = `translateY(${dy}px)`; };
    const up = e => { if (e.pointerId !== id) return; id = null; sheet.classList.remove('drag'); sheet.style.transform = ''; if (dy > 110) closeSheet(); };
    for (const h of [$('top'), $('grab')]) { h.addEventListener('pointerdown', down); h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up); }
  })();
  window.addEventListener('resize', layout);
  layout();

  /* ---------- mở / đóng bảng, chuyển trang ---------- */
  const NAV = ['home', 'rank', 'spam', 'set'];
  function setNav(v) {
    const i = Math.max(0, NAV.indexOf(v));
    $('navPill').style.transform = `translateX(${i * 100}%)`;
    for (const b of $('nav').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === NAV[i]);
  }
  function show(v) {
    S.view = v;
    for (const [k, id] of [['home', 'vHome'], ['res', 'vRes'], ['rank', 'vRank'], ['spam', 'vSpam'], ['set', 'vSet']]) $(id).hidden = k !== v;
    $('cta').hidden = v !== 'home';
    $('body').scrollTop = 0;
    setNav(v === 'res' ? S.from : v);
    if (v === 'home') { S.anim = true; detect(true); }
    if (v === 'rank') renderRank();
    if (v === 'set') renderSet();
    if (v === 'spam') renderSpam();
  }
  for (const b of $('nav').querySelectorAll('button')) b.onclick = () => show(b.dataset.v);
  function openSheet(v) {
    sheet.classList.add('on'); scrim.classList.add('on'); fab.hidden = true;
    if (v) show(v);
    clearInterval(S.poll);
    S.poll = setInterval(() => {
      if (S.running || S.view !== 'home' || !sheet.classList.contains('on')) return;
      const changed = !S.items.length || S.items.some(x => !x.el.isConnected) || snapshot(S.items) !== S.snap;
      detect(changed);
    }, 2000);
  }
  function closeSheet() {
    sheet.classList.remove('on'); scrim.classList.remove('on');
    fab.hidden = S.running;
    clearInterval(S.poll);
  }
  scrim.onclick = closeSheet;
  $('bClose').onclick = closeSheet;
  $('rBack').onclick = () => show(S.from === 'rank' ? 'rank' : 'home');

  /* ---------- trang Đếm: người đang mở + danh sách ---------- */
  const snapshot = items => items.map(x => { const im = imgOf(x.el); return (im ? avKey(im) : '') + '|' + (itemName(x.el) || '') + (x.active ? '*' : ''); }).join('§');
  function curHist() {
    if (!S.sc) return null;
    const cur = S.items.find(x => x.active) || S.items.find(x => x.name && sameName(x.name, S.title));
    return histFor({ k: cur && cur.k, name: S.title });
  }
  function detect(full) {
    const sc = findScroller();
    S.sc = sc; S.title = sc ? findTitle(sc) : '';
    if (full) {
      if (sc && S.title) learnFromChat(sc, S.title);
      S.items = scanItems(sc);
      S.snap = snapshot(S.items);
      for (const id of [...S.sel]) if (!S.items.some(x => x.id === id)) S.sel.delete(id);
      saveNames();
      S.visible = sc ? analyze(sc).total : 0;
      renderPeople();
    }
    renderHero(); renderCTA();
  }
  function renderHero() {
    const h = $('hero');
    $('hLast').hidden = true; $('hQuick').hidden = true;
    if (S.sc) {
      const cur = S.items.find(x => x.active) || S.items.find(x => x.name && sameName(x.name, S.title));
      h.classList.remove('empty');
      setAv($('hAv'), (cur && cur.img) || chatAvatar(S.sc), S.title || '?');
      $('hLbl').textContent = 'Đang mở';
      $('hName').textContent = S.title || 'Cuộc trò chuyện đang mở';
      $('hSub').textContent = `${fmt(S.visible)} tin đang hiện trên màn hình`;
      $('hBtns').hidden = false;
      const hs = curHist();
      $('hGoT').textContent = hs ? 'Đếm lại' : 'Đếm người này';
      $('hQuick').hidden = !canQuick(hs);
      if (hs) {
        const rm = relOf(hs);
        $('hLastT').textContent = `Lần trước: ${fmt(hs.total)} tin${rm ? ' · ' + rm.emoji + ' ' + rm.label : ''} · ${ago(hs.at)}`;
        $('hLastB').onclick = () => { S.from = 'home'; showResult(hs, false); };
        $('hLast').hidden = false;
      }
    } else {
      h.classList.add('empty');
      setAv($('hAv'), '', null);
      $('hLbl').textContent = S.items.length ? 'Chưa mở cuộc trò chuyện' : 'Chưa thấy tin nhắn';
      $('hName').textContent = S.items.length ? 'Chọn người bên dưới' : 'Mở trang Tin nhắn';
      $('hSub').textContent = S.items.length ? 'Chọn một hoặc nhiều người, script tự mở và đếm lần lượt' : 'Bấm biểu tượng tin nhắn của TikTok, rồi bấm ⟳';
      $('hBtns').hidden = true;
    }
  }
  function renderPeople() {
    const box = $('people');
    box.textContent = '';
    box.classList.toggle('anim', S.anim);
    S.anim = false;
    $('srch').hidden = S.items.length < 6;
    $('filt').hidden = S.items.length < 4 || !history.length;
    $('selAll').hidden = S.items.length < 2;
    if (!S.items.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = S.sc ? 'Không thấy danh sách người cạnh khung chat. Bấm “Đếm người này” ở thẻ phía trên để đếm người đang mở.' : 'Chưa thấy danh sách tin nhắn. Hãy mở trang Tin nhắn của TikTok rồi bấm ⟳.';
      box.appendChild(d);
      return;
    }
    const q = normName($('q').value);
    let shown = 0;
    S.items.forEach((it, i) => {
      const nm = it.name || `Người #${i + 1}`;
      if (q && !normName(nm).includes(q)) return;
      const hst = histFor(it);
      if ((S.filter === 'todo' && hst) || (S.filter === 'done' && !hst)) return;
      const isCur = !!S.sc && (it.active || !!(it.name && sameName(it.name, S.title)));
      const b = document.createElement('button');
      b.className = 'pr' + (S.sel.has(it.id) ? ' sel' : '');
      b.style.animationDelay = Math.min(shown * 30, 360) + 'ms';
      b.innerHTML = `<div class="av"></div><div class="pm"><div class="pn"><span class="t"></span></div><div class="ps"></div></div><div class="ck">${I.check}</div>`;
      setAv(b.querySelector('.av'), it.img, nm);
      b.querySelector('.t').textContent = nm;
      const pn = b.querySelector('.pn');
      if (isCur) { const tg = document.createElement('span'); tg.className = 'tag'; tg.textContent = 'ĐANG MỞ'; pn.appendChild(tg); }
      const rm = relOf(hst);
      if (rm) { const tg = document.createElement('span'); tg.className = 'rtag'; tg.textContent = rm.emoji; tg.title = rm.label; pn.appendChild(tg); }
      const ps = b.querySelector('.ps');
      if (hst) { ps.innerHTML = '<b></b> tin · '; ps.querySelector('b').textContent = fmt(hst.total); ps.append(ago(hst.at)); }
      else ps.textContent = !it.name ? 'Chưa biết tên · vẫn đếm được' : !it.sure ? 'Tên đoán theo thứ tự danh sách' : 'Chưa đếm';
      b.onclick = () => { if (S.sel.has(it.id)) S.sel.delete(it.id); else S.sel.add(it.id); b.classList.toggle('sel', S.sel.has(it.id)); renderCTA(); };
      box.appendChild(b);
      shown++;
    });
    if (!shown) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = 'Không có ai khớp.'; box.appendChild(d); }
  }
  const selected = () => S.items.filter(x => S.sel.has(x.id));
  function renderCTA() {
    const sel = selected(), go = $('go');
    $('selAll').textContent = S.items.length && S.items.every(x => S.sel.has(x.id)) ? 'Bỏ chọn' : 'Chọn tất cả';
    const quickN = (sel.length ? sel.map(x => histFor(x)) : S.sc ? [curHist()] : []).filter(canQuick).length;
    $('mode').hidden = !quickN;
    for (const b of $('mode').querySelectorAll('button')) b.classList.toggle('on', b.dataset.m === S.mode);
    const qtxt = quickN && S.mode === 'quick' ? ` · ⚡${sel.length > 1 ? ' ' + quickN + ' người' : ''}` : '';
    if (sel.length > 1) { go.disabled = false; $('goT').textContent = `Đếm ${sel.length} người${qtxt}`; }
    else if (sel.length === 1) { go.disabled = false; $('goT').textContent = `Đếm với ${sel[0].name || 'người đã chọn'}${qtxt}`; }
    else if (S.sc) { go.disabled = false; $('goT').textContent = `Đếm với ${S.title || 'người đang mở'}${qtxt}`; }
    else { go.disabled = true; $('goT').textContent = 'Chọn người để đếm'; }
    $('hint').textContent = quickN && S.mode === 'quick' ? '⚡ Người đã đếm đủ: chỉ tải tin mới rồi cộng dồn' : 'Tự mở · tự cuộn tới tin đầu tiên · nhớ giữ màn hình sáng';
  }
  for (const b of $('mode').querySelectorAll('button')) b.onclick = () => { S.mode = b.dataset.m; renderCTA(); };
  for (const b of $('filt').querySelectorAll('button')) b.onclick = () => { S.filter = b.dataset.f; for (const x of $('filt').querySelectorAll('button')) x.classList.toggle('on', x === b); renderPeople(); };
  $('q').oninput = renderPeople;
  $('selAll').onclick = () => { const all = S.items.every(x => S.sel.has(x.id)); S.sel.clear(); if (!all) S.items.forEach(x => S.sel.add(x.id)); renderPeople(); renderCTA(); };
  $('rescan').onclick = () => { S.anim = true; detect(true); toast(S.items.length ? `Thấy ${S.items.length} cuộc trò chuyện` : 'Chưa thấy danh sách tin nhắn'); };
  const toTarget = x => ({ id: x.id, el: x.el, k: x.k, name: x.name, sure: x.sure, img: x.img });
  $('go').onclick = () => run(selected().map(toTarget), S.mode);
  $('hGo').onclick = () => run([], 'full');
  $('hQuick').onclick = () => run([], 'quick');

  /* ---------- đảo trạng thái khi đang đếm ---------- */
  const LV = { spam: null, t0: 0, last: { total: 0, me: 0, them: 0, media: 0 }, base: 0, samples: [], rates: [], phase: '', name: '', timer: 0 };
  function liveStart(name, img, qi, n) {
    LV.t0 = Date.now(); LV.last = { total: 0, me: 0, them: 0, media: 0 }; LV.base = 0; LV.samples = []; LV.rates = []; LV.name = name || 'Cuộc trò chuyện';
    setAv($('fAv'), img, LV.name); setAv($('iAv'), img, LV.name);
    $('fName').textContent = LV.name;
    $('fQ').hidden = n <= 1; $('fQ').textContent = `${qi + 1}/${n}`;
    $('fMode').hidden = true; $('fUnit').textContent = 'tin';
    odoBig(0); odoMini(0);
    livePaint();
  }
  function livePaint() {
    const now = Date.now(), el = (now - LV.t0) / 1000, c = LV.last;
    $('fTime').textContent = mmss(el);
    $('fStep').textContent = LV.phase;
    odoBig(c.total); odoMini(c.total);
    const pm = c.total ? (c.me / c.total) * 100 : 50;
    $('fA').style.width = pm + '%'; $('fB').style.width = (100 - pm) + '%';
    $('fMe').textContent = `Bạn ${fmt(c.me)}`;
    $('fThem').textContent = `${short(LV.name, 16)} ${fmt(c.them)}`;
    LV.samples.push({ t: now, n: c.total });
    while (LV.samples.length > 2 && now - LV.samples[0].t > 3000) LV.samples.shift();
    const s0 = LV.samples[0];
    const rate = now - s0.t > 400 ? Math.max(0, (c.total - s0.n) / ((now - s0.t) / 1000)) : 0;
    LV.rates.push(rate); if (LV.rates.length > 90) LV.rates.shift();
    $('fRate').textContent = fmt(Math.round(rate));
    drawSpark($('spark'), LV.rates);
    if (LV.spam) {
      const sp = LV.spam, p = sp.n ? (sp.sent / sp.n) * 100 : 0;
      $('fA').style.width = p + '%'; $('fB').style.width = (100 - p) + '%';
      $('fMe').textContent = `Đã gửi ${fmt(sp.sent)}/${fmt(sp.n)}`;
      $('fThem').textContent = sp.fail ? `Lỗi ${fmt(sp.fail)}` : `Còn ${fmt(sp.n - sp.sent)}`;
    }
  }
  function drawSpark(cv, arr) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    if (arr.length < 2) return;
    const max = Math.max(20, ...arr) * 1.2, stepX = W / 89, x0 = W - (arr.length - 1) * stepX;
    const pts = arr.map((v, i) => [x0 + i * stepX, H - 8 - (v / max) * (H - 30)]);
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) { const [x, y] = pts[i], [px, py] = pts[i - 1]; g.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2); }
    const lp = pts[pts.length - 1];
    g.lineTo(lp[0], lp[1]);
    const line = g.createLinearGradient(0, 0, W, 0); line.addColorStop(0, '#25F4EE'); line.addColorStop(.6, '#8B5CF6'); line.addColorStop(1, '#FE2C55');
    g.strokeStyle = line; g.lineWidth = 4; g.lineJoin = 'round'; g.lineCap = 'round'; g.stroke();
    g.lineTo(lp[0], H); g.lineTo(pts[0][0], H); g.closePath();
    const fill = g.createLinearGradient(0, 0, 0, H); fill.addColorStop(0, 'rgba(139,92,246,.35)'); fill.addColorStop(1, 'rgba(139,92,246,0)');
    g.fillStyle = fill; g.fill();
    g.beginPath(); g.arc(lp[0] - 3, lp[1], 6, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
  }
  function islandOn(on) {
    island.hidden = !on;
    if (on) island.classList.remove('mini');
    fab.hidden = on || sheet.classList.contains('on');
  }
  $('fMin').onclick = () => island.classList.add('mini');
  $('imini').onclick = () => island.classList.remove('mini');
  $('fStop').onclick = () => { S.stop = true; $('fStop').textContent = 'Đang dừng…'; };

  let wake = null;
  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator) wake = await navigator.wakeLock.request('screen');
      else if (!on && wake) { await wake.release(); wake = null; }
    } catch {}
  }

  /* ---------- chạy đếm (một hoặc nhiều người) ---------- */
  function relSummary(an, name) {
    const d = an ? AN.derive(an, name) : null;
    if (!d) return {};
    return { rel: { id: d.rel.id, p: Math.round(d.rel.conf * 100), who: d.rel.who }, tp: d.topics.slice(0, 3).map(t => t.id) };
  }
  async function run(targets, mode) {
    if (S.running) return;
    S.running = true; S.stop = false;
    closeSheet(); islandOn(true);
    $('fStop').textContent = 'Dừng';
    keepAwake(true);
    LV.timer = setInterval(livePaint, 400);
    const queue = targets.length ? targets : [null];
    const done = [];
    let fatal = null;
    for (let qi = 0; qi < queue.length && !S.stop; qi++) {
      const tg = queue[qi];
      const curName = tg ? tg.name : S.title;
      liveStart(curName, tg ? tg.img : (S.items.find(x => x.active) || S.items.find(x => x.name && sameName(x.name, S.title)) || {}).img || (S.sc ? chatAvatar(S.sc) : ''), qi, queue.length);
      LV.phase = 'Đang chuẩn bị…';
      try {
        if (tg) await openTarget(tg, p => { LV.phase = p; }, () => S.stop);
        const sc = findScroller();
        const title = sc ? findTitle(sc) : '';
        if (title) { LV.name = title; $('fName').textContent = title; }
        const avNow = sc ? chatAvatar(sc) : '';
        const key = (tg && tg.k) || (avNow ? avKey(avNow) : '') || ((S.items.find(x => x.active) || {}).k) || '';
        const prev = histFor({ k: key, name: title || (tg && tg.name) });
        const quick = mode === 'quick' && canQuick(prev);
        $('fMode').hidden = !quick;
        if (quick) { $('fUnit').textContent = 'tin mới'; }
        const t0 = Date.now();
        LV.phase = quick ? 'Đang tải tin mới…' : 'Đang tải tin cũ hơn…';
        const res = await countAll({
          anchor: quick ? prev.anchor : null,
          shouldStop: () => S.stop,
          onProgress: (c, ph, left) => {
            LV.last = c;
            LV.phase = ph === 'sweep' ? 'Đang gom tin từng đoạn…' : ph === 'wait' ? `Đang chờ TikTok gửi thêm… ${left}s` : quick ? 'Đang tìm chỗ đếm lần trước…' : 'Đang tải tin cũ hơn…';
          },
        });
        LV.last = res; livePaint();
        S.lastScroll = res.scrollInfo;
        const name = res.title || (tg && tg.name) || 'Cuộc trò chuyện';
        let an = null;
        if (CFG.analyze && res.msgs && res.msgs.length) {
          LV.phase = 'Đang phân tích nội dung…'; livePaint();
          an = await AN.build(res.msgs, p => { LV.phase = `Đang phân tích nội dung… ${Math.round(p * 100)}%`; });
        }
        const shareN = res.msgs ? res.msgs.filter(m => m.kind === 'share').length : 0;
        res.msgs = null;
        let rec;
        if (res.incremental && prev) {
          rec = { ...prev, name, total: prev.total + res.total, me: prev.me + res.me, them: prev.them + res.them, media: (prev.media || 0) + res.media, share: (prev.share || 0) + shareN,
            added: res.total, prevAt: prev.at, an: CFG.analyze ? AN.merge(prev.an, an) : prev.an, anPartial: CFG.analyze && !prev.an && !!an };
          if (!rec.img) rec.img = (tg && tg.img) || res.avatar || '';
          if (res.anchor.length) rec.anchor = res.anchor;
        } else {
          rec = { name, k: key, img: (tg && tg.img) || res.avatar || '', total: res.total, me: res.me, them: res.them, media: res.media, share: shareN, an, anchor: res.anchor, added: 0, prevAt: 0 };
        }
        Object.assign(rec, { secs: (Date.now() - t0) / 1000, at: Date.now(), complete: res.complete, lossy: res.lossy, incremental: res.incremental, live: true }, relSummary(rec.an, name));
        done.push(rec);
        if (res.complete && rec.total) saveHistory(rec);
      } catch (e) {
        const msg = String((e && e.message) || e);
        done.push({ error: msg, name: curName || '' });
        if (queue.length === 1) fatal = msg;
      }
    }
    clearInterval(LV.timer);
    keepAwake(false);
    S.running = false;
    S.sel.clear();
    islandOn(false);
    if (fatal) { openSheet('home'); toast('⚠ ' + fatal, 6500); return; }
    const ok = done.filter(d => !d.error);
    S.from = queue.length > 1 ? 'rank' : 'home';
    if (queue.length === 1 && ok.length === 1) { openSheet(); showResult(ok[0], true); }
    else { openSheet(); show('rank'); renderRank(done); if (ok.length) confetti(); }
  }

  /* ---------- trang kết quả ---------- */
  function countUp(el, to) {
    const t0 = performance.now(), d = 1100;
    const f = t => { const k = Math.min(1, (t - t0) / d), e = 1 - Math.pow(1 - k, 4); el.textContent = fmt(Math.round(to * e)); if (k < 1) requestAnimationFrame(f); };
    requestAnimationFrame(f);
  }
  const crownText = r => {
    if (!r.total) return '';
    if (r.me === r.them) return '⚖️ Hai bạn nhắn ngang nhau';
    const big = Math.max(r.me, r.them), small = Math.min(r.me, r.them);
    const more = small ? Math.round(((big - small) / small) * 100) + '%' : 'hẳn';
    return r.me > r.them ? `👑 Bạn nhắn nhiều hơn ${more}` : `👑 ${short(r.name, 18)} nhắn nhiều hơn ${more}`;
  };
  function setTab(t) {
    S.tab = t;
    for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.t === t);
    for (const [k, id] of [['ov', 'tOv'], ['tp', 'tTp'], ['rl', 'tRl'], ['hb', 'tHb']]) $(id).hidden = k !== t;
    const tb = $('tabs'); $('body').scrollTop = Math.min($('body').scrollTop, tb.offsetTop);
  }
  for (const b of $('tabs').querySelectorAll('button')) b.onclick = () => setTab(b.dataset.t);
  $('wRel').onclick = () => setTab('rl');

  function showResult(r, fresh) {
    S.last = r;
    show('res');
    $('rBackT').textContent = S.from === 'rank' ? 'Bảng xếp hạng' : 'Quay lại';
    const D = r.an ? AN.derive(r.an, short(r.name, 14)) : null;
    S.lastD = D;
    setTab('ov');
    setAv($('wAv'), r.img, r.name);
    $('wName').textContent = r.name;
    $('wDate').textContent = dstr(r.at || Date.now());
    countUp($('wBig'), r.total);
    $('wInc').hidden = !r.prevAt;
    if (r.prevAt) $('wInc').textContent = r.added ? `⚡ +${fmt(r.added)} tin mới kể từ ${dstr(r.prevAt)}` : `⚡ Không có tin mới kể từ ${dstr(r.prevAt)}`;
    const pm = r.total ? (r.me / r.total) * 100 : 50;
    $('wA').style.width = '50%'; $('wB').style.width = '50%';
    requestAnimationFrame(() => requestAnimationFrame(() => { $('wA').style.width = pm + '%'; $('wB').style.width = 100 - pm + '%'; }));
    $('wMe').textContent = fmt(r.me); $('wMeL').textContent = `Bạn · ${Math.round(pm)}%`;
    $('wThem').textContent = fmt(r.them); $('wThemL').textContent = `${short(r.name, 16)} · ${100 - Math.round(pm)}%`;
    const cr = crownText(r);
    $('wCrown').hidden = !cr; $('wCrown').textContent = cr;
    $('wRel').hidden = !D;
    if (D) { $('wRelE').textContent = D.rel.emoji; $('wRelL').textContent = D.rel.label; $('wRelP').textContent = Math.round(D.rel.conf * 100) + '%'; }
    const tp = $('wTp'); tp.textContent = '';
    if (D) for (const t of D.topics.slice(0, 3)) { const s = document.createElement('span'); s.textContent = `${t.icon} ${t.name}`; tp.appendChild(s); }
    const chips = $('wChips'); chips.textContent = '';
    const chip = (v, l) => { const d = document.createElement('div'); d.className = 'chip'; d.innerHTML = '<b></b><small></small>'; d.querySelector('b').textContent = v; d.querySelector('small').textContent = l; chips.appendChild(d); };
    chip(fmt(Math.max(0, (r.media || 0) - (r.share || 0))), 'ảnh · sticker');
    chip(fmt(r.share || 0), 'video chia sẻ');
    chip(D && D.habits.perDay ? fmt(Math.round(D.habits.perDay)) : '—', 'tin / ngày');
    chip(r.secs ? durShort(r.secs) : '—', 'thời gian đếm');
    $('wOk').textContent = r.complete && r.total ? (r.prevAt ? '✓ Đã cộng dồn với lần đếm trước' : '✓ Đã tải tới tin nhắn đầu tiên') : '';
    const w = $('wWarn');
    const warn = r.complete === false ? 'Bạn đã dừng giữa chừng, nên số này mới tính phần lịch sử đã tải. Bấm “Đếm tiếp” để tải nốt.' :
      !r.total ? 'Không nhận diện được tin nào trong khung chat. Vào Cài đặt → “Báo cáo lỗi”, rồi gửi nội dung đó cho người sửa script.' :
      r.lossy ? 'TikTok có vẻ đã gỡ bớt tin cũ khỏi trang trong lúc cuộn, nên số có thể thiếu một ít.' :
      r.anPartial ? 'Lần đếm trước chưa có phân tích nội dung, nên phần Chủ đề / Quan hệ chỉ dựa trên tin mới. Bấm “Đếm lại” để phân tích toàn bộ.' : '';
    w.hidden = !warn; w.textContent = warn;
    $('rAgainT').textContent = r.complete === false ? 'Đếm tiếp' : 'Đếm lại';
    renderTopics(r, D); renderRel(r, D); renderHabits(r, D);
    S.cardBlob = null;
    makeCard(r, D).then(b => { if (S.last === r) S.cardBlob = b; }).catch(() => {});
    if (fresh && r.total) confetti();
  }
  const noData = () => `<div class="na">${CFG.analyze ? 'Chưa có dữ liệu phân tích cho người này (đếm bằng bản cũ hoặc chưa đếm xong).' : 'Bạn đang tắt “Phân tích nội dung” trong Cài đặt.'}<button data-act="again">Đếm lại để phân tích</button></div>`;
  function bindNa(box) { const b = box.querySelector('[data-act="again"]'); if (b) b.onclick = () => $('rAgain').onclick(); }

  function renderTopics(r, D) {
    const box = $('tTp');
    if (!D) { box.innerHTML = noData(); bindNa(box); return; }
    const them = esc(short(r.name, 14));
    const t3 = D.topics.slice(0, 3);
    let h = `<div class="sum">${t3.length ? `Hai bạn hay nói về ${t3.map(t => `<b>${t.icon} ${esc(t.name.toLowerCase())}</b>`).join(t3.length > 2 ? ', ' : ' và ').replace(/, ([^,]*)$/, ' và $1')}` : 'Chưa nhận ra chủ đề nào thật rõ ràng — có lẽ toàn nói chuyện phiếm 😄'}</div>`;
    if (D.topics.length) {
      const mx = D.topics[0].n;
      h += `<div class="card"><div class="ch"><span>Chủ đề</span><span class="lg"><span><i class="a"></i>Bạn</span><span><i class="b"></i>${them}</span></span></div>`;
      for (const t of D.topics) {
        const w = (t.n / mx) * 100;
        h += `<div class="trow"><div class="ti">${t.icon}</div><div class="tm"><div class="tn"><b>${esc(t.name)}</b><span>${Math.round(t.pct * 100)}%</span></div><div class="tb"><i class="a" style="width:${(w * t.me / t.n).toFixed(1)}%"></i><i class="b" style="width:${(w * t.them / t.n).toFixed(1)}%"></i></div></div></div>`;
      }
      h += '</div>';
    }
    if (D.words.length) {
      const mx = D.words[0].n, mn = D.words[D.words.length - 1].n;
      h += '<div class="card"><div class="ch"><span>Từ khoá hay nhắc</span></div><div class="cloud">';
      for (const x of D.words) {
        const k = mx === mn ? 0.5 : (x.n - mn) / (mx - mn);
        const cls = x.me / x.n >= 0.7 ? 'm' : x.them / x.n >= 0.7 ? 't' : '';
        h += `<span class="${cls}" style="font-size:${(12.5 + k * 6).toFixed(1)}px">${esc(x.w)}<small>${fmt(x.n)}</small></span>`;
      }
      h += '</div></div>';
    }
    if (D.emojis.length) {
      h += '<div class="card"><div class="ch"><span>Emoji yêu thích</span></div><div class="emos">';
      for (const e of D.emojis) h += `<div><b>${esc(e.e)}</b><small>${fmt(e.n)}</small></div>`;
      h += '</div></div>';
    }
    if (D.catch[0] || D.catch[1]) h += `<div class="card"><div class="ch"><span>Câu cửa miệng</span></div><div class="cp"><div><small>Bạn hay nói</small><b>${D.catch[0] ? '“' + esc(D.catch[0]) + '”' : '—'}</b></div><div><small>${them} hay nói</small><b>${D.catch[1] ? '“' + esc(D.catch[1]) + '”' : '—'}</b></div></div></div>`;
    box.innerHTML = h;
  }
  function renderRel(r, D) {
    const box = $('tRl');
    if (!D) { box.innerHTML = noData(); bindNa(box); return; }
    const R = D.rel, g = R.gauges, them = esc(short(r.name, 12));
    let h = `<div class="relc" style="--g1:${R.grad[0]};--g2:${R.grad[1]}"><div class="rele">${R.emoji}</div><div class="rell">MÁY ĐOÁN HAI BẠN LÀ</div><div class="reln">${esc(R.label)}</div>
      <div class="reld">${esc(R.desc)}</div><div class="relp"><div><i style="width:${Math.round(R.conf * 100)}%"></i></div><span>Độ chắc ${Math.round(R.conf * 100)}%</span></div></div>`;
    const gauge = (v, l, c) => `<div class="gauge"><div class="gr" style="--v:${v};--gc:${c}"><b>${v}</b></div><small>${l}</small></div>`;
    h += `<div class="card"><div class="ch"><span>Chỉ số</span></div><div class="gg">${gauge(g.close, 'Độ thân thiết', 'var(--c)')}${gauge(g.romance, 'Độ “tình”', 'var(--p)')}${gauge(g.balance, 'Độ cân bằng', 'var(--y)')}${gauge(g.init, 'Bạn chủ động', 'var(--v)')}</div></div>`;
    if (R.reasons.length) h += `<div class="card"><div class="ch"><span>Vì sao máy đoán vậy?</span></div><ul class="why">${R.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
    h += '<div class="card"><div class="ch"><span>Các khả năng khác</span></div>';
    for (const p of R.probs.slice(0, 6)) h += `<div class="prow"><span class="pe">${p.emoji}</span><span class="pl">${esc(p.label)}</span><span class="pb"><i style="width:${Math.max(2, Math.round(p.p * 100))}%"></i></span><span class="pv">${Math.round(p.p * 100)}%</span></div>`;
    h += `</div><p class="disc">🎲 Chỉ mang tính giải trí: máy đoán dựa trên cách xưng hô, từ ngữ, giờ giấc và độ “nhiệt” của hai bên (${fmt(D.N)} tin) — có thể sai, đừng giận ${them} nha 😉</p>`;
    box.innerHTML = h;
  }
  function renderHabits(r, D) {
    const box = $('tHb');
    if (!D) { box.innerHTML = noData(); bindNa(box); return; }
    const H = D.habits, them = esc(short(r.name, 10));
    const tile = (l, v, s) => `<div class="tile"><small>${l}</small><b>${v}</b>${s ? `<span>${s}</span>` : ''}</div>`;
    let h = '<div class="tiles">';
    if (H.hasTs) {
      h += tile('Nhắn với nhau từ', H.first ? dstr(H.first) : '—', H.first ? ago(H.first).replace('trước', 'trước') : '');
      h += tile('Số ngày có nhắn', fmt(H.active), H.perDay ? `~${fmt(Math.round(H.perDay))} tin mỗi ngày` : '');
      h += tile('Ngày sôi nổi nhất', H.busiest ? dkey(H.busiest.d) : '—', H.busiest ? `${fmt(H.busiest.n)} tin` : '');
      h += tile('Giờ hay nhắn nhất', H.peak >= 0 ? `${H.peak}h – ${(H.peak + 1) % 24}h` : '—', `${Math.round(H.night * 100)}% lúc đêm khuya`);
    }
    h += tile('Nhắn liền tay dài nhất', fmt(Math.max(H.run[0], H.run[1])) + ' tin', H.run[0] >= H.run[1] ? 'kỷ lục của bạn' : `kỷ lục của ${them}`);
    h += tile('Tin dài nhất', fmt(Math.max(H.ml[0], H.ml[1])) + ' ký tự', H.ml[0] >= H.ml[1] ? 'do bạn viết' : `do ${them} viết`);
    h += '</div>';
    if (H.hasTs) {
      const mx = Math.max(1, ...H.hr);
      h += `<div class="card"><div class="ch"><span>Nhắn lúc mấy giờ</span></div><div class="bars">${H.hr.map((v, i) => `<i class="${i === H.peak ? 'pk' : ''}" style="height:${Math.max(3, (v / mx) * 100).toFixed(1)}%;animation-delay:${i * 15}ms" title="${i}h: ${v}"></i>`).join('')}</div><div class="axis"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div></div>`;
      const order = [1, 2, 3, 4, 5, 6, 0], lab = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'], mw = Math.max(1, ...H.dw);
      const pk = H.dw.indexOf(Math.max(...H.dw));
      h += `<div class="card"><div class="ch"><span>Thứ trong tuần</span></div><div class="bars" style="height:70px">${order.map((d, i) => `<i class="${d === pk ? 'pk' : ''}" style="height:${Math.max(3, (H.dw[d] / mw) * 100).toFixed(1)}%;animation-delay:${i * 30}ms"></i>`).join('')}</div><div class="axis d7">${lab.map(x => `<span>${x}</span>`).join('')}</div></div>`;
    } else h += '<div class="na" style="margin-top:10px">TikTok không hiện mốc giờ trong cuộc trò chuyện này, nên phần giờ giấc tạm ẩn.</div>';
    const row = (l, a, b, fa, fb) => {
      const s = a + b, p = s ? (a / s) * 100 : 50;
      return `<div class="cmp"><span class="l">${fa}</span><div class="mid"><small>${l}</small><div class="cb"><i class="a" style="width:${p.toFixed(1)}%"></i><i class="b" style="width:${(100 - p).toFixed(1)}%"></i></div></div><span class="r">${fb}</span></div>`;
    };
    const n = [r.me, r.them];
    h += `<div class="card"><div class="ch"><span>So kè hai bên</span></div><div class="cmph"><span>Bạn</span><span></span><span>${them}</span></div>`;
    h += row('Tin nhắn', n[0], n[1], fmt(n[0]), fmt(n[1]));
    h += row('Độ dài trung bình (ký tự)', H.len[0], H.len[1], fmt(Math.round(H.len[0])), fmt(Math.round(H.len[1])));
    h += row('Câu hỏi', H.q[0], H.q[1], fmt(H.q[0]), fmt(H.q[1]));
    h += row('Hay mở lời trước', H.st[0], H.st[1], fmt(H.st[0]), fmt(H.st[1]));
    h += row('Trả lời cụt lủn', H.dry[0], H.dry[1], Math.round(H.dry[0] * 100) + '%', Math.round(H.dry[1] * 100) + '%');
    h += row('Cười haha', H.lau[0], H.lau[1], fmt(H.lau[0]), fmt(H.lau[1]));
    h += row('Emoji', H.emo[0], H.emo[1], fmt(H.emo[0]), fmt(H.emo[1]));
    h += row('Ảnh / video', H.med[0] + H.sh[0], H.med[1] + H.sh[1], fmt(H.med[0] + H.sh[0]), fmt(H.med[1] + H.sh[1]));
    h += '</div>';
    box.innerHTML = h;
  }

  $('rAgain').onclick = () => {
    const r = S.last; if (!r) return;
    const sc = findScroller();
    if (sc && sameName(findTitle(sc), r.name)) { run([], 'full'); return; }
    const it = scanItems(sc).find(x => (r.k && x.k === r.k) || (x.name && sameName(x.name, r.name)));
    if (it) run([toTarget(it)], 'full');
    else toast(`Không thấy ${r.name} trong danh sách hiện tại. Hãy mở trang Tin nhắn rồi thử lại.`, 4000);
  };
  $('rCopy').onclick = async () => {
    const r = S.last; if (!r) return;
    const D = S.lastD;
    let text = `Mình và ${r.name} đã nhắn ${fmt(r.total)} tin trên TikTok (mình ${fmt(r.me)}, ${r.name} ${fmt(r.them)}).`;
    if (D) {
      if (D.topics.length) text += `\nHay nói về: ${D.topics.slice(0, 3).map(t => t.icon + ' ' + t.name).join(', ')}.`;
      text += `\nMáy đoán: ${D.rel.emoji} ${D.rel.label} (${Math.round(D.rel.conf * 100)}%).`;
    }
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
      root.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch {} ta.remove();
    }
    toast(ok ? 'Đã chép kết quả ✓' : 'Không chép được trên trình duyệt này');
  };
  $('rShare').onclick = async () => {
    const r = S.last; if (!r) return;
    try {
      const blob = S.cardBlob || await makeCard(r, S.lastD);
      const file = new File([blob], `tin-nhan-${normName(r.name) || 'tiktok'}.png`, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: 'Đếm tin nhắn TikTok' }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = file.name; root.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast('Đã tạo ảnh kết quả ✓');
    } catch { toast('Không tạo được ảnh trên trình duyệt này'); }
  };

  // ảnh kết quả 1080×1350 để lưu / chia sẻ
  function makeCard(r, D) {
    const W = 1080, H = 1350, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const F = (w, s) => `${w} ${s}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif`;
    g.fillStyle = '#0b0b12'; g.fillRect(0, 0, W, H);
    const blob = (x, y, rad, col) => { const gr = g.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(11,11,18,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, H); };
    blob(170, 170, 760, 'rgba(37,244,238,.45)'); blob(950, 260, 700, 'rgba(254,44,85,.45)'); blob(540, 1420, 860, 'rgba(139,92,246,.45)');
    const shade = g.createLinearGradient(0, 0, 0, H); shade.addColorStop(0, 'rgba(9,9,15,.1)'); shade.addColorStop(.75, 'rgba(9,9,15,.72)'); g.fillStyle = shade; g.fillRect(0, 0, W, H);
    const pill = (x, y, w, h, rad) => { g.beginPath(); g.moveTo(x + rad, y); g.arcTo(x + w, y, x + w, y + h, rad); g.arcTo(x + w, y + h, x, y + h, rad); g.arcTo(x, y + h, x, y, rad); g.arcTo(x, y, x + w, y, rad); g.closePath(); };
    const fit = (txt, w, size, weight) => { let s = size; g.font = F(weight, s); while (g.measureText(txt).width > w && s > 20) { s -= 2; g.font = F(weight, s); } return s; };
    g.textBaseline = 'alphabetic';
    pill(90, 70, 330, 62, 31); g.fillStyle = 'rgba(0,0,0,.35)'; g.fill(); g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 2; g.stroke();
    g.fillStyle = '#fff'; g.font = F(900, 28); g.textAlign = 'center'; g.fillText('TIN NHẮN TIKTOK', 255, 111);
    g.textAlign = 'right'; g.font = F(600, 32); g.fillStyle = 'rgba(255,255,255,.8)'; g.fillText(dstr(r.at || Date.now()), W - 90, 112);
    const circle = (cx, cy, rad, c1, c2, ch, tc) => {
      const gr = g.createLinearGradient(cx - rad, cy - rad, cx + rad, cy + rad); gr.addColorStop(0, c1); gr.addColorStop(1, c2);
      g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fillStyle = gr; g.fill(); g.lineWidth = 12; g.strokeStyle = '#0b0b12'; g.stroke();
      g.fillStyle = tc; g.font = F(850, rad * 0.95); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(ch, cx, cy + 4); g.textBaseline = 'alphabetic';
    };
    const gr2 = GRADS[Math.abs(hashStr(normName(r.name) || '?')) % GRADS.length];
    circle(480, 255, 90, '#25F4EE', '#0ea5b7', 'B', '#00262a');
    circle(600, 255, 90, gr2[0], gr2[1], initial(r.name), '#fff');
    g.textAlign = 'center'; g.fillStyle = '#fff'; fit(`Bạn & ${r.name}`, 900, 50, 800); g.fillText(`Bạn & ${r.name}`, W / 2, 425);
    const num = fmt(r.total);
    fit(num, 940, 230, 900);
    const ng = g.createLinearGradient(0, 480, W, 660); ng.addColorStop(0, '#ffffff'); ng.addColorStop(.5, '#c6fbf9'); ng.addColorStop(1, '#ffd0dc');
    g.fillStyle = ng; g.shadowColor = 'rgba(37,244,238,.35)'; g.shadowBlur = 40; g.fillText(num, W / 2, 655); g.shadowBlur = 0;
    g.font = F(600, 40); g.fillStyle = 'rgba(255,255,255,.82)'; g.fillText('tin nhắn đã gửi cho nhau', W / 2, 728);
    const bx = 90, bw = W - 180, by = 785, bh = 30, pm = r.total ? r.me / r.total : 0.5;
    const lw = Math.max(bh, bw * pm - 5), rw = Math.max(bh, bw * (1 - pm) - 5);
    const la = g.createLinearGradient(bx, 0, bx + lw, 0); la.addColorStop(0, '#0ee6e0'); la.addColorStop(1, '#25F4EE');
    pill(bx, by, Math.min(lw, bw - bh - 10), bh, bh / 2); g.fillStyle = la; g.fill();
    const ra = g.createLinearGradient(bx + bw - rw, 0, bx + bw, 0); ra.addColorStop(0, '#FE2C55'); ra.addColorStop(1, '#ff6b8e');
    pill(bx + bw - Math.min(rw, bw - bh - 10), by, Math.min(rw, bw - bh - 10), bh, bh / 2); g.fillStyle = ra; g.fill();
    g.textAlign = 'left'; g.fillStyle = '#fff'; g.font = F(850, 62); g.fillText(fmt(r.me), bx, 892);
    g.font = F(600, 30); g.fillStyle = 'rgba(255,255,255,.8)'; g.fillText(`Bạn · ${Math.round(pm * 100)}%`, bx, 934);
    g.textAlign = 'right'; g.fillStyle = '#fff'; g.font = F(850, 62); g.fillText(fmt(r.them), bx + bw, 892);
    g.font = F(600, 30); g.fillStyle = 'rgba(255,255,255,.8)'; g.fillText(`${short(r.name, 18)} · ${100 - Math.round(pm * 100)}%`, bx + bw, 934);
    let y = 985;
    if (D) {
      const R = D.rel;
      pill(90, y, W - 180, 120, 34);
      const rg = g.createLinearGradient(90, y, W - 90, y + 120); rg.addColorStop(0, R.grad[0] + '55'); rg.addColorStop(1, R.grad[1] + '55');
      g.fillStyle = rg; g.fill(); g.strokeStyle = 'rgba(255,255,255,.28)'; g.lineWidth = 2; g.stroke();
      g.textAlign = 'left'; g.font = F(400, 64); g.fillStyle = '#fff'; g.fillText(R.emoji, 125, y + 84);
      g.font = F(800, 24); g.fillStyle = 'rgba(255,255,255,.75)'; g.fillText('MÁY ĐOÁN HAI BẠN LÀ', 225, y + 48);
      fit(R.label, 560, 46, 900); g.fillStyle = '#fff'; g.fillText(R.label, 225, y + 96);
      g.textAlign = 'right'; g.font = F(900, 44); g.fillText(Math.round(R.conf * 100) + '%', W - 125, y + 78);
      y += 150;
      if (D.topics.length) {
        const tt = 'Hay nói về: ' + D.topics.slice(0, 3).map(t => t.icon + ' ' + t.name).join('  ·  ');
        g.textAlign = 'center'; fit(tt, 900, 32, 700); g.fillStyle = 'rgba(255,255,255,.9)'; g.fillText(tt, W / 2, y + 20);
        y += 60;
      }
    } else {
      const cr = crownText(r);
      if (cr) {
        g.font = F(750, 36); const tw = Math.min(900, g.measureText(cr).width + 70);
        pill((W - tw) / 2, y, tw, 74, 26); g.fillStyle = 'rgba(255,197,61,.14)'; g.fill(); g.strokeStyle = 'rgba(255,197,61,.35)'; g.lineWidth = 2; g.stroke();
        g.textAlign = 'center'; g.fillStyle = '#FFD66B'; g.fillText(cr, W / 2, y + 49);
      }
    }
    g.font = F(600, 26); g.fillStyle = 'rgba(255,255,255,.5)'; g.textAlign = 'center';
    g.fillText(r.complete === false ? 'Đếm một phần lịch sử' : '✓ Đếm toàn bộ tới tin nhắn đầu tiên', W / 2, 1300);
    return new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'));
  }

  // pháo giấy
  function confetti() {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const cv = $('fx'), dpr = Math.min(2, window.devicePixelRatio || 1), Wv = window.innerWidth, Hv = window.innerHeight;
    cv.width = Wv * dpr; cv.height = Hv * dpr; cv.hidden = false;
    const g = cv.getContext('2d'); g.scale(dpr, dpr);
    const cols = ['#25F4EE', '#FE2C55', '#8B5CF6', '#FFC53D', '#ffffff'];
    const P = Array.from({ length: 160 }, (_, i) => {
      const side = i % 2 ? 1 : -1;
      return { x: Wv / 2 + side * Wv * 0.25, y: Hv * 0.55, vx: -side * (2 + Math.random() * 9) + (Math.random() - 0.5) * 4, vy: -(9 + Math.random() * 13),
        w: 6 + Math.random() * 6, h: 9 + Math.random() * 10, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.35, c: cols[(Math.random() * cols.length) | 0] };
    });
    const t0 = performance.now();
    const frame = t => {
      const k = (t - t0) / 2000;
      g.clearRect(0, 0, Wv, Hv);
      for (const p of P) {
        p.vy += 0.38; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.globalAlpha = Math.max(0, 1 - k * k);
        g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 1.4)) + 1); g.restore();
      }
      if (k < 1) requestAnimationFrame(frame); else { g.clearRect(0, 0, Wv, Hv); cv.hidden = true; }
    };
    requestAnimationFrame(frame);
  }

  /* ---------- bảng xếp hạng ---------- */
  function renderRank(batch) {
    const list = [...history].sort((a, b) => b.total - a.total);
    const pod = $('podium'), rl = $('rlist'), sum = $('kSum');
    pod.textContent = ''; rl.textContent = ''; sum.textContent = '';
    const errs = (batch || []).filter(d => d.error);
    const tot = list.reduce((a, x) => a + (x.total || 0), 0);
    $('kSub').textContent = batch && batch.length > 1
      ? `Vừa đếm xong ${batch.length - errs.length}/${batch.length} người${errs.length ? ' · ' + errs.length + ' người lỗi (xem bên dưới)' : ''}`
      : list.length ? `Tổng ${fmt(tot)} tin với ${list.length} người · nhiều nhất ở trên` : 'Chưa có ai. Đếm xong một người là họ sẽ xuất hiện ở đây.';
    // đếm theo loại quan hệ
    const kinds = new Map();
    for (const x of list) { const m = relOf(x); if (m) kinds.set(m.label, { e: m.emoji, n: ((kinds.get(m.label) || {}).n || 0) + 1 }); }
    for (const [l, v] of kinds) { const s = document.createElement('span'); s.textContent = `${v.e} ${l} · ${v.n}`; sum.appendChild(s); }
    const fresh = new Set((batch || []).filter(d => !d.error).map(d => d.k || 'n:' + normName(d.name)));
    const open = r => { S.from = 'rank'; showResult(r, false); };
    const medal = ['🥇', '🥈', '🥉'];
    [1, 0, 2].forEach((pos, j) => {
      const r = list[pos]; if (!r) return;
      const d = document.createElement('button');
      d.className = `pod p${pos + 1}`; d.style.animationDelay = j * 90 + 'ms';
      d.innerHTML = '<div class="av"></div><div class="nm"></div><div class="n"></div><div class="base"></div>';
      setAv(d.querySelector('.av'), r.img, r.name);
      d.querySelector('.nm').textContent = r.name;
      d.querySelector('.n').textContent = fmt(r.total);
      d.querySelector('.base').textContent = medal[pos];
      d.onclick = () => open(r);
      pod.appendChild(d);
    });
    const max = list[0] ? list[0].total : 1;
    list.forEach((r, i) => {
      const b = document.createElement('button');
      b.className = 'rl'; b.style.animationDelay = Math.min(i * 35, 400) + 'ms';
      b.innerHTML = '<div class="rk"></div><div class="av"></div><div class="rm"><div class="nm"></div><div class="bar"><i></i></div></div><div class="n"></div>';
      b.querySelector('.rk').textContent = i + 1;
      setAv(b.querySelector('.av'), r.img, r.name);
      b.querySelector('.nm').textContent = (fresh.has(r.k || 'n:' + normName(r.name)) ? '● ' : '') + r.name;
      b.querySelector('.bar i').style.width = Math.max(3, (r.total / max) * 100) + '%';
      const n = b.querySelector('.n'); n.textContent = fmt(r.total);
      const m = relOf(r); if (m) { const s = document.createElement('small'); s.textContent = m.emoji; s.title = m.label; n.appendChild(s); }
      b.onclick = () => open(r);
      rl.appendChild(b);
    });
    for (const e of errs) {
      const b = document.createElement('div');
      b.className = 'rl err';
      b.innerHTML = '<div class="rk">!</div><div class="rm"><div class="nm"></div></div><div class="n"></div>';
      b.querySelector('.nm').textContent = e.name || 'Không rõ';
      b.querySelector('.n').textContent = short(e.error, 60);
      rl.appendChild(b);
    }
    $('kClear').hidden = !list.length;
  }
  let clearArm = 0;
  $('kClear').onclick = () => {
    if (Date.now() - clearArm > 3000) { clearArm = Date.now(); $('kClear').textContent = 'Bấm lần nữa để xoá hết'; setTimeout(() => { $('kClear').textContent = 'Xoá lịch sử'; }, 3000); return; }
    history = []; persistHistory(); $('kClear').textContent = 'Xoá lịch sử'; renderRank(); toast('Đã xoá lịch sử');
  };


  /* ---------- spam nhãn dán / emoji ---------- */
  // TikTok bản web không có bảng nhãn dán → script tự vẽ nhãn dán rồi gửi như một tấm ảnh (qua nút gửi ảnh của TikTok)
  const SP = Object.assign({ kind: 'sticker', stk: 'p:0', stkRand: false, text: '❤️', rand: false, n: 10, spd: 1000, jit: true }, store.get('dmcSpam2') || {});
  const saveSP = () => store.set('dmcSpam2', { kind: SP.kind, stk: SP.stk, stkRand: SP.stkRand, text: SP.text, rand: SP.rand, n: SP.n, spd: SP.spd, jit: SP.jit });
  let MY = Array.isArray(store.get('dmcStk')) ? store.get('dmcStk') : []; // nhãn dán của bạn: {id, e, c} (tự tạo) hoặc {id, img} (ảnh)
  const saveMY = () => { MY = MY.slice(-16); if (!store.set('dmcStk', MY)) { MY.shift(); store.set('dmcStk', MY); toast('Bộ nhớ đầy, đã bỏ bớt nhãn dán cũ nhất'); } };
  const SP_SPEEDS = [[2000, '🐢 Chậm', '2 giây/lần'], [1000, 'Vừa', '1 giây/lần'], [600, '⚡ Nhanh', '0,6 giây/lần'], [350, '🚀 Siêu tốc', '0,35 giây/lần']];
  const SP_EMO = ['❤️', '😂', '🥺', '😘', '🔥', '👍', '🤡', '💀', '🙄', '😭', '🫶', '🐧'];
  const PACK = [['😴', 'ngủ ngon nha'], ['🥺', 'nhớ quá à'], ['😘', 'moah moah'], ['🫶', 'thương nhiều'], ['😭', 'huhu'], ['😤', 'dỗi rồi đó'], ['🙄', 'ủa alo?'], ['👀', 'seen rồi nha'],
    ['🤡', 'hề thật sự'], ['💀', 'cứu tui'], ['😂', 'cười xỉu'], ['🔥', 'quá đỉnh'], ['🐧', 'ơi ơi'], ['🫵', 'là bạn đó'], ['🐷', 'đồ heo'], ['📢', 'rep đi mà'], ['🍵', 'trà xanh'], ['😎', 'ngầu chưa'], ['🥱', 'buồn ngủ'], ['❤️', 'yêu']];
  const SP_MAX = 100, SP_MIN_GAP = 350;
  const sleepR = ms => new Promise(r => setTimeout(r, ms * SPEED));

  /* vẽ nhãn dán: emoji thật to + chữ trắng viền đen, nền trong suốt */
  const stkCache = new Map();
  function drawSticker(emoji, caption, size = 360) {
    const cv = document.createElement('canvas'); cv.width = cv.height = size;
    const g = cv.getContext('2d');
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = size * 0.04; g.shadowOffsetY = size * 0.015;
    g.font = `${Math.round(size * (caption ? 0.56 : 0.72))}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    g.fillText(emoji || '❤️', size / 2, size * (caption ? 0.4 : 0.52));
    if (caption) {
      g.shadowColor = 'transparent';
      let fs = size * 0.15;
      const font = s => `900 ${s}px -apple-system,"SF Pro Display","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif`;
      g.font = font(fs);
      while (g.measureText(caption).width > size * 0.92 && fs > size * 0.07) { fs -= 2; g.font = font(fs); }
      g.lineJoin = 'round'; g.lineWidth = fs * 0.28; g.strokeStyle = '#111'; g.fillStyle = '#fff';
      g.strokeText(caption, size / 2, size * 0.84); g.fillText(caption, size / 2, size * 0.84);
    }
    return cv;
  }
  const cvBlob = cv => new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'));
  const dataBlob = async u => (await fetch(u)).blob();
  function stkList() {
    return [...MY.map(m => ({ id: 'c:' + m.id, my: m })), ...PACK.map((p, i) => ({ id: 'p:' + i, e: p[0], c: p[1] }))];
  }
  function stkPreview(s) {
    if (stkCache.has(s.id)) return stkCache.get(s.id);
    const u = s.my && s.my.img ? s.my.img : drawSticker(s.my ? s.my.e : s.e, s.my ? s.my.c : s.c, 160).toDataURL('image/png');
    stkCache.set(s.id, u); return u;
  }
  async function stkBlob(s) {
    if (s.my && s.my.img) return dataBlob(s.my.img);
    return cvBlob(drawSticker(s.my ? s.my.e : s.e, s.my ? s.my.c : s.c, 360));
  }

  /* tìm các nút của khung nhập: ô chọn ảnh (input file) và nút gửi */
  function findFileInput(inp) {
    const okF = x => !ours(x) && (!x.accept || /image|\*/i.test(x.accept));
    for (let a = inp.parentElement, l = 0; a && l < 9; a = a.parentElement, l++) { const f = qsa(a, 'input[type="file"]').filter(okF); if (f.length) return f[0]; }
    return qsa(document, 'input[type="file"]').filter(okF)[0] || null;
  }
  const inputText = el => (el.isContentEditable ? el.textContent : el.value || '');
  function findSendBtn(inp) {
    for (let a = inp.parentElement, l = 0; a && l < 6; a = a.parentElement, l++) {
      const c = qsa(a, '[data-e2e*="send" i],[aria-label*="send" i],[aria-label*="gửi" i],[title*="gửi" i],[title*="send" i]').filter(e => !ours(e) && visible(e) && !e.contains(inp));
      if (c.length) return c[c.length - 1];
    }
    // không có nhãn: lấy biểu tượng nằm NGOÀI CÙNG bên phải trên cùng hàng với ô nhập (mũi tên ➤)
    const ir = rectOf(inp), cy = (ir.top + ir.bottom) / 2, sc = findScroller();
    let best = null, bx = -1;
    for (const e of qsa(document, 'button,[role="button"],svg,[tabindex]')) {
      if (ours(e) || (sc && sc.contains(e)) || e.contains(inp)) continue;
      const r = rectOf(e);
      if (r.width < 14 || r.width > 80 || r.height < 14 || r.height > 80) continue;
      const ey = (r.top + r.bottom) / 2;
      if (Math.abs(ey - cy) > Math.max(30, ir.height / 2 + 10) || r.left < ir.left || r.left > ir.right + 280) continue;
      if (r.right > bx) { bx = r.right; best = e; }
    }
    return best;
  }
  function tap(el) {
    let r = rectOf(el);
    if (r.bottom < 0 || r.top > innerHeight) { try { el.scrollIntoView({ block: 'nearest' }); } catch {} r = rectOf(el); }
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const prev = HOST.style.visibility; HOST.style.visibility = 'hidden';
    const hit = document.elementFromPoint(x, y); HOST.style.visibility = prev;
    const t = hit && (el.contains(hit) || hit.contains(el)) ? hit : el;
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
    try { t.dispatchEvent(new PointerEvent('pointerdown', { ...o, pointerId: 1, isPrimary: true, pointerType: 'mouse' })); } catch {}
    t.dispatchEvent(new MouseEvent('mousedown', o));
    try { t.dispatchEvent(new PointerEvent('pointerup', { ...o, pointerId: 1, isPrimary: true, pointerType: 'mouse' })); } catch {}
    t.dispatchEvent(new MouseEvent('mouseup', o));
    t.dispatchEvent(new MouseEvent('click', o));
  }
  function pressEnter(inp) {
    const k = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13, bubbles: true, cancelable: true, composed: true };
    const t = (inp.isContentEditable && document.activeElement && inp.contains(document.activeElement) && document.activeElement) || inp;
    t.dispatchEvent(new KeyboardEvent('keydown', k)); t.dispatchEvent(new KeyboardEvent('keypress', k)); t.dispatchEvent(new KeyboardEvent('keyup', k));
  }
  function clearInput(inp) {
    if (!inputText(inp).trim()) return;
    inp.focus();
    if (inp.isContentEditable) { try { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); } catch {} if (inputText(inp).trim()) inp.textContent = ''; }
    else { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inp), 'value'); if (d && d.set) d.set.call(inp, ''); else inp.value = ''; }
    inp.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  }
  // theo dõi khung chat: có tin mới xuất hiện thật hay chưa
  function watchChat() {
    const sc = findScroller(); let added = false;
    const mo = sc ? new MutationObserver(rs => { if (rs.some(r => r.addedNodes.length)) added = true; }) : null;
    if (mo) mo.observe(sc, { childList: true, subtree: true });
    return { get added() { return added; }, stop() { if (mo) mo.disconnect(); }, none: !mo };
  }
  async function sendText(txt) {
    const inp = findInput();
    if (!inp) return false;
    inp.focus();
    if (inp.isContentEditable) {
      try { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, txt); } catch {}
      if (!inputText(inp).includes(txt)) { inp.textContent = txt; inp.dispatchEvent(new InputEvent('input', { bubbles: true, data: txt, inputType: 'insertText' })); }
    } else {
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inp), 'value');
      if (d && d.set) d.set.call(inp, txt); else inp.value = txt;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await sleepR(60);
    pressEnter(inp);
    await sleepR(160);
    if (inputText(inp).trim()) { const b = findSendBtn(inp); if (b) { tap(b); await sleepR(160); } }
    return !inputText(inp).trim();
  }
  async function sendImage(blob, name) {
    const inp = findInput(); if (!inp) return false;
    const fi = findFileInput(inp);
    if (!fi) throw new Error('Không tìm thấy nút gửi ảnh của TikTok trong khung chat này.');
    clearInput(inp);
    const file = new File([blob], name, { type: blob.type || 'image/png' });
    const w = watchChat();
    try {
      const dt = new DataTransfer(); dt.items.add(file);
      fi.files = dt.files;
    } catch { w.stop(); throw new Error('Trình duyệt này không cho script gửi ảnh. Hãy cập nhật Safari / iPadOS rồi thử lại.'); }
    fi.dispatchEvent(new Event('input', { bubbles: true })); fi.dispatchEvent(new Event('change', { bubbles: true }));
    // TikTok có thể gửi ngay, hoặc hiện ảnh xem trước chờ bấm gửi
    await waitFor(() => w.added, 1800, () => S.stop);
    if (!w.added && !S.stop) {
      const b = findSendBtn(inp);
      if (b) tap(b); else pressEnter(inp);
      await waitFor(() => w.added, 7000, () => S.stop);
    }
    w.stop();
    try { fi.value = ''; } catch {}
    return w.none ? true : w.added;
  }

  /* nhãn dán của bạn: tự tạo, tải ảnh lên, lấy từ khung chat */
  const fileToData = (file, max = 384) => new Promise((res, rej) => {
    if (/gif/i.test(file.type) && file.size <= 450e3) { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); return; }
    const u = URL.createObjectURL(file), im = new Image();
    im.onload = () => { const k = Math.min(1, max / Math.max(im.width, im.height)), cv = document.createElement('canvas'); cv.width = Math.round(im.width * k); cv.height = Math.round(im.height * k); cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height); URL.revokeObjectURL(u); res(cv.toDataURL('image/png')); };
    im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('img')); };
    im.src = u;
  });
  function addMine(m) { m.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5); MY.push(m); saveMY(); SP.stk = 'c:' + m.id; SP.kind = 'sticker'; saveSP(); }
  $('spFile').onchange = async () => {
    const f = $('spFile').files[0]; $('spFile').value = '';
    if (!f) return;
    try { addMine({ img: await fileToData(f) }); toast('Đã thêm nhãn dán ✓'); } catch { toast('Không đọc được ảnh này'); }
    renderSpam();
  };
  function grabFromChat() {
    closeSheet();
    const done = msg => { window.removeEventListener('click', onClick, true); hideToast(); if (msg) toast(msg, 4500); setTimeout(() => openSheet('spam'), 600); };
    const onClick = async e => {
      if (ours(e.target)) return;
      const sc = findScroller();
      const im = e.target.closest('img') || (e.target.querySelector && e.target.querySelector('img'));
      if (!sc || !im || !sc.contains(im) || rectOf(im).width < 48) { if (sc && sc.contains(e.target)) { e.preventDefault(); e.stopPropagation(); toast('Chạm đúng vào hình nhãn dán / ảnh trong khung chat', 0, { label: 'Huỷ', fn: () => done('') }); } return; }
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      try {
        const r = await fetch(imgSrc(im), { credentials: 'omit' });
        const b = await r.blob();
        if (!r.ok || !/^image\//.test(b.type)) throw 0;
        addMine({ img: await fileToData(new File([b], 'stk', { type: b.type })) });
        done('Đã lưu nhãn dán từ khung chat ✓');
      } catch { done('TikTok không cho lấy ảnh này trực tiếp. Hãy lưu ảnh về máy rồi dùng “Tải ảnh lên”.'); }
    };
    window.addEventListener('click', onClick, true);
    toast('Chạm vào nhãn dán / ảnh trong khung chat muốn lưu', 0, { label: 'Huỷ', fn: () => done('') });
  }

  /* giao diện mục Spam */
  function renderSpam() {
    const sc = findScroller(), inp = findInput(), title = sc ? chatName(sc) : '', to = $('spTo');
    to.className = 'spto' + (sc && inp ? '' : ' bad');
    to.innerHTML = sc && inp ? '<div class="av"></div><div><small>Sẽ gửi vào cuộc trò chuyện với</small><b></b></div>' : '<div>⚠️ Hãy mở cuộc trò chuyện muốn spam trên TikTok trước</div>';
    if (sc && inp) { setAv(to.querySelector('.av'), chatAvatar(sc), title || '?'); to.querySelector('b').textContent = title || 'Cuộc trò chuyện đang mở'; }
    for (const b of $('spKind').querySelectorAll('button')) b.classList.toggle('on', b.dataset.k === SP.kind);
    $('spStkBox').hidden = SP.kind !== 'sticker'; $('spTxtBox').hidden = SP.kind !== 'text';
    // lưới nhãn dán
    const g = $('spStk'); g.textContent = '';
    const tool = (ic, l, fn) => { const b = document.createElement('button'); b.className = 'it add'; b.innerHTML = `<span>${ic}</span><small>${l}</small>`; b.onclick = fn; g.appendChild(b); };
    tool('🖼️', 'Tải ảnh lên', () => $('spFile').click());
    tool('✏️', 'Tự tạo', () => { $('spMake').hidden = !$('spMake').hidden; mkPrev(); });
    tool('📥', 'Lấy từ chat', grabFromChat);
    for (const s of stkList()) {
      const it = document.createElement('button');
      it.className = 'it' + (!SP.stkRand && s.id === SP.stk ? ' on' : '');
      const im = document.createElement('img'); im.src = stkPreview(s); im.alt = s.my ? 'Nhãn dán của bạn' : s.c; it.appendChild(im);
      if (s.my) {
        const x = document.createElement('span'); x.className = 'x'; x.textContent = '×'; x.title = 'Xoá';
        x.onclick = e => { e.stopPropagation(); MY = MY.filter(m => m !== s.my); saveMY(); stkCache.delete(s.id); if (SP.stk === s.id) SP.stk = 'p:0'; saveSP(); renderSpam(); };
        it.appendChild(x);
      }
      it.onclick = () => { SP.stk = s.id; SP.stkRand = false; saveSP(); renderSpam(); };
      g.appendChild(it);
    }
    $('spStkRand').classList.toggle('on', SP.stkRand);
    // emoji / chữ
    const em = $('spEmo'); em.textContent = '';
    for (const e of SP_EMO) { const b = document.createElement('button'); b.textContent = e; b.className = !SP.rand && SP.text === e ? 'on' : ''; b.onclick = () => { SP.text = e; SP.rand = false; $('spText').value = ''; saveSP(); renderSpam(); }; em.appendChild(b); }
    const rb = document.createElement('button'); rb.className = 'rnd' + (SP.rand ? ' on' : ''); rb.textContent = '🎲 Ngẫu nhiên'; rb.onclick = () => { SP.rand = !SP.rand; saveSP(); renderSpam(); }; em.appendChild(rb);
    if (!SP_EMO.includes(SP.text) && document.activeElement !== $('spText')) $('spText').value = SP.text;
    // số lần & tốc độ
    $('spN').value = SP.n;
    for (const b of $('spCq').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.n) === SP.n);
    const sp = $('spSpd'); sp.textContent = '';
    for (const [ms, l, d] of SP_SPEEDS) { const b = document.createElement('button'); b.className = SP.spd === ms ? 'on' : ''; b.innerHTML = `<b>${l}</b><small>${d}</small>`; b.onclick = () => { SP.spd = ms; saveSP(); renderSpam(); }; sp.appendChild(b); }
    $('spJit').checked = !!SP.jit;
    const what = SP.kind === 'sticker' ? (SP.stkRand ? 'nhãn dán ngẫu nhiên' : 'nhãn dán') : SP.rand ? 'emoji ngẫu nhiên' : `“${short(SP.text, 12)}”`;
    $('spGoT').textContent = `Spam ${fmt(SP.n)} ${what}`;
    $('spGo').disabled = !(sc && inp) || (SP.kind === 'sticker' && !SP.stkRand && !stkList().some(s => s.id === SP.stk)) || (SP.kind === 'text' && !SP.rand && !SP.text.trim());
  }
  function mkPrev() { $('spMkPrev').src = drawSticker($('spMkE').value.trim() || '😴', $('spMkC').value.trim(), 160).toDataURL('image/png'); }
  $('spMkE').oninput = mkPrev; $('spMkC').oninput = mkPrev;
  $('spMkGo').onclick = () => { addMine({ e: $('spMkE').value.trim() || '😴', c: $('spMkC').value.trim().slice(0, 28) }); $('spMake').hidden = true; toast('Đã tạo nhãn dán ✓'); renderSpam(); };
  $('spStkRand').onclick = () => { SP.stkRand = !SP.stkRand; saveSP(); renderSpam(); };
  for (const b of $('spKind').querySelectorAll('button')) b.onclick = () => { SP.kind = b.dataset.k; saveSP(); renderSpam(); };
  $('spText').oninput = () => { const v = $('spText').value; if (v.trim()) { SP.text = v.slice(0, 200); SP.rand = false; } saveSP(); for (const b of $('spEmo').querySelectorAll('button')) b.classList.remove('on'); $('spGoT').textContent = `Spam ${fmt(SP.n)} “${short(SP.text, 12)}”`; };
  const setN = v => { SP.n = clamp(Math.round(Number(v) || 1), 1, SP_MAX); saveSP(); renderSpam(); };
  $('spN').onchange = () => setN($('spN').value);
  $('spMinus').onclick = () => setN(SP.n - 1);
  $('spPlus').onclick = () => setN(SP.n + 1);
  for (const b of $('spCq').querySelectorAll('button')) b.onclick = () => setN(b.dataset.n);
  $('spJit').onchange = () => { SP.jit = $('spJit').checked; saveSP(); };
  $('spGo').onclick = () => runSpam();

  async function runSpam() {
    if (S.running) return;
    const sc = findScroller(), title = sc ? chatName(sc) : '';
    if (!sc || !findInput()) { toast('Hãy mở một cuộc trò chuyện trước'); return; }
    const L = stkList(), pick = () => (SP.stkRand ? L[Math.floor(Math.random() * L.length)] : L.find(s => s.id === SP.stk));
    if (SP.kind === 'sticker' && !pick()) { toast('Chọn một nhãn dán trước'); return; }
    const n = clamp(SP.n, 1, SP_MAX), gap = Math.max(SP_MIN_GAP, SP.spd), unit = SP.kind === 'sticker' ? 'nhãn dán' : 'tin';
    S.running = true; S.stop = false;
    closeSheet(); islandOn(true);
    $('fStop').textContent = 'Dừng';
    liveStart(title || 'Cuộc trò chuyện', chatAvatar(sc), 0, 1);
    $('fName').textContent = `🚀 Spam → ${title || 'cuộc trò chuyện'}`;
    $('fUnit').textContent = unit;
    LV.spam = { sent: 0, n, fail: 0 };
    LV.phase = 'Chuẩn bị gửi…';
    LV.timer = setInterval(livePaint, 300);
    keepAwake(true);
    let fails = 0, err = '';
    const blobs = new Map();
    try {
      for (let i = 0; i < n && !S.stop; i++) {
        const s2 = findScroller();
        if (!s2 || (title && !sameName(chatName(s2), title))) throw new Error('Cuộc trò chuyện đã đổi — dừng lại để không gửi nhầm người.');
        LV.phase = `Đang gửi ${i + 1}/${n} · ${(gap / 1000).toLocaleString('vi-VN')} giây/lần`;
        let ok;
        if (SP.kind === 'sticker') {
          const s = pick();
          if (!blobs.has(s.id)) blobs.set(s.id, await stkBlob(s));
          ok = await sendImage(blobs.get(s.id), `sticker-${i + 1}.${/gif/.test(blobs.get(s.id).type) ? 'gif' : 'png'}`);
        } else ok = await sendText(SP.rand ? SP_EMO[Math.floor(Math.random() * SP_EMO.length)] : SP.text);
        if (ok) { LV.spam.sent++; fails = 0; LV.last = { total: LV.spam.sent, me: LV.spam.sent, them: 0, media: 0 }; }
        else {
          LV.spam.fail++;
          if (++fails >= 3) throw new Error(SP.kind === 'sticker' ? 'Gửi nhãn dán không thành công 3 lần liền. Thử chạm vào ô nhập tin nhắn một lần rồi spam lại.' : 'Không gửi được tin. Hãy chạm vào ô nhập tin nhắn một lần rồi thử lại.');
        }
        if (i < n - 1) await sleepR(SP.jit ? gap * (0.75 + Math.random() * 0.5) : gap);
      }
    } catch (e) { err = String((e && e.message) || e); }
    clearInterval(LV.timer); livePaint();
    const sent = LV.spam.sent;
    LV.spam = null; keepAwake(false); S.running = false; islandOn(false);
    toast(err ? '⚠ ' + err : `${S.stop ? 'Đã dừng. ' : ''}Đã gửi ${fmt(sent)} ${unit} ✓`, err ? 6500 : 3000);
  }

  /* ---------- cài đặt ---------- */
  function renderSet() {
    const box = $('spd'); box.textContent = '';
    for (const k of ['fast', 'normal', 'safe']) {
      const b = document.createElement('button');
      b.className = CFG.speed === k ? 'on' : '';
      b.innerHTML = `<b>${k === 'fast' ? '⚡ ' : k === 'safe' ? '🐢 ' : ''}${SPEEDS[k].label}</b><small>${SPEEDS[k].desc}</small>`;
      b.onclick = () => { CFG.speed = k; saveCfg(); renderSet(); toast(`Tốc độ: ${SPEEDS[k].label} · chờ tối đa ${SPEEDS[k].patience / 1000}s khi TikTok tải chậm`); };
      box.appendChild(b);
    }
    $('cAn').checked = !!CFG.analyze; $('cQk').checked = !!CFG.quick;
  }
  $('cAn').onchange = () => { CFG.analyze = $('cAn').checked; saveCfg(); };
  $('cQk').onchange = () => { CFG.quick = $('cQk').checked; S.mode = CFG.quick ? 'quick' : 'full'; saveCfg(); };
  $('sDiag').onclick = () => { const d = $('diag'); if (!d.hidden) { d.hidden = true; return; } d.textContent = diagnose(); d.hidden = false; };
  $('sRep').onclick = async () => {
    const ta = $('repT');
    ta.value = buildReport(); ta.hidden = false;
    let ok = false;
    try { await navigator.clipboard.writeText(ta.value); ok = true; } catch { try { ta.select(); ok = document.execCommand('copy'); } catch {} }
    toast(ok ? 'Đã chép báo cáo ✓ Dán gửi cho người sửa script' : 'Hãy bôi đen và chép nội dung trong ô báo cáo', 3500);
  };
  $('sForget').onclick = () => { nameByAv.clear(); ORDER = null; saveNames(); toast('Đã quên tên đã nhớ. Mở rộng danh sách tin nhắn để script học lại.'); };
  let wipeArm = 0;
  $('sWipe').onclick = () => {
    if (Date.now() - wipeArm > 3000) { wipeArm = Date.now(); $('sWipe').textContent = 'Chắc chưa?'; setTimeout(() => { $('sWipe').textContent = 'Xoá'; }, 3000); return; }
    history = []; nameByAv.clear(); ORDER = null;
    for (const k of ['dmcHistory', 'dmcNames', 'dmcCfg', 'dmcFab']) store.del(k);
    $('sWipe').textContent = 'Xoá'; toast('Đã xoá toàn bộ dữ liệu của script');
  };
  $('sPick').onclick = () => {
    closeSheet();
    const cancel = () => { document.removeEventListener('click', onPick, true); hideToast(); };
    const onPick = e => {
      if (ours(e.target)) return;
      e.preventDefault(); e.stopPropagation();
      document.removeEventListener('click', onPick, true);
      let el = e.target;
      for (; el && el !== document.body; el = el.parentElement) if (scrollable(el) && el.scrollHeight > el.clientHeight + 4) break;
      if (el && el !== document.body && chatLike(el).ok) { manualSc = el; toast('Đã chọn khung chat ✓'); }
      else toast('Chỗ đó không giống khung tin nhắn. Hãy mở cuộc trò chuyện trước, rồi chạm vào giữa các tin nhắn.', 4000);
      setTimeout(() => openSheet('home'), 600);
    };
    document.addEventListener('click', onPick, true);
    toast('Chạm vào giữa các tin nhắn trong khung chat', 0, { label: 'Huỷ', fn: () => { cancel(); openSheet('home'); } });
  };

  // dùng cho test tự động
  window.__dmc = { analyze, tally, findScroller, findTitle, findConvList, scanItems, findInput, diagnose, buildReport, parseStamp, AN, VERSION };
})();
