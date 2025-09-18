// server.js
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { google } from 'googleapis';
import fs from 'fs';
import caregivers from './caregivers.json' assert { type: 'json' };

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
  .split(',').map(s=>s.trim()).filter(Boolean);

/* ===== GOOGLE AUTH ===== */
function getJwt() {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile || !fs.existsSync(keyFile)) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS no apunta a un archivo existente');
  }
  return new google.auth.JWT({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
}
function calClient(){ return google.calendar({ version: 'v3', auth: getJwt() }); }

/* ===== UTIL ===== */
const pad = n => String(n).padStart(2,'0');
const isWeekend = d => [0,6].includes(d.getDay());
const addDays = (d,n)=>{const x=new Date(d); x.setDate(x.getDate()+n); return x;};
function addWorkdays(d,n){ if(n<=0) return d; let x=new Date(d),a=0; while(a<n){ x=addDays(x,1); if(!isWeekend(x)) a++; } return x; }
function getRanges(){ const out=[]; for(let h=9;h<14;h++) out.push(`${pad(h)}:00-${pad(h+1)}:00`); for(let h=16;h<20;h++) out.push(`${pad(h)}:00-${pad(h+1)}:00`); return out; }
const fmtHour = (date) => new Intl.DateTimeFormat('es-ES',{ hour:'2-digit', hour12:false, timeZone:TZ }).format(date).padStart(2,'0');

// fecha flexible: YYYY-MM-DD o DD/MM/YYYY
function parseDateFlexible(s){
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [Y,M,D]=s.split('-').map(Number); return new Date(Date.UTC(Y,M-1,D)); }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) { const [D,M,Y]=s.split('/').map(Number); return new Date(Date.UTC(Y,M-1,D)); }
  return new Date(NaN);
}
function timeMinISO(ymdStr){ const d=parseDateFlexible(ymdStr); return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),0,0,0)).toISOString(); }
function timeMaxISO(ymdStr){ const d=parseDateFlexible(ymdStr); return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),23,59,59)).toISOString(); }
function rangeToDateTimes(ymdStr, range){
  const d=parseDateFlexible(ymdStr);
  const [s,e]=range.split('-'); const [sh]=s.split(':').map(Number); const [eh]=e.split(':').map(Number);
  const start=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),sh));
  const end  =new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),eh));
  return { start:{ dateTime:start.toISOString(), timeZone:TZ }, end:{ dateTime:end.toISOString(), timeZone:TZ } };
}

const normalize = s => (s||'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
const caregiversIndex = Object.fromEntries(Object.entries(caregivers).map(([k,v]) => [normalize(k), { ...v, _key:k }]));

/* ===== LOG ===== */
app.use((req,_res,next)=>{ if(req.path.startsWith('/api/')) console.log(`[${req.method}] ${req.path}`, req.query); next(); });

/* ===== ENDPOINTS ===== */
app.get('/api/health', (_req,res)=> res.json({ ok:true }));
app.get('/api/caregivers', (_req,res)=> res.json({ caregivers: Object.keys(caregivers) }));

// DIAG: para probar permisos y que la fecha/parámetros están bien
app.get('/api/diag', async (req,res)=>{
  try{
    const { cuidadora='Raquel', fecha='2025-09-25' } = req.query;
    const map = caregiversIndex[normalize(cuidadora)];
    if (!map) return res.status(400).json({ ok:false, error:'cuidadora_desconocida' });
    const events = await calClient().events.list({
      calendarId: map.calendarId,
      timeMin: timeMinISO(fecha),
      timeMax: timeMaxISO(fecha),
      singleEvents: true,
      orderBy: 'startTime'
    });
    res.json({ ok:true, calendarId: map.calendarId, items: (events.data.items||[]).length });
  }catch(e){
    console.error('DIAG ERROR:', e?.response?.data || e?.message || e);
    res.status(500).json({ ok:false, error:'google_error', detail: e?.response?.data || e?.message || 'unknown' });
  }
});

app.get('/api/slots', async (req,res)=>{
  try{
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
  }catch(e){
    console.error('SLOTS ERROR:', e?.response?.data || e?.message || e);
    res.status(500).json({ error:'server_error', detail: e?.response?.data || e?.message || 'unknown' });
  }
});

app.post('/api/reserve', async (req,res)=>{
  try{
    const { nombre, apellidos, email, telefono, localidad, direccion, servicios, cuidadora, fecha, horas = [], detalles = '' } = req.body || {};
    if (!nombre || !apellidos || !email || !telefono || !localidad || !direccion || !Array.isArray(servicios) || servicios.length === 0 || !cuidadora || !fecha || !Array.isArray(horas) || horas.length === 0) {
      return res.status(400).json({ error: 'faltan_campos' });
    }

    const map = caregiversIndex[normalize(cuidadora)];
    if (!map) return res.status(400).json({ error:'cuidadora_desconocida' });

    const qDate = parseDateFlexible(fecha);
    if (isNaN(qDate) || isWeekend(new Date(qDate))) return res.status(400).json({ error:'fecha_no_disponible' });

    const earliest = addWorkdays(new Date(), LEAD_WORKDAYS); earliest.setHours(0,0,0,0);
    if (qDate < earliest) return res.status(400).json({ error:'antes_de_lead' });

    // Conflictos
    const dayEv = await calClient().events.list({
      calendarId: map.calendarId,
      timeMin: timeMinISO(fecha),
      timeMax: timeMaxISO(fecha),
      singleEvents: true,
      orderBy: 'startTime'
    });
    const occupied = new Set((dayEv.data.items||[]).map(ev=>{
      try{
        const st=new Date(ev.start.dateTime||ev.start.date), en=new Date(ev.end.dateTime||ev.end.date);
        return `${fmtHour(st)}:00-${fmtHour(en)}:00`;
      } catch { return null; }
    }).filter(Boolean));
    const conflicts = horas.filter(r => occupied.has(r));
    if (conflicts.length) return res.status(409).json({ error:'conflicto', slots: conflicts });

    // Crear en cuidadora + ORG_CALENDARS (sin duplicados)
    const writeCalendars = Array.from(new Set([map.calendarId, ...ORG_CALENDARS]));
    const created = [];
    const cal = calClient();

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

    res.json({ ok:true, createdCount: created.length, bloques: horas,
      precio: { horas: horas.length, subtotal: RATE*horas.length, iva: RATE*horas.length*IVA, total: RATE*horas.length*(1+IVA) } });
  }catch(e){
    console.error('RESERVE ERROR:', e?.response?.data || e?.message || e);
    res.status(500).json({ error:'server_error', detail: e?.response?.data || e?.message || 'unknown' });
  }
});

app.listen(PORT, ()=> console.log(`API escuchando en ${PORT}`));
