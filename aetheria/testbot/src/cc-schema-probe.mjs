// Probe @colyseus/schema exports + usable decode API
import * as s from '@colyseus/schema';
console.log('exports:', Object.keys(s).sort().join(', '));
console.log('has SchemaSerializer:', !!s.SchemaSerializer, '| Reflection:', !!s.Reflection, '| Serializer:', !!s.Serializer);
if (s.SchemaSerializer) {
  const p = s.SchemaSerializer.prototype;
  console.log('SchemaSerializer proto:', Object.getOwnPropertyNames(p).join(', '));
  try { const inst = new s.SchemaSerializer(); console.log('instances create ok; own:', Object.getOwnPropertyNames(inst).join(', ')); } catch (e) { console.log('ctor err', e.message); }
}
if (s.Reflection) {
  console.log('Reflection statics:', Object.getOwnPropertyNames(s.Reflection).join(', '));
}
if (s.Decoder) {
  console.log('Decoder proto:', Object.getOwnPropertyNames(s.Decoder.prototype).join(', '));
  try { const d = new s.Decoder(); console.log('Decoder ctor ok; own:', Object.getOwnPropertyNames(d).join(', ')); } catch (e) { console.log('Decoder ctor err:', e.message); }
}
if (s.decodeSchemaOperation) console.log('decodeSchemaOperation arity:', s.decodeSchemaOperation.length);
