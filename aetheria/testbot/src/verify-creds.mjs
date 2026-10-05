// verify the primary + spare account credentials
const tests = [
  { label: 'PRIMARY (ScoutA1)', userId: 'g_5b9a26f761', password: '9ON9mwrxIMTxbtIxq4N8YQzKZCaxU43o' },
  { label: 'SPARE (ScoutA92391)', userId: 'g_fa4b74a890', password: 'MkReDWuUO0twmNDVzNIFSrc-UXciFVdE' },
];
for (const t of tests) {
  try {
    const res = await fetch('https://www.aetheria-online.in.th/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: t.userId, password: t.password }),
    });
    const j = await res.json().catch(() => ({}));
    console.log(`${t.label}: ${res.status} ${res.ok ? '✓ LOGIN OK' : '✗ ' + JSON.stringify(j).slice(0, 120)} | user ${t.userId}`);
    if (res.ok && j.token) {
      const chars = await (await fetch('https://www.aetheria-online.in.th/characters', { headers: { Authorization: `Bearer ${j.token}` } })).json();
      console.log('   chars:', JSON.stringify(chars.characters?.map((c) => `${c.name} (id ${c.characterId}, ${c.mapName ?? ''})`) ?? chars).slice(0, 200));
    }
  } catch (e) { console.log(`${t.label}: ERROR ${e.message}`); }
  await new Promise((r) => setTimeout(r, 2500));
}
