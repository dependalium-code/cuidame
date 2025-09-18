// server.js - CommonJS (no ESM). Asegúrate de que package.json NO tenga "type":"module"
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

// ========= CONFIG =========
const PORT = process.env.PORT || 10000;
const TZ = 'Europe/Madrid';
const LEAD_WORKDAYS = Number(process.env.LEAD_WORKDAYS || 5); // Días laborables de antelación
const RATE = Number(process.env.RATE || 18);
const IVA = Number(process.env.IVA || 0.10);
const CANCEL_SECRET = process.env.CANCEL_SECRET || 'change_me_please';

// Email (Nodemailer). Recomendado: Gmail + "App Password"
const MAIL_HOST   = process.env.MAIL_HOST   || 'smtp.gmail.com';
const MAIL_PORT   = Number(process.env.MAIL_PORT || 465);
const MAIL_SECURE = process.env.MAIL_SECURE !== 'false'; // por defecto true
const MAIL_USER   = process.env.MAIL_USER   || 'dependalium@gmail.com';
const MAIL_PASS   = process.env.MAIL_PASS   || ''; // App password
const MAIL_FROM   = process.env.MAIL_FROM   || `Cuidame <${MAIL_USER}>`;
const MAIL_TO_INT = process.env.MAIL_TO_INT || 'dependalium@gmail.com';

// Carga cuidadores (IDs correctos)
const caregivers = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'caregivers.json'), 'utf8')
);
// caregivers.json DEBE tener este formato:
//
// {
//   "Raquel":  { "calendarId": "fe9a8085d8db29f888a6382935c82e20f33d476347adfe6416582401d377454d@group.calendar.google.com" },
//   "Carmen":  { "calendarId": "4562295563647999c8222fc750cf01803405063f186574ff7df5dfe2694a9c73@group.calendar.google.com" },
//   "Daniela": { "calendarId": "84f168dd91cb85bbe4a97b2c88d4d174a3b09f53e025b0a51f401dc91cf70759@group.calendar.google.com" }
// }

// ========= GOOGLE AUTH (Service Account) =========
// Requiere GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/gsa.json (Render: Secret File + env var)
const auth = new google.auth.JWT({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth });

// ========= EMAIL (Nodemailer) =========
const transporter = nodemailer.createTransport({
  host: MAIL_HOST,
  port: MAIL_PORT,
  secure: MAIL_SECURE,
  auth: { user: MAIL_USER, pass: MAIL_PASS },
});

// ========= UTILS =========
const pad = (n) => String(n).padStart(2, '0');
const isWeekend = (d) => {
  const wd = d.getDay();
  return wd === 0 || wd === 6;
};
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function addWorkdays(date, n) {
  const d = new Date(date);
  let count = 0;
  while (count < n) {
    d.setDate(d.getDate() + 1);
    if (!isWeekend(d)) count++;
  }
  return d;
}
function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Rango horario (incluye 13:00–14:00)
function genRanges() {
  const out = [];
  for (let h = 9; h < 14; h++) out.push(`${pad(h)}:00-${pad(h + 1)}:00`);
  for (let h = 16; h < 20; h++) out.push(`${pad(h)}:00-${pad(h + 1)}:00`);
  return out;
}

// Convierte YYYY-MM-DD + "HH:MM-HH:MM" (local Madrid) a ISO
function slotToISO(fecha, range) {
  const [a, b] = range.split('-'); // "HH:MM", "HH:MM"
  const [sh, sm] = a.split(':').map(Number);
  const [eh, em] = b.split(':').map(Number);

  // Construimos en zona local Europe/Madrid:
  // Creamos fecha base en UTC y usamos offset fijo con Intl (suficiente para Calendar)
  const d = new Date(`${fecha}T00:00:00`);
  const start = new Date(d);
  start.setHours(sh, sm, 0, 0);
  const end = new Date(d);
  end.setHours(eh, em, 0, 0);

  return {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
  };
}

// Firma HMAC para cancelación
function signCancel(caregiver, eventId) {
  return crypto
    .createHmac('sha256', CANCEL_SECRET)
    .update(`${caregiver}:${eventId}`)
    .digest('hex');
}

// ========= APP =========
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ========= SLOTS =========
app.get('/api/slots', async (req, res) => {
  try {
    const { fecha, cuidadora } = req.query;
    if (!fecha || !cuidadora) {
      return res.status(400).json({ error: 'missing_params' });
    }

    const c = caregivers[cuidadora];
    if (!c?.calendarId) {
      return res.status(400).json({ error: 'unknown_caregiver' });
    }

    // Bloqueo de findes + lead de N días laborables
    const target = new Date(`${fecha}T00:00:00`);
    if (isWeekend(target)) {
      return res.json({ slots: [] });
    }
    const minDate = addWorkdays(new Date(), LEAD_WORKDAYS);
    if (target < new Date(ymd(minDate) + 'T00:00:00')) {
      return res.json({ slots: [] });
    }

    const timeMin = new Date(`${fecha}T00:00:00.000Z`).toISOString();
    const timeMax = new Date(`${fecha}T23:59:59.999Z`).toISOString();

    const ev = await calendar.events.list({
      calendarId: c.calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const taken = new Set();
    for (const e of ev.data.items || []) {
      const ex = e.extendedProperties?.private?.range;
      if (ex) {
        taken.add(ex);
      } else {
        // Si no tiene metadata, calculamos el range por solapamiento “a la hora”
        const s = e.start?.dateTime || e.start?.date;
        const en = e.end?.dateTime || e.end?.date;
        if (s && en) {
          const sd = new Date(s);
          const ed = new Date(en);
          const hours = genRanges();
          for (const r of hours) {
            const { startISO, endISO } = slotToISO(fecha, r);
            const rs = new Date(startISO);
            const re = new Date(endISO);
            // Solapamiento básico
            if (rs < ed && re > sd) taken.add(r);
          }
        }
      }
    }

    const slots = genRanges().map((r) => ({
      range: r,
      taken: taken.has(r),
    }));
    res.json({ slots });
  } catch (err) {
    console.error('SLOTS ERROR:', err?.message || err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ========= RESERVE =========
app.post('/api/reserve', async (req, res) => {
  try {
    const p = req.body || {};
    const required = [
      'nombre',
      'apellidos',
      'email',
      'telefono',
      'localidad',
      'direccion',
      'servicios',
      'cuidadora',
      'fecha',
      'horas',
    ];
    for (const k of required) {
      if (
        typeof p[k] === 'undefined' ||
        (Array.isArray(p[k]) && p[k].length === 0) ||
        (typeof p[k] === 'string' && !p[k].trim())
      ) {
        return res.status(400).json({ error: 'missing_field', field: k });
      }
    }

    const c = caregivers[p.cuidadora];
    if (!c?.calendarId) return res.status(400).json({ error: 'unknown_caregiver' });

    // Lead + findes
    const target = new Date(`${p.fecha}T00:00:00`);
    if (isWeekend(target)) return res.status(400).json({ error: 'weekend_not_allowed' });
    const minDate = addWorkdays(new Date(), LEAD_WORKDAYS);
    if (target < new Date(ymd(minDate) + 'T00:00:00')) {
      return res.status(400).json({ error: 'lead_days_not_met' });
    }

    // Conflictos en el día
    const timeMin = new Date(`${p.fecha}T00:00:00.000Z`).toISOString();
    const timeMax = new Date(`${p.fecha}T23:59:59.999Z`).toISOString();
    const ev = await calendar.events.list({
      calendarId: c.calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const existing = ev.data.items || [];
    const conflicts = [];
    for (const slot of p.horas) {
      const { startISO, endISO } = slotToISO(p.fecha, slot);
      const rs = new Date(startISO);
      const re = new Date(endISO);

      const clash = existing.some((e) => {
        const s = e.start?.dateTime || e.start?.date;
        const en = e.end?.dateTime || e.end?.date;
        if (!s || !en) return false;
        const sd = new Date(s);
        const ed = new Date(en);
        return rs < ed && re > sd;
      });
      if (clash) conflicts.push(slot);
    }
    if (conflicts.length) {
      return res.status(409).json({ error: 'conflict', slots: conflicts });
    }

    // Crear eventos (SIN attendees) + metadata propia
    const created = [];
    for (const slot of p.horas) {
      const { startISO, endISO } = slotToISO(p.fecha, slot);
      const event = {
        start: { dateTime: startISO, timeZone: TZ },
        end: { dateTime: endISO, timeZone: TZ },
        summary: `CUIDAME — ${p.nombre} ${p.apellidos} — ${slot}`,
        description:
          `Tel: ${p.telefono}\n` +
          `Email: ${p.email}\n` +
          `Localidad: ${p.localidad}\n` +
          `Dirección: ${p.direccion}\n` +
          `Servicios: ${Array.isArray(p.servicios) ? p.servicios.join(', ') : String(p.servicios)}\n` +
          `Cuidadora: ${p.cuidadora}\n` +
          `Origen: web-hero-overlay`,
        extendedProperties: {
          private: { cuidame: '1', range: slot },
        },
      };

      const { data } = await calendar.events.insert({
        calendarId: c.calendarId,
        requestBody: event,
        // IMPORTANTÍSIMO: sin sendUpdates ni attendees → no 403
      });

      created.push({
        id: data.id,
        range: slot,
        cancel_url: `/api/cancel?c=${encodeURIComponent(p.cuidadora)}&id=${encodeURIComponent(
          data.id
        )}&t=${signCancel(p.cuidadora, data.id)}`,
      });
    }

    // Email de confirmación al cliente
    const horas = p.horas.length;
    const subtotal = RATE * horas;
    const iva = subtotal * IVA;
    const total = subtotal + iva;

    const prettyDate = p.fecha.split('-').reverse().join('/');

    const mensajeCliente = [
      `Hola ${p.nombre},`,
      ``,
      `Tu reserva con Cuidame está CONFIRMADA ✅`,
      ``,
      `• Fecha: ${prettyDate}`,
      `• Cuidadora: ${p.cuidadora}`,
      `• Horas: ${p.horas.join(', ')}`,
      `• Servicios: ${Array.isArray(p.servicios) ? p.servicios.join(', ') : String(p.servicios)}`,
      ``,
      `Precio: ${RATE} €/h`,
      `Subtotal: ${subtotal.toFixed(2)} €`,
      `IVA (10%): ${iva.toFixed(2)} €`,
      `TOTAL: ${total.toFixed(2)} €`,
      ``,
      `🔔 Recuerda: el importe de la reserva debe abonarse **24 horas antes** de empezar el servicio.`,
      ``,
      `Si necesitas anular algún tramo, responde a este correo y te ayudamos.`,
      ``,
      `Gracias por confiar en Cuidame.`,
    ].join('\n');

    // Cliente
    if (MAIL_PASS) {
      await transporter.sendMail({
        from: MAIL_FROM,
        to: p.email,
        subject: `Reserva confirmada — ${prettyDate} — ${p.cuidadora}`,
        text: mensajeCliente,
      });

      // Interno
      await transporter.sendMail({
        from: MAIL_FROM,
        to: MAIL_TO_INT,
        subject: `Nueva reserva — ${p.cuidadora} — ${prettyDate}`,
        text:
          `Nombre: ${p.nombre} ${p.apellidos}\n` +
          `Teléfono: ${p.telefono}\nEmail: ${p.email}\n` +
          `Localidad: ${p.localidad}\nDirección: ${p.direccion}\n` +
          `Servicios: ${Array.isArray(p.servicios) ? p.servicios.join(', ') : String(p.servicios)}\n` +
          `Cuidadora: ${p.cuidadora}\nFecha: ${prettyDate}\n` +
          `Horas: ${p.horas.join(', ')}\n` +
          `Total: ${total.toFixed(2)} €\n`,
      });
    } else {
      console.warn('[EMAIL] MAIL_PASS no definido: no se envían emails.');
    }

    res.json({
      ok: true,
      bloques: p.horas,
      created: created.length,
      precio: { horas, subtotal, iva, total },
      cancel: created,
    });
  } catch (err) {
    console.error('RESERVAR ERROR:', err);
    const status = err?.code === 403 ? 403 : 500;
    res.status(status).json({ error: 'server_error' });
  }
});

// ========= CANCEL =========
app.get('/api/cancel', async (req, res) => {
  try {
    const { c: caregiverName, id, t } = req.query;
    if (!caregiverName || !id || !t) return res.status(400).send('Bad request');

    const expected = signCancel(caregiverName, id);
    if (t !== expected) return res.status(403).send('Forbidden');

    const c = caregivers[caregiverName];
    if (!c?.calendarId) return res.status(400).send('Unknown caregiver');

    await calendar.events.delete({
      calendarId: c.calendarId,
      eventId: id,
    });

    res.send('Reserva cancelada y franja liberada.');
  } catch (err) {
    console.error('CANCEL ERROR:', err);
    res.status(500).send('Server error');
  }
});

app.listen(PORT, () => {
  console.log(`API escuchando en ${PORT}`);
});
