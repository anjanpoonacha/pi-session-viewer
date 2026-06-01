// client/prune.js — prune-page interactivity.

(function () {
  const form = document.getElementById('prune-form');
  if (!form) return;

  const cbs = () => Array.from(form.querySelectorAll('input.prune-cb'));
  const totalCount = cbs().length;
  const runningEl = document.getElementById('prune-running-total');
  const confirmBtn = document.getElementById('confirm-prune-btn');

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function refresh() {
    let sel = 0;
    let bytes = 0;
    for (const cb of cbs()) {
      if (cb.checked) {
        sel++;
        const item = cb.closest('.prune-item');
        bytes += parseInt((item && item.dataset.bytes) || '0', 10);
      }
    }
    runningEl.textContent = sel + ' of ' + totalCount + ' selected · ' + fmtBytes(bytes);
    confirmBtn.disabled = sel === 0;
  }
  form.addEventListener('change', (e) => {
    if (e.target.matches('input.prune-cb')) refresh();
  });

  // ---- quick-action buttons ----
  document.querySelectorAll('.quick-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const action = btn.dataset.quick;
      const sectionSel = btn.dataset.sectionSelect;
      const sectionClear = btn.dataset.sectionClear;

      if (sectionSel) {
        for (const cb of cbs()) {
          const item = cb.closest('.prune-item');
          if (item && item.dataset.kind === sectionSel) cb.checked = true;
        }
      } else if (sectionClear) {
        for (const cb of cbs()) {
          const item = cb.closest('.prune-item');
          if (item && item.dataset.kind === sectionClear) cb.checked = false;
        }
      } else if (action === 'clear') {
        for (const cb of cbs()) cb.checked = false;
      } else if (action === 'all-images') {
        for (const cb of cbs()) {
          const item = cb.closest('.prune-item');
          if (item && item.dataset.kind === 'image') cb.checked = true;
        }
      } else if (action === 'last-5-images') {
        // candidates are sorted most-recent-first; keep top-5, check the rest
        let imgIdx = 0;
        for (const cb of cbs()) {
          const item = cb.closest('.prune-item');
          if (!item || item.dataset.kind !== 'image') continue;
          imgIdx++;
          cb.checked = imgIdx > 5;
        }
      } else if (action === 'all-bash') {
        for (const cb of cbs()) {
          const item = cb.closest('.prune-item');
          if (!item || item.dataset.kind !== 'toolResultText') continue;
          const tool = (item.querySelector('.prune-tool') || {}).textContent || '';
          if (tool === 'bash' && parseInt(item.dataset.bytes || '0', 10) > 8 * 1024) cb.checked = true;
        }
      } else if (action === 'all-thinking') {
        for (const cb of cbs()) {
          const item = cb.closest('.prune-item');
          if (item && item.dataset.kind === 'thinking') cb.checked = true;
        }
      } else if (action === 'all-toolargs') {
        for (const cb of cbs()) {
          const item = cb.closest('.prune-item');
          if (item && item.dataset.kind === 'toolCallArg') cb.checked = true;
        }
      } else if (action === 'all-elided') {
        for (const cb of cbs()) {
          const item = cb.closest('.prune-item');
          if (item && item.dataset.kind === 'elidedPlaceholder') cb.checked = true;
        }
      }
      refresh();
    });
  });

  // ---- submit handler ----
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ids = cbs().filter((c) => c.checked).map((c) => c.value);
    if (!ids.length) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Pruning…';
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selectedIds: ids }),
      });
      const body = await res.json();
      if (!body.ok) {
        if (window.__toast) window.__toast({ kind: 'err', text: 'Prune failed: ' + body.error, ttlMs: 8000 });
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Create pruned snapshot →';
        return;
      }
      const r = body.report;
      const result = document.createElement('div');
      result.className = 'prune-result';
      result.innerHTML =
        '<h3>✓ Pruned snapshot created</h3>' +
        '<div class="prune-result-row">New file: <code>' + body.targetPath + '</code></div>' +
        '<div class="prune-result-row">Resume: <code id="resume-cmd">' + body.resumeCommand + '</code> ' +
        '  <button type="button" class="quick-btn small" id="copy-resume">copy</button></div>' +
        '<div class="prune-result-row dim small">Removed ' + r.removedCount + ' items · ' +
        fmtBytes(r.bytesBefore) + ' → ' + fmtBytes(r.bytesAfter) + '</div>' +
        '<div class="prune-result-row dim small">Audit log: ' + body.auditPath + '</div>';
      form.replaceWith(result);
      const copyBtn = document.getElementById('copy-resume');
      if (copyBtn) copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(body.resumeCommand).then(() => {
          copyBtn.textContent = 'copied';
          if (window.__toast) window.__toast({ kind: 'ok', text: 'Resume command copied to clipboard', ttlMs: 2500 });
        });
      });
      if (window.__toast) {
        window.__toast({
          kind: 'ok',
          text: 'Snapshot created · ' + r.removedCount + ' items · ' +
            fmtBytes(r.bytesBefore) + ' → ' + fmtBytes(r.bytesAfter),
          ttlMs: 6000,
        });
        if (body.sourceLikelyActive) {
          window.__toast({
            kind: 'info',
            text: 'Heads up: original session was modified ' + body.sourceAgeSec +
              's ago. The snapshot may not include the very latest entries. The original is unchanged.',
            ttlMs: 9000,
          });
        }
      }
    } catch (err) {
      if (window.__toast) window.__toast({ kind: 'err', text: 'Request failed: ' + err.message, ttlMs: 6000 });
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Create pruned snapshot →';
    }
  });

  refresh();
})();
