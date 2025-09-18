// server.js
import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import { readFileSync } from 'fs';

// Cargar cuidadores.json sin "assert"
const caregivers = JSON.parse(
  readFileSync(new URL('./caregivers.json', import.meta.url), 'utf8')
);

const app = express();
app.use(cors());
app.use(express.json());

// Puerto (Render usa process.env.PORT)
const PORT = process.env.PORT || 10000;

// Ruta base para test
app.get('/', (req, res) => {
  res.send('API de cuidadores activa ✅');
});

// Endpoint para disponibilidad
app.get('/api/disponibilidad', async (req, res) => {
  try {
    const { cuidadora, fecha } = req.query;
    if (!cuidadora || !fecha) {
      return res.status(400).json({ error: 'Falta cuidadora o fecha' });
    }

    const config = caregivers[cuidadora];
    if (!config) {
      return res.status(404).json({ error: 'Cuidadora no encontrada' });
    }

    // Inicializar cliente Google con credenciales del secreto en Render
    const auth = new google.auth.GoogleAuth({
      keyFile: '/etc/secrets/gsa.json', // donde guardaste el JSON
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });

    const calendar = google.calendar({ version: 'v3', auth });

    const startDate = new Date(fecha + 'T00:00:00Z');
    const endDate = new Date(fecha + 'T23:59:59Z');

    const response = await calendar.events.list({
      calendarId: config.calendarId,
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];
    const horasOcupadas = events.map(event => {
      const start = new Date(event.start.dateTime || event.start.date).toISOString();
      const end = new Date(event.end.dateTime || event.end.date).toISOString();
      return { start, end };
    });

    res.json({ cuidadora, fecha, ocupadas: horasOcupadas });
  } catch (err) {
    console.error('ERROR en disponibilidad:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.listen(PORT, () => {
  console.log(`API escuchando en ${PORT}`);
});
