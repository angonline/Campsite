import express from 'express';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import generatePayload from 'promptpay-qr';

const MAX_NIGHTS = 14;
const HOLD_MINUTES = 20; // จองแล้วไม่จ่ายภายในกี่นาทีให้ปล่อยจุดคืน
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const todayTH = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s));
const nightsBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const addDay = (s, d) => {
  const x = new Date(s + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
};

// ---- ล็อกอินแอดมิน: โทเคนแบบเซ็นชื่อ (HMAC) อายุ 12 ชั่วโมง ----
const secret = () => process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || '';
const hmac = (payload) =>
  crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
function signToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 3600 * 1000 })).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}
function verifyToken(t) {
  try {
    const [payload, sig] = String(t).split('.');
    if (!payload || !sig) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(hmac(payload));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now();
  } catch {
    return false;
  }
}
const safeEqual = (a, b) =>
  crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a)).digest(),
    crypto.createHash('sha256').update(String(b)).digest()
  );

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

export function apiRouter({ supabase, client, notifyAdminSlip, adminActions }) {
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
    code: b.booking_code || null,
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
    res.json({
      liffId: process.env.LIFF_ID,
      today: todayTH(),
      contact: {
        phone: process.env.CONTACT_PHONE || '081 391 1540',
        line: process.env.CONTACT_LINE || '@JTGROUP',
      },
      ...s,
    });
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

  // ================= หลังบ้านแอดมิน (ต้องล็อกอินด้วย ADMIN_PASSWORD) =================
  const STATUSES = ['pending_payment', 'awaiting_confirm', 'confirmed', 'rejected', 'cancelled'];

  const adminAuth = (req, res, next) => {
    if (!process.env.ADMIN_PASSWORD)
      return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่า ADMIN_PASSWORD ใน Render' });
    const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!verifyToken(t)) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
    res.set('Cache-Control', 'no-store');
    next();
  };

  r.post('/admin/login', (req, res) => {
    if (!process.env.ADMIN_PASSWORD)
      return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่า ADMIN_PASSWORD ใน Render' });
    if (!rateOk('login:' + req.ip, 8, 15 * 60 * 1000))
      return res.status(429).json({ error: 'ลองรหัสผ่านบ่อยเกินไป กรุณารอ 15 นาที' });
    if (!safeEqual(req.body?.password ?? '', process.env.ADMIN_PASSWORD))
      return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
    res.json({ token: signToken() });
  });

  r.get('/admin/stats', adminAuth, async (_req, res) => {
    try {
      const today = todayTH();
      const tomorrow = addDay(today, 1);
      const monthStart = `${today.slice(0, 7)}-01T00:00:00+07:00`;
      const head = { count: 'exact', head: true };

      const [waiting, staying, arriving, revenue, free, spots] = await Promise.all([
        supabase.from('bookings').select('id', head).eq('status', 'awaiting_confirm'),
        supabase.from('bookings').select('id', head).eq('status', 'confirmed')
          .lte('check_in', today).gt('check_out', today),
        supabase.from('bookings').select('id', head).eq('status', 'confirmed').eq('check_in', today),
        supabase.from('bookings').select('total_price').eq('status', 'confirmed').gte('confirmed_at', monthStart),
        supabase.rpc('available_spots', { p_check_in: today, p_check_out: tomorrow }),
        supabase.from('spots').select('name').eq('active', true).order('id'),
      ]);

      res.json({
        today,
        waiting: waiting.count || 0,
        staying: staying.count || 0,
        arriving_today: arriving.count || 0,
        revenue_month: (revenue.data || []).reduce((n, x) => n + (x.total_price || 0), 0),
        free: (free.data || []).map((s) => s.name),
        all: (spots.data || []).map((s) => s.name),
      });
    } catch (e) {
      console.error('admin stats error', e);
      res.status(500).json({ error: 'ดึงข้อมูลสรุปไม่สำเร็จ' });
    }
  });

  r.get('/admin/bookings', adminAuth, async (req, res) => {
    try {
      const { status, q, from, to } = req.query;
      let query = supabase
        .from('bookings')
        .select('*, spots(name)')
        .order('created_at', { ascending: false })
        .limit(300);
      if (STATUSES.includes(status)) query = query.eq('status', status);
      if (isDate(from)) query = query.gte('check_in', from);
      if (isDate(to)) query = query.lte('check_in', to);
      const term = String(q || '').replace(/[%,()*\\]/g, '').trim().slice(0, 50);
      if (term)
        query = query.or(
          `customer_name.ilike.%${term}%,phone.ilike.%${term}%,booking_code.ilike.%${term}%`
        );
      const { data, error } = await query;
      if (error) throw error;
      res.json({
        bookings: data.map((b) => ({
          id: b.id,
          code: b.booking_code || null,
          status: b.status,
          spot: b.spots?.name,
          name: b.customer_name,
          phone: b.phone,
          address: b.address,
          check_in: b.check_in,
          check_out: b.check_out,
          guests: b.guests,
          total: b.total_price,
          source: b.source || 'line',
          slip_url: b.slip_url || null,
          created_at: b.created_at,
          checked_in_at: b.checked_in_at || null,
          has_line: !!b.line_user_id,
        })),
      });
    } catch (e) {
      console.error('admin list error', e);
      res.status(500).json({ error: 'ดึงรายการจองไม่สำเร็จ' });
    }
  });

  r.post('/admin/bookings/:id/:action', adminAuth, async (req, res) => {
    try {
      const { id, action } = req.params;
      if (!UUID.test(id) || !['confirm', 'reject', 'cancel', 'checkin'].includes(action))
        return bad(res, 'คำสั่งไม่ถูกต้อง');
      const { data: b } = await supabase
        .from('bookings')
        .select('*, spots(name)')
        .eq('id', id)
        .maybeSingle();
      if (!b) return res.status(404).json({ error: 'ไม่พบการจอง' });
      const out = await adminActions.apply(b, action);
      if (out.error) return res.status(409).json({ error: out.error });
      res.json({ ok: true, ...out });
    } catch (e) {
      console.error('admin action error', e);
      res.status(500).json({ error: 'ทำรายการไม่สำเร็จ' });
    }
  });

  return r;
}
