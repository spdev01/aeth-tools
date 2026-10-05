const res = await fetch('https://www.aetheria-online.in.th/auth/guest', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
});
console.log('status:', res.status);
console.log('body:', (await res.text()).slice(0, 300));
