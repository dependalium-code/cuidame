// calendar.js
import { google } from 'googleapis';

export const TZ = 'Europe/Madrid';

/** Devuelve un cliente de Calendar autenticado (secret file o variables) */
export function getCalendarClient() {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (keyFile) {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/calendar'],
      keyFile,
    });
    return google.calendar({ version: 'v3', auth });
  }

  // Fallback: variables (por si no hay secret file)
  const clientEmail = process.env.GOOGLE_SA_CLIENT_EMAIL;
  let privateKey = process.env.GOOGLE_SA_PRIVATE_KEY || '';
  if (privateKey.includes('\\n')) privateKey = privateKey.replace(/\\n/g, '\n');

  const jwt = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  return google.calendar({ version: 'v3', auth: jwt });
}

/** Acepta '2025-09-25' o '25/09/2025' y devuelve Date (UTC a medianoche) */
export function parseDateFlexible(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [Y, M, D] = s.split('-').map(Number);
    return new Date(Date.UTC(Y, M - 1, D));
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [D, M, Y] = s.split('/').map(Number);
    return new Date(Date.UTC(Y, M - 1, D));
  }
  return new Date(NaN);
}

export function timeMinISO(ymdStr) {
  const d = parseDateFlexible(ymdStr);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0)).toISOString();
}
export function timeMaxISO(ymdStr) {
  const d = parseDateFlexible(ymdStr);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59)).toISOString();
}

/** Convierte '10:00-11:00' a start/end con TZ correcta */
export function slotToDateTimes(ymdStr, range) {
  const base = parseDateFlexible(ymdStr);
  const [ini, fin] = range.split('-');
  const [sh] = ini.split(':').map(Number);
  const [eh] = fin.split(':').map(Number);

  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), sh));
  const end   = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), eh));

  return {
    start: { dateTime: start.toISOString(), timeZone: TZ },
    end:   { dateTime: end.toISOString(),   timeZone: TZ },
  };
}

/** Formatea hora local Madrid a 'HH' */
export const fmtHour = (date) =>
  new Intl.DateTimeFormat('es-ES', { hour: '2-digit', hour12: false, timeZone: TZ })
    .format(date).padStart(2, '0');

/** Lista eventos del día con logs de error útiles */
export async function listDayEvents(calendarId, ymdStr) {
  const calendar = getCalendarClient();
  try {
    return await calendar.events.list({
      calendarId,
      timeMin: timeMinISO(ymdStr),
      timeMax: timeMaxISO(ymdStr),
      singleEvents: true,
      orderBy: 'startTime',
    });
  } catch (e) {
    console.error('GOOGLE LIST ERROR:', JSON.stringify(e?.response?.data || e?.message || e, null, 2));
    throw e;
  }
}
