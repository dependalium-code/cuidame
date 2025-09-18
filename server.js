/**
 * Cuidame — Backend de reservas (Google Calendar + Email opcional)
 * Modo: CommonJS (compatible con Node en Render)
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

/* ---------- Configuración vía ENV ---------- */
const PORT         = process.env.PORT || 10000;
const TIMEZONE     = 'Europe/Madrid';
const RATE         = Number(process.env.RATE || 18);
const IVA          = Number(process.env.IVA || 0.10);
const LEAD_WORKDAYS = Number(process.env.LEAD_WORKDAYS || 5); // días laborables mínimos

/* ---------- Mapeo de cuidadoras (IDs CORREGIDOS) ---------- */
/* Usa EXACTAMENTE estos IDs que nos pasaste */
const CAREGIVERS = {
  Raquel: {
    calendarId:
      'fe9a8085d8db29f888a6382935c82e20f33d476347adfe6416582401d377454d@group.calendar.google.com',
    email: 'dependalium@gmail.com', // para futuros usos (no se invita)
  },
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
};

/* ---------- Slots de trabajo (incluye 13:00–14:00) ---------- */
const SLOT_RANGES = [
  '09:00-10:00',
  '10:00-11:00',
  '11:00-12:00',
  '12:00-13:00',
  '13:00-14:00',
  // tarde
  '17:00-18:00',
  '18:00-19:00',
  '19:00-20:00',
];

/* ---------- Utilidades de fecha ---------- */
const isWeekend = (date) => {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0 dom, 6 sáb (con cuidado si usas getDay/getUTCDay)
  return day === 0 || day === 6;
};

// suma días naturales
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

// suma "días laborables"
const addWorkdays = (startDate, workdays) => {
  let d = new Date(startDate);
  let added = 0;
  while (added < workdays) {
    d = addDays(d, 1);
    const wd = d.getDay(); // local: 0 dom, 6 sáb
    if (wd !== 0 && wd !== 6) added++;
  }
  return d;
};

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Devuelve { startISO, endISO } en formato YYYY-MM-DDTHH:mm:ss (sin offset)
// Google interpretará según el `timeZone` que le pasamos al crear el evento
function buildSlotISO(fecha, range) {
  const [h1, h2] = range.split('-');
  const [H1, M1] = h1.split(':').map(Number);
  const [H2, M2] = h2.split(':').map(Number);

  // Construimos objetos Date en local para generar la parte 'HH:mm:ss'
  const start = new Date(`${fecha}T${pad(H1)}:${pad(M1)}:00`);
  const end   = new Date(`${fecha}T${pad(H2)}:${pad(M2)}:00`);

  const iso = (d) =>
    `${fecha}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { startISO: iso(start), endISO: iso(end) };
}

// Comprobación de solape entre dos rangos (en minutos)
function overlap(rangeA, rangeB) {
  const toMin = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const [a1, a2] = rangeA.split('-');
  const [b1, b2] = rangeB.split('-');
  const A1 = toMin(a1), A2 = toMin(a2);
  const B1 = toMin(b1), B2 = toMin(b2);
  return Math.max(A1, B1) < Math.min(A2, B2);
}

/* ---------- Google Calendar auth ---------- */
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/calendar'],
  // GOOGLE_APPLICATION_CREDENTIALS debe apuntar al /etc/secrets/gsa.json en Render
});
const calendar = google.calendar({ version: 'v3', auth });

/* ---------- Email (opcional) ---------- */
const emailEnabled =
  !!process.env.MAIL_HOST && !!process.env.MAIL_USER && !!process.env.MAIL_PASS;

let mailer = null;
if (emailEnabled) {
  mailer = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT || 465),
    secure: String(process.env.MAIL_SECURE || 'true') === 'true',
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
    },
  });
}

/* ---------- Servidor ---------- */
const app = express();
app.use(cors());
app.use(bodyParser.json());

/* Salud */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* Obtener slots disponibles para una cuidadora/fecha */
app.get('/api/slots', async (req, res) => {
  try {
    const cuidadora = String(req.query.cuidadora || '');
    const fecha = String(req.query.fecha || '');

    if (!CAREGIVERS[cuidadora]) {
      return res.status(400).json({ error: 'cuidadora_invalida' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return res.status(400).json({ error: 'fecha_invalida' });
    }

    // Fines de semana bloqueados
    const dateObj = new Date(`${fecha}T00:00:00`);
    const dow = dateObj.getDay();
    if (dow === 0 || dow === 6) {
      return res.json({ fecha, slots: SLOT_RANGES.map((r) => ({ range: r, taken: true })) });
    }

    // Antelación mínima (días laborables)
    const min = addWorkdays(new Date(), LEAD_WORKDAYS);
    if (new Date(`${fecha}T00:00:00`) < new Date(fmtDate(min) + 'T00:00:00')) {
      return res.json({ fecha, lead: LEAD_WORKDAYS, slots: SLOT_RANGES.map((r) => ({ range: r, taken: true })) });
    }

    // Traer eventos del día en ese calendario
    const { calendarId } = CAREGIVERS[cuidadora];
    const timeMin = `${fecha}T00:00:00.000Z`;
    const timeMax = `${fecha}T23:59:59.999Z`;

    const resp = await calendar.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = resp.data.items || [];

    // Marcamos ocupados si hay solape
    const slots = SLOT_RANGES.map((range) => {
      // Si el evento fue creado por nosotros, guardamos el range en extendedProperties.private.range
      const taken = events.some((ev) => {
        const p = (ev.extendedProperties && ev.extendedProperties.private) || {};
        if (p.range) return overlap(p.range, range);

        // fallback: calcular por horas
        try {
          const start = new Date(ev.start.dateTime || ev.start.date);
          const end = new Date(ev.end.dateTime || ev.end.date);
          const startHH = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
          const endHH   = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
          return overlap(`${startHH}-${endHH}`, range);
        } catch {
          return false;
        }
      });

      return { range, taken };
    });

    return res.json({ fecha, slots });
  } catch (err) {
    console.error('SLOTS ERROR:', err?.message || err);
    return res.status(500).json({ error: 'server_error' });
  }
});

/* Crear reserva */
app.post('/api/reserve', async (req, res) => {
  try {
    const payload = req.body || {};
    const required = [
      'nombre', 'apellidos', 'email', 'telefono',
      'localidad', 'direccion', 'servicios', 'cuidadora',
      'fecha', 'horas'
    ];

    for (const k of required) {
      if (
        payload[k] === undefined ||
        payload[k] === null ||
        (Array.isArray(payload[k]) && payload[k].length === 0) ||
        (typeof payload[k] === 'string' && payload[k].trim() === '')
      ) {
        return res.status(400).json({ error: 'campo_requerido', campo: k });
      }
    }

    if (!CAREGIVERS[payload.cuidadora]) {
      return res.status(400).json({ error: 'cuidadora_invalida' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.fecha)) {
      return res.status(400).json({ error: 'fecha_invalida' });
    }

    // Bloqueo de findes
    const dow = new Date(`${payload.fecha}T00:00:00`).getDay();
    if (dow === 0 || dow === 6) {
      return res.status(400).json({ error: 'solo_lunes_viernes' });
    }

    // Antelación mínima de días laborables
    const min = addWorkdays(new Date(), LEAD_WORKDAYS);
    if (new Date(`${payload.fecha}T00:00:00`) < new Date(fmtDate(min) + 'T00:00:00')) {
      return res.status(400).json({ error: 'lead_minimo', dias: LEAD_WORKDAYS });
    }

    // Comprobar conflictos antes de crear
    const { calendarId } = CAREGIVERS[payload.cuidadora];
    const timeMin = `${payload.fecha}T00:00:00.000Z`;
    const timeMax = `${payload.fecha}T23:59:59.999Z`;

    const resp = await calendar.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = resp.data.items || [];

    const conflicts = [];
    for (const range of payload.horas) {
      // si ya está tomado => conflicto
      const taken = events.some((ev) => {
        const p = (ev.extendedProperties && ev.extendedProperties.private) || {};
        if (p.range) return overlap(p.range, range);

        try {
          const start = new Date(ev.start.dateTime || ev.start.date);
          const end = new Date(ev.end.dateTime || ev.end.date);
          const startHH = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
          const endHH   = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
          return overlap(`${startHH}-${endHH}`, range);
        } catch {
          return false;
        }
      });
      if (taken) conflicts.push(range);
    }

    if (conflicts.length) {
      return res.status(409).json({ error: 'conflicto', slots: conflicts });
    }

    // Crear eventos (SIN attendees ni sendUpdates para evitar 403)
    const createdIds = [];
    for (const range of payload.horas) {
      const { startISO, endISO } = buildSlotISO(payload.fecha, range);

      const ev = await calendar.events.insert({
        calendarId,
        requestBody: {
          start: { dateTime: startISO, timeZone: TIMEZONE },
          end:   { dateTime: endISO,   timeZone: TIMEZONE },
          summary: `CUIDAME — ${payload.nombre} ${payload.apellidos} — ${range}`,
          description:
            `Tel: ${payload.telefono}\n` +
            `Email: ${payload.email}\n` +
            `Localidad: ${payload.localidad}\n` +
            `Dirección: ${payload.direccion}\n` +
            `Servicios: ${payload.servicios.join(', ')}\n` +
            `Cuidadora: ${payload.cuidadora}\n` +
            `Origen: web-hero-overlay`,
          extendedProperties: {
            private: { cuidame: '1', range }
          },
        },
      });

      createdIds.push(ev.data.id);
    }

    // Email opcional de confirmación
    if (emailEnabled && mailer) {
      try {
        await mailer.sendMail({
          from: process.env.MAIL_FROM || `"Cuidame" <${process.env.MAIL_USER}>`,
          to: payload.email,
          bcc: process.env.MAIL_TO_INT, // copia interna opcional
          subject: `Reserva confirmada — ${payload.cuidadora} — ${payload.fecha} (${payload.horas.join(', ')})`,
          text:
`Hola ${payload.nombre},

Tu reserva se ha confirmado para el ${payload.fecha} en los tramos ${payload.horas.join(', ')} con ${payload.cuidadora}.
Recuerda que el importe debe abonarse 24 horas antes de comenzar el servicio.

Detalles:
- Servicios: ${payload.servicios.join(', ')}
- Dirección: ${payload.direccion}, ${payload.localidad}
- Teléfono de contacto: ${payload.telefono}

Gracias,
Cuidame`,
        });
      } catch (mailErr) {
        console.warn('EMAIL ERROR:', mailErr?.message || mailErr);
      }
    }

    // Resumen de precio
    const horasCount = payload.horas.length;
    const subtotal = horasCount * RATE;
    const iva = subtotal * IVA;
    const total = subtotal + iva;

    return res.json({
      ok: true,
      created: createdIds.length,
      bloques: payload.horas,
      precio: { horas: horasCount, subtotal, iva, total },
    });
  } catch (err) {
    console.error('RESERVAR ERROR:', err?.message || err);
    // si viene de Google con detalles:
    if (err?.response?.data) console.error('Google API:', err.response.data);
    return res.status(500).json({ error: 'server_error' });
  }
});

/* Arrancar servidor */
app.listen(PORT, () => {
  console.log(`API escuchando en ${PORT}`);
});
