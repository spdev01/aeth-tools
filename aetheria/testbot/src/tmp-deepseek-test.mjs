// tmp-deepseek-test.mjs — verify DeepSeek config + reply sanitization WITHOUT touching the game.
// usage (after filling apiKey in testbot/deepseek.json):
//   node src/tmp-deepseek-test.mjs ["ข้อความจาก GM ที่จะลองตอบ"]
import fs from 'fs';
const cfg = JSON.parse(fs.readFileSync('deepseek.json', 'utf8'));
if (!cfg.apiKey) { console.log('NO API KEY — fill "apiKey" in testbot/deepseek.json first (then rerun).'); process.exit(1); }
const msg = process.argv[2] || 'สวัสดีครับ ผม GM นะครับ ช่วยบอกหน่อยว่าคุณเล่นอยู่เองหรือเปล่า?';
const sys = String(cfg.systemPrompt || '')
  .replaceAll('{name}', 'TestChar')
  .replaceAll('{mins}', '10') || 'Reply with only the Thai chat message text.';
const body = {
  model: cfg.model || 'deepseek-chat',
  messages: [{ role: 'system', content: sys }, { role: 'user', content: `GM (GM.Test) whispered: ${msg}` }],
  temperature: 1.0, max_tokens: 220,
};
const r = await fetch(String(cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '') + '/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
  body: JSON.stringify(body),
});
console.log('HTTP:', r.status);
const j = await r.json();
const raw = j?.choices?.[0]?.message?.content ?? JSON.stringify(j).slice(0, 300);
console.log('RAW  :', raw);
let t = String(raw).replace(/```[\s\S]*?```/g, ' ').replace(/^(ตอบ(กลับ)?|Reply)\s*[:：]\s*/i, '').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').replace(/\s+/g, ' ').trim();
console.log('CLEAN:', t);
