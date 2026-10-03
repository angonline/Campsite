import express from 'express';
import QRCode from 'qrcode';
import generatePayload from 'promptpay-qr';

const MAX_NIGHTS = 14;
const HOLD_MINUTES = 60; // จองแล้วไม่จ่ายภายในกี่นาทีให้ปล่อยจุดคืน

const todayTH = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s));
const nightsBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

function validRange(check_in, check_out) {
  if (!isDate(check_in) || !isDate(check_out)) return false;
  if (check_in < todayTH()) return false;
  const n = nightsBetween(check_in, check_out);
  return n >= 1 && n <= MAX_NIGHTS;
}

export function apiRouter({ supabase, client }) {
  const r = express.Router();

  // ปล่อยจุดที่ค้างชำระนานเกินกำหนด
  async function cleanup() {
    const cutoff = new Date(Date.now() - HOLD_MINUTES * 60 * 1000).toISOString();
    await supabase
      .from('bookings')
      .update({ status: 'cancelled' })
      .eq('status', 'pending_payment')
      .lt('created_at', cutoff);
  }

  // ค่าตั้งต้นสำหรับหน้าฟอร์ม
  r.get('/config', async (_req, res) => {
    const { data } = await supabase.from('settings').select('key,value');
    const s = Object.fromEntries((data || []).map((x) => [x.key, x.value]));
    res.json({ liffId: process.env.LIFF_ID, today: todayTH(), ...s });
  });

  // จุดที่ว่างตามช่วงวันที่
  r.get('/availability', async (req, res) => {
    const { check_in, check_out } = req.query;
    if (!validRange(check_in, check_out))
      return res.status(400).json({ error: 'วันที่ไม่ถูกต้อง' });
    await cleanup();
    const { data, error } = await supabase.rpc('available_spots', {
      p_check_in: check_in,
      p_check_out: check_out,
    });
    if (error) return res.status(500).json({ error: 'ระบบขัดข้อง' });
    res.json({ spots: data.map((s) => ({ id: s.id, name: s.name })) });
  });

  // สร้างการจอง
  r.post('/book', async (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim();
      const phone = String(b.phone || '').replace(/[-\s]/g, '');
      const address = String(b.address || '').trim();
      const guests = Number(b.guests);
      const spot_id = Number(b.spot_id);

      if (!name || name.length > 100) return bad(res, 'กรุณากรอกชื่อ');
      if (!/^0\d{8,9}$/.test(phone)) return bad(res, 'เบอร์โทรไม่ถูกต้อง');
      if (address.length < 5 || address.length > 300) return bad(res, 'กรุณากรอกที่อยู่');
      if (!Number.isInteger(guests) || guests < 1 || guests > 4)
        return bad(res, 'จำนวนคนต้องอยู่ระหว่าง 1-4');
      if (!Number.isInteger(spot_id)) return bad(res, 'กรุณาเลือกจุด');
      if (!validRange(b.check_in, b.check_out)) return bad(res, 'วันที่ไม่ถูกต้อง');

      // ยืนยันตัวตนผู้จองจาก LINE
      const pr = await fetch('https://api.line.me/v2/profile', {
        headers: { Authorization: `Bearer ${b.accessToken}` },
      });
      if (!pr.ok) return res.status(401).json({ error: 'กรุณาเปิดฟอร์มจาก LINE ใหม่อีกครั้ง' });
      const profile = await pr.json();

      await cleanup();

      // คิดราคาที่ฝั่งเซิร์ฟเวอร์เท่านั้น
      const { data: total, error: pErr } = await supabase.rpc('calc_price', {
        p_guests: guests,
        p_check_in: b.check_in,
        p_check_out: b.check_out,
      });
      if (pErr) throw pErr;

      const { data: booking, error } = await supabase
        .from('bookings')
        .insert({
          spot_id,
          line_user_id: profile.userId,
          customer_name: name,
          phone,
          address,
          check_in: b.check_in,
          check_out: b.check_out,
          guests,
          total_price: total,
        })
        .select('*, spots(name)')
        .single();

      if (error) {
        if (error.code === '23P01')
          return res.status(409).json({ error: 'ขออภัย จุดนี้เพิ่งถูกจอง กรุณาเลือกจุดอื่น' });
        throw error;
      }

      // สร้าง QR PromptPay ตามยอด
      const payload = generatePayload(process.env.PROMPTPAY_ID, { amount: total });
      const png = await QRCode.toBuffer(payload, { width: 600, margin: 2 });
      const qrDataUrl = `data:image/png;base64,${png.toString('base64')}`;

      // ส่ง QR เข้าแชต เพื่อให้ลูกค้ากลับมาเปิดดูได้
      try {
        const path = `qr/${booking.id}.png`;
        await supabase.storage.from('slips').upload(path, png, {
          contentType: 'image/png',
          upsert: true,
        });
        const { data: pub } = supabase.storage.from('slips').getPublicUrl(path);
        await client.pushMessage({
          to: profile.userId,
          messages: [
            {
              type: 'text',
              text:
                `รับจองแล้ว (รอชำระเงิน)\n` +
                `จุด ${booking.spots.name} | ${booking.guests} คน\n` +
                `${booking.check_in} ถึง ${booking.check_out}\n` +
                `ยอดชำระ ${Number(total).toLocaleString('th-TH')} บาท\n\n` +
                `สแกน QR ด้านล่างเพื่อชำระเงิน แล้วส่งรูปสลิปในแชตนี้ภายใน ${HOLD_MINUTES} นาที`,
            },
            { type: 'image', originalContentUrl: pub.publicUrl, previewImageUrl: pub.publicUrl },
          ],
        });
      } catch (e) {
        console.error('push QR failed', e);
      }

      res.json({
        booking: {
          id: booking.id,
          spot_name: booking.spots.name,
          check_in: booking.check_in,
          check_out: booking.check_out,
          guests: booking.guests,
          total,
        },
        qr: qrDataUrl,
        hold_minutes: HOLD_MINUTES,
      });
    } catch (e) {
      console.error('book error', e);
      res.status(500).json({ error: 'ระบบขัดข้อง กรุณาลองใหม่' });
    }
  });

  return r;
}

const bad = (res, msg) => res.status(400).json({ error: msg });
