// client/sessions.js — list/detail page interactivity (purge buttons, tombstones, toasts).

(function () {
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // ---- toasts (top-right) ----
  function ensureToastHost() {
    let host = document.getElementById('toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-host';
      host.className = 'toast-host';
      document.body.appendChild(host);
    }
    return host;
  }

  function toast(opts) {
    // opts: { kind: 'ok'|'err'|'info', text, action?: { label, fn }, ttlMs }
    const host = ensureToastHost();
    const el = document.createElement('div');
    el.className = 'toast toast-' + (opts.kind || 'info');
    const span = document.createElement('span');
    span.className = 'toast-text';
    span.textContent = opts.text;
    el.appendChild(span);
    if (opts.action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = opts.action.label;
      btn.addEventListener('click', () => {
        try { opts.action.fn(); } finally { dismiss(); }
      });
      el.appendChild(btn);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => dismiss());
    el.appendChild(close);
    host.appendChild(el);

    let t;
    function dismiss() {
      if (t) clearTimeout(t);
      el.classList.add('toast-leaving');
      setTimeout(() => el.remove(), 200);
    }
    if (opts.ttlMs !== 0) t = setTimeout(dismiss, opts.ttlMs || 5000);
    return { dismiss };
  }
  window.__toast = toast;

  // ---- two-click arm pattern for destructive buttons ----
  const ARM_MS = 4000;
  function arm(btn, label) {
    if (btn.dataset.armed === '1') return false;
    btn.dataset.armed = '1';
    btn.dataset.originalLabel = btn.dataset.originalLabel || btn.textContent;
    btn.classList.add('armed');
    btn.textContent = label;
    const disarm = () => {
      if (btn.dataset.armed !== '1') return;
      btn.dataset.armed = '0';
      btn.classList.remove('armed');
      btn.textContent = btn.dataset.originalLabel || btn.textContent;
      document.removeEventListener('click', onDocClick, true);
      clearTimeout(timer);
    };
    const onDocClick = (ev) => { if (!btn.contains(ev.target)) disarm(); };
    const timer = setTimeout(disarm, ARM_MS);
    document.addEventListener('click', onDocClick, true);
    btn._disarm = disarm;
    return true;
  }
  const isArmed = (btn) => btn.dataset.armed === '1';

  // ---- whole-session purge: trash with arm-and-click ----
  document.querySelectorAll('button.purge-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sid = btn.dataset.sessionId;
      const size = btn.dataset.sessionSize || '';
      const detailRedirect = btn.classList.contains('detail-purge');
      if (!sid) return;

      if (!isArmed(btn)) {
        arm(btn, 'click to confirm');
        return;
      }
      if (btn._disarm) btn._disarm();
      btn.disabled = true;
      btn.textContent = '…';

      try {
        const res = await fetch('/api/session/' + sid, { method: 'DELETE' });
        const body = await res.json();
        if (body.ok) {
          if (detailRedirect) {
            try {
              sessionStorage.setItem('flash', JSON.stringify({
                kind: 'ok',
                text: 'Session moved to ' + body.method + ' · ' + (size || ''),
              }));
            } catch (_) { /* storage might be disabled */ }
            window.location.href = '/';
            return;
          }
          const row = document.getElementById('row-' + sid);
          if (row) {
            row.style.opacity = '0.4';
            row.style.textDecoration = 'line-through';
          }
          btn.textContent = body.method === 'trash' ? '✓ trashed' : '✓ deleted';
          toast({
            kind: 'ok',
            text: 'Moved to ' + body.method + ' · ' + size + ' · ' + sid.slice(0, 8),
            ttlMs: 4000,
          });
        } else {
          btn.disabled = false;
          btn.textContent = '🗑 purge';
          toast({ kind: 'err', text: 'Purge failed: ' + body.error, ttlMs: 8000 });
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '🗑 purge';
        toast({ kind: 'err', text: 'Purge request failed: ' + err.message, ttlMs: 8000 });
      }
    });
  });

  // ---- per-entry tombstone: reversible, no arm ----
  document.querySelectorAll('button.entry-purge-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sid = btn.dataset.sessionId;
      const eid = btn.dataset.entryId;
      if (!sid || !eid) return;
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const res = await fetch('/api/session/' + sid + '/entry/' + eid + '/tombstone', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'manual' }),
        });
        const body = await res.json();
        if (body.ok) {
          const block = document.getElementById('block-' + eid);
          if (block) {
            block.style.opacity = '0.3';
            block.style.textDecoration = 'line-through';
          }
          btn.textContent = '✓ hidden';
          toast({
            kind: 'ok',
            text: 'Entry ' + eid + ' hidden',
            action: {
              label: 'undo',
              fn: async () => {
                try {
                  await fetch('/api/session/' + sid + '/entry/' + eid + '/tombstone', { method: 'DELETE' });
                  if (block) {
                    block.style.opacity = '';
                    block.style.textDecoration = '';
                  }
                  btn.disabled = false;
                  btn.textContent = btn.dataset.originalLabel || '🪦 hide';
                  toast({ kind: 'info', text: 'Restored', ttlMs: 2500 });
                } catch (er) {
                  toast({ kind: 'err', text: 'Undo failed: ' + er.message, ttlMs: 6000 });
                }
              },
            },
            ttlMs: 7000,
          });
        } else {
          btn.disabled = false;
          btn.textContent = btn.dataset.originalLabel || '🪦 hide';
          toast({ kind: 'err', text: 'Hide failed: ' + body.error, ttlMs: 8000 });
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = btn.dataset.originalLabel || '🪦 hide';
        toast({ kind: 'err', text: 'Request failed: ' + err.message, ttlMs: 6000 });
      }
    });
  });

  // ---- replay flash messages stashed across redirects ----
  try {
    const f = sessionStorage.getItem('flash');
    if (f) {
      sessionStorage.removeItem('flash');
      const parsed = JSON.parse(f);
      if (parsed && parsed.text) toast(parsed);
    }
  } catch (_) { /* storage might be disabled */ }
})();
