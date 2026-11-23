export const HOUR = 3600000;
export const FORECAST_HOURS = 168;

export const SERIES = [
  ['temperature', 'Temperature', 'temp', 'temperature'],
  ['dewpoint', 'Dewpoint', 'dew', 'temperature', 'dotted'],
  ['heatIndex', 'Heat Index', 'heat', 'temperature', 'dashed'],
  ['windChill', 'Wind Chill', 'chill', 'temperature', 'dashed'],
  ['windSpeed', 'Wind Speed', 'wind', 'wind'],
  ['windGust', 'Wind Gust', 'gust', 'wind', 'dotted'],
  ['skyCover', 'Sky Cover', 'sky', 'probability', 'dotted'],
  ['probabilityOfPrecipitation', 'Precip Potential', 'precip', 'probability'],
  ['relativeHumidity', 'Relative Humidity', 'humid', 'probability'],
  ['probabilityOfThunder', 'Thunder Probability', 'thunder', 'probability', 'dotted'],
].map(([key, label, color, panel, style]) => ({key, label, color, panel, style}));

export const ACCUMULATIONS = [
  {key: 'quantitativePrecipitation', label: 'Liquid-equivalent precip.', type: 'rain', color: 'precip'},
  {key: 'snowfallAmount', label: 'Snow accumulation', type: 'snow', shortLabel: 'snow', color: 'dew'},
];

export const TYPES = [
  ['rain', 'Rain', 'precip', /rain|drizzle|showers/],
  ['thunder', 'Thunder', 'storm', /thunder/],
  ['snow', 'Snow', 'dew', /snow|flurr/],
  ['sleet', 'Sleet', 'heat', /icepellet|sleet/],
  ['freezingRain', 'Freezing Rain', 'temp', /freezing(?:rain|drizzle)/],
].map(([key, label, color, pattern]) => ({key, label, color, pattern, style: 'category'}));

export function interval(validTime) {
  const [timestamp, duration] = validTime?.split('/') ?? [];
  const parts = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(duration);
  const start = Date.parse(timestamp);
  if (!parts || !Number.isFinite(start)) return [];
  const [days, hours, minutes, seconds] = parts.slice(1).map(value => Number(value ?? 0));
  return [start, start + (days * 86400 + hours * 3600 + minutes * 60 + seconds) * 1000];
}

function hourly(field, first, convert = value => value) {
  const hours = Array(FORECAST_HOURS).fill(null);
  for (const entry of field?.values ?? []) {
    const [start, end] = interval(entry.validTime);
    const firstIndex = Math.max(0, Math.ceil((start - first) / HOUR));
    const lastIndex = Math.min(hours.length, Math.ceil((end - first) / HOUR));
    if (firstIndex < lastIndex) hours.fill(convert(entry.value, end - start), firstIndex, lastIndex);
  }
  return hours;
}

export function buildForecast(properties, now = Date.now()) {
  const first = Math.ceil(now / HOUR) * HOUR;
  const values = Object.fromEntries(SERIES.map(({key, panel}) => {
    const field = properties[key];
    const unit = field?.uom?.split(':').at(-1);
    const converted = hourly(field, first).map(value => {
      if (!Number.isFinite(value)) return null;
      if (panel === 'temperature' && unit === 'degC') return value * 1.8 + 32;
      if (panel === 'wind' && unit === 'km_h-1') return value / 1.609344;
      if (panel === 'wind' && unit === 'm_s-1') return value / 0.44704;
      return value;
    });
    return [key, converted];
  }));
  values.heatIndex = values.heatIndex.map((value, i) =>
    value != null && values.temperature[i] != null && value - values.temperature[i] > 5 ? value : null);
  values.windChill = values.windChill.map((value, i) =>
    value != null && values.temperature[i] != null && values.temperature[i] - value >= 5 ? value : null);
  values.windGust = values.windGust.map((value, i) =>
    value != null && values.windSpeed[i] != null && value - values.windSpeed[i] >= 10 ? value : null);

  const weather = hourly(properties.weather, first);
  for (const type of TYPES) {
    values[type.key] = weather.map(items => Array.isArray(items) && items.some(item => {
      const code = String(item?.weather ?? '').toLowerCase().replace(/[^a-z]/g, '');
      if (type.key === 'rain' && TYPES.at(-1).pattern.test(code)) return false;
      return type.pattern.test(code);
    }));
  }
  const accumulations = Object.fromEntries(ACCUMULATIONS.map(({key}) => {
    const field = properties[key];
    const unit = field?.uom?.split(':').at(-1);
    const unitsToInches = {mm: 1 / 25.4, cm: 1 / 2.54, m: 1 / .0254, in: 1};
    const factor = unitsToInches[unit];
    return [key, hourly(field, first, (value, duration) =>
      Number.isFinite(value) && Number.isFinite(factor) && duration > 0
        ? {inches: value * factor, hours: duration / HOUR}
        : null)];
  }));
  return {first, values, accumulations, updated: Date.parse(properties.updateTime)};
}

export async function fetchForecast(lat, lon, signal) {
  async function get(url) {
    const response = await fetch(url, {headers: {Accept: 'application/geo+json'}, signal});
    if (!response.ok) {
      const error = new Error(`NWS responded with HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return (await response.json()).properties;
  }
  const point = await get(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  if (!point?.forecastGridData) throw new Error('NWS returned no forecast grid for this point.');
  const grid = await get(point.forecastGridData);
  const forecast = buildForecast(grid);
  if (!forecast.values.temperature.some(Number.isFinite)) throw new Error('NWS returned no upcoming temperatures for this point.');
  return {...forecast, point, lat, lon};
}

export function temperatureTurns(values) {
  const points = values.flatMap((value, index) => value == null ? [] : [{value, index}]);
  const turns = [];
  let direction = 0;
  let candidate = points[0];
  for (const point of points.slice(1)) {
    const change = point.value - candidate.value;
    if (!direction && Math.abs(change) < 5) continue;
    if (direction && Math.abs(change) >= 5 && Math.sign(change) !== direction) {
      turns.push({...candidate, high: direction > 0});
    } else if (direction && change * direction <= 0) {
      continue;
    }
    direction = Math.sign(change);
    candidate = point;
  }
  return turns;
}

// Approximate sunrise and sunset from solar declination and equation of time.
export function isNight(time, lat, lon) {
  const date = new Date(time);
  const day = (time - Date.UTC(date.getUTCFullYear(), 0, 1)) / (24 * HOUR);
  const yearAngle = 2 * Math.PI * day / 365.2422;
  const equation = 229.18 * (.000075 + .001868 * Math.cos(yearAngle)
    - .032077 * Math.sin(yearAngle) - .014615 * Math.cos(2 * yearAngle) - .040849 * Math.sin(2 * yearAngle));
  const declination = .006918 - .399912 * Math.cos(yearAngle) + .070257 * Math.sin(yearAngle)
    - .006758 * Math.cos(2 * yearAngle) + .000907 * Math.sin(2 * yearAngle)
    - .002697 * Math.cos(3 * yearAngle) + .00148 * Math.sin(3 * yearAngle);
  const radians = Math.PI / 180;
  const hourAngle = (((time % (24 * HOUR)) / 60000 + equation + 4 * lon) / 4 - 180) * radians;
  return Math.sin(lat * radians) * Math.sin(declination)
    + Math.cos(lat * radians) * Math.cos(declination) * Math.cos(hourAngle) < Math.sin(-.833 * radians);
}
