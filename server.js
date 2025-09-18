// server.js
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { google } from 'googleapis';
import fs from 'fs';
import nodemailer from 'nodemailer';
import caregivers from './caregivers.json' with { type: 'json' }; // Node 22+

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Desactivar caché en /api
app.set('etag', false);
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

/* ========= ENV ========= */
const PORT = process.env.PORT || 10000;
const TZ = 'Europe/Madrid';
const RATE = Number(process.env.RATE || 18);
const IVA  = Number(process.env.IVA  || 0.10);
const LEAD_WORKDAYS = Number(process.env.LEAD_WORKDAYS || 0);

const ORG_CALENDARS = (process.env.ORG_CALENDARS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/* ========= GOOGLE AUTH ========= */
function getJwt() {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile || !fs.existsSync(keyFile)) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS no apunta a un archivo existente (gsa.json).');
  }
  return new google.auth.JWT({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
}
function calClient() {
  return google.calendar({ version: 'v3', auth: getJwt() });
}

/* ========= EMAIL (opcional) ========= */
const mailer = process.env.MAIL_USER
  ? nodemailer.createTransport({
      host: process.env.MAIL_HOST || 'smtp.gmail.com',
      port: Number(process.env.MAIL_PORT || 465),
      secure: String(process.env.MAIL_SECURE || 'true') === 'true',
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
    })
  : null;

async function sendMail({ to, subject, text }) {
  if (!mailer) return;
  const from = process.env.MAIL_FROM || process.env.MAIL_USER;
  try { await mailer.sendMail({ from, to, subject, text }); }
  catch (e) { console.error('MAIL ERROR:', e?.message || e); }
}

/* ========= UTIL ========= */
const pad = n => String(n).padStart(2, '0');
const isWeekend = d => [0, 6].includes(d.getDay());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
function addWorkdays(d, n) { if (n <= 0) return d; let x = new Date(d), a = 0; while (a < n) { x = addDays(x, 1); if (!isWeekend(x)) a++; } return x; }
function getRanges() {
  const out = [];
  for (let h = 9; h < 14; h++) out.push(`${pad(h)}:00-${pad(h+1)}:00`);
  for (let h = 16; h < 20; h++) out.push(`${pad(h)}:00-${pad(h+1)}:00`);
  return out;
}

const fmtHour = (date) =>
  new Intl.DateTimeFormat('es-ES', { hour: '2-digit', hour12: false, timeZone: TZ })
    .format(date).padStart(2, '0');

// Acepta 'YYYY-MM-DD' o 'DD/MM/YYYY'
function parseDateFlexible(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [Y,M,D] = s.split('-').map(Number); return new Date(Date.UTC(Y, M-1, D)); }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) { const [D,M,Y] = s.split('/').map(Number); return new Date(Date.UTC(Y, M-1, D)); }
  return new Date(NaN);
}
function timeMinISO(ymdStr){ const d = parseDateFlexible(ymdStr); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0,0,0)).toISOString(); }
function timeMaxISO(ymdStr){ const d = parseDateFlexible(ymdStr); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23,59,59)).toISOString(); }

/* === FIX 1: horas exactas con offset RFC3339 (+01:00/+02:00) === */
function rangeToDateTimes(ymdStr, range) {
  // Calcula el offset real de Europe/Madrid para esa fecha (verano/invierno)
  const offsetFor = (dateYmd) => {
    const ref = new Date(`${dateYmd}T12:00:00Z`);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      timeZoneName: 'shortOffset'
    }).formatToParts(ref);
    const name = (parts.find(p => p.type === 'timeZoneName') || {}).value || 'GMT+00';
    const m = name.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/);
    const sign = m && m[1].startsWith('-') ? '-' : '+';
    const hh = m ? String(Math.abs(parseInt(m[1], 10))).padStart(2, '0') : '00';
    const mm = (m && m[2]) ? m[2] : '00';
    return `${sign}${hh}:${mm}`;
  };

  const offset = offsetFor(ymdStr);
  const [s, e] = range.split('-');
  const make = (hhmm) => {
    const [h, m = 0] = hhmm.split(':').map(Number);
    // devolvemos dateTime con offset embebido y SIN timeZone
    return { dateTime: `${ymdStr}T${pad(h)}:${pad(m)}:00${offset}` };
  };
  return { start: make(s), end: make(e) };
}

const normalize = s => (s||'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
const caregiversIndex = Object.fromEntries(Object.entries(caregivers).map(([k,v]) => [normalize(k), { ...v, _key:k }]));

/* ========= LOG ========= */
app.use((req,_res,next)=>{ if (req.path.startsWith('/api/')) console.log(`[${req.method}] ${req.path}`, req.query); next(); });

/* ========= ENDPOINTS ========= */
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/caregivers', (_req, res) => res.json({ caregivers: Object.keys(caregivers) }));

// Diagnóstico de permisos/fecha para una cuidadora
app.get('/api/diag', async (req, res) => {
  try {
    const { cuidadora = 'Raquel', fecha = '2025-09-25' } = req.query;
    const map = caregiversIndex[normalize(cuidadora)];
    if (!map) return res.status(400).json({ ok:false, error:'cuidadora_desconocida' });

    const r = await calClient().events.list({
      calendarId: map.calendarId,
      timeMin: timeMinISO(fecha),
      timeMax: timeMaxISO(fecha),
      singleEvents: true,
      orderBy: 'startTime'
    });

    res.json({ ok:true, calendarId: map.calendarId, items: (r.data.items || []).length });
  } catch (e) {
    console.error('DIAG ERROR:', e?.response?.data || e?.message || e);
    res.status(500).json({ ok:false, error:'google_error', detail: e?.response?.data || e?.message || 'unknown' });
  }
});

// Slots de disponibilidad (solo calendario de la cuidadora)
app.get('/api/slots', async (req, res) => {
  try {
    const { fecha, cuidadora } = req.query;
    if (!fecha || !cuidadora) return res.status(400).json({ error:'faltan_parametros' });

    const map = caregiversIndex[normalize(cuidadora)];
    if (!map) return res.status(400).json({ error:'cuidadora_desconocida' });

    const qDate = parseDateFlexible(fecha);
    if (isNaN(qDate)) return res.status(400).json({ error:'fecha_invalida' });
    if (isWeekend(new Date(qDate))) return res.json({ slots: [] });

    const earliest = addWorkdays(new Date(), LEAD_WORKDAYS); earliest.setHours(0,0,0,0);
    if (qDate < earliest) return res.json({ slots: [] });

    const events = await calClient().events.list({
      calendarId: map.calendarId,
      timeMin: timeMinISO(fecha),
      timeMax: timeMaxISO(fecha),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const taken = new Set(
      (events.data.items || []).map(ev => {
        try {
          const st = new Date(ev.start.dateTime || ev.start.date);
          const en = new Date(ev.end.dateTime   || ev.end.date);
          return `${fmtHour(st)}:00-${fmtHour(en)}:00`;
        } catch { return null; }
      }).filter(Boolean)
    );

    const slots = getRanges().map(r => ({ range: r, taken: taken.has(r) }));
    res.json({ slots });
  } catch (e) {
    console.error('SLOTS ERROR:', e?.response?.data || e?.message || e);
    res.status(500).json({ error:'server_error', detail: e?.response?.data || e?.message || 'unknown' });
  }
});

// Crear reserva en 1) calendario de la cuidadora + 2) ORG_CALENDARS (filtrados)
app.post('/api/reserve', async (req, res) => {
  try {
    const { nombre, apellidos, email, telefono, localidad, direccion, servicios, cuidadora, fecha, horas = [], detalles = '' } = req.body || {};
    if (!nombre || !apellidos || !email || !telefono || !localidad || !direccion || !Array.isArray(servicios) || servicios.length === 0 || !cuidadora || !fecha || !Array.isArray(horas) || horas.length === 0) {
      return res.status(400).json({ error:'faltan_campos' });
    }

    const map = caregiversIndex[normalize(cuidadora)];
    if (!map) return res.status(400).json({ error:'cuidadora_desconocida' });

    const qDate = parseDateFlexible(fecha);
    if (isNaN(qDate) || isWeekend(new Date(qDate))) return res.status(400).json({ error:'fecha_no_disponible' });

    const earliest = addWorkdays(new Date(), LEAD_WORKDAYS); earliest.setHours(0,0,0,0);
    if (qDate < earliest) return res.status(400).json({ error:'antes_de_lead' });

    // Comprobación de conflictos en calendario de la cuidadora
    const dayEv = await calClient().events.list({
      calendarId: map.calendarId,
      timeMin: timeMinISO(fecha),
      timeMax: timeMaxISO(fecha),
      singleEvents: true,
      orderBy: 'startTime'
    });
    const occupied = new Set(
      (dayEv.data.items || []).map(ev => {
        try {
          const st = new Date(ev.start.dateTime || ev.start.date);
          const en = new Date(ev.end.dateTime   || ev.end.date);
          return `${fmtHour(st)}:00-${fmtHour(en)}:00`;
        } catch { return null; }
      }).filter(Boolean)
    );
    const conflicts = horas.filter(r => occupied.has(r));
    if (conflicts.length) return res.status(409).json({ error:'conflicto', slots: conflicts });

    /* === FIX 2: no escribir en calendarios de otras cuidadoras === */
    const caregiverCalendarIds = new Set(Object.values(caregivers).map(c => c.calendarId));
    let writeCalendars = [map.calendarId, ...ORG_CALENDARS]
      .filter(id => id === map.calendarId || !caregiverCalendarIds.has(id));
    writeCalendars = Array.from(new Set(writeCalendars)); // dedup

    const created = [];
    const cal = calClient();

    for (const r of horas) {
      const { start, end } = rangeToDateTimes(fecha, r);
      const summary = `Reserva — ${nombre} ${apellidos} — ${map._key} — ${r}`;
      const description =
        `Tel: ${telefono}\nEmail: ${email}\nLocalidad: ${localidad}\nDirección: ${direccion}\n` +
        `Servicios: ${Array.isArray(servicios) ? servicios.join(', ') : servicios}\n` +
        `Cuidadora: ${map._key}\nOrigen: web\n${detalles ? `Detalles: ${detalles}` : ''}`;

      for (const calendarId of writeCalendars) {
        const ev = await cal.events.insert({
          calendarId,
          sendUpdates: 'none',
          requestBody: {
            start, end, summary, description,
            extendedProperties: { private: { range: r, cuidadora: map._key } }
          }
        });
        created.push({ calendarId, id: ev.data.id, range: r });
      }
    }

    // Correo de cortesía (si está configurado)
    await sendMail({
      to: email,
      subject: `Reserva confirmada — ${fecha} — ${map._key}`,
      text: `Hola ${nombre}, hemos reservado ${horas.join(', ')} para el ${fecha}.`
    });

    res.json({
      ok: true,
      createdCount: created.length,
      bloques: horas,
      precio: {
        horas: horas.length,
        subtotal: RATE * horas.length,
        iva: RATE * horas.length * IVA,
        total: RATE * horas.length * (1 + IVA)
      }
    });
  } catch (e) {
    console.error('RESERVE ERROR:', e?.response?.data || e?.message || e);
    res.status(500).json({ error:'server_error', detail: e?.response?.data || e?.message || 'unknown' });
  }
});

/* ========= START ========= */
app.listen(PORT, () => console.log(`API escuchando en ${PORT}`));

