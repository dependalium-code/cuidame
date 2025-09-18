import { google } from 'googleapis';

const TZ = 'Europe/Madrid';

export function getCalendarClient() {
  const clientEmail = process.env.GOOGLE_SA_CLIENT_EMAIL;
  const privateKey = (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  const jwt = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/calendar']
  });

  const calendar = google.calendar({ version: 'v3', auth: jwt });
  return { calendar, TZ };
}

// Convierte "YYYY-MM-DD" + "HH:MM-HH:MM" a objeto start/end con TZ
export function slotToDateTimes(fecha, range) {
  const [ini, fin] = range.split('-'); // "09:00", "10:00"
  return {
    start: { dateTime: `${fecha}T${ini}:00`, timeZone: 'Europe/Madrid' },
    end:   { dateTime: `${fecha}T${fin}:00`, timeZone: 'Europe/Madrid' }
  };
}
