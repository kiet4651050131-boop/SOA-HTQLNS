const { callConfigService } = require('./config-client');

let settings;
let holidays;
let refreshTimer;
let cacheRevision = 0;
let refreshGeneration = 0;

function getCachedSettings() {
  if (!settings) throw new Error('Config Service cache has not been initialized');
  return { ...settings };
}

function getCachedHolidays(from, to) {
  if (!holidays) throw new Error('Config Service cache has not been initialized');
  return new Set(holidays
    .filter((holiday) => holiday.date >= from && holiday.date <= to)
    .map((holiday) => holiday.date));
}

function setSettingsCache(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Config Service returned invalid settings');
  }
  settings = { ...value };
  cacheRevision++;
}

function setHolidaysCache(value) {
  if (!Array.isArray(value) || value.some((holiday) =>
    !holiday || typeof holiday.date !== 'string' || typeof holiday.name !== 'string')) {
    throw new Error('Config Service returned invalid holidays');
  }
  holidays = value.map((holiday) => ({ date: holiday.date, name: holiday.name }));
  cacheRevision++;
}

function addHolidayCache(holiday) {
  if (!holidays) throw new Error('Config Service cache has not been initialized');
  holidays = [...holidays.filter((item) => item.date !== holiday.date), holiday];
  cacheRevision++;
}

function deleteHolidayCache(date) {
  if (!holidays) throw new Error('Config Service cache has not been initialized');
  holidays = holidays.filter((holiday) => holiday.date !== date);
  cacheRevision++;
}

async function refreshConfigCache() {
  const generation = ++refreshGeneration;
  const revision = cacheRevision;
  const [nextSettings, nextHolidays] = await Promise.all([
    callConfigService('/internal/v1/settings'),
    callConfigService('/internal/v1/holidays'),
  ]);
  if (generation !== refreshGeneration || revision !== cacheRevision) return;
  setSettingsCache(nextSettings);
  setHolidaysCache(nextHolidays);
}

function startConfigCacheRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    refreshConfigCache().catch((error) => {
      console.error(`Config Service cache refresh failed: ${error.message}`);
    });
  }, 30000);
  refreshTimer.unref();
}

module.exports = {
  getCachedSettings,
  getCachedHolidays,
  setSettingsCache,
  setHolidaysCache,
  addHolidayCache,
  deleteHolidayCache,
  refreshConfigCache,
  startConfigCacheRefresh,
};
