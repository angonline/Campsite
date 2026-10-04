import express from 'express';
import QRCode from 'qrcode';
import generatePayload from 'promptpay-qr';

const MAX_NIGHTS = 14;
const HOLD_MINUTES = 20; // จองแล้วไม่จ่ายภายในกี่นาทีให้ปล่อยจุดคืน
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const todayTH = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s));
const nightsBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const bad = (res, msg) => res.status(400).json({ error: msg });

function validRange(check_in, check_out) {
  if (!isDate(check_in) || !isDate(check_out)) return false;
  if (check_in < todayTH()) return false;
  const n = nightsBetween(check_in, check_out);
  return n >= 1 && n <= MAX_NIGHTS;
}

// จำกัดจำนวนครั้งต่อ IP กันคนกดจองรัวเพื่อกันที่ (เฉพาะเวอร์ชันเว็บ)
const hits = new Map();
function rateOk(key, limit, windowMs = 60 * 60 * 1000) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) return false;
  arr.push(now);
  hits.set(key, arr);
  return true;
}

export function apiRouter({ supabase, client, notifyAdminSlip }) {
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

  const makeQr = (total) =>
    QRCode.toBuffer(generatePayload(process.env.PROMPTPAY_ID, { amount: total }), {
      width: 600,
      margin: 2,
    });
  const dataUrl = (png) => `data:image/png;base64,${png.toString('base64')}`;
  const view = (b) => ({
    id: b.id,
    spot_name: b.spots.name,
    check_in: b.check_in,
    check_out: b.check_out,
    guests: b.guests,
    total: b.total_price,
  });

  // ตรวจข้อมูลฟอร์ม (ใช้ร่วมกันทั้ง LINE และเว็บ)
  function parseForm(b) {
    const name = String(b.name || '').trim();
    const phone = String(b.phone || '').replace(/[-\s]/g, '');
    const address = String(b.address || '').trim();
    const guests = Number(b.guests);
    const spot_id = Number(b.spot_id);

    if (!name || name.length > 100) return { error: 'กรุณากรอกชื่อ' };
    if (!/^0\d{8,9}$/.test(phone)) return { error: 'เบอร์โทรไม่ถูกต้อง' };
    if (address.length < 5 || address.length > 300) return { error: 'กรุณากรอกที่อยู่' };
    if (!Number.isInteger(guests) || guests < 1 || guests > 4)
      return { error: 'จำนวนคนต้องอยู่ระหว่าง 1-4' };
    if (!Number.isInteger(spot_id)) return { error: 'กรุณาเลือกจุด' };
    if (!validRange(b.check_in, b.check_out)) return { error: 'วันที่ไม่ถูกต้อง' };
    return {
      data: {
        spot_id,
        customer_name: name,
        phone,
        address,
        check_in: b.check_in,
        check_out: b.check_out,
        guests,
      },
    };
  }

  // สร้างการจอง: คิดราคาที่ฝั่งเซิร์ฟเวอร์เท่านั้น
  async function createBooking(data, lineUserId, source) {
    await cleanup();
    const { data: total, error: pErr } = await supabase.rpc('calc_price', {
      p_guests: data.guests,
      p_check_in: data.check_in,
      p_check_out: data.check_out,
    });
    if (pErr) throw pErr;

    const row = { ...data, total_price: total };
    if (lineUserId) row.line_user_id = lineUserId;
    if (source) row.source = source;

    const { data: booking, error } = await supabase
      .from('bookings')
      .insert(row)
      .select('*, spots(name)')
      .single();
    if (error) {
      if (error.code === '23P01') return { conflict: true };
      throw error;
    }
    return { booking, total, png: await makeQr(total) };
  }

  const conflictMsg = 'ขออภัย จุดนี้เพิ่งถูกจอง กรุณาเลือกจุดอื่น';

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

  // ---------- จองผ่าน LINE (LIFF) ----------
  r.post('/book', async (req, res) => {
    try {
      const b = req.body || {};
      const p = parseForm(b);
      if (p.error) return bad(res, p.error);

      // ยืนยันตัวตนผู้จองจาก LINE
      const pr = await fetch('https://api.line.me/v2/profile', {
        headers: { Authorization: `Bearer ${b.accessToken}` },
      });
      if (!pr.ok) return res.status(401).json({ error: 'กรุณาเปิดฟอร์มจาก LINE ใหม่อีกครั้ง' });
      const profile = await pr.json();

      const out = await createBooking(p.data, profile.userId, null);
      if (out.conflict) return res.status(409).json({ error: conflictMsg });
      const { booking, total, png } = out;

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

      res.json({ booking: view(booking), qr: dataUrl(png), hold_minutes: HOLD_MINUTES });
    } catch (e) {
      console.error('book error', e);
      res.status(500).json({ error: 'ระบบขัดข้อง กรุณาลองใหม่' });
    }
  });

  // ---------- จองผ่านเว็บ (ไม่ต้องมี LINE) ----------
  r.post('/web/book', async (req, res) => {
    try {
      if (!rateOk('book:' + req.ip, 6))
        return res.status(429).json({ error: 'ทำรายการบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่' });
      const p = parseForm(req.body || {});
      if (p.error) return bad(res, p.error);

      const out = await createBooking(p.data, null, 'web');
      if (out.conflict) return res.status(409).json({ error: conflictMsg });

      res.json({
        booking: view(out.booking),
        qr: dataUrl(out.png),
        hold_minutes: HOLD_MINUTES,
      });
    } catch (e) {
      console.error('web book error', e);
      res.status(500).json({ error: 'ระบบขัดข้อง กรุณาลองใหม่' });
    }
  });

  // ดูสถานะการจอง (ใช้รหัสการจองที่เป็น UUID เป็นกุญแจ)
  r.get('/web/status', async (req, res) => {
    try {
      const id = String(req.query.id || '');
      if (!UUID.test(id)) return bad(res, 'ไม่พบการจอง');
      await cleanup();
      const { data: b } = await supabase
        .from('bookings')
        .select('*, spots(name)')
        .eq('id', id)
        .eq('source', 'web')
        .maybeSingle();
      if (!b) return res.status(404).json({ error: 'ไม่พบการจอง' });

      const out = { booking: view(b), status: b.status, hold_minutes: HOLD_MINUTES };
      if (b.status === 'pending_payment') out.qr = dataUrl(await makeQr(b.total_price));
      res.json(out);
    } catch (e) {
      console.error('web status error', e);
      res.status(500).json({ error: 'ระบบขัดข้อง' });
    }
  });

  // อัปโหลดสลิป (รูปถูกย่อเป็น JPEG ที่ฝั่งเบราว์เซอร์แล้ว)
  r.post('/web/slip', async (req, res) => {
    try {
      if (!rateOk('slip:' + req.ip, 20))
        return res.status(429).json({ error: 'ทำรายการบ่อยเกินไป กรุณารอสักครู่' });
      const { id, image } = req.body || {};
      const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(String(image || ''));
      if (!UUID.test(String(id || '')) || !m) return bad(res, 'ไฟล์รูปไม่ถูกต้อง');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 3 * 1024 * 1024) return bad(res, 'รูปใหญ่เกินไป');

      const { data: b } = await supabase
        .from('bookings')
        .select('*, spots(name)')
        .eq('id', id)
        .eq('source', 'web')
        .eq('status', 'pending_payment')
        .maybeSingle();
      if (!b)
        return res.status(409).json({ error: 'การจองนี้หมดเวลาหรือส่งสลิปไปแล้ว' });

      const path = `${b.id}-${Date.now()}.${m[1] === 'png' ? 'png' : 'jpg'}`;
      const { error: upErr } = await supabase.storage
        .from('slips')
        .upload(path, buf, { contentType: `image/${m[1]}` });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from('slips').getPublicUrl(path);

      await supabase
        .from('bookings')
        .update({ slip_url: pub.publicUrl, status: 'awaiting_confirm' })
        .eq('id', b.id);

      try {
        await notifyAdminSlip(b, pub.publicUrl);
      } catch (e) {
        console.error('notify admin failed', e);
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('web slip error', e);
      res.status(500).json({ error: 'ส่งสลิปไม่สำเร็จ กรุณาลองใหม่' });
    }
  });

  return r;
}
