/* ============================================================
   MASAR — public site forms.
   Submits the lead form (#leadForm → /api/public/lead, JSON) and the
   job-application form (#applyForm → /api/public/apply, multipart with
   a CV file). Both send the "X-Requested-With: XMLHttpRequest" header
   so the request clears the app's CSRF gate; a plain form POST can't.

   Served from the same origin as the API, so this file is allowed by
   the page's "script-src 'self'" policy and the fetch is same-origin.
   No framework; progressive enhancement over a <noscript> fallback.
   ============================================================ */
(function () {
  'use strict';

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function setStatus(form, state, msg) {
    var el = form.querySelector('[data-status]');
    if (!el) return;
    el.setAttribute('data-state', state);   // "ok" | "err"
    el.textContent = msg;
  }
  function clearStatus(form) {
    var el = form.querySelector('[data-status]');
    if (el) { el.removeAttribute('data-state'); el.textContent = ''; }
  }
  function busy(form, on) {
    var btn = form.querySelector('button[type="submit"]');
    if (!btn) return;
    btn.disabled = on;
    var label = on ? btn.getAttribute('data-busy') : btn.getAttribute('data-default');
    if (label) btn.textContent = label;
  }

  // Trim + require a few basics shared by both forms. Returns an error
  // message string, or null when valid.
  function basicError(form) {
    var name  = (form.elements.name  && form.elements.name.value  || '').trim();
    var email = (form.elements.email && form.elements.email.value || '').trim();
    var phone = (form.elements.phone && form.elements.phone.value || '').trim();
    if (!name) return 'الاسم مطلوب.';
    if (!email && !phone) return 'أدخل بريدًا إلكترونيًا أو رقم جوال.';
    if (email && !EMAIL_RE.test(email)) return 'البريد الإلكتروني غير صالح.';
    return null;
  }

  // Build the full phone (country code + number) for submission.
  function fullPhone(form) {
    var cc  = (form.elements.phone_cc && form.elements.phone_cc.value || '').trim();
    var num = (form.elements.phone    && form.elements.phone.value    || '').trim();
    if (!num) return '';
    num = num.replace(/[\s-]/g, '');
    // Drop a leading zero before prefixing the country code.
    num = num.replace(/^0+/, '');
    return cc ? (cc + num) : num;
  }

  async function send(url, opts) {
    var res = await fetch(url, opts);
    var data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok) {
      var m = (data && data.error) ? data.error : 'تعذّر الإرسال، حاول مرة أخرى.';
      throw new Error(m);
    }
    return data;
  }

  // ── Lead form (JSON) ──
  function wireLead(form) {
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearStatus(form);
      var err = basicError(form);
      if (err) { setStatus(form, 'err', err); return; }

      var body = {
        name:          (form.elements.name.value || '').trim(),
        email:         (form.elements.email.value || '').trim(),
        phone:         fullPhone(form),
        company:       (form.elements.company && form.elements.company.value || '').trim(),
        sector:        (form.elements.sector && form.elements.sector.value || '').trim(),
        monthly_calls: (form.elements.monthly_calls && form.elements.monthly_calls.value || '').trim(),
        message:       (form.elements.message && form.elements.message.value || '').trim()
      };

      busy(form, true);
      try {
        await send(form.getAttribute('data-endpoint'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify(body)
        });
        form.reset();
        setStatus(form, 'ok', 'تم استلام طلبك، سنتواصل معك قريبًا. شكرًا لك.');
      } catch (ex) {
        setStatus(form, 'err', ex.message);
      } finally {
        busy(form, false);
      }
    });
  }

  // ── Application form (multipart + CV) ──
  function wireApply(form) {
    // Show the chosen file name next to the upload button.
    var fileInput = form.querySelector('input[type="file"]');
    var nameOut = form.querySelector('[data-filename]');
    if (fileInput && nameOut) {
      fileInput.addEventListener('change', function () {
        nameOut.textContent = fileInput.files && fileInput.files[0] ? fileInput.files[0].name : '';
      });
    }

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearStatus(form);
      var err = basicError(form);
      if (err) { setStatus(form, 'err', err); return; }
      if (fileInput && (!fileInput.files || !fileInput.files[0])) {
        setStatus(form, 'err', 'أرفق سيرتك الذاتية (PDF أو Word).'); return;
      }

      var fd = new FormData();
      fd.append('name',    (form.elements.name.value || '').trim());
      fd.append('email',   (form.elements.email.value || '').trim());
      fd.append('phone',   fullPhone(form));
      fd.append('message', (form.elements.message && form.elements.message.value || '').trim());
      if (fileInput && fileInput.files[0]) fd.append('cv', fileInput.files[0]);

      busy(form, true);
      try {
        // No Content-Type header: the browser sets the multipart boundary.
        await send(form.getAttribute('data-endpoint'), {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          body: fd
        });
        form.reset();
        if (nameOut) nameOut.textContent = '';
        setStatus(form, 'ok', 'تم استلام طلبك، شكرًا لتقديمك. سنراجع طلبك ونعود إليك.');
      } catch (ex) {
        setStatus(form, 'err', ex.message);
      } finally {
        busy(form, false);
      }
    });
  }

  function init() {
    var lead = document.getElementById('leadForm');
    if (lead) wireLead(lead);
    var apply = document.getElementById('applyForm');
    if (apply) wireApply(apply);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
