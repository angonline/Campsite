import 'dotenv/config';
import express from 'express';
import * as line from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';

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

const text = (t) => ({ type: 'text', text: t });
const baht = (n) => Number(n).toLocaleString('th-TH');

const app = express();

app.get('/', (_req, res) => res.send('camp-bot is running'));

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
  } catch (err) {
    console.error('webhook error', err);
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

  if (msg === 'จอง' || msg === 'book') {
    if (!process.env.LIFF_URL) {
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
              { type: 'uri', label: 'จองที่กางเต็นท์', uri: process.env.LIFF_URL },
            ],
          },
        },
      ],
    });
  }

  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [text('พิมพ์ "จอง" เพื่อจองที่กางเต็นท์ หรือส่งรูปสลิปหลังโอนเงินครับ')],
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

  // แจ้งแอดมิน
  if (ADMIN_GROUP_ID) {
    await client.pushMessage({
      to: ADMIN_GROUP_ID,
      messages: [
        { type: 'image', originalContentUrl: pub.publicUrl, previewImageUrl: pub.publicUrl },
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
}

function summary(b) {
  return (
    `${b.customer_name} (${b.phone})\n` +
    `จุด ${b.spots?.name} | ${b.guests} คน\n` +
    `${b.check_in} ถึง ${b.check_out}\n` +
    `ยอด ${baht(b.total_price)} บาท`
  );
}

// ---------- แอดมินกดปุ่ม ----------
async function handlePostback(event) {
  const params = new URLSearchParams(event.postback.data);
  const action = params.get('action');
  const id = params.get('id');
  if (!['confirm', 'reject'].includes(action) || !id) return;

  if (!ADMIN_USERS.includes(event.source.userId)) {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [text('เฉพาะแอดมินเท่านั้นที่กดได้ครับ')],
    });
  }

  const { data: booking } = await supabase
    .from('bookings')
    .select('*, spots(name)')
    .eq('id', id)
    .maybeSingle();

  if (!booking) {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [text('ไม่พบรายการจองนี้')],
    });
  }
  if (booking.status !== 'awaiting_confirm') {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [text(`รายการนี้ถูกดำเนินการแล้ว (สถานะ: ${booking.status})`)],
    });
  }

  const confirmed = action === 'confirm';
  await supabase
    .from('bookings')
    .update({
      status: confirmed ? 'confirmed' : 'rejected',
      confirmed_at: confirmed ? new Date().toISOString() : null,
    })
    .eq('id', id);

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [text(`${confirmed ? 'ยืนยัน' : 'ปฏิเสธ'}การจองของ ${booking.customer_name} แล้ว`)],
  });

  // แจ้งลูกค้า
  await client.pushMessage({
    to: booking.line_user_id,
    messages: [
      text(
        confirmed
          ? `✅ ยืนยันการจองแล้ว\nจุด ${booking.spots?.name}\n${booking.check_in} ถึง ${booking.check_out}\nขอบคุณที่ใช้บริการครับ`
          : '❌ ขออภัย การจองไม่ผ่านการยืนยัน (สลิปไม่ถูกต้องหรือยอดไม่ตรง) กรุณาติดต่อแอดมินครับ'
      ),
    ],
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`camp-bot listening on ${port}`));
