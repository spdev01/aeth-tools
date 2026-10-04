// extract the auto-skills toggle/panel code to nail config.skills shape
import fs from 'node:fs';
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
let pos = 0, n = 0;
while ((pos = c.indexOf('auto-skills', pos)) >= 0 && n < 3) {
  console.log(`\n=== auto-skills @ ${pos} ===`);
  console.log(c.substring(pos - 800, pos + 900).replace(/\s+/g, ' '));
  pos += 10; n++;
}
// also find where the skill toggle sends (search 'skills:[' near 'includes')
pos = 0; n = 0;
while ((pos = c.indexOf('skills.includes', pos)) >= 0 && n < 6) {
  console.log(`\n=== skills.includes @ ${pos} ===`);
  console.log(c.substring(pos - 500, pos + 500).replace(/\s+/g, ' '));
  pos += 10; n++;
}
