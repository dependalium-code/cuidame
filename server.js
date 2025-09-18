// server.js
import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import { readFileSync } from 'fs';

// Carga cuidadores.json (sin import assertions)
const caregivers = JSON.parse(
  readFileSync(new URL('./caregivers.json', import.meta.url), 'utf8')
);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TZ = 'Europe/Madrid';

// ---------- Auth Google (usa Secret File o variables si no hay file) ----------
function getCalendarClient() {
  const scopes = ['https://www.googleapis.com/auth/calendar'];
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (keyFile) {
    const auth = new google.auth.GoogleAuth({ keyFile, scopes });
    const calendar = google.calendar({ version: 'v3', auth });
    return calendar;
  }

  // Fallback por si no hay secret file y usas variables
  const email = process.env.GOOGLE_SA_CLIENT_EMAIL;
  let key = process.env.GOOGLE_SA_PRIVATE_KEY;
  if (!email || !key) throw new Error('No key or keyFile set');
  if (key.includes('\\n')) key = key.replace(/\\n/g, '\n');
  const auth = new google.auth.JWT({ email, key, scopes });
  return google.calendar({ version: 'v3', auth });
}

// ---------- Helpers ----------
const pad = n => String(n).padStart(2, '0');
const ranges = () => {
  const out = [];
  for (let h = 9; h < 14; h++) out.push(`${pad(h)}:00-${pad(h + 1)}:00`);
  for (let h = 16; h < 20; h++) out.push(`${pad(h)}:00-${pad(h + 1)}:00`);
  return out;
};
function toISO(date, time) {
  // fecha "YYYY-MM-DD", time "HH:MM"
  return new Date(`${date}T${time}:00${offsetForTZ(TZ)}`).toISOString();
}
function offsetForTZ(tz) {
  // convierte TZ a offset del día actual (simple para nuestro caso)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  const parts = fmt.formatToParts(new Date());
  const d = new Date(
    `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}-${parts.find(p=>p.type==='day').value}T${parts.find(p=>p.type==='hour').value}:${parts.find(p=>p.type==='minute').value}:00`
  );
  const diff = (d.getTime() - Date.now()) / 60000; // minutos
  const sign = diff >= 0 ? '+' : '-';
  const m = Math.abs(diff);
  const hh = pad(Math.floor(m / 60));
  const mm = pad(Math.floor(m % 60));
  return `${sign}${hh}:${mm}`;
}

// ---------- Endpoints ----------
app.get('/', (_req, res) => res.send('API cuidame: ok'));

app.get('/api/health', async (_req, res) => {
  try {
    const calendar = getCalendarClient();
    // llamada tonta para comprobar auth (lista calendarios del usuario de la SA)
    await calendar.calendarList.list({ maxResults: 1 });
    res.json({ ok: true });
  } catch (e) {
    console.error('HEALTH ERROR:', e?.response?.data || e.message || e);
    res.status(500).json({ ok: false, error: e?.message || 'auth_failed' });
  }
});

app.get('/api/slots', async (req, res) => {
  try {
    const { fecha, cuidadora } = req.query;
    if (!fecha || !cuidadora) {
      return res.status(400).json({ error: 'Missing fecha or cuidadora' });
    }
    const cfg = caregivers[cuidadora];
    if (!cfg?.calendarId) return res.status(404).json({ error: 'Cuidadora no encontrada' });

    const calendar = getCalendarClient();

    // Pedimos todos los eventos del día
    const timeMin = `${fecha}T00:00:00Z`;
    const timeMax = `${fecha}T23:59:59Z`;
    const r = await calendar.events.list({
      calendarId: cfg.calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime'
    });

    const busy = (r.data.items || []).map(ev => ({
      start: ev.start.dateTime || ev.start.date, // ISO
      end: ev.end.dateTime || ev.end.date        // ISO
    }));

    // Construimos nuestro grid de rangos y marcamos los ocupados
    const grid = ranges().map(range => {
      const [ini, fin] = range.split('-');
      const startISO = toISO(fecha, ini);
      const endISO   = toISO(fecha, fin);
      const taken = busy.some(b => !(endISO <= b.start || startISO >= b.end));
      return { range, taken };
    });

    res.json({ slots: grid });
  } catch (e) {
    console.error('SLOTS ERROR:', e?.response?.data || e.message || e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.listen(PORT, () => console.log(`API escuchando en ${PORT}`));
