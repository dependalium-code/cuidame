// server.js
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import caregivers from './caregivers.json' assert { type: 'json' };

const app = express();
app.use(cors());
app.use(bodyParser.json());

/* ======= ENV ======= */
const PORT = process.env.PORT || 10000;
const TZ = 'Europe/Madrid';
const RATE = Number(process.env.RATE || 18);
const IVA = Number(process.env.IVA || 0.10);
const LEAD_WORKDAYS = Number(process.env.LEAD_WORKDAYS || 0); // 0 = sin restricción, >0 = días hábiles de colchón

/* ======= GOOGLE AUTH ======= */
function getJwt() {
  // Render: GOOGLE_APPLICATION_CREDENTIALS debe apuntar a /etc/secrets/gsa.json
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile || !fs.existsSync(keyFile)) {
    throw new Error('No key or keyFile set. Define GOOGLE_APPLICATION_CREDENTIALS con la ruta de tu gsa.json');
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
        pass: process.env.MAIL_PASS, // Gmail App Password
      },
    })
  : null;

async function sendMail({ to, subject, text }) {
  if (!mailer) return;
  const from = process.env.MAIL_FROM || process.env.MAIL_USER;
  const toInt = process.env.MAIL_TO_INT || process.env.MAIL_USER;
  try {
    await mailer.sendMail({ from, to, subject, text });
    // copia interna
    if (toInt && toInt !== to) {
      await mailer.sendMail({ from, to: toInt, subject: `(Copia) ${subject}`, text });
    }
  } catch (e) {
    console.error('MAIL ERROR:', e.message);
  }
}

/* ======= UTIL ======= */
const pad = (n) => String(n).padStart(2, '0');
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function isWeekend(d) { const wd = d.getDay(); return wd === 0 || wd === 6; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function addWorkdays(d, n) {
  if (n <= 0) return d;
  let x = new Date(d);
  let added = 0;
  while (added < n) {
    x = addDays(x, 1);
    const wd = x.getDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return x;
}

/** Rangos que quieres disponibles (incluye 13–14 que pediste) */
function getRanges() {
  const out = [];
  for (let h = 9; h < 14; h++) out.push(`${pad(h)}:00-${pad(h + 1)}:00`);
  for (let h = 16; h < 20; h++) out.push(`${pad(h)}:00-${pad(h + 1)}:00`);
  return out;
}

/** Convierte "2025-09-25", "12:00-13:00" a datetimes ISO TZ */
function rangeToDateTimes(dateYmd, range) {
  const [s, e] = range.split('-');
  const [sh, sm] = s.split(':').map(Number);
  const [eh, em] = e.split(':').map(Number);
  const [Y, M, D] = dateYmd.split('-').map(Number);
  const start = new Date(Date.UTC(Y, M - 1, D, sh - 2, sm || 0)); // offset crudo; Google respeta timeZone
  const end = new Date(Date.UTC(Y, M - 1, D, eh - 2, em || 0));
  return {
    start: { dateTime: start.toISOString(), timeZone: TZ },
    end: { dateTime: end.toISOString(), timeZone: TZ },
  };
}

/* ======= SLOTS ======= */
app.get('/api/slots', async (req, res) => {
  try {
    const { fecha, cuidadora } = req.query;
    if (!fecha || !cuidadora) return res.status(400).json({ error: 'faltan parametros' });

    // ventana: todo el año, pero bloquea fines y respeta colchón laboral si LEAD_WORKDAYS>0
    const qDate = new Date(`${fecha}T00:00:00`);
    if (isNaN(qDate)) return res.status(400).json({ error: 'fecha inválida' });
    if (isWeekend(qDate)) return res.json({ slots: [] });

    const earliest = addWorkdays(new Date(), LEAD_WORKDAYS);
    earliest.setHours(0,0,0,0);
    if (qDate < earliest) {
      return res.json({ slots: [] });
    }

    const map = caregivers[cuidadora];
    if (!map) return res.status(400).json({ error: 'cuidadora desconocida' });

    const cal = calendarClient();

    const timeMin = new Date(`${fecha}T00:00:00Z`).toISOString();
    const timeMax = new Date(`${fecha}T23:59:59Z`).toISOString();

    const events = await cal.events.list({
      calendarId: map.calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });

    // Toma todos los que se solapen (da igual quién los haya creado)
    const taken = new Set(
      (events.data.items || []).map((ev) => {
        try {
          const st = new Date(ev.start.dateTime || ev.start.date);
          const en = new Date(ev.end.dateTime || ev.end.date);
          const sh = pad(st.getUTCHours()+2); // mostrar en horario local
          const eh = pad(en.getUTCHours()+2);
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
    const map = caregivers[cuidadora];
    if (!map) return res.status(400).json({ error: 'cuidadora_desconocida' });

    const qDate = new Date(`${fecha}T00:00:00`);
    if (isNaN(qDate) || isWeekend(qDate)) return res.status(400).json({ error: 'fecha_no_disponible' });

    const earliest = addWorkdays(new Date(), LEAD_WORKDAYS);
    earliest.setHours(0,0,0,0);
    if (qDate < earliest) return res.status(400).json({ error: 'antes_de_lead' });

    const cal = calendarClient();

    // Comprobación de colisiones previa
    const timeMin = new Date(`${fecha}T00:00:00Z`).toISOString();
    const timeMax = new Date(`${fecha}T23:59:59Z`).toISOString();
    const dayEv = await cal.events.list({
      calendarId: map.calendarId,
      timeMin, timeMax, singleEvents: true, orderBy: 'startTime',
    });

    const existing = dayEv.data.items || [];
    const occupied = new Set(existing.map((ev) => {
      try {
        const st = new Date(ev.start.dateTime || ev.start.date);
        const en = new Date(ev.end.dateTime || ev.end.date);
        const sh = pad(st.getUTCHours()+2);
        const eh = pad(en.getUTCHours()+2);
        return `${sh}:00-${eh}:00`;
      } catch { return null; }
    }).filter(Boolean));

    const conflicts = horas.filter((r) => occupied.has(r));
    if (conflicts.length) return res.status(409).json({ error: 'conflicto', slots: conflicts });

    // Crear eventos (sin attendees) - esto evita el 403
    const createdIds = [];
    for (const r of horas) {
      const { start, end } = rangeToDateTimes(fecha, r);
      const summary = `CUIDAME — ${nombre} ${apellidos} — ${r}`;
      const description =
`Tel: ${telefono}
Email: ${email}
Localidad: ${localidad}
Dirección: ${direccion}
Servicios: ${Array.isArray(servicios) ? servicios.join(', ') : servicios}
Cuidadora: ${cuidadora}
Origen: web-hero-overlay
${detalles ? `Detalles: ${detalles}` : ''}`;

      const ev = await cal.events.insert({
        calendarId: map.calendarId,
        sendUpdates: 'none', // ¡importante!
        requestBody: {
          start, end, summary, description,
          extendedProperties: { private: { cuidame: '1', range: r } },
          guestsCanInviteOthers: false,
          guestsCanSeeOtherGuests: false,
        },
      });

      createdIds.push(ev.data.id);
    }

    // Email de confirmación (cliente + copia interna)
    await sendMail({
      to: email,
      subject: `Reserva confirmada — ${fecha} — ${cuidadora}`,
      text:
`Hola ${nombre},

Hemos confirmado tu reserva con ${cuidadora} para el día ${fecha} en los bloques:
${horas.map(h => `• ${h}`).join('\n')}

Importe estimado:
  - Horas: ${horas.length}
  - Subtotal: ${(RATE*horas.length).toFixed(2)} €
  - IVA (${(IVA*100)}%): ${(RATE*horas.length*IVA).toFixed(2)} €
  - TOTAL: ${(RATE*horas.length*(1+IVA)).toFixed(2)} €

Recuerda: el servicio debe abonarse 24 horas antes de comenzar para quedar reservado.
Si necesitas ayuda, responde a este correo.

Gracias,
Equipo Cuidame
`,
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
    // Si llegase un 403 aquí es porque se han reintroducido attendees o falta permiso de escritura.
    res.status(500).json({ error: 'server_error' });
  }
});

/* ======= HEALTH ======= */
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`API escuchando en ${PORT}`);
});
