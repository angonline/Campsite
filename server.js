import 'dotenv/config';
import express from 'express';
import { randomInt } from 'node:crypto';
import * as line from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import { apiRouter } from './api.js';

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});
const blob = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: lineConfig.channelAccessToken,
});
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID;
const ADMIN_USERS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// สร้างลิงก์ LIFF อัตโนมัติจาก LIFF_ID (ถ้าไม่ได้ใส่ LIFF_URL ที่ถูกต้อง)
const rawLiffUrl = (process.env.LIFF_URL || '').trim();
const LIFF_ID = (process.env.LIFF_ID || '').trim();
const LIFF_URL = rawLiffUrl.startsWith('https://liff.line.me/')
  ? rawLiffUrl
  : LIFF_ID
  ? `https://liff.line.me/${LIFF_ID}`
  : '';

const text = (t) => ({ type: 'text', text: t });
const baht = (n) => Number(n).toLocaleString('th-TH');
const reply = (event, messages) =>
  client.replyMessage({ replyToken: event.replyToken, messages });
const todayTH = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
const addDay = (s, d) => {
  const x = new Date(s + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
};
const STATUS_TH = {
  pending_payment: 'รอชำระเงิน',
  awaiting_confirm: 'รอแอดมินตรวจสลิป',
  confirmed: 'ยืนยันแล้ว',
  rejected: 'ไม่ผ่านการยืนยัน',
  cancelled: 'ยกเลิกแล้ว',
};
const ACTIVE = ['pending_payment', 'awaiting_confirm', 'confirmed'];
const CONTACT_PHONE = process.env.CONTACT_PHONE || '081 391 1540';
const CONTACT_LINE = process.env.CONTACT_LINE || '@JTGROUP';
const CONTACT_TEXT = `ติดต่อ: โทร ${CONTACT_PHONE} | LINE ${CONTACT_LINE}`;

// รหัสจอง 6 ตัว ไม่มีตัวที่สับสนง่าย (0/O, 1/I)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genCode = () =>
  Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
async function assignCode(id) {
  for (let i = 0; i < 6; i++) {
    const { error } = await supabase
      .from('bookings')
      .update({ booking_code: genCode() })
      .eq('id', id)
      .is('booking_code', null);
    if (!error) break;
    if (error.code !== '23505') throw error;
  }
  const { data } = await supabase.from('bookings').select('booking_code').eq('id', id).single();
  return data?.booking_code;
}

const confirmText = (b, code) =>
  `✅ ยืนยันการจองแล้ว\nรหัสจอง: ${code}\nจุด ${b.spots?.name} | ${b.guests} คน\n${b.check_in} ถึง ${b.check_out}\n\nวันเข้าพัก กรุณาแจ้งรหัสจองนี้กับเจ้าหน้าที่ (พร้อมเบอร์โทรที่ใช้จอง)\n${CONTACT_TEXT}`;
const rejectText = `❌ ขออภัย การจองไม่ผ่านการยืนยัน (สลิปไม่ถูกต้องหรือยอดไม่ตรง) กรุณาติดต่อแอดมินครับ\n${CONTACT_TEXT}`;
const cancelText = 'การจองของคุณถูกยกเลิกแล้ว หากชำระเงินไปแล้ว แอดมินจะติดต่อเรื่องการคืนเงินครับ';

const NO_LINE_NOTE = (b) => `\n(ลูกค้าจองผ่านเว็บ ไม่มี LINE โปรดแจ้งผลทางโทร ${b.phone})`;
async function notifyCustomer(booking, messages) {
  if (!booking.line_user_id) return false;
  await client.pushMessage({ to: booking.line_user_id, messages });
  return true;
}

const app = express();
app.set('trust proxy', 1);

app.use(express.static('public'));
app.use('/api', express.json({ limit: '4mb' }), apiRouter({ supabase, client, notifyAdminSlip, adminActions: { apply: applyAdminAction } }));

app.get('/', (_req, res) => res.send('camp-bot is running'));

// เรียกวันละครั้งจาก cron-job.org: แจ้งเตือนลูกค้าที่เข้าพักพรุ่งนี้ + ปล่อยจุดที่ค้างชำระ
app.get('/cron/reminders', async (req, res) => {
  if (!process.env.CRON_SECRET || req.query.key !== process.env.CRON_SECRET)
    return res.sendStatus(401);
  const tomorrow = addDay(todayTH(), 1);
  const { data } = await supabase
    .from('bookings')
    .select('*, spots(name)')
    .eq('status', 'confirmed')
    .eq('check_in', tomorrow)
    .not('line_user_id', 'is', null)
    .is('reminded_at', null);
  let sent = 0;
  for (const b of data || []) {
    try {
      await client.pushMessage({
        to: b.line_user_id,
        messages: [
          text(
            `🏕 แจ้งเตือนการเข้าพัก\nพรุ่งนี้ (${b.check_in}) คุณเข้าพักที่จุด ${b.spots.name}\n` +
              `ถึง ${b.check_out} | ${b.guests} คน\n` +
              (b.booking_code ? `รหัสจอง: ${b.booking_code} (แจ้งเจ้าหน้าที่ตอนเข้าพัก)\n` : '') +
              `แล้วพบกันครับ`
          ),
        ],
      });
      await supabase
        .from('bookings')
        .update({ reminded_at: new Date().toISOString() })
        .eq('id', b.id);
      sent++;
    } catch (e) {
      console.error('reminder failed', b.id, e.message);
    }
  }
  await supabase
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('status', 'pending_payment')
    .lt('created_at', new Date(Date.now() - 20 * 60 * 1000).toISOString());
  res.json({ sent });
});

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
  } catch (err) {
    console.error('webhook error', err.message, err.status, JSON.stringify(err.body || ''));
  }
  res.sendStatus(200);
});

async function handleEvent(event) {
  if (event.type === 'follow') {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [text('ยินดีต้อนรับครับ พิมพ์ "จอง" เพื่อจองที่กางเต็นท์')],
    });
  }
  if (event.type === 'postback') return handlePostback(event);
  if (event.type === 'message' && event.message.type === 'text')
    return handleText(event);
  if (event.type === 'message' && event.message.type === 'image')
    return handleSlip(event);
}

// ---------- ข้อความจากลูกค้า ----------
async function handleText(event) {
  const msg = event.message.text.trim().toLowerCase();

  // ใช้หา userId / groupId เพื่อตั้งค่าแอดมิน
  if (msg === 'myid') {
    const s = event.source;
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        text(`userId: ${s.userId || '-'}\ngroupId: ${s.groupId || '-'}`),
      ],
    });
  }

  const codeMatch = event.message.text.trim().match(/^รหัส\s*([A-Za-z0-9]{4,10})$/);
  if (codeMatch) return lookupCode(event, codeMatch[1].toUpperCase());

  if (msg === 'การจองของฉัน') return myBookings(event);
  if (msg === 'ยกเลิก') return cancelMenu(event);
  if (msg === 'สรุปวันนี้') return dailySummary(event);

  if (msg === 'จอง' || msg === 'book') {
    if (!LIFF_URL) {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [text('ระบบจองกำลังเตรียมการ เร็ว ๆ นี้ครับ')],
      });
    }
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: 'template',
          altText: 'จองที่กางเต็นท์',
          template: {
            type: 'buttons',
            text: 'กดปุ่มเพื่อเลือกจุดและกรอกข้อมูลการจอง',
            actions: [
              { type: 'uri', label: 'จองที่กางเต็นท์', uri: LIFF_URL },
            ],
          },
        },
      ],
    });
  }

  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [text('พิมพ์ "จอง" เพื่อจองที่กางเต็นท์\n"การจองของฉัน" เพื่อดูสถานะ\n"ยกเลิก" เพื่อยกเลิกการจอง\nหรือส่งรูปสลิปหลังโอนเงินครับ')],
  });
}

// ---------- ลูกค้าส่งสลิป ----------
async function handleSlip(event) {
  const userId = event.source.userId;

  const { data: booking } = await supabase
    .from('bookings')
    .select('*, spots(name)')
    .eq('line_user_id', userId)
    .eq('status', 'pending_payment')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!booking) {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [text('ไม่พบการจองที่รอชำระเงิน พิมพ์ "จอง" เพื่อเริ่มจองใหม่ครับ')],
    });
  }

  // ดาวน์โหลดรูปจาก LINE แล้วเก็บใน Supabase Storage (bucket: slips, public)
  const stream = await blob.getMessageContent(event.message.id);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const buf = Buffer.concat(chunks);

  const path = `${booking.id}-${Date.now()}.jpg`;
  const { error: upErr } = await supabase.storage
    .from('slips')
    .upload(path, buf, { contentType: 'image/jpeg' });
  if (upErr) throw upErr;
  const { data: pub } = supabase.storage.from('slips').getPublicUrl(path);

  await supabase
    .from('bookings')
    .update({ slip_url: pub.publicUrl, status: 'awaiting_confirm' })
    .eq('id', booking.id);

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [text('ได้รับสลิปแล้วครับ รอแอดมินตรวจสอบและยืนยันการจอง')],
  });

  await notifyAdminSlip(booking, pub.publicUrl);
}

// แจ้งแอดมินในกลุ่มพร้อมรูปสลิปและปุ่มยืนยัน/ปฏิเสธ (ใช้ร่วมกับการจองผ่านเว็บ)
async function notifyAdminSlip(booking, slipUrl) {
  if (!ADMIN_GROUP_ID) return;
  await client.pushMessage({
    to: ADMIN_GROUP_ID,
    messages: [
      { type: 'image', originalContentUrl: slipUrl, previewImageUrl: slipUrl },
      {
        type: 'template',
        altText: 'มีการจองรอยืนยัน',
        template: {
          type: 'buttons',
          text: summary(booking).slice(0, 160),
          actions: [
            { type: 'postback', label: 'ยืนยัน', data: `action=confirm&id=${booking.id}` },
            { type: 'postback', label: 'ปฏิเสธ', data: `action=reject&id=${booking.id}` },
          ],
        },
      },
    ],
  });
}

function summary(b) {
  return (
    `${b.source === 'web' ? '[เว็บ] ' : ''}${b.customer_name} (${b.phone})\n` +
    `จุด ${b.spots?.name} | ${b.guests} คน\n` +
    `${b.check_in} ถึง ${b.check_out}\n` +
    `ยอด ${baht(b.total_price)} บาท`
  );
}

// ---------- ลูกค้า: ดูการจอง / ยกเลิก ----------
async function myBookings(event) {
  const { data } = await supabase
    .from('bookings')
    .select('*, spots(name)')
    .eq('line_user_id', event.source.userId)
    .in('status', ACTIVE)
    .gte('check_out', todayTH())
    .order('check_in')
    .limit(5);
  if (!data?.length)
    return reply(event, [text('ไม่พบการจองที่ใช้งานอยู่ พิมพ์ "จอง" เพื่อจองใหม่ครับ')]);
  const lines = data.map(
    (b) =>
      `• จุด ${b.spots.name} | ${b.guests} คน\n  ${b.check_in} ถึง ${b.check_out} | ${baht(b.total_price)} บาท\n  สถานะ: ${STATUS_TH[b.status]}${b.booking_code ? `\n  รหัสจอง: ${b.booking_code}` : ''}`
  );
  return reply(event, [
    text('การจองของคุณ\n\n' + lines.join('\n\n') + '\n\nพิมพ์ "ยกเลิก" หากต้องการยกเลิก'),
  ]);
}

async function cancelMenu(event) {
  const { data } = await supabase
    .from('bookings')
    .select('*, spots(name)')
    .eq('line_user_id', event.source.userId)
    .in('status', ACTIVE)
    .gte('check_in', todayTH())
    .order('check_in')
    .limit(5);
  if (!data?.length)
    return reply(event, [text('ไม่พบการจองที่ยกเลิกได้ครับ')]);
  return reply(event, [
    {
      type: 'template',
      altText: 'เลือกการจองที่ต้องการยกเลิก',
      template: {
        type: 'carousel',
        columns: data.map((b) => ({
          text: `จุด ${b.spots.name} | ${b.guests} คน\n${b.check_in} ถึง ${b.check_out}\n${baht(b.total_price)} บาท | ${STATUS_TH[b.status]}`.slice(0, 120),
          actions: [
            { type: 'postback', label: 'ยกเลิกการจองนี้', data: `action=cancel&id=${b.id}` },
          ],
        })),
      },
    },
  ]);
}

async function handleCustomerCancel(event, action, id) {
  if (action === 'cancel_no')
    return reply(event, [text('ไม่ได้ยกเลิกการจองครับ')]);

  const { data: b } = await supabase
    .from('bookings')
    .select('*, spots(name)')
    .eq('id', id)
    .eq('line_user_id', event.source.userId)
    .maybeSingle();
  if (!b || !ACTIVE.includes(b.status))
    return reply(event, [text('ไม่พบการจองที่ยกเลิกได้ครับ')]);

  if (action === 'cancel') {
    return reply(event, [
      {
        type: 'template',
        altText: 'ยืนยันการยกเลิก',
        template: {
          type: 'confirm',
          text: `ยืนยันยกเลิกจุด ${b.spots.name}\n${b.check_in} ถึง ${b.check_out}?`,
          actions: [
            { type: 'postback', label: 'ยกเลิกเลย', data: `action=cancel_yes&id=${id}` },
            { type: 'postback', label: 'ไม่ยกเลิก', data: `action=cancel_no&id=${id}` },
          ],
        },
      },
    ]);
  }

  // cancel_yes: ยังไม่จ่าย -> ยกเลิกได้ทันที
  if (b.status === 'pending_payment') {
    await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', id);
    return reply(event, [text('ยกเลิกการจองแล้วครับ')]);
  }

  // จ่ายแล้ว/ส่งสลิปแล้ว -> ส่งคำขอให้แอดมินอนุมัติ (เรื่องคืนเงินแอดมินคุยกับลูกค้าเอง)
  await reply(event, [
    text('ส่งคำขอยกเลิกให้แอดมินแล้วครับ แอดมินจะติดต่อกลับเรื่องการคืนเงิน'),
  ]);
  if (ADMIN_GROUP_ID) {
    await client.pushMessage({
      to: ADMIN_GROUP_ID,
      messages: [
        {
          type: 'template',
          altText: 'ลูกค้าขอยกเลิกการจอง',
          template: {
            type: 'buttons',
            text: ('ลูกค้าขอยกเลิก\n' + summary(b)).slice(0, 160),
            actions: [
              { type: 'postback', label: 'อนุมัติยกเลิก', data: `action=admin_cancel&id=${id}` },
            ],
          },
        },
      ],
    });
  }
}

// ---------- แอดมิน: ตรวจรหัสจองตอนลูกค้าเข้าพัก (พิมพ์ "รหัส K7M2QX") ----------
async function lookupCode(event, code) {
  if (!ADMIN_USERS.includes(event.source.userId))
    return reply(event, [text('คำสั่งนี้สำหรับแอดมินเท่านั้นครับ')]);
  const { data: b } = await supabase
    .from('bookings')
    .select('*, spots(name)')
    .eq('booking_code', code)
    .maybeSingle();
  if (!b) return reply(event, [text(`ไม่พบรหัส ${code}`)]);
  return reply(event, [
    text(
      `รหัส ${code}\nสถานะ: ${STATUS_TH[b.status]}\n` +
        `จุด ${b.spots.name} | ${b.guests} คน\n${b.check_in} ถึง ${b.check_out}\n` +
        `${b.customer_name} | ${b.phone}\nยอด ${baht(b.total_price)} บาท`
    ),
  ]);
}

// ---------- แอดมิน: สรุปวันนี้ ----------
async function dailySummary(event) {
  if (!ADMIN_USERS.includes(event.source.userId))
    return reply(event, [text('คำสั่งนี้สำหรับแอดมินเท่านั้นครับ')]);

  const today = todayTH();
  const tomorrow = addDay(today, 1);

  const { data: staying } = await supabase
    .from('bookings')
    .select('*, spots(name)')
    .eq('status', 'confirmed')
    .lte('check_in', today)
    .gt('check_out', today)
    .order('spot_id');
  const { count: waiting } = await supabase
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'awaiting_confirm');
  const { count: arrivingTomorrow } = await supabase
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'confirmed')
    .eq('check_in', tomorrow);
  const { count: totalSpots } = await supabase
    .from('spots')
    .select('id', { count: 'exact', head: true })
    .eq('active', true);

  const occupied = new Set((staying || []).map((b) => b.spot_id)).size;
  const lines = (staying || []).map(
    (b) =>
      `• ${b.spots.name} | ${b.customer_name} | ${b.guests} คน | ${b.phone}\n  รหัส ${b.booking_code || '-'} | ออก ${b.check_out}${b.check_in === today ? ' (เข้าวันนี้)' : ''}`
  );

  return reply(event, [
    text(
      `สรุปวันที่ ${today}\n` +
        `มีผู้เข้าพัก ${occupied}/${totalSpots} จุด (ว่าง ${totalSpots - occupied})\n` +
        `รอยืนยันสลิป ${waiting} รายการ\n` +
        `เข้าพักพรุ่งนี้ ${arrivingTomorrow} รายการ\n\n` +
        (lines.length ? lines.join('\n') : 'วันนี้ยังไม่มีผู้เข้าพัก')
    ),
  ]);
}

// ---------- ทำรายการจากหน้าเว็บแอดมิน (ใช้กติกาเดียวกับปุ่มใน LINE) ----------
async function applyAdminAction(b, action) {
  const now = new Date().toISOString();
  const safeNotify = (messages) => notifyCustomer(b, messages).catch(() => false);

  if (action === 'confirm' || action === 'reject') {
    if (b.status !== 'awaiting_confirm')
      return { error: `รายการนี้ถูกดำเนินการแล้ว (สถานะ: ${STATUS_TH[b.status]})` };
    const confirmed = action === 'confirm';
    await supabase
      .from('bookings')
      .update({ status: confirmed ? 'confirmed' : 'rejected', confirmed_at: confirmed ? now : null })
      .eq('id', b.id);
    const code = confirmed ? await assignCode(b.id) : null;
    const notified = await safeNotify([text(confirmed ? confirmText(b, code) : rejectText)]);
    return { code, notified, no_line: !b.line_user_id, phone: b.phone };
  }

  if (action === 'cancel') {
    if (!ACTIVE.includes(b.status))
      return { error: `ยกเลิกไม่ได้ (สถานะ: ${STATUS_TH[b.status]})` };
    await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', b.id);
    const notified = await safeNotify([text(cancelText)]);
    return { notified, no_line: !b.line_user_id, phone: b.phone };
  }

  if (action === 'checkin') {
    if (b.status !== 'confirmed') return { error: 'ต้องเป็นการจองที่ยืนยันแล้วเท่านั้น' };
    if (b.checked_in_at) return { error: 'เช็กอินไปแล้ว' };
    const { error } = await supabase.from('bookings').update({ checked_in_at: now }).eq('id', b.id);
    if (error) return { error: 'บันทึกเช็กอินไม่สำเร็จ (ตรวจว่ารัน migration_admin.sql แล้ว)' };
    return {};
  }
  return { error: 'คำสั่งไม่ถูกต้อง' };
}

// ---------- ปุ่มกด (postback) ----------
async function handlePostback(event) {
  const params = new URLSearchParams(event.postback.data);
  const action = params.get('action');
  const id = params.get('id');
  if (!action || !id) return;

  if (['cancel', 'cancel_yes', 'cancel_no'].includes(action))
    return handleCustomerCancel(event, action, id);
  if (!['confirm', 'reject', 'admin_cancel'].includes(action)) return;

  if (!ADMIN_USERS.includes(event.source.userId)) {
    return reply(event, [text('เฉพาะแอดมินเท่านั้นที่กดได้ครับ')]);
  }

  const { data: booking } = await supabase
    .from('bookings')
    .select('*, spots(name)')
    .eq('id', id)
    .maybeSingle();

  if (!booking) return reply(event, [text('ไม่พบรายการจองนี้')]);

  if (action === 'admin_cancel') {
    if (!['awaiting_confirm', 'confirmed'].includes(booking.status))
      return reply(event, [text(`รายการนี้ถูกดำเนินการแล้ว (สถานะ: ${STATUS_TH[booking.status]})`)]);
    await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', id);
    await reply(event, [
      text(`ยกเลิกการจองของ ${booking.customer_name} แล้ว` + (booking.line_user_id ? '' : NO_LINE_NOTE(booking))),
    ]);
    await notifyCustomer(booking, [
      text(cancelText),
    ]);
    return;
  }

  if (booking.status !== 'awaiting_confirm') {
    return reply(event, [text(`รายการนี้ถูกดำเนินการแล้ว (สถานะ: ${STATUS_TH[booking.status]})`)]);
  }

  const confirmed = action === 'confirm';
  await supabase
    .from('bookings')
    .update({
      status: confirmed ? 'confirmed' : 'rejected',
      confirmed_at: confirmed ? new Date().toISOString() : null,
    })
    .eq('id', id);
  const code = confirmed ? await assignCode(id) : null;

  await reply(event, [
    text(
      `${confirmed ? 'ยืนยัน' : 'ปฏิเสธ'}การจองของ ${booking.customer_name} แล้ว${code ? ` (รหัสจอง ${code})` : ''}` +
        (booking.line_user_id ? '' : NO_LINE_NOTE(booking))
    ),
  ]);

  // ลูกค้าที่จองผ่านเว็บจะเห็นผลที่หน้าสถานะเอง
  await notifyCustomer(booking, [
    text(
      confirmed
        ? confirmText(booking, code)
        : rejectText
    ),
  ]);
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`camp-bot listening on ${port} | LIFF link: ${LIFF_URL || 'NOT SET'}`));
