// server.js
// API de reservas con Google Calendar como fuente de verdad
// Requisitos en Render:
//  - Variable: GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/gsa.json
//  - Secret file: gsa.json (Service Account) en /etc/secrets/gsa.json
//  - package.json con "type":"module"
//  - Node 20+ (recomendado 20 LTS)

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { google } from 'googleapis';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 10000;

// --------- Middlewares ---------
app.use(cors());
app.use(bodyParser.json());

// --------- Config ---------
const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/secrets/gsa.json';
if (!fs.existsSync(keyFile)) {
  console.error('⚠️  No se encuentra el fichero de credenciales:', keyFile);
}
const TZ = 'Europe/Madrid';

// Calendarios (IDs que me diste) y email de notificación (todos al mismo)
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

// Franjas disponibles (1 hora)
const RANGES = [
  '09:00-10:00',
  '10:00-11:00',
  '11:00-12:00',
  '12:00-13:00',
  '17:00-18:00',
  '18:00-19:00',
  '19:00-20:00',
];

// --------- Utilidades ---------
function getGoogleClient() {
  // Usa keyFilename -> JSON de Service Account
  return new google.auth.GoogleAuth({
    keyFilename: keyFile,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const wd = d.getDay();
  return wd === 0 || wd === 6;
}

function addWorkdays(from, n) {
  const x = new Date(from);
  let c = 0;
  while (c < n) {
    x.setDate(x.getDate() + 1);
    const wd = x.getDay();
    if (wd !== 0 && wd !== 6) c++;
  }
  return x;
}

function ensureMinWorkdays(dateStr, n = 5) {
  const today = new Date();
  const min = addWorkdays(today, n);
  const sel = new Date(dateStr + 'T00:00:00');
  return sel >= new Date(min.getFullYear(), min.getMonth(), min.getDate());
}

function toRFC3339(dateStr, range) {
  // "YYYY-MM-DD", "HH:MM-HH:MM" -> start/end ISO
  const [h1, m1] = range.split('-')[0].split(':').map(Number);
  const [h2, m2] = range.split('-')[1].split(':').map(Number);
  // construimos en local y dejamos que Calendar aplique TZ al insert
  const start = new Date(
    `${dateStr}T${String(h1).padStart(2, '0')}:${String(m1).padStart(2, '0')}:00`
  );
  const end = new Date(
    `${dateStr}T${String(h2).padStart(2, '0')}:${String(m2).padStart(2, '0')}:00`
  );
  return { start: start.toISOString(), end: end.toISOString() };
}

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

// --------- Rutas ---------
app.get('/', (_req, res) => res.type('text').send('Cuidame API • OK'));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Disponibilidad de un día/cuidadora
app.get('/api/slots', async (req, res) => {
  try {
    const { fecha, cuidadora } = req.query;
    console.log('SLOTS request →', { fecha, cuidadora });

    if (!fecha || !cuidadora) {
      console.log('SLOTS error: missing_params');
      return res.status(400).json({ error: 'missing_params' });
    }

    if (isWeekend(fecha)) {
      console.log('SLOTS weekend → bloqueado');
      return res.json({ slots: RANGES.map((r) => ({ range: r, taken: true })) });
    }

    const cfg = CAREGIVERS[cuidadora];
    if (!cfg) {
      console.log('SLOTS error: caregiver_not_found', cuidadora);
      return res.status(404).json({ error: 'caregiver_not_found' });
    }

    const auth = getGoogleClient();
    const calendar = google.calendar({ version: 'v3', auth });
    const events = await listDayEvents(calendar, cfg.calendarId, fecha);

    const taken = new Set();
    for (const ev of events) {
      const start = new Date(ev.start.dateTime || ev.start.date);
      const end = new Date(ev.end.dateTime || ev.end.date);
      for (const r of RANGES) {
        const { start: rs, end: re } = toRFC3339(fecha, r);
        const rStart = new Date(rs);
        const rEnd = new Date(re);
        if (rStart < end && rEnd > start) taken.add(r);
      }
    }

    const out = RANGES.map((r) => ({ range: r, taken: taken.has(r) }));
    return res.json({ slots: out });
  } catch (err) {
    console.error('SLOTS ERROR:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Crear reserva(s) (1 evento por franja)
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

    // Validaciones
    const required =
      nombre && apellidos && email && telefono && localidad && direccion && cuidadora && fecha;
    if (!required) return res.status(400).json({ error: 'Faltan datos personales' });

    if (!Array.isArray(servicios) || servicios.length === 0) {
      return res.status(400).json({ error: 'Elige al menos un servicio' });
    }
    if (!Array.isArray(horas) || horas.length === 0) {
      return res.status(400).json({ error: 'Elige al menos una franja' });
    }
    if (isWeekend(fecha)) return res.status(400).json({ error: 'weekend_not_allowed' });
    if (!ensureMinWorkdays(fecha, 5)) return res.status(400).json({ error: 'min_workdays_not_met' });

    const cfg = CAREGIVERS[cuidadora];
    if (!cfg) return res.status(404).json({ error: 'caregiver_not_found' });

    const auth = getGoogleClient();
    const calendar = google.calendar({ version: 'v3', auth });

    // Comprobar conflictos en vivo
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

    // Crear eventos (uno por franja)
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
          extendedProperties: { private: { cuidame: '1', range: r } },
        },
        sendUpdates: 'all',
      });
      createdEvents.push(ev.data);
    }

    // Precio estimado (eco)
    const RATE = 18;
    const IVA = 0.1;
    const horasCount = horas.length;
    const subtotal = horasCount * RATE;
    const iva = +(subtotal * IVA).toFixed(2);
    const total = +(subtotal + iva).toFixed(2);

    return res.json({
      ok: true,
      created: createdEvents.length,
      bloques: horas,
      precio: { horas: horasCount, subtotal, iva, total },
      eventIds: createdEvents.map((e) => e.id),
    });
  } catch (err) {
    console.error('RESERVAR ERROR:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Cancelar reservas (opcional)
app.post('/api/cancel', async (req, res) => {
  try {
    const { cuidadora, eventIds = [] } = req.body || {};
    if (!cuidadora || !Array.isArray(eventIds) || eventIds.length === 0) {
      return res.status(400).json({ error: 'missing_params' });
    }

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

// ---- Start ----
app.listen(PORT, () => {
  console.log(`API escuchando en ${PORT}`);
});
