// server.js
// API de reservas que usa Google Calendar como fuente de verdad.
// Node 22, ESM habilitado (type: module en package.json)

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/* =========================
   Configuración básica
========================= */
const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;

// 1) Dónde está el JSON de la cuenta de servicio en Render:
//    Has subido el archivo secreto como /etc/secrets/gsa.json y
//    has configurado GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/gsa.json
const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/secrets/gsa.json';
if (!fs.existsSync(keyFile)) {
  console.error('No se encuentra el fichero de credenciales:', keyFile);
}

// 2) Email de notificaciones (opcional, ahora no lo usamos)
const DEFAULT_NOTIFY = 'dependalium@gmail.com';

// 3) Mapa de cuidadoras -> calendarId (tus IDs)
const CAREGIVERS = {
  Raquel: {
    calendarId:
      '4562295563647999c8222fc750cf01803405063f186574ff7df5dfe2694a9c73@group.calendar.google.com',
    email: 'dependalium@gmail.com',
  },
  Carmen: {
    calendarId:
      '84f168dd91cb85bbe4a97b2c88d4d174a3b09f53e025b0a51f401dc91cf70759@group.calendar.google.com',
    email: 'dependalium@gmail.com',
  },
  Daniela: {
    calendarId:
      'fe9a8085d8db29f888a6382935c82e20f33d476347adfe6416582401d377454d@group.calendar.google.com',
    email: 'dependalium@gmail.com',
  },
};

// 4) Huecos de trabajo por hora
const RANGES = [
  '09:00-10:00',
  '10:00-11:00',
  '11:00-12:00',
  '12:00-13:00',
  '17:00-18:00',
  '18:00-19:00',
  '19:00-20:00',
];

const TZ = 'Europe/Madrid';

/* =========================
   Google Calendar client
========================= */
function getGoogleClient() {
  // Las libs modernas de google usan keyFilename o credentials:
  return new google.auth.GoogleAuth({
    keyFilename: keyFile,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

function toRFC3339(dateStr, range) {
  // dateStr: "YYYY-MM-DD", range: "HH:MM-HH:MM" → start,end en ISO
  const [h1, m1] = range.split('-')[0].split(':').map(Number);
  const [h2, m2] = range.split('-')[1].split(':').map(Number);
  const start = new Date(`${dateStr}T${String(h1).padStart(2, '0')}:${String(m1).padStart(2, '0')}:00`);
  const end = new Date(`${dateStr}T${String(h2).padStart(2, '0')}:${String(m2).padStart(2, '0')}:00`);
  // Ajuste de TZ: Calendar espera RFC con offset; usamos toISOString y que Calendar interprete con zona
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T00:00');
  const wd = d.getDay();
  return wd === 0 || wd === 6;
}

/* =========================
   Utilidad: leer eventos del día
========================= */
async function listDayEvents(calendar, calendarId, dateStr) {
  const startOfDay = new Date(dateStr + 'T00:00:00');
  const endOfDay = new Date(dateStr + 'T23:59:59');
  const resp = await calendar.events.list({
    calendarId,
    singleEvents: true,
    orderBy: 'startTime',
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    timeZone: TZ,
  });
  return resp.data.items || [];
}

/* =========================
   Rutas
========================= */

// Salud
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Slots disponibles de una cuidadora en un día
app.get('/api/slots', async (req, res) => {
  try {
    const { fecha, cuidadora } = req.query;
    if (!fecha || !cuidadora) return res.status(400).json({ error: 'missing_params' });

    if (isWeekend(fecha)) {
      return res.json({ slots: RANGES.map(r => ({ range: r, taken: true })) }); // bloquear fines de semana
    }

    const cfg = CAREGIVERS[cuidadora];
    if (!cfg) return res.status(404).json({ error: 'caregiver_not_found' });

    const auth = getGoogleClient();
    const calendar = google.calendar({ version: 'v3', auth });

    const events = await listDayEvents(calendar, cfg.calendarId, fecha);

    // Convertimos eventos a mapa de rangos ocupados por cada hora exacta
    const taken = new Set();
    for (const ev of events) {
      // Cogemos hora de inicio y fin, y marcamos las franjas RANGES que solapen
      const start = new Date(ev.start.dateTime || ev.start.date);
      const end = new Date(ev.end.dateTime || ev.end.date);

      for (const r of RANGES) {
        const { start: rs, end: re } = toRFC3339(fecha, r);
        const rStart = new Date(rs);
        const rEnd = new Date(re);
        // Solape: inicio de rango < fin del evento && fin de rango > inicio del evento
        if (rStart < end && rEnd > start) taken.add(r);
      }
    }

    const out = RANGES.map(r => ({ range: r, taken: taken.has(r) }));
    return res.json({ slots: out });
  } catch (err) {
    console.error('SLOTS ERROR:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Crear reservas (1 evento por hora)
app.post('/api/reservar', async (req, res) => {
  try {
    const {
      nombre,
      apellidos,
      email,
      telefono,
      localidad,
      direccion,
      servicios = [],
      cuidadora,
      fecha,
      horas = [],
      detalles = '',
    } = req.body || {};

    // Validaciones básicas
    const required =
      nombre && apellidos && email && telefono && localidad && direccion && cuidadora && fecha;
    if (!required) return res.status(400).json({ error: 'Faltan datos personales' });
    if (!Array.isArray(servicios) || servicios.length === 0)
      return res.status(400).json({ error: 'Elige al menos un servicio' });
    if (!Array.isArray(horas) || horas.length === 0)
      return res.status(400).json({ error: 'Elige al menos una franja' });
    if (isWeekend(fecha)) return res.status(400).json({ error: 'weekend_not_allowed' });

    const cfg = CAREGIVERS[cuidadora];
    if (!cfg) return res.status(404).json({ error: 'caregiver_not_found' });

    const auth = getGoogleClient();
    const calendar = google.calendar({ version: 'v3', auth });

    // Comprobación de conflictos en vivo
    const events = await listDayEvents(calendar, cfg.calendarId, fecha);
    const occupied = new Set();
    for (const ev of events) {
      const start = new Date(ev.start.dateTime || ev.start.date);
      const end = new Date(ev.end.dateTime || ev.end.date);
      for (const r of horas) {
        const { start: rs, end: re } = toRFC3339(fecha, r);
        const rStart = new Date(rs);
        const rEnd = new Date(re);
        if (rStart < end && rEnd > start) occupied.add(r);
      }
    }
    if (occupied.size) {
      return res.status(409).json({ error: 'conflict', slots: [...occupied] });
    }

    // Crear eventos (uno por cada hora)
    const createdEvents = [];
    for (const r of horas) {
      const { start, end } = toRFC3339(fecha, r);
      const summary = `CUIDAME — ${nombre} ${apellidos} — ${r}`;
      const description =
        `Tel: ${telefono}\n` +
        `Email: ${email}\n` +
        `Localidad: ${localidad}\n` +
        `Dirección: ${direccion}\n` +
        `Servicios: ${servicios.join(', ')}\n` +
        (detalles ? `Detalles: ${detalles}\n` : '') +
        `Cuidadora: ${cuidadora}\n` +
        `Origen: web-hero-overlay`;

      const ev = await calendar.events.insert({
        calendarId: cfg.calendarId,
        requestBody: {
          start: { dateTime: start, timeZone: TZ },
          end: { dateTime: end, timeZone: TZ },
          summary,
          description,
          attendees: [{ email: cfg.email }, { email }],
          // Marcamos una meta para poder filtrar en el futuro si quieres
          extendedProperties: { private: { cuidame: '1', range: r } },
        },
        sendUpdates: 'all', // invita por email
      });
      createdEvents.push(ev.data);
    }

    // Precio estimado (lado cliente ya lo calcula, aquí sólo devolvemos eco)
    const horasCount = horas.length;
    const RATE = 18;
    const IVA = 0.10;
    const subtotal = horasCount * RATE;
    const iva = +(subtotal * IVA).toFixed(2);
    const total = +(subtotal + iva).toFixed(2);

    return res.json({
      ok: true,
      created: createdEvents.length,
      bloques: horas,
      precio: { horas: horasCount, subtotal, iva, total },
      // si quisieras cancelar vía API, podrías devolver los ids:
      eventIds: createdEvents.map(e => e.id),
    });
  } catch (err) {
    console.error('RESERVAR ERROR:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Cancelar eventos (opcional) => elimina array de eventIds del calendario
app.post('/api/cancel', async (req, res) => {
  try {
    const { cuidadora, eventIds = [] } = req.body || {};
    if (!cuidadora || !Array.isArray(eventIds) || !eventIds.length)
      return res.status(400).json({ error: 'missing_params' });

    const cfg = CAREGIVERS[cuidadora];
    if (!cfg) return res.status(404).json({ error: 'caregiver_not_found' });

    const auth = getGoogleClient();
    const calendar = google.calendar({ version: 'v3', auth });

    for (const id of eventIds) {
      await calendar.events.delete({ calendarId: cfg.calendarId, eventId: id, sendUpdates: 'all' });
    }
    return res.json({ ok: true, deleted: eventIds.length });
  } catch (err) {
    console.error('CANCEL ERROR:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Home
app.get('/', (_req, res) => {
  res.type('text').send('Cuidame API • OK');
});

app.listen(PORT, () => {
  console.log(`API escuchando en ${PORT}`);
});
