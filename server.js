// server.js
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { google } from 'googleapis';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(bodyParser.json());

// ======== CONFIG ========
const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/secrets/gsa.json';
if (!fs.existsSync(keyFile)) {
  console.error('⚠️ No se encuentra el fichero de credenciales:', keyFile);
}
const TZ = 'Europe/Madrid';

// Calendarios por cuidadora (tus IDs)
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

// Todas las franjas laborales (incluye 13:00–14:00)
const RANGES = [
  '09:00-10:00',
  '10:00-11:00',
  '11:00-12:00',
  '12:00-13:00',
  '13:00-14:00',
  '17:00-18:00',
  '18:00-19:00',
  '19:00-20:00',
];

// ======== HELPERS ========
function getGoogleClient() {
  return new google.auth.GoogleAuth({
    keyFilename: keyFile,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.getDay() === 0 || d.getDay() === 6;
}

function addWorkdays(from, n) {
  const x = new Date(from);
  let c = 0;
  while (c < n) {
    x.setDate(x.getDate() + 1);
    if (![0, 6].includes(x.getDay())) c++;
  }
  return x;
}

function ensureMinWorkdays(dateStr, n = 5) {
  const today = new Date();
  const min = addWorkdays(today, n);
  const sel = new Date(dateStr + 'T00:00:00');
  const normalizedMin = new Date(min.getFullYear(), min.getMonth(), min.getDate());
  return sel >= normalizedMin;
}

function toRFC3339(dateStr, range) {
  const [h1, m1] = range.split('-')[0].split(':').map(Number);
  const [h2, m2] = range.split('-')[1].split(':').map(Number);
  const s = new Date(`${dateStr}T${String(h1).padStart(2,'0')}:${String(m1).padStart(2,'0')}:00`);
  const e = new Date(`${dateStr}T${String(h2).padStart(2,'0')}:${String(m2).padStart(2,'0')}:00`);
  return { start: s.toISOString(), end: e.toISOString() };
}

async function listDayEvents(calendar, calendarId, dateStr) {
  const startOfDay = new Date(dateStr + 'T00:00:00');
  const endOfDay   = new Date(dateStr + 'T23:59:59');
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

// ======== RUTAS ========
app.get('/', (_req, res) => res.send('Cuidame API • OK'));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Obtener slots disponibles
app.get('/api/slots', async (req, res) => {
  try {
    const { fecha, cuidadora } = req.query;
    if (!fecha || !cuidadora) return res.status(400).json({ error: 'missing_params' });

    // Fines de semana siempre bloqueados
    if (isWeekend(fecha)) return res.json({ slots: RANGES.map(r => ({ range: r, taken: true })) });

    const cfg = CAREGIVERS[cuidadora];
    if (!cfg) return res.status(404).json({ error: 'caregiver_not_found' });

    const auth = getGoogleClient();
    const calendar = google.calendar({ version: 'v3', auth });
    const events = await listDayEvents(calendar, cfg.calendarId, fecha);

    const taken = new Set();
    for (const ev of events) {
      const start = new Date(ev.start.dateTime || ev.start.date);
      const end   = new Date(ev.end.dateTime   || ev.end.date);
      for (const r of RANGES) {
        const { start: rs, end: re } = toRFC3339(fecha, r);
        const rStart = new Date(rs), rEnd = new Date(re);
        if (rStart < end && rEnd > start) taken.add(r);
      }
    }

    const out = RANGES.map(r => ({ range: r, taken: taken.has(r) }));
    res.json({ slots: out });
  } catch (err) {
    console.error('SLOTS ERROR:', err);
    res.status(500).json({ error: 'server_error', details: err.message });
  }
});

// Reservar (crea eventos sin attendees para evitar 403)
app.post('/api/reservar', async (req, res) => {
  try {
    const {
      nombre, apellidos, email, telefono,
      localidad, direccion, servicios = [],
      cuidadora, fecha, horas = [], detalles = ''
    } = req.body || {};

    if (!nombre || !apellidos || !email || !telefono || !localidad || !direccion || !cuidadora || !fecha)
      return res.status(400).json({ error: 'faltan_campos' });
    if (servicios.length === 0) return res.status(400).json({ error: 'faltan_servicios' });
    if (horas.length === 0)     return res.status(400).json({ error: 'faltan_horas' });
    if (isWeekend(fecha))       return res.status(400).json({ error: 'weekend_not_allowed' });
    if (!ensureMinWorkdays(fecha, 5)) return res.status(400).json({ error: 'min_workdays_not_met' });

    const cfg = CAREGIVERS[cuidadora];
    if (!cfg) return res.status(404).json({ error: 'caregiver_not_found' });

    const auth = getGoogleClient();
    const calendar = google.calendar({ version: 'v3', auth });

    // Comprobar conflictos
    const events = await listDayEvents(calendar, cfg.calendarId, fecha);
    const occupied = new Set();
    for (const ev of events) {
      const start = new Date(ev.start.dateTime || ev.start.date);
      const end   = new Date(ev.end.dateTime   || ev.end.date);
      for (const r of horas) {
        const { start: rs, end: re } = toRFC3339(fecha, r);
        const rStart = new Date(rs), rEnd = new Date(re);
        if (rStart < end && rEnd > start) occupied.add(r);
      }
    }
    if (occupied.size) return res.status(409).json({ error: 'conflict', slots: [...occupied] });

    // Crear eventos (sin attendees -> evita el 403)
    const created = [];
    for (const r of horas) {
      const { start, end } = toRFC3339(fecha, r);
      const summary = `CUIDAME — ${nombre} ${apellidos} — ${r}`;
      const description =
`Tel: ${telefono}
Email: ${email}
Localidad: ${localidad}
Dirección: ${direccion}
Servicios: ${servicios.join(', ')}
Cuidadora: ${cuidadora}
Origen: web-hero-overlay${detalles ? '\nDetalles: ' + detalles : ''}`;

      const ev = await calendar.events.insert({
        calendarId: cfg.calendarId,
        sendUpdates: 'none', // <- clave para no intentar invitar
        requestBody: {
          start: { dateTime: start, timeZone: TZ },
          end:   { dateTime: end,   timeZone: TZ },
          summary,
          description,
          guestsCanInviteOthers: false,
          guestsCanModify: false,
          guestsCanSeeOtherGuests: false,
          extendedProperties: { private: { cuidame: '1', range: r } },
        },
      });
      created.push(ev.data.id);
    }

    res.json({ ok: true, created: created.length, eventIds: created, bloques: horas });
  } catch (err) {
    console.error('RESERVAR ERROR:', err);
    res.status(500).json({ error: 'server_error', details: err.message });
  }
});

// Cancelar (borra del calendario -> vuelve a quedar libre)
app.post('/api/cancel', async (req, res) => {
  try {
    const { cuidadora, eventIds = [] } = req.body || {};
    if (!cuidadora || eventIds.length === 0) return res.status(400).json({ error: 'missing_params' });

    const cfg = CAREGIVERS[cuidadora];
    if (!cfg) return res.status(404).json({ error: 'caregiver_not_found' });

    const auth = getGoogleClient();
    const calendar = google.calendar({ version: 'v3', auth });

    for (const id of eventIds) {
      await calendar.events.delete({
        calendarId: cfg.calendarId,
        eventId: id,
        sendUpdates: 'none',
      });
    }
    res.json({ ok: true, deleted: eventIds.length });
  } catch (err) {
    console.error('CANCEL ERROR:', err);
    res.status(500).json({ error: 'server_error', details: err.message });
  }
});

app.listen(PORT, () => console.log(`API escuchando en ${PORT}`));
