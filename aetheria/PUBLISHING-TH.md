# คู่มือเผยแพร่ (สำหรับผู้ดูแล) — Aetheria Tools

เอกสารนี้อธิบายระบบ **push → build → GitHub Pages → อัปเดตอัตโนมัติ** สำหรับทั้ง
ตลาด+ (Market+) และ Command Center

---

## ภาพรวมระบบ

```
git push (branch main)
   └─ GitHub Actions: .github/workflows/publish.yml
        1. คำนวณเวอร์ชันอัตโนมัติ = เวลาที่ build (รูปแบบ yy.mm.dd.hhmm, เวลาไทย)
        2. Build ตลาด+  (extension + userscript + ตัวอัปเดต + latest-version.txt)
        3. (ถ้ามี AMO secrets) เซ็นไฟล์ .xpi สำหรับ Zen + สร้าง updates.json
        4. Build Command Center (zip + UPDATE-CC + version.txt)
        5. รวมทุกอย่างเป็นเว็บไซต์ _site/ → deploy ขึ้น GitHub Pages
```

หลัง deploy เสร็จ (ประมาณ 1–2 นาทีหลัง push):

| เครื่องมือ | ช่องทางอัปเดต | พฤติกรรม |
|---|---|---|
| Userscript | `@updateURL` | อัปเดตอัตโนมัติทันทีที่เปิดเบราว์เซอร์ครั้งถัดไป |
| Chrome (ชุดติดตั้ง) | `UPDATE-CHROME.cmd` | ผู้ใช้ดับเบิลคลิก 1 ครั้ง → กด ↻ ที่ chrome://extensions |
| Zen (.xpi ติดตั้งถาวร) | `updates.json` + `update_url` | อัปเดตอัตโนมัติ (Firefox เช็ค ~วันละครั้ง) |
| Command Center | `UPDATE-CC.cmd` | ผู้ใช้ดับเบิลคลิก 1 ครั้ง → restart เซิร์ฟเวอร์ |

**เวอร์ชัน** ถูกสร้างจากวัน-เวลาที่ build: `yy.mm.dd.hhmm` (ตัดเลข 0 นำหน้า)
ใช้เวลาไทย (Asia/Bangkok) — CI ตั้ง TZ ให้อัตโนมัติ — ไม่ต้องตั้งเลขเวอร์ชันเอง
เช่น `26.10.5.1022` = 5 ต.ค. 2026 เวลา 10:22
ทุกครั้งที่ push ระบบจะออกเวอร์ชันใหม่ให้ทันที

> หมายเหตุ: ถ้า push สองครั้งภายในนาทีเดียวกัน เวอร์ชันจะซ้ำกัน — รอ 1 นาทีแล้ว push ใหม่

---

## ตั้งค่าครั้งแรก (ทำครั้งเดียว)

### 1) สร้าง GitHub repo และ push

```powershell
# ในโฟลเดอร์ E:\GitHub\lumivaraonline
git remote add origin https://github.com/<USERNAME>/<REPO>.git
git push -u origin main
```

### 2) เปิด GitHub Pages

- ไปที่ repo → **Settings → Pages**
- **Source:** เลือก **GitHub Actions**
- ⚠️ **repo แบบ private + GitHub Pages ต้องมี GitHub Pro** (Free plan ใช้ Pages ได้กับ repo public เท่านั้น)
  - ทางเลือกฟรี: ใช้ repo **public ถาวร** เฉพาะไฟล์ที่เผยแพร่ได้ (หน้าเว็บมีรหัสผ่านกันอยู่แล้ว) — หรืออัปเกรดเป็น Pro
- URL หน้าเว็บจะอยู่ที่: `https://<USERNAME>.github.io/<REPO>/`

### 3) (ตัวเลือก) เซ็นไฟล์ .xpi อัตโนมัติสำหรับ Zen

สร้าง API key ที่ https://addons.mozilla.org/developers/addon/api/key/ แล้วตั้งค่า:

- repo → **Settings → Secrets and variables → Actions** → เพิ่ม:
  - `AMO_API_KEY`
  - `AMO_API_SECRET`

ถ้าไม่ตั้ง secrets นี้ ระบบจะข้ามการสร้าง .xpi (หน้าเว็บยังใช้งานได้ปกติ —
ผู้ใช้ Zen เลือกใช้ Userscript หรือโหลดแบบชั่วคราวได้)

### 4) ทดสอบ push แรก

```powershell
git add .
git commit -m "chore: publish pipeline"
git push
```

ดูความคืบหน้าที่แท็บ **Actions** — เสร็จแล้วเปิดหน้าเว็บตาม URL ด้านบน

---

## โครงสร้างไฟล์บนเว็บ (URL คงที่)

```
https://<user>.github.io/<repo>/
  index.html                          ← หน้าแรก (มีรหัสผ่าน)
  market-watch.html                   ← คู่มือติดตั้ง/ใช้งาน ตลาด+ (มีรหัสผ่าน)
  command-center.html                 ← คู่มือติดตั้ง/ใช้งาน Command Center (มีรหัสผ่าน)
  ← ไฟล์ด้านล่างนี้ "ไม่มี" รหัสผ่าน (จำเป็นสำหรับระบบอัปเดตอัตโนมัติ) →
  aetheria-market-plus.user.js        (userscript — เช็ค @updateURL)
  aetheria-market-plus-chrome.zip     (zip สำหรับ Chrome)
  aetheria-market-plus-bundle.zip     (ชุดติดตั้งแนะนำ: chrome + ตัวอัปเดต + คู่มือ)
  aetheria-market-plus-<เวอร์ชัน>.xpi (ไฟล์เซ็นสำหรับ Zen, ถ้ามี)
  latest-version.txt                  (เวอร์ชันล่าสุดของตลาด+ — ใช้เทียบอัปเดต Chrome)
  updates.json                        (ตัวชี้การอัปเดต Zen)
  command-center/aetheria-command-center.zip
  command-center/version.txt
```

---

## เปลี่ยนรหัสผ่านของหน้าเว็บ

หน้าเว็บใช้รหัสผ่านฝั่งผู้ใช้ (client-side) — ค่าเริ่มต้นคือ **Conan1234**

```powershell
# 1) สร้างค่า hash ของรหัสใหม่
node -e "console.log(require('crypto').createHash('sha256').update('รหัสใหม่').digest('hex'))"

# 2) เปิด aetheria/site/assets/gate.js แก้ตัวแปร HASH = '<ค่า hash ใหม่>'
# 3) commit + push → รหัสใหม่มีผลเมื่อ deploy เสร็จ
```

> **ข้อจำกัด:** GitHub Pages ไม่รองรับรหัสผ่านฝั่งเซิร์ฟเวอร์ การป้องกันแบบนี้
> กันคนทั่วไปได้ แต่ไฟล์ดาวน์โหลด/ไฟล์อัปเดตเปิดตรงโดยเจตนา (เพื่อให้ระบบอัปเดต
> อัตโนมัติทำงานโดยไม่ต้องใส่รหัส) — **อย่าใส่ข้อมูลลับใดๆ ลงในโฟลเดอร์ `site/`**

---

## ทดสอบก่อน push (บนเครื่องตัวเอง)

```powershell
cd E:\GitHub\lumivaraonline

# 1) build ตลาด+ (กำหนดเวอร์ชันเองได้ด้วย env)
$env:MARKETPLUS_VERSION = (node aetheria/tools/version.mjs)
$env:DEPLOY_BASE = "https://example.github.io/repo"
cd aetheria/market-tool; node build.mjs; cd ../..

# 2) build Command Center
node aetheria/command-center/tools/build-release.mjs

# 3) รวมเว็บไซต์
node aetheria/tools/assemble-site.mjs

# 4) เปิดดูในเครื่อง
node aetheria/tools/serve-site.mjs        # → http://127.0.0.1:4398
```

หมายเหตุ macOS/Linux: ตั้ง env ต่างกัน (`export MARKETPLUS_VERSION=...`)

---

## แก้ไขที่พบบ่อย

- **Actions fail ตอน deploy pages** → ยังไม่ได้ตั้ง Pages Source เป็น "GitHub Actions"
- **repo private แต่เปิด Pages ไม่ได้** → ต้องมี GitHub Pro หรือใช้ repo public สำหรับฝั่งเผยแพร่
- **หน้าเว็บขึ้น 404 ทั้งหมด** → รอ deploy รอบแรกเสร็จก่อน (แท็บ Actions ต้องเป็นสีเขียว)
- **Zen ไม่เห็นอัปเดต** → ต้องติดตั้งจากไฟล์ .xpi แบบถาวรเท่านั้น (แบบ temporary ไม่อัปเดต) และผู้ใช้ต้องเปิดใช้ auto-update
- **ไฟล์ .xpi ไม่ถูกสร้าง** → ยังไม่ได้ตั้ง `AMO_API_KEY` / `AMO_API_SECRET` (ดูข้อ 3)
