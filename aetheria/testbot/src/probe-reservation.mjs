// probe reservation shape from server matchmake
const BASE = 'https://www.aetheria-online.in.th';
const H = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

const auth = await (await fetch(BASE + '/auth/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
console.log('guest userId:', auth.guest?.userId);

const cl = await (await fetch(BASE + '/characters', { headers: H(auth.token) })).json();
let cid = cl.characters?.[0]?.id || cl.characters?.[0]?.characterId;
console.log('existing chars:', (cl.characters || []).length, 'cid:', cid);
if (!cid) {
  const cr = await (await fetch(BASE + '/characters', { method: 'POST', headers: H(auth.token), body: JSON.stringify({ name: 'ScoutB2' }) })).json();
  cid = cr.characterId;
  console.log('created:', JSON.stringify(cr));
}

const en = await (await fetch(BASE + '/world/enter', { method: 'POST', headers: H(auth.token), body: JSON.stringify({ characterId: cid }) })).json();
console.log('enter:', JSON.stringify({ ...en, ticket: en.ticket.slice(0, 30) + '...(' + en.ticket.length + ')' }));

// raw matchmake exactly like colyseus 0.16 client does
const url = en.endpoint + '/matchmake/joinById/' + en.roomId;
const mm = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: en.ticket, batch: true }) });
const txt = await mm.text();
console.log('matchmake status:', mm.status);
console.log('matchmake raw:', txt.slice(0, 2000));
