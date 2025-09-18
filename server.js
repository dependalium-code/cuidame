// server.js
// API Cuidame — Calendarios por cuidadora (Google Calendar)
// Endpoints:
//   GET  /                 -> "API cuidame: ok"
//   GET  /api/health       -> { ok: true } si las credenciales funcionan
//   GET  /api/slots        -> ?fecha=YYYY-MM-DD&cuidadora=Raquel|Carmen|Daniela
//   POST /api/reservar     -> crea evento(s) en el calendario de la cuidadora

import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import { readFileSync } from 'fs';

// ---------- Carga de configuración ----------
const caregivers = JSON.parse(
  readFileSync(new URL('./caregivers.json', import.meta.url), 'utf8')
);

const app = express();

// Ajusta el origen si quieres restringirlo a tu dominio de WP
app.use(cors({ origin: true })); // o: { origin: 'https://cuidame.es' }
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TZ = 'Europe/Madrid';

// ---------- Google Auth (Secret File o variables) ----------
function getCalendarClient() {
  const scopes = ['https://www.googleapis.com/auth/calendar'];

  // 1) Vía recomendada: Secret File en Render
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes
    });
    return google.calendar({ version: 'v3', auth });
  }

  // 2) Fallback por variables (si no hay secret file)
  const email = process.env.GOOGLE_SA_CLIENT_EMAIL;
  let key = process.env.GOOGLE_SA_PRIVATE_KEY;
  if (!email || !key) throw new Error('No key or keyFile set');
  if (key.includes('\\n')) key = key.replace(/\\n/g, '\n');

  const auth = new google.auth.JWT({ email, key, scopes });
  return google.calendar({ version: 'v3', auth });
}

// ---------- Utils ----------
const pad = (n) => String(n).padStart(2, '0');

const ranges = () => {
  const out = [];
  for (let h = 9; h < 14; h++) out.push(`${pad(h)}:00-${pad(h + 1)}:00`);
  for (let h = 16; h < 20; h++) out.push(`${pad(h)}:00-${pad(h + 1)}:00`);
  return out;
};

// Offset horario actual para una TZ (formato ±HH:MM)
function offsetForTZ(tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).map(p => [p.type, p.value])
  );
  const d = new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00`);
  const diffMin = Math.round((d.getTime() - Date.now()) / 60000);
  const sign = diffMin >= 0 ? '+' : '-';
  const m = Math.abs(diffMin);
  return `${sign}${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

// Convierte "YYYY-MM-DD" + "HH:MM" a ISO respetando TZ
function toISO(fecha, hhmm) {
  return new Date(`${fecha}T${hhmm}:00${offsetForTZ(TZ)}`).toISOString();
}

// Une horas contiguas: ["18:00-19:00","19:00-20:00"] => ["18:00-20:00"]
function mergeContiguousSlots(horas) {
  const order = new Map(ranges().map((r, i) => [r, i]));
  const sorted = [...horas].sort((a, b) => order.get(a) - order.get(b));
  const merged = [];
  for (const r of sorted) {
    if (!merged.length) { merged.push(r); continue; }
    const last = merged[merged.length - 1];
    const [, lastEnd] = last.split('-');
    const [curStart, curEnd] = r.split('-');
    if (curStart === lastEnd) merged[merged.length - 1] = last.split('-')[0] + '-' + curEnd;
    else merged.push(r);
  }
  return merged;
}

// ---------- Rutas ----------
app.get('/', (_req, res) => res.send('API cuidame: ok'));

app.get('/api/health', async (_req, res) => {
  try {
    const calendar = getCalendarClient();
    await calendar.calendarList.list({ maxResults: 1 });
    res.json({ ok: true });
  } catch (e) {
    console.error('HEALTH ERROR:', e?.response?.data || e.message || e);
    res.status(500).json({ ok: false, error: e?.message || 'auth_failed' });
  }
});

// Devuelve matriz de {range, taken} para una cuidadora y fecha
app.get('/api/slots', async (req, res) => {
  try {
    const { fecha, cuidadora } = req.query;
    if (!fecha || !cuidadora) {
      return res.status(400).json({ error: 'Missing fecha or cuidadora' });
    }
    const cfg = caregivers[cuidadora];
    if (!cfg?.calendarId) return res.status(404).json({ error: 'Cuidadora no encontrada' });

    const calendar = getCalendarClient();
    const timeMin = `${fecha}T00:00:00Z`;
    const timeMax = `${fecha}T23:59:59Z`;

    const r = await calendar.events.list({
      calendarId: cfg.calendarId,
      timeMin, timeMax, singleEvents: true, orderBy: 'startTime'
    });

    const busy = (r.data.items || []).map(ev => ({
      start: ev.start.dateTime || ev.start.date,
      end:   ev.end.dateTime   || ev.end.date
    }));

    const slots = ranges().map(range => {
      const [ini, fin] = range.split('-');
      const s = toISO(fecha, ini);
      const e = toISO(fecha, fin);
      const taken = busy.some(b => !(e <= b.start || s >= b.end));
      return { range, taken };
    });

    res.json({ slots });
  } catch (e) {
    console.error('SLOTS ERROR:', e?.response?.data || e.message || e);
    res.status(500).json({ error: 'server_error' });
  }
});

// Crea eventos (uno por bloque, uniendo horas contiguas)
app.post('/api/reservar', async (req, res) => {
  try {
    const {
      nombre, apellidos, email, telefono,
      localidad, direccion, servicios = [],
      cuidadora, fecha, horas = [], detalles, origen
    } = req.body || {};

    // Validaciones básicas
    if (!nombre || !apellidos || !email || !telefono || !localidad || !direccion)
      return res.status(400).json({ error: 'Faltan datos personales' });
    if (!Array.isArray(servicios) || servicios.length === 0)
      return res.status(400).json({ error: 'Elige al menos un servicio' });
    if (!cuidadora || !fecha || !Array.isArray(horas) || horas.length === 0)
      return res.status(400).json({ error: 'Faltan cuidadora/fecha/horas' });

    const cfg = caregivers[cuidadora];
    if (!cfg?.calendarId) return res.status(404).json({ error: 'Cuidadora no encontrada' });

    const calendar = getCalendarClient();

    // Re-chequeo de conflictos por seguridad
    const timeMin = `${fecha}T00:00:00Z`;
    const timeMax = `${fecha}T23:59:59Z`;
    const r = await calendar.events.list({
      calendarId: cfg.calendarId, timeMin, timeMax, singleEvents: true, orderBy: 'startTime'
    });
    const busy = (r.data.items || []).map(ev => ({
      start: ev.start.dateTime || ev.start.date,
      end:   ev.end.dateTime   || ev.end.date
    }));

    const conflict = horas.find(range => {
      const [ini, fin] = range.split('-');
      const s = toISO(fecha, ini);
      const e = toISO(fecha, fin);
      return busy.some(b => !(e <= b.start || s >= b.end));
    });
    if (conflict) return res.status(409).json({ error: `Conflicto en ${conflict}` });

    // Unir contiguas y crear eventos
    const bloques = mergeContiguousSlots(horas);

    for (const bloque of bloques) {
      const [ini, fin] = bloque.split('-');
      const start = { dateTime: `${fecha}T${ini}:00`, timeZone: TZ };
      const end   = { dateTime: `${fecha}T${fin}:00`, timeZone: TZ };

      const summary = `Reserva — ${nombre} ${apellidos} (${telefono})`;
      const description =
`Servicios: ${servicios.join(', ')}
Email: ${email}
Localidad: ${localidad}
Dirección: ${direccion}
Cuidadora: ${cuidadora}
Detalle: ${detalles || '—'}
Origen: ${origen || 'web'}`;

      await calendar.events.insert({
        calendarId: cfg.calendarId,
        requestBody: { summary, description, start, end }
      });
    }

    res.json({ ok: true, bloques, created: bloques.length });
  } catch (e) {
    console.error('RESERVA ERROR:', e?.response?.data || e.message || e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.listen(PORT, () => {
  console.log(`API escuchando en ${PORT}`);
});
