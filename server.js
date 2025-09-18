// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { getCalendarClient, slotToDateTimes } from './calendar.js';

// Cargar JSON (compatible en Render / Node) SIN import assertions
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const caregivers = require('./caregivers.json');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const RATE = 18;
const IVA = 0.10;

/* ==================== Utils ==================== */
const genRanges = () => {
  const out = [];
  for (let h = 9; h < 14; h++) out.push(`${String(h).padStart(2, '0')}:00-${String(h + 1).padStart(2, '0')}:00`);
  for (let h = 16; h < 20; h++) out.push(`${String(h).padStart(2, '0')}:00-${String(h + 1).padStart(2, '0')}:00`);
  return out;
};

/* ==================== Home ==================== */
app.get('/', (req, res) => {
  res.type('html').send(`
    <html><head><meta charset="utf-8"><title>Cuidame API</title>
    <style>body{font-family:system-ui;padding:28px;line-height:1.6} code{background:#f3f4f6;padding:2px 6px;border-radius:6px}</style>
    </head><body>
      <h1>✅ Cuidame API en marcha</h1>
      <ul>
        <li><code>GET /api/health</code></li>
        <li><code>GET /api/slots?fecha=YYYY-MM-DD&cuidadora=Raquel</code></li>
        <li><code>POST /api/reserve</code> (JSON)</li>
        <li><code>GET /api/cancel/:token</code></li>
      </ul>
    </body></html>
  `);
});

/* ==================== Health (diagnóstico) ==================== */
app.get('/api/health', async (_req, res) => {
  try {
    const { calendar } = getCalendarClient();
    const raquelId = caregivers?.Raquel?.calendarId;
    if (!raquelId) return res.status(500).json({ ok: false, reason: 'missing_calendarId_Raquel' });

    const now = new Date();
    const timeMin = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const timeMax = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();

    const { data } = await calendar.events.list({
      calendarId: raquelId,
      timeMin,
      timeMax,
      singleEvents: true
    });

    res.json({ ok: true, eventsCount: (data.items || []).length });
  } catch (e) {
    console.error('HEALTH ERROR:', e?.response?.data || e.message || e);
    res.status(500).json({ ok: false, error: e?.message || 'see logs' });
  }
});

/* ==================== Slots ==================== */
app.get('/api/slots', async (req, res) => {
  const { fecha, cuidadora } = req.query;
  if (!fecha || !cuidadora) return res.status(400).json({ error: 'fecha y cuidadora requeridas' });

  const cg = caregivers[cuidadora];
  if (!cg) return res.status(404).json({ error: 'cuidadora no encontrada' });

  try {
    const { calendar, TZ } = getCalendarClient();

    const timeMin = new Date(`${fecha}T00:00:00Z`).toISOString();
    const timeMax = new Date(`${fecha}T23:59:59Z`).toISOString();

    const { data } = await calendar.events.list({
      calendarId: cg.calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: TZ
    });

    const events = data.items || [];
    const taken = new Set();

    for (const ev of events) {
      const evStart = new Date(ev.start?.dateTime || `${fecha}T00:00:00`);
      const evEnd = new Date(ev.end?.dateTime || `${fecha}T23:59:59`);
      for (const r of genRanges()) {
        const [ini, fin] = r.split('-');
        const s = new Date(`${fecha}T${ini}:00`);
        const e = new Date(`${fecha}T${fin}:00`);
        if (s < evEnd && e > evStart) taken.add(r);
      }
    }

    const slots = genRanges().map(r => ({ range: r, taken: taken.has(r) }));
    res.json({ fecha, cuidadora, slots });
  } catch (e) {
    console.error('SLOTS ERROR:', e?.response?.data || e.message || e);
    res.status(500).json({ error: 'server_error', details: e?.message || 'see server logs' });
  }
});

/* ==================== Reservar ==================== */
app.post('/api/reserve', async (req, res) => {
  const {
    nombre,
    apellidos,
    email,
    telefono,
    localidad,
    direccion,
    servicios,
    cuidadora,
    fecha,
    horas,
    detalles
  } = req.body || {};

  if (
    !nombre ||
    !apellidos ||
    !email ||
    !telefono ||
    !localidad ||
    !direccion ||
    !Array.isArray(servicios) ||
    servicios.length === 0 ||
    !cuidadora ||
    !fecha ||
    !Array.isArray(horas) ||
    horas.length === 0
  ) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const cg = caregivers[cuidadora];
  if (!cg) return res.status(404).json({ error: 'cuidadora_not_found' });

  const subtotal = horas.length * RATE;
  const iva = subtotal * IVA;
  const total = subtotal + iva;
  const token = uuidv4();

  try {
    const { calendar } = getCalendarClient();

    // Comprobar conflictos
    const { data } = await calendar.events.list({
      calendarId: cg.calendarId,
      timeMin: new Date(`${fecha}T00:00:00Z`).toISOString(),
      timeMax: new Date(`${fecha}T23:59:59Z`).toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });
    const existing = data.items || [];

    const conflicts = [];
    for (const r of horas) {
      const [ini, fin] = r.split('-');
      const s = new Date(`${fecha}T${ini}:00`);
      const e = new Date(`${fecha}T${fin}:00`);
      const overlap = existing.some(ev => {
        const a = new Date(ev.start?.dateTime || `${fecha}T00:00:00`);
        const b = new Date(ev.end?.dateTime || `${fecha}T23:59:59`);
        return s < b && e > a;
      });
      if (overlap) conflicts.push(r);
    }
    if (conflicts.length) return res.status(409).json({ error: 'conflict', slots: conflicts });

    // Crear eventos (uno por tramo)
    for (const r of horas) {
      const { start, end } = slotToDateTimes(fecha, r);
      const desc = [
        `Cliente: ${nombre} ${apellidos}`,
        `Tel: ${telefono} · Email: ${email}`,
        `Dirección: ${direccion}, ${localidad}`,
        `Servicios: ${servicios.join(', ')}`,
        `Precio: ${subtotal.toFixed(2)} € + IVA (${iva.toFixed(2)} €) = ${total.toFixed(2)} €`,
        `CancelToken: ${token}`,
        detalles ? `Detalles: ${detalles}` : ''
      ]
        .filter(Boolean)
        .join('\n');

      await calendar.events.insert({
        calendarId: cg.calendarId,
        requestBody: {
          summary: `Reserva — ${r} — ${nombre} ${apellidos}`,
          description: desc,
          start,
          end,
          attendees: [{ email }, { email: cg.email }], // cliente + correo único de dependalium
          reminders: { useDefault: true }
        }
      });
    }

    const cancelUrl = `${process.env.PUBLIC_BASE_URL || ''}/api/cancel/${token}`;
    res.json({ ok: true, cancel_url: cancelUrl });
  } catch (e) {
    console.error('RESERVE ERROR:', e?.response?.data || e.message || e);
    res.status(500).json({ error: 'server_error', details: e?.message || 'see server logs' });
  }
});

/* ==================== Cancelar ==================== */
app.get('/api/cancel/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const { calendar } = getCalendarClient();
    const calIds = Object.values(caregivers).map(c => c.calendarId);
    let deleted = 0;

    for (const calendarId of calIds) {
      const now = new Date();
      const past = new Date(now);
      past.setFullYear(now.getFullYear() - 1);
      const future = new Date(now);
      future.setFullYear(now.getFullYear() + 1);

      const { data } = await calendar.events.list({
        calendarId,
        q: token,
        timeMin: past.toISOString(),
        timeMax: future.toISOString(),
        singleEvents: true
      });

      for (const ev of data.items || []) {
        try {
          await calendar.events.delete({ calendarId, eventId: ev.id });
          deleted++;
        } catch (_) {
          /* ignorar */
        }
      }
    }

    if (!deleted) return res.status(404).send('No se encontró ninguna reserva con ese token.');

    res.send(`<html><body style="font-family:system-ui;padding:20px">
      <h2>Reserva anulada correctamente</h2>
      <p>Los huecos quedan disponibles de nuevo.</p>
      <a href="/">Volver</a>
    </body></html>`);
  } catch (e) {
    console.error('CANCEL ERROR:', e?.response?.data || e.message || e);
    res.status(500).send('Error al anular la reserva.');
  }
});

/* ==================== Start ==================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API escuchando en', PORT));
