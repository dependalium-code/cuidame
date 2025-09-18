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

/* ===== ENV ===== */
const PORT = process.env.PORT || 10000;
const TZ = 'Europe/Madrid';
const RATE = Number(process.env.RATE || 18);
const IVA = Number(process.env.IVA || 0.10);
const LEAD_WORKDAYS = Number(process.env.LEAD_WORKDAYS || 0);
const ORG_CALENDARS = (process.env.ORG_CALENDARS || '')
  .split(',').map(s => s.trim()).filter(Boolean); // 2 calendarios extra donde también se crea la reserva

/* ===== GOOGLE AUTH ===== */
function getJwt() {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile || !fs.existsSync(keyFile)) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS no apunta al JSON del service account');
  }
  return new google.auth.JWT({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
}
function calendarClient() { return google.calendar({ version: 'v3', auth: getJwt() }); }

/* ===== MAIL (opcional) ===== */
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

/* ===== UTIL ===== */
const pad = (n) => String(n).padStart(2, '0');
const isWeekend = (d) => [0, 6].includes(d.getDay());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
function addWorkdays(d, n) { if (n <= 0) return d; let x=new Date(d), a=0; while(a<n){ x=addDays(x,1); if(!isWeekend(x)) a++; } return x; }
function getRanges() { const out=[]; for (let h=9; h<14; h++) out.push(`${pad(h)}:00-${pad(h+1)}:00`); for (let h=16; h<20; h++) out.push(`${pad(h)}:00-${pad(h+1)}:00`); return out; }
const fmtHour = (date) => new Intl.DateTimeFormat('es-ES', { hour: '2-digit', hour12: false, timeZone: TZ }).format(date).padStart(2,'0');
const normalize = (s) => (s||'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
const caregiversIndex = Object.fromEntries(Object.entries(caregiversRaw).map(([k,v]) => [normalize(k), { ...v, _key: k }]));

// Acepta 2025-09-25 o 25/09/2025
function parseDateFlexible(s){
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [Y,M,D]=s.split('-').map(Number); return new Date(Date.UTC(Y,M-1,D)); }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) { const [D,M,Y]=s.split('/').map(Number); return new Date(Date.UTC(Y,M-1,D)); }
  return new Date(NaN);
}
function timeMinISO(ymdStr){ const d=parseDateFlexible(ymdStr); return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),0,0,0)).toISOString(); }
function timeMaxISO(ymdStr){ const d=parseDateFlexible(ymdStr); return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),23,59,59)).toISOString(); }
function rangeToDateTimes(ymdStr, range){
  const d=parseDateFlexible(ymdStr); const [s,e]=range.split('-'); const [sh]=s.split(':').map(Number); const [eh]=e.split(':').map(Number);
  const start=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),sh));
  const end  =new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),eh));
  return { start:{ dateTime:start.toISOString(), timeZone:TZ }, end:{ dateTime:end.toISOString(), timeZone:TZ } };
}

/* ===== LOG básico ===== */
app.use((req,_res,next)=>{ if (req.path.startsWith('/api/')) console.log(`[${req.method}] ${req.path}`, Object.keys(req.query).length?req.query:''); next(); });

/* ===== Google list con logs de error “de verdad” ===== */
async function listDayEvents(calendarId, ymdStr){
  const cal = calendarClient();
  try {
    return await cal.events.list({
      calendarId,
      timeMin: timeMinISO(ymdStr),
      timeMax: timeMaxISO(ymdStr),
      singleEvents: true,
      orderBy: 'startTime'
    });
  } catch (e) {
    console.error('GOOGLE LIST ERROR:', JSON.stringify(e?.response?.data || e?.message || e, null, 2));
    throw e;
  }
}

/* ===== ENDPOINTS ===== */
app.get('/api/health', (_req,res)=> res.json({ ok:true }));
app.get('/api/caregivers', (_req,res)=> res.json({ caregivers: Object.keys(caregiversRaw) }));

// Diagnóstico rápido (prueba permisos contra calendar de la cuidadora)
app.get('/api/diag', async (req,res)=>{
  const { cuidadora='Raquel', fecha='25/09/2025' } = req.query;
  const map = caregiversIndex[normalize(cuidadora)];
  if (!map) return res.status(400).json({ ok:false, error:'cuidadora_desconocida' });
  try {
    const out = await listDayEvents(map.calendarId, fecha);
    res.json({ ok:true, calendarId: map.calendarId, items:(out.data.items||[]).length });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.response?.data || e?.message || 'google_error' });
  }
});

// Disponibilidad: SOLO mira el calendar de la cuidadora
app.get('/api/slots', async (req,res)=>{
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

    const events = await listDayEvents(map.calendarId, fecha);
    const taken = new Set(
      (events.data.items || []).map(ev=>{
        try{
          const st=new Date(ev.start.dateTime || ev.start.date);
          const en=new Date(ev.end.dateTime || ev.end.date);
          return `${fmtHour(st)}:00-${fmtHour(en)}:00`;
        }catch{ return null; }
      }).filter(Boolean)
    );

    const slots = getRanges().map(r => ({ range:r, taken: taken.has(r) }));
    res.json({ slots });
  } catch (e) {
    console.error('SLOTS ERROR:', e?.response?.data || e?.message || e);
    res.status(500).json({ error:'server_error', detail: e?.response?.data || e?.message || 'unknown' });
  }
});

// Reserva: crea en 1) calendar de cuidadora + 2) ORG_CALENDARS
app.post('/api/reserve', async (req,res)=>{
  const { nombre, apellidos, email, telefono, localidad, direccion, servicios, cuidadora, fecha, horas = [], detalles = '' } = req.body || {};
  if (!nombre || !apellidos || !email || !telefono || !localidad || !direccion || !Array.isArray(servicios) || servicios.length === 0 || !cuidadora || !fecha || !Array.isArray(horas) || horas.length === 0) {
    return res.status(400).json({ error: 'faltan_campos' });
  }

  try{
    const map = caregiversIndex[normalize(cuidadora)];
    if (!map) return res.status(400).json({ error:'cuidadora_desconocida' });

    const qDate = parseDateFlexible(fecha);
    if (isNaN(qDate) || isWeekend(new Date(qDate))) return res.status(400).json({ error:'fecha_no_disponible' });

    const earliest = addWorkdays(new Date(), LEAD_WORKDAYS); earliest.setHours(0,0,0,0);
    if (qDate < earliest) return res.status(400).json({ error:'antes_de_lead' });

    // Conflictos del día en el calendar de la cuidadora
    const dayEv = await listDayEvents(map.calendarId, fecha);
    const occupied = new Set((dayEv.data.items||[]).map(ev=>{
      try{
        const st=new Date(ev.start.dateTime||ev.start.date), en=new Date(ev.end.dateTime||ev.end.date);
        return `${fmtHour(st)}:00-${fmtHour(en)}:00`;
      } catch { return null; }
    }).filter(Boolean));
    const conflicts = horas.filter(r => occupied.has(r));
    if (conflicts.length) return res.status(409).json({ error:'conflicto', slots: conflicts });

    const cal = calendarClient();
    const writeCalendars = [map.calendarId, ...ORG_CALENDARS];
    const created = [];

    for (const r of horas) {
      const { start, end } = rangeToDateTimes(fecha, r);
      const summary = `Reserva — ${nombre} ${apellidos} — ${map._key} — ${r}`;
      const description = `Tel: ${telefono}\nEmail: ${email}\nLocalidad: ${localidad}\nDirección: ${direccion}\nServicios: ${Array.isArray(servicios)?servicios.join(', '):servicios}\nCuidadora: ${map._key}\nOrigen: web\n${detalles ? `Detalles: ${detalles}` : ''}`;

      for (const calendarId of writeCalendars) {
        const ev = await cal.events.insert({
          calendarId,
          sendUpdates: 'none',
          requestBody: { start, end, summary, description, extendedProperties: { private: { range: r, cuidadora: map._key } } }
        });
        created.push({ calendarId, id: ev.data.id, range: r });
      }
    }

    await sendMail({ to: email, subject: `Reserva confirmada — ${fecha} — ${map._key}`, text: `Hola ${nombre}, hemos reservado ${horas.join(', ')} para el ${fecha}.` });

    res.json({
      ok: true,
      createdCount: created.length,
      bloques: horas,
      precio: { horas: horas.length, subtotal: RATE*horas.length, iva: RATE*horas.length*IVA, total: RATE*horas.length*(1+IVA) }
    });
  } catch (e) {
    console.error('RESERVAR ERROR:', e?.response?.data || e?.message || e);
    res.status(500).json({ error:'server_error', detail: e?.response?.data || e?.message || 'unknown' });
  }
});

app.listen(PORT, ()=>console.log(`API escuchando en ${PORT}`));
