import { google } from 'googleapis';

const TZ = 'Europe/Madrid';

export function getCalendarClient() {
  // Opción 1: usar secret file (recomendado)
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (keyFile) {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/calendar'],
      keyFile
    });
    const calendar = google.calendar({ version: 'v3', auth });
    return { calendar, TZ };
  }

  // Opción 2: fallback a variables de entorno (por si no hay secret file)
  const clientEmail = process.env.GOOGLE_SA_CLIENT_EMAIL;
  let privateKey = process.env.GOOGLE_SA_PRIVATE_KEY || '';
  if (privateKey.includes('\\n')) privateKey = privateKey.replace(/\\n/g, '\n');

  const jwt = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/calendar']
  });

  const calendar = google.calendar({ version: 'v3', auth: jwt });
  return { calendar, TZ };
}

export function slotToDateTimes(fecha, range) {
  const [ini, fin] = range.split('-');
  return {
    start: { dateTime: `${fecha}T${ini}:00`, timeZone: TZ },
    end:   { dateTime: `${fecha}T${fin}:00`, timeZone: TZ }
  };
}
