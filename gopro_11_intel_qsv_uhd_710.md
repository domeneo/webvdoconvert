# 🎥 คู่มือการรีดคุณภาพวิดีโอ GoPro 11 บน Intel QSV (UHD 710) ที่บิตเรต 20M

เอกสารนี้สรุปแนวทางการอัปเกรดพารามิเตอร์ของ `hevc_qsv` ในไฟล์ `server.js` เพื่อให้ได้คุณภาพความคมชัดสูงสุด (โดยเฉพาะฉากผิวน้ำและหยดน้ำ) ในงบบิตเรต **20 Mbps** หรือช่วยให้ลดบิตเรตลงมาเหลือ **15M–18M** ได้โดยไม่สูญเสียรายละเอียด

---

## 🔍 1. จุดที่พบจากโค้ดปัจจุบัน (`server.js`)

ในไฟล์ `readme.md` ได้มีการบันทึกผลการทดสอบว่าการใช้ **Lookahead + B-frames** ช่วยเพิ่มคะแนน VMAF ได้ถึง ~3 คะแนน แต่ในโค้ดจริงของ `server.js` (ฟังก์ชัน `buildTranscodeCommand`) ยังไม่ได้ใส่แฟล็กเหล่านี้เข้าไป:

```javascript
// โค้ดเดิมใน server.js (ยังไม่มี Lookahead, ExtBRC และ B-Frames)
rateControl = `-b:v ${cleanBitrate} -maxrate ${peakMaxrate} -bufsize ${dynamicBuf} -preset ${qsvPreset}`;
```

> **💡 ข้อควรรู้สำหรับ Intel QSV HEVC:**  
> ในฮาร์ดแวร์ Intel Gen 12 (UHD 710) การเปิด Lookahead และ Adaptive Quantization สำหรับโค้ดเดก **HEVC (`hevc_qsv`)** จะต้องเรียกใช้ผ่านแฟล็ก **`-extbrc 1` (Extended Bitrate Control)** ร่วมกับ `-look_ahead_depth` แทนการใช้ `-look_ahead 1` แบบ H.264

---

## 🚀 2. 4 เทคนิคการปรับจูนเพื่อรีดคุณภาพสูงสุด

### 2.1 เปิดใช้งาน Extended Bitrate Control (`-extbrc 1`) และ Lookahead
ช่วยให้ชิปฮาร์ดแวร์วิเคราะห์ภาพล่วงหน้าก่อนตัดสินใจเทบิตเรต และทำ Adaptive Quantization (ลดการบีบอัดในจุดที่สายตาโฟกัส เช่น หยดน้ำ และบีบอัดเพิ่มในฉากหลังที่เบลอ)
- `-extbrc 1`: เปิดระบบควบคุมบิตเรตขั้นสูงของ Intel QSV
- `-look_ahead_depth 40`: วิเคราะห์เฟรมล่วงหน้า 40 เฟรม

### 2.2 ปรับโครงสร้าง B-Frames และ GOP แบบไดนามิก
วิดีโอจาก GoPro มีทั้งจังหวะที่กล้องนิ่งและจังหวะที่คลื่นซัดเร็ว การให้ฮาร์ดแวร์ปรับจำนวน B-Frame และ I-Frame อัตโนมัติจะช่วยประหยัดบิตเรตได้มาก:
- `-bf 4`: ใช้ B-Frames สูงสุด 4 เฟรม
- `-b_strategy 1`: จัดวางโครงสร้าง B-Frames แบบฉลาดตามการเคลื่อนไหว
- `-adaptive_i 1 -adaptive_b 1`: แทรก I-Frame และ B-Frame อัตโนมัติเมื่อภาพเปลี่ยนฉากกะทันหัน
- `-g 120`: กำหนดระยะ Keyframe (GOP) ที่ 120 เฟรม (ประมาณ 2 วินาทีสำหรับคลิป 60fps) ไม่ให้สร้าง I-Frame ถี่เกินไปจนเปลืองบิตเรต

### 2.3 ใช้ไปป์ไลน์สี 10-bit (`-profile:v main10`)
**GoPro Hero 11** รองรับการถ่ายสี 10-bit และชิป **Intel UHD 710** รองรับการเข้ารหัส HEVC 10-bit ด้วยฮาร์ดแวร์เต็มรูปแบบ (Pure Hardware):
- การใส่ `-profile:v main10` ช่วยให้การคำนวณความละเอียดแสงและสีภายในมีความแม่นยำสูงขึ้น
- ลดอาการ **Color Banding** (สีท้องฟ้าหรือผิวน้ำใต้น้ำเป็นชั้นวงๆ)
- ช่วยประหยัดบิตเรตลงได้อีกประมาณ 5%–10% ที่ความคมชัดเท่าเดิม

### 2.4 รักษา Metadata และเปิด Faststart
- `-map_metadata 0`: เก็บข้อมูลวันที่และเวลาถ่ายจริงของไฟล์ต้นฉบับไว้
- `-movflags +faststart`: ย้ายส่วนหัวของไฟล์ (moov atom) มาไว้ด้านหน้า ทำให้เปิดดูวิดีโอผ่าน LAN หรือ Web Browser ได้ทันทีโดยไม่ต้องรอโหลดจบไฟล์

---

## 🛠️ 3. โค้ดสำหรับอัปเดตใน `server.js`

นำโค้ดด้านล่างนี้ไปแทนที่ในฟังก์ชัน `buildTranscodeCommand` ส่วนของ `if (hardwareMode === 'qsv')` ในไฟล์ `server.js`:

```javascript
    if (hardwareMode === 'qsv') {
        const qsvPreset = preset && preset.trim() ? preset.trim() : 'veryslow';
        
        // พารามิเตอร์เพิ่มความฉลาดให้ชิป Intel UHD 710 (Gen 12)
        const qsvAdvancedFlags = [
            '-profile:v main10',       // ใช้ 10-bit pipeline ลดสีเป็นชั้น (Banding) บนผิวน้ำ/ท้องฟ้า
            '-extbrc 1',               // เปิด Extended Bitrate Control (Adaptive Quantization + Lookahead สำหรับ HEVC)
            '-look_ahead_depth 40',    // วิเคราะห์เฟรมล่วงหน้า 40 เฟรม
            '-bf 4',                   // ใช้ B-Frames สูงสุด 4 เฟรม
            '-b_strategy 1',           // จัดวาง B-Frames แบบฉลาดตามการเคลื่อนไหว
            '-adaptive_i 1',           // แทรก I-Frame อัตโนมัติเมื่อภาพเปลี่ยนฉากเร็ว
            '-adaptive_b 1',           // ปรับ B-Frame อัตโนมัติ
            '-g 120'                   // ระยะ GOP ที่สมดุลสำหรับคลิป GoPro 60fps
        ].join(' ');

        let rateControl = '';
        if (cleanBitrate) {
            // โหมด VBR Peak Burst + ExtBRC
            const numeric = parseInt(cleanBitrate) || 20;
            const peakMaxrate = Math.round(numeric * 2.3) + 'M';
            const dynamicBuf = Math.round(numeric * 2.5) + 'M';
            rateControl = `-b:v ${cleanBitrate} -maxrate ${peakMaxrate} -bufsize ${dynamicBuf} -preset ${qsvPreset} ${qsvAdvancedFlags}`;
        } else {
            // โหมด ICQ (Intelligent Constant Quality) ฉลาดกว่า CQP ธรรมดา ไม่ทำให้ไฟล์บวมเกินจำเป็น
            rateControl = `-global_quality ${qp || 22} -preset ${qsvPreset} ${qsvAdvancedFlags}`;
        }

        // Full Pure Hardware Pipeline + เก็บ Metadata วันที่ถ่าย + Faststart สำหรับสตรีมผ่าน LAN
        cmd = `"${FFMPEG_PATH}" -y -hwaccel qsv -hwaccel_output_format qsv -i "${inputPath}" -map_metadata 0 ${colorFlags} -c:v hevc_qsv ${rateControl} -c:a copy -movflags +faststart -f mp4 "${tempOutputPath}"`;
    }
```

---

## 💡 4. ทางเลือกเพิ่มเติม: โหมด `ICQ` vs `Bitrate 20M`

| โหมดการควบคุม | การตั้งค่าบนหน้าเว็บ | พฤติกรรมการทำงาน | เหมาะสำหรับ |
| :--- | :--- | :--- | :--- |
| **VBR + ExtBRC** *(แนะนำหลัก)* | ใส่ Bitrate = `20M` | คุมขนาดไฟล์เฉลี่ยที่ 20 Mbps อย่างแม่นยำ และยอมให้พุ่งไปถึง ~46 Mbps ในช่วงที่คลื่นซัดหนัก | ต้องการคุมขนาดไฟล์ให้คาดเดาได้ชัดเจน และได้ความคมของหยดน้ำสูงสุด |
| **ICQ (Intelligent Constant Quality)** | **เว้นว่าง** ช่อง Bitrate และตั้งค่า QP = `21` หรือ `22` | คล้ายโหมด CRF ของ x265 หากเป็นคลิปเดินเที่ยวทั่วไป บิตเรตจะลดเหลือแค่ `11M–14M` เองอัตโนมัติ แต่ถ้าเจอฉากน้ำจะดันไปที่ `20M–25M` | แปลงไฟล์จำนวนมากปนกัน (ทั้งคลิปนิ่งและคลิปแอ็กชัน) โดยเน้นประหยัดพื้นที่รวมสูงสุด |

---

## ✅ 5. ขั้นตอนการนำไปใช้งานและทดสอบ

1. นำโค้ดข้อที่ 3 ไปอัปเดตลงในไฟล์ `server.js`
2. สั่งรีสตาร์ทเซอร์วิสด้วยคำสั่ง:
   ```powershell
   pm2 restart ffmpegServer
   ```
3. ทดสอบแปลงไฟล์คลิปน้ำตัวเดิมที่บิตเรต `20M` (Preset: `veryslow`)
4. กดปุ่ม **📐 SSIM / PSNR** และ **📸 เทียบภาพประกบข้าง** บนหน้าเว็บเพื่อเปรียบเทียบความคมชัดของหยดน้ำและคะแนน SSIM/PSNR กับไฟล์ก่อนปรับจูน