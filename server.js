// server.js
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import fs from 'fs';
import caregiversRaw from './caregivers.json' assert { type: 'json' };

const app = express();
app.use(cors());
app.use(bodyParser.json());

/* ======= ENV ======= */
const PORT = process.env.PORT || 10000;
const TZ = 'Europe/Madrid';
const RATE = Number(process.env.RATE || 18);
const IVA = Number(process.env.IVA || 0.10);
const LEAD_WORKDAYS = Number(process.env.LEAD_WORKDAYS || 0);

/* ======= GOOGLE AUTH ======= */
function getJwt() {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile || !fs.existsSync(keyFile)) {
    throw new Error('No keyFile. Define GOOGLE_APPLICATION_CREDENTIALS con la ruta a tu gsa.json');
  }
  return new google.auth.JWT({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}
function calendarClient() {
  return google.calendar({ version: 'v3', auth: getJwt() });
}

/* ======= EMAIL (Nodemailer) ======= */
const mailer = process.env.MAIL_USER
  ? nodemailer.createTransport({
      host: process.env.MAIL_HOST || 'smtp.gmail.com',
      port: Number(process.env.MAIL_PORT || 465),
      secure: String(process.env.MAIL_SECURE || 'true') === 'true',
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS,
      },
    })
  : null;

async function sendMail({ to, subject, text }) {
  if (!mailer) return;
  const from = process.env.MAIL_FROM || process.env.MAIL_USER;
  try {
    await mailer.sendMail({ from, to, subject, text });
  } catch (e) {
    console.error('MAIL ERROR:', e.message);
  }
}

/* ======= UTIL ======= */
const pad = (n) => String(n).padStart(2, '0');
function isWeekend(d) { const wd = d.getDay(); return wd === 0 || wd === 6; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function addWorkdays(d, n) {
  if (n <= 0) return d;
  let x = new Date(d);
  let added = 0;
  while (added < n) {
    x = addDays(x, 1);
    if (!isWeekend(x)) added++;
  }
  return x;
}
function getRanges() {
  const out = [];
  for (let h = 9; h < 14; h++) out.push(`${pad(h)}:00-${pad(h + 1)}:00`);
  for (let h = 16; h < 20; h++) out.push(`${pad(h)}:00-${pad(h + 1)}:00`);
  return out;
}
function rangeToDateTimes(dateYmd, range) {
  const [s, e] = range.split('-');
  const [sh] = s.split(':').map(Number);
  const [eh] = e.split(':').map(Number);
  const [Y, M, D] = dateYmd.split('-').map(Number);
  const start = new Date(Date.UTC(Y, M - 1, D, sh - 2));
  const end = new Date(Date.UTC(Y, M - 1, D, eh - 2));
  return {
    start: { dateTime: start.toISOString(), timeZone: TZ },
    end: { dateTime: end.toISOString(), timeZone: TZ },
  };
}

/* ======= NORMALIZACIÓN DE NOMBRES ======= */
const normalize = (s) =>
  (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const caregiversIndex = Object.fromEntries(
  Object.entries(caregiversRaw).map(([k, v]) => [normalize(k), { ...v, _key: k }])
);

/* ======= SLOTS ======= */
app.get('/api/slots', async (req, res) => {
  try {
    const { fecha, cuidadora } = req.query;
    if (!fecha || !cuidadora) return res.status(400).json({ error: 'faltan_parametros' });

    const key = normalize(cuidadora);
    const map = caregiversIndex[key];
    if (!map) return res.status(400).json({ error: 'cuidadora_desconocida' });

    const qDate = new Date(`${fecha}T00:00:00`);
    if (isNaN(qDate)) return res.status(400).json({ error: 'fecha_invalida' });
    if (isWeekend(qDate)) return res.json({ slots: [] });

    const earliest = addWorkdays(new Date(), LEAD_WORKDAYS);
    earliest.setHours(0,0,0,0);
    if (qDate < earliest) return res.json({ slots: [] });

    const cal = calendarClient();
    const events = await cal.events.list({
      calendarId: map.calendarId,
      timeMin: new Date(`${fecha}T00:00:00Z`).toISOString(),
      timeMax: new Date(`${fecha}T23:59:59Z`).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const taken = new Set(
      (events.data.items || []).map((ev) => {
        try {
          const st = new Date(ev.start.dateTime || ev.start.date);
          const en = new Date(ev.end.dateTime || ev.end.date);
          const sh = pad(st.getUTCHours() + 2);
          const eh = pad(en.getUTCHours() + 2);
          return `${sh}:00-${eh}:00`;
        } catch { return null; }
      }).filter(Boolean)
    );

    const slots = getRanges().map((r) => ({ range: r, taken: taken.has(r) }));
    res.json({ slots });
  } catch (e) {
    console.error('SLOTS ERROR:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/* ======= RESERVA ======= */
app.post('/api/reserve', async (req, res) => {
  const { nombre, apellidos, email, telefono, localidad, direccion, servicios, cuidadora, fecha, horas = [], detalles = '' } = req.body || {};
  if (!nombre || !apellidos || !email || !telefono || !localidad || !direccion || !Array.isArray(servicios) || servicios.length === 0 || !cuidadora || !fecha || !Array.isArray(horas) || horas.length === 0) {
    return res.status(400).json({ error: 'faltan_campos' });
  }

  try {
    const key = normalize(cuidadora);
    const map = caregiversIndex[key];
    if (!map) return res.status(400).json({ error: 'cuidadora_desconocida' });

    const qDate = new Date(`${fecha}T00:00:00`);
    if (isNaN(qDate) || isWeekend(qDate)) return res.status(400).json({ error: 'fecha_no_disponible' });

    const earliest = addWorkdays(new Date(), LEAD_WORKDAYS);
    earliest.setHours(0,0,0,0);
    if (qDate < earliest) return res.status(400).json({ error: 'antes_de_lead' });

    const cal = calendarClient();
    const existing = (await cal.events.list({
      calendarId: map.calendarId,
      timeMin: new Date(`${fecha}T00:00:00Z`).toISOString(),
      timeMax: new Date(`${fecha}T23:59:59Z`).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    })).data.items || [];

    const occupied = new Set(existing.map((ev) => {
      try {
        const st = new Date(ev.start.dateTime || ev.start.date);
        const en = new Date(ev.end.dateTime || ev.end.date);
        const sh = pad(st.getUTCHours() + 2);
        const eh = pad(en.getUTCHours() + 2);
        return `${sh}:00-${eh}:00`;
      } catch { return null; }
    }).filter(Boolean));

    const conflicts = horas.filter((r) => occupied.has(r));
    if (conflicts.length) return res.status(409).json({ error: 'conflicto', slots: conflicts });

    const createdIds = [];
    for (const r of horas) {
      const { start, end } = rangeToDateTimes(fecha, r);
      const summary = `Reserva — ${nombre} ${apellidos} — ${r}`;
      const description = `Tel: ${telefono}\nEmail: ${email}\nLocalidad: ${localidad}\nDirección: ${direccion}\nServicios: ${servicios.join(', ')}\nCuidadora: ${cuidadora}\n${detalles ? `Detalles: ${detalles}` : ''}`;
      const ev = await cal.events.insert({
        calendarId: map.calendarId,
        sendUpdates: 'none',
        requestBody: {
          start, end, summary, description,
          extendedProperties: { private: { range: r } }
        },
      });
      createdIds.push(ev.data.id);
    }

    await sendMail({
      to: email,
      subject: `Reserva confirmada — ${fecha} — ${cuidadora}`,
      text: `Hola ${nombre}, tu reserva para ${fecha} en ${horas.join(', ')} ha sido confirmada.`
    });

    res.json({
      ok: true,
      created: createdIds.length,
      bloques: horas,
      precio: {
        horas: horas.length,
        subtotal: RATE * horas.length,
        iva: RATE * horas.length * IVA,
        total: RATE * horas.length * (1 + IVA),
      },
    });
  } catch (e) {
    console.error('RESERVAR ERROR:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/* ======= HEALTH ======= */
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`API escuchando en ${PORT}`));
