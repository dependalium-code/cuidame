/**
 * Cuidame — API de reservas (Google Calendar)
 * Node 22.x — Express
 *
 * Requisitos en Render:
 * 1) Variable de entorno: GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/gsa.json
 * 2) Secret file: gsa.json (credenciales de la cuenta de servicio)
 * 3) Build & Start: node server.js
 */

import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';

const app = express();
app.use(cors());
app.use(express.json());

/* ========= CONFIG ========= */

/** Mapa de cuidadoras → sus calendarios (IDs correctos que nos pasaste) */
const CAREGIVERS = {
  Carmen: {
    calendarId:
      '4562295563647999c8222fc750cf01803405063f186574ff7df5dfe2694a9c73@group.calendar.google.com',
    email: 'dependalium@gmail.com',
  },
  Daniela: {
    calendarId:
      '84f168dd91cb85bbe4a97b2c88d4d174a3b09f53e025b0a51f401dc91cf70759@group.calendar.google.com',
    email: 'dependalium@gmail.com',
  },
  Raquel: {
    calendarId:
      'fe9a8085d8db29f888a6382935c82e20f33d476347adfe6416582401d377454d@group.calendar.google.com',
    email: 'dependalium@gmail.com',
  },
};

/** Zona horaria oficial — evita desfases */
const TZ = 'Europe/Madrid';

/** Rangos de horas: 09–13 y 16–20 (incluye 13–14, que te faltaba) */
const RANGES = [
  '09:00-10:00',
  '10:00-11:00',
  '11:00-12:00',
  '12:00-13:00',
  '13:00-14:00',
  '16:00-17:00',
  '17:00-18:00',
  '18:00-19:00',
  '19:00-20:00',
];

/** +5 días laborables bloqueados desde HOY */
const BLOCK_WORKDAYS = 5;

/* ========= HELPERS ========= */

/** ¿Fin de semana? (0=Dom, 6=Sáb) */
function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const wd = d.getDay();
  return wd === 0 || wd === 6;
}

/** Suma n días naturales */
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Suma n días laborables a partir de 'today' (sin contar sábados ni domingos) */
function addWorkdaysFromToday(n) {
  const x = new Date();
  let count = 0;
  while (count < n) {
    x.setDate(x.getDate() + 1);
    const wd = x.getDay();
    if (wd !== 0 && wd !== 6) count++;
  }
  // devuelve yyyy-mm-dd
  const pad = (k) => String(k).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

/** Da formato local “yyyy-mm-ddTHH:MM:SS” SIN offset ni Z (lo interpreta con timeZone) */
function toLocalDateTime(dateStr, hh, mm = 0) {
  const pad = (k) => String(k).padStart(2, '0');
  return `${dateStr}T${pad(hh)}:${pad(mm)}:00`;
}

/** Parsea "HH:MM-HH:MM" a objetos { dateTime, timeZone } **locales** */
function toGCalTimes(dateStr, range) {
  const [a, b] = range.split('-'); // "13:00" , "14:00"
  const [h1, m1] = a.split(':').map((n) => parseInt(n, 10));
  const [h2, m2] = b.split(':').map((n) => parseInt(n, 10));
  return {
    start: { dateTime: toLocalDateTime(dateStr, h1, m1), timeZone: TZ },
    end: { dateTime: toLocalDateTime(dateStr, h2, m2), timeZone: TZ },
  };
}

/** Auth de Google (usa GOOGLE_APPLICATION_CREDENTIALS) */
function getGoogleClient() {
  return new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

/** Lista los eventos de un día (00:00–23:59) del calendario */
async function listDayEvents(calendar, calendarId, dateStr) {
  const startOfDay = `${dateStr}T00:00:00`;
  const endOfDay = `${dateStr}T23:59:59`;
  const resp = await calendar.events.list({
    calendarId,
    timeMin: startOfDay,
    timeMax: endOfDay,
    timeZone: TZ,
    singleEvents: true,
    orderBy: 'startTime',
  });
  return resp.data.items || [];
}

/* ========= ENDPOINTS ========= */

app.get('/api/health', (req, res) => res.send('OK'));

/**
 * GET /api/slots?fecha=YYYY-MM-DD&cuidadora=Nombre
 * Responde con cada rango "taken" o no tomado
 * Bloquea fines de semana y también los primeros +5 laborables desde HOY
 */
app.get('/api/slots', async (req, res) => {
  try {
    const { fecha, cuidadora } = req.query;
    if (!fecha || !cuidadora)
      return res.status(400).json({ error: 'missing_params' });

    // bloqueos
    if (isWeekend(fecha)) {
      return res.json({
        slots: RANGES.map((r) => ({ range: r, taken: true })),
        reason: 'weekend',
      });
    }

    // +5 laborables bloqueados desde HOY
    const minAllowed = addWorkdaysFromToday(BLOCK_WORKDAYS); // yyyy-mm-dd
    if (fecha < minAllowed) {
      return res.json({
        slots: RANGES.map((r) => ({ range: r, taken: true })),
        reason: 'blocked_window',
        minAllowed,
      });
    }

    const cfg = CAREGIVERS[cuidadora];
    if (!cfg) return res.status(404).json({ error: 'caregiver_not_found' });

    const auth = getGoogleClient();
    const calendar = google.calendar({ version: 'v3', auth });

    const events = await listDayEvents(calendar, cfg.calendarId, fecha);

    // marca tomados
    const taken = new Set();
    for (const ev of events) {
      const evStart = new Date(ev.start.dateTime || ev.start.date);
      const evEnd = new Date(ev.end.dateTime || ev.end.date);
      for (const r of RANGES) {
        const { start, end } = toGCalTimes(fecha, r);
        const rStart = new Date(start.dateTime);
        const rEnd = new Date(end.dateTime);
        // solape
        if (rStart < evEnd && rEnd > evStart) taken.add(r);
      }
    }

    const out = RANGES.map((r) => ({ range: r, taken: taken.has(r) }));
    res.json({ slots: out });
  } catch (err) {
    console.error('❌ SLOTS ERROR:', err.response?.data || err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * POST /api/reserve
 * body: { nombre, apellidos, email, telefono, localidad, direccion, servicios[], cuidadora, fecha, horas[] }
 * Crea UN evento por cada hora solicitada (y no invita asistentes para evitar 403).
 */
app.post('/api/reserve', async (req, res) => {
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
      origen = 'web-hero-overlay',
      detalles = '',
    } = req.body || {};

    if (
      !nombre ||
      !apellidos ||
      !email ||
      !telefono ||
      !localidad ||
      !direccion ||
      !cuidadora ||
      !fecha ||
      !Array.isArray(horas) ||
      horas.length === 0
    ) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    // bloqueos
    if (isWeekend(fecha)) return res.status(400).json({ error: 'weekend' });
    const minAllowed = addWorkdaysFromToday(BLOCK_WORKDAYS);
    if (fecha < minAllowed)
      return res.status(400).json({ error: 'blocked_window', minAllowed });

    const cfg = CAREGIVERS[cuidadora];
    if (!cfg) return res.status(404).json({ error: 'caregiver_not_found' });

    const auth = getGoogleClient();
    const calendar = google.calendar({ version: 'v3', auth });

    // 1) Comprobar que no haya solapes ahora mismo
    const events = await listDayEvents(calendar, cfg.calendarId, fecha);
    const taken = new Set();
    for (const ev of events) {
      const evStart = new Date(ev.start.dateTime || ev.start.date);
      const evEnd = new Date(ev.end.dateTime || ev.end.date);
      for (const r of horas) {
        const { start, end } = toGCalTimes(fecha, r);
        const rStart = new Date(start.dateTime);
        const rEnd = new Date(end.dateTime);
        if (rStart < evEnd && rEnd > evStart) taken.add(r);
      }
    }
    if (taken.size > 0)
      return res.status(409).json({ error: 'conflict', slots: [...taken] });

    // 2) Crear cada evento (sin attendees, sin sendUpdates)
    const created = [];
    for (const range of horas) {
      const { start, end } = toGCalTimes(fecha, range);
      const event = {
        start,
        end,
        summary: `CUIDAME — ${nombre} ${apellidos} — ${range}`,
        description:
          `Tel: ${telefono}\nEmail: ${email}\nLocalidad: ${localidad}\nDirección: ${direccion}\n` +
          `Servicios: ${servicios.join(', ') || '-'}\nCuidadora: ${cuidadora}\nOrigen: ${origen}\n${detalles ? `\nDetalles:\n${detalles}` : ''}`,
        // Nada de attendees para evitar 403 por DWD
        extendedProperties: { private: { cuidame: '1', range } },
      };

      const ins = await calendar.events.insert({
        calendarId: cfg.calendarId,
        requestBody: event,
        // Evitar envíos de invitaciones que causan 403 con service accounts
        sendUpdates: 'none',
      });

      created.push(ins.data.id);
    }

    res.json({
      ok: true,
      created: created.length,
      bloques: horas,
      precio: {
        horas: horas.length,
        subtotal: Number((horas.length * 18).toFixed(2)),
        iva: Number((horas.length * 18 * 0.1).toFixed(2)),
        total: Number((horas.length * 18 * 1.1).toFixed(2)),
      },
    });
  } catch (err) {
    console.error('❌ RESERVAR ERROR:', err.response?.data || err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/* ========= ARRANQUE ========= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`API escuchando en ${PORT}`);
});
