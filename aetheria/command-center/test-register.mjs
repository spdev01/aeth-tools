// probe /auth/register response shape + latency
const uid = 'cctest' + String(Math.floor(Math.random() * 9000) + 1000);
const t0 = Date.now();
const res = await fetch('https://www.aetheria-online.in.th/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://www.aetheria-online.in.th', Referer: 'https://www.aetheria-online.in.th/play', Accept: '*/*' },
  body: JSON.stringify({ userId: uid, password: 'CcTest' + Math.floor(Math.random() * 900000) + 'x' }),
});
const text = await res.text();
console.log('status:', res.status, '| ms:', Date.now() - t0);
console.log('body:', text.slice(0, 400));
