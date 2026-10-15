// tmp-bundle-probe5.mjs — whisper/chat mechanics in the new bundle (safe to delete)
import fs from 'fs';
const newF = process.env.TEMP + '\\aetheria-bundle.js';
const B = fs.readFileSync(newF, 'utf8');
const show = (pat, ctx = 240, max = 8) => {
  let i = -1, n = 0;
  console.log(`\n===== "${pat}" =====`);
  while ((i = B.indexOf(pat, i + 1)) !== -1) { n++; if (n <= max) console.log('@', i, '::', JSON.stringify(B.slice(Math.max(0, i - ctx), i + ctx))); }
  console.log('count:', n);
};
show('whisper');
show('onMessage(`chat`', 320, 3);
show('.send(`chat`', 320, 4);
show('chat_translate', 200, 3);
show('chatListeners', 260, 3);
