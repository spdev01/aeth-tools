import fs from 'node:fs';
const OUT = 'e:/GitHub/lumivaraonline/aetheria/testbot/out';
const runs = fs.readdirSync(OUT).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
outer: for (const f of runs) {
  const es = fs.readFileSync(`${OUT}/${f}`, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const inv = es.filter((e) => e.data && e.data.items && (e.evt === 'message:inventory' || /inventory/i.test(e.evt))).pop();
  if (inv) {
    console.log('file:', f, '| evt:', inv.evt);
    const it = inv.data.items.find((i) => i.autoPotion) || inv.data.items[0];
    console.log('sample item:', JSON.stringify(it).slice(0, 300));
    const potions = inv.data.items.filter((i) => /potion/i.test(i.name)).slice(0, 6).map((i) => `${i.itemId}:${i.name}:autoPotion=${i.autoPotion}`);
    console.log('potions:', JSON.stringify(potions));
    break outer;
  }
}
console.log('done');
