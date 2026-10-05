// Client-side password gate for the Aetheria tools pages.
// NOTE: soft protection (GitHub Pages cannot do server-side auth) — it keeps casual
// visitors out; direct file URLs (zips/userscript/version files) stay UN-gated on
// purpose so auto-updaters keep working.
// Change the password: compute sha256 of the new password and replace HASH below:
//   node -e "console.log(require('crypto').createHash('sha256').update('NEWPASS').digest('hex'))"
(function () {
  var HASH = '4ffe9015b7f66cd2659cbc6442ecd08f85c1926fedebffcdaa37c72a10bd7ab9';
  var KEY = 'lmv_gate_ok_v1';

  function pass() {
    document.documentElement.classList.add('gate-ok');
    var g = document.getElementById('gate');
    if (g) g.remove();
  }

  try { if (sessionStorage.getItem(KEY) === HASH) { document.addEventListener('DOMContentLoaded', pass); return; } } catch (e) { /* noop */ }

  document.addEventListener('DOMContentLoaded', function () {
    var g = document.createElement('div');
    g.id = 'gate';
    g.innerHTML =
      '<div class="gate-card">' +
      '  <div class="gate-logo">⌘</div>' +
      '  <h1>Aetheria Tools</h1>' +
      '  <p>หน้านี้ถูกป้องกันด้วยรหัสผ่าน<br>กรอกรหัสเพื่อเข้าใช้งาน</p>' +
      '  <form id="gate-form">' +
      '    <input id="gate-pass" type="password" placeholder="รหัสผ่าน" autocomplete="current-password" autofocus />' +
      '    <button type="submit">เข้าใช้งาน</button>' +
      '  </form>' +
      '  <p class="gate-err" id="gate-err"></p>' +
      '</div>';
    document.body.appendChild(g);

    var form = document.getElementById('gate-form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = document.getElementById('gate-pass').value;
      try {
        crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)).then(function (buf) {
          var hex = Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
          if (hex === HASH) { try { sessionStorage.setItem(KEY, HASH); } catch (err) { } pass(); }
          else { document.getElementById('gate-err').textContent = 'รหัสผ่านไม่ถูกต้อง'; }
        });
      } catch (err) {
        document.getElementById('gate-err').textContent = 'เบราว์เซอร์ไม่รองรับ (ต้องเปิดผ่าน https)';
      }
    });
  });
})();
