// dump Training Master object + peco context from live capital map
const j = await (await fetch('https://www.aetheria-online.in.th/maps/capital.json')).json();
for (const layer of j.layers ?? []) {
  if (layer.type !== 'objectgroup') continue;
  for (const o of layer.objects ?? []) {
    const props = Object.fromEntries((o.properties ?? []).map((p) => [p.name, p.value]));
    if (props.npcId === 210 || /training/i.test(o.name ?? '')) {
      console.log('OBJECT:', JSON.stringify(o, null, 1));
    }
  }
}
// find where 'peco' string is
const raw = JSON.stringify(j);
const i = raw.indexOf('peco');
console.log('\npeco context:', raw.substring(Math.max(0, i - 400), i + 400));
