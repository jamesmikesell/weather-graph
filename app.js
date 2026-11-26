import {HOUR, buildForecast, distanceMeters, fetchPoint, fetchForecast, fetchCurrentConditions} from './forecast.js?v=12';
import {createChart} from './chart.js?v=25';
import {addRadar} from './radar.js?v=3';

const byId = id => document.getElementById(id);
const theme = byId('theme');
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const compactLayout = matchMedia('(max-width: 760px)');
const locationPanel = byId('location-panel');

function setLocationPanel() {
  locationPanel.open = !compactLayout.matches;
}

setLocationPanel();
compactLayout.addEventListener('change', setLocationPanel);
locationPanel.addEventListener('toggle', () => {
  if (locationPanel.open) map?.invalidateSize({pan: false});
});
const city = byId('city');
const suggestions = byId('suggestions');
const searchStatus = byId('search-status');
const locationStatus = byId('location-status');
const locate = byId('locate');
const status = byId('forecast-status');
const place = byId('place');
const metadata = byId('metadata');
const conditions = byId('conditions');
const conditionsValues = byId('conditions-values');
const conditionsSource = byId('conditions-source');
const refresh = byId('refresh');
const range = byId('range');
const chart = byId('chart');
const graphStorageKey = 'weather-grid-graph';
let savedGraph;
try {
  savedGraph = JSON.parse(localStorage.getItem(graphStorageKey));
} catch {
  // Graph controls still work when preferences cannot be read.
}

let days = Number.isInteger(savedGraph?.days) && savedGraph.days >= 1 && savedGraph.days <= 7
  ? savedGraph.days : 7;
let hiddenSeries = Array.isArray(savedGraph?.hiddenSeries) ? savedGraph.hiddenSeries : [];

function saveGraph() {
  try {
    localStorage.setItem(graphStorageKey, JSON.stringify({days, hiddenSeries}));
  } catch {
    // Graph controls still work when preferences cannot be saved.
  }
}

const draw = createChart(byId('plot'), byId('legend'), byId('tooltip'), byId('chart-readout'), {
  hiddenSeries,
  onVisibilityChange(keys) {
    hiddenSeries = keys;
    saveGraph();
  },
});
const LOCATION_RADIUS_METERS = 1609.344;
const REGIONAL_ZOOM = 7;

const {L} = window;
let map;
let marker;
let selection;
let forecast;
let request;
let forecastTimer;
let lastForecastCheck;
let automaticLocation;
let locationPermission;

function applyTheme() {
  const appearance = theme.value;
  if (appearance === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = appearance;
  const dark = appearance === 'dark' || (appearance === 'auto' && systemTheme.matches);
  byId('map').classList.toggle('dark-map', dark);
}

try {
  const saved = localStorage.getItem('weather-grid-theme');
  if (['light', 'dark', 'auto'].includes(saved)) theme.value = saved;
} catch {
  // Theme switching remains available when storage is restricted.
}
theme.addEventListener('change', () => {
  applyTheme();
  try { localStorage.setItem('weather-grid-theme', theme.value); } catch {}
});
systemTheme.addEventListener('change', applyTheme);

function showLocationStatus(message = '') {
  locationStatus.textContent = message;
  locationStatus.hidden = !message;
}

function coordinates({lat, lon}) {
  return `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;
}

function setupExpandedMap(dialog) {
  const home = byId('map-home');
  const view = byId('map-view');
  const button = byId('expand-map');
  if (!dialog?.showModal || !home || !view || !button) return;

  function updateButton(expanded) {
    const label = expanded ? 'Exit expanded map' : 'Expand map';
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  button.hidden = false;
  button.addEventListener('click', () => {
    if (dialog.open) {
      dialog.close();
      return;
    }
    dialog.append(view);
    updateButton(true);
    dialog.showModal();
    button.focus({preventScroll: true});
    map.invalidateSize();
  });
  dialog.addEventListener('close', () => {
    locationPanel.open = true;
    home.append(view);
    updateButton(false);
    button.focus({preventScroll: true});
    map.invalidateSize();
  });
}

if (L) {
  const wheelInput = matchMedia('(hover: hover) and (pointer: fine)');
  map = L.map('map', {
    scrollWheelZoom: wheelInput.matches,
    zoomControl: false,
    wheelPxPerZoomLevel: 120,
    zoomSnap: .5,
    worldCopyJump: true,
    minZoom: 2,
  }).setView([38, -97], 2);
  wheelInput.addEventListener('change', ({matches}) => {
    if (matches) map.scrollWheelZoom.enable();
    else map.scrollWheelZoom.disable();
  });
  map.attributionControl.setPrefix(false);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const dialog = byId('map-dialog');
  setupExpandedMap(dialog);
  const radarControls = byId('radar-controls');
  if (radarControls) addRadar(L, map, locationPanel, radarControls, byId('radar-playback'), byId('radar-time'), dialog);
  map.on('click', ({latlng}) => choosePoint(latlng.wrap(), {fromMap: true}));
} else {
  byId('map').textContent = 'The map could not load. City search and device location are available.';
}
applyTheme();

for (let length = 1; length <= 7; length++) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `${length}d`;
  button.setAttribute('aria-label', `${length} ${length === 1 ? 'day' : 'days'}`);
  button.setAttribute('aria-pressed', String(days === length));
  button.addEventListener('click', () => {
    days = length;
    saveGraph();
    for (const item of range.children) item.setAttribute('aria-pressed', String(item === button));
    if (forecast) draw(forecast, days);
  });
  range.append(button);
}

function choosePoint(point, {fromMap = false, source = 'manual'} = {}) {
  if (source === 'manual') stopAutomaticLocation();
  showLocationStatus();
  closeSuggestions();
  const firstSelection = !selection;
  selection = {lat: point.lat, lon: point.lon ?? point.lng, name: point.name, source};
  if (map) {
    const position = [selection.lat, selection.lon];
    if (!marker) marker = L.circleMarker(position, {radius: 6, color: '#fff', weight: 2, fillColor: '#247fd0', fillOpacity: 1, interactive: false}).addTo(map);
    else marker.setLatLng(position);
    if (fromMap && !firstSelection) map.panTo(position);
    else map.setView(position, Math.max(REGIONAL_ZOOM, map.getZoom()), {animate: false});
  }
  loadForecast();
}

function showConditions(observation, timeZone) {
  if (!observation) {
    conditionsValues.textContent = '';
    conditionsSource.textContent = 'No recent nearby station report available.';
    return;
  }

  const {description, temperature, humidity, wind, station, distance, observedAt} = observation;
  const temperatureText = temperature == null ? null : `${Math.round(temperature)}°F`;
  const summary = [temperatureText, description].filter(Boolean).join(' ');
  const details = [summary, humidity == null ? null : `Humidity ${Math.round(humidity)}%`,
    wind == null ? null : wind < .5 ? 'Calm wind' : `Wind ${Math.round(wind)} mph`].filter(Boolean);
  conditionsValues.replaceChildren(...details.map(value => {
    const item = document.createElement('span');
    item.textContent = value;
    return item;
  }));

  const time = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(observedAt);
  conditionsSource.textContent = [station, distance == null ? null : `${Math.round(distance / 1609.344)} mi away`,
    `Observed ${time}`].filter(Boolean).join(' · ');
}

function updateForecastClock() {
  clearTimeout(forecastTimer);
  const now = Date.now();
  const hour = Math.floor(now / HOUR) * HOUR;
  forecastTimer = setTimeout(updateForecastClock, hour + HOUR - now);
  if (forecast && forecast.first !== hour) {
    forecast = {...forecast, ...buildForecast(forecast.properties, now)};
    draw(forecast, days, {preserveView: true});
  }
  if (!document.hidden && selection && !refresh.disabled && lastForecastCheck !== hour) {
    loadForecast({automatic: true});
  }
}

async function loadForecast({automatic = false, preserveView = automatic} = {}) {
  lastForecastCheck = Math.floor(Date.now() / HOUR) * HOUR;
  request?.abort();
  const controller = new AbortController();
  request = controller;
  const selected = selection;
  const timeout = setTimeout(() => controller.abort('timeout'), 20000);
  const keepVisible = preserveView && Boolean(forecast);
  const locationCoordinates = selected.source === 'manual' ? coordinates(selected) : '';
  const locationDetail = selected.source === 'ip' ? 'Approximate location from IP' : locationCoordinates;
  const defaultLabel = locationCoordinates || 'Current location';
  if (!keepVisible) {
    forecast = null;
    place.textContent = selected.name || defaultLabel;
    status.textContent = 'Loading the NWS grid forecast…';
    status.hidden = false;
    metadata.textContent = locationDetail;
    metadata.hidden = !locationDetail;
    chart.hidden = range.hidden = true;
    conditions.hidden = true;
  }
  refresh.hidden = false;
  refresh.disabled = true;
  let observationWork;
  try {
    const point = automatic && keepVisible ? forecast.point : await fetchPoint(selected.lat, selected.lon, controller.signal);
    if (request !== controller) return;
    if (!automatic || !keepVisible) {
      conditions.hidden = false;
      conditionsValues.textContent = '';
      conditionsSource.textContent = 'Looking up nearby station observations…';
      observationWork = fetchCurrentConditions(point, selected, controller.signal)
        .then(observation => {
          if (request === controller) showConditions(observation, point.timeZone || 'UTC');
        })
        .catch(() => {
          if (request === controller) showConditions(null);
        });
    }
    const result = await fetchForecast(point, selected.lat, selected.lon, controller.signal);
    if (request !== controller) return;
    forecast = result;
    const nearby = result.point.relativeLocation?.properties;
    place.textContent = selected.name || (nearby?.city ? `Near ${nearby.city}, ${nearby.state}` : defaultLabel);
    const zone = result.point.timeZone || 'UTC';
    const update = Number.isFinite(result.updated) ? new Intl.DateTimeFormat('en-US', {
      timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(result.updated) : null;
    metadata.textContent = [locationDetail, update && `Updated ${update}`].filter(Boolean).join(' · ');
    metadata.hidden = !metadata.textContent;
    status.hidden = true;
    chart.hidden = range.hidden = false;
    draw(result, days, {preserveView: keepVisible});
  } catch (error) {
    if (request !== controller || (automatic && keepVisible)) return;
    status.hidden = false;
    if (error.status === 404) status.textContent = 'NWS has no forecast grid here. Try a point on land within the United States.';
    else if (controller.signal.reason === 'timeout') status.textContent = 'The NWS request timed out. Select Refresh to try again.';
    else status.textContent = 'Could not load the NWS forecast. Select Refresh to try again or choose another location.';
  } finally {
    if (request === controller) {
      refresh.disabled = false;
      if (lastForecastCheck !== Math.floor(Date.now() / HOUR) * HOUR) updateForecastClock();
    }
    await observationWork;
    clearTimeout(timeout);
  }
}

function stopAutomaticLocation() {
  if (!automaticLocation) return;
  const {watch, ipRequest} = automaticLocation;
  automaticLocation = undefined;
  if (watch != null) navigator.geolocation.clearWatch(watch);
  ipRequest?.abort();
}

function canEstimateLocation() {
  const state = locationPermission?.state;
  return state === 'prompt' || state === 'denied';
}

async function estimateLocation(session) {
  if (automaticLocation !== session || selection || session.ipAttempted || !canEstimateLocation()) return;
  session.ipAttempted = true;
  status.textContent = 'Finding your approximate location…';
  const controller = new AbortController();
  session.ipRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 6500);
  try {
    const response = await fetch('https://get.geojs.io/v1/ip/geo.json', {
      signal: controller.signal, credentials: 'omit', cache: 'no-store',
    });
    if (!response.ok) throw new Error('IP location unavailable');
    const {latitude, longitude} = await response.json();
    const lat = typeof latitude === 'string' && latitude.trim() ? Number(latitude) : NaN;
    const lon = typeof longitude === 'string' && longitude.trim() ? Number(longitude) : NaN;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
      throw new Error('IP location unavailable');
    }
    if (automaticLocation === session && !selection && canEstimateLocation()) {
      choosePoint({lat, lon}, {source: 'ip'});
    }
  } catch {
    if (automaticLocation !== session || selection || !canEstimateLocation()) return;
    const message = 'Approximate location unavailable. Use device location, search for a city, or pick a point on the map.';
    status.textContent = message;
    status.hidden = false;
  } finally {
    clearTimeout(timeout);
    session.ipRequest = undefined;
  }
}

function useLocation() {
  stopAutomaticLocation();
  const session = {};
  automaticLocation = session;
  showLocationStatus('Finding your device location…');
  if (!selection) {
    status.textContent = 'Finding your location…';
    status.hidden = false;
  }

  function deviceLocationUnavailable() {
    if (automaticLocation !== session) return;
    showLocationStatus('Device location is unavailable. Check browser permissions or choose another location.');
    if (!selection && !session.ipAttempted) {
      status.textContent = 'Device location unavailable. Search for a city or pick a point on the map.';
    }
    estimateLocation(session);
  }

  if (!navigator.geolocation) {
    deviceLocationUnavailable();
    return;
  }
  estimateLocation(session);

  session.watch = navigator.geolocation.watchPosition(({coords}) => {
    if (automaticLocation !== session) return;
    session.ipRequest?.abort();
    showLocationStatus();
    const point = {lat: coords.latitude, lon: coords.longitude};
    if (selection?.source === 'device' && distanceMeters(selection, point) < LOCATION_RADIUS_METERS) return;
    choosePoint(point, {source: 'device'});
  }, deviceLocationUnavailable, {enableHighAccuracy: true, maximumAge: 30000, timeout: 8500});
}

navigator.permissions?.query({name: 'geolocation'}).then(permission => {
  locationPermission = permission;
  if (automaticLocation) estimateLocation(automaticLocation);
  permission.addEventListener('change', () => {
    if (!automaticLocation) return;
    if (permission.state === 'granted') useLocation();
    else estimateLocation(automaticLocation);
  });
}).catch(() => {});

locate.addEventListener('click', useLocation);
refresh.addEventListener('click', () => loadForecast({preserveView: true}));
document.addEventListener('visibilitychange', updateForecastClock);
updateForecastClock();

const stateNames = Object.fromEntries(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY'
    .split(' ').map((code, i) => [code, 'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|District of Columbia|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Puerto Rico|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming'.split('|')[i]]),
);
const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
let dataset;
let results = [];
let active = -1;
let searchVersion = 0;
let searchTimer;

function closeSuggestions() {
  clearTimeout(searchTimer);
  searchVersion++;
  results = [];
  active = -1;
  suggestions.hidden = true;
  city.setAttribute('aria-expanded', 'false');
  city.removeAttribute('aria-activedescendant');
}

function openSuggestions() {
  suggestions.hidden = false;
  city.setAttribute('aria-expanded', 'true');
}

function cityLabel([name, state, , , detail]) {
  return detail ? `${name}, ${state} (${detail})` : `${name}, ${state}`;
}

function selectCity(index) {
  const {row} = results[index];
  const [, , lat, lon] = row;
  const label = cityLabel(row);
  city.value = label;
  searchStatus.textContent = `Selected ${label}.`;
  choosePoint({lat, lon, name: label});
}

function scheduleSearch() {
  closeSuggestions();
  searchStatus.textContent = '';
  const query = normalize(city.value);
  if (query.length < 2) return;
  const version = searchVersion;
  searchTimer = setTimeout(() => search(query, version), 180);
}

async function search(query, version) {
  try {
    dataset ??= fetch('data/places.json?v=2').then(response => {
      if (!response.ok) throw new Error('Place index unavailable');
      return response.json();
    }).then(rows => rows.map(row => {
      const name = normalize(row[0]);
      return {row, name, base: name.replace(/ (?:township|town|plantation)$/, ''),
        state: normalize(stateNames[row[1]] || row[1])};
    }))
      .catch(error => { dataset = undefined; throw error; });
    const index = await dataset;
    if (version !== searchVersion) return;
    const [name, state] = query.split(',').map(part => part.trim());
    results = index.flatMap(entry => {
      const code = entry.row[1].toLowerCase();
      const starts = entry.name.startsWith(name);
      const hasState = [entry.name, entry.base].some(place =>
        `${place} ${code}`.startsWith(query) || `${place} ${entry.state}`.startsWith(query));
      if (state && !code.startsWith(state) && !entry.state.startsWith(state)) return [];
      if (entry.name === name || entry.base === name || (!state && hasState && !starts)) return [{...entry, rank: 0}];
      if (starts) return [{...entry, rank: 1}];
      if (entry.name.includes(name)) return [{...entry, rank: 2}];
      return [];
    }).sort((a, b) => a.rank - b.rank || a.name.length - b.name.length).slice(0, 8);
    suggestions.replaceChildren();
    openSuggestions();
    searchStatus.textContent = results.length ? `${results.length} suggestions available.` : 'No matching cities.';
    if (!results.length) {
      const empty = document.createElement('li');
      empty.setAttribute('role', 'presentation');
      empty.textContent = 'No matching cities';
      suggestions.append(empty);
    }
    results.forEach(({row}, i) => {
      const option = document.createElement('li');
      option.id = `city-option-${i}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.textContent = cityLabel(row);
      option.addEventListener('pointerdown', event => event.preventDefault());
      option.addEventListener('click', () => selectCity(i));
      suggestions.append(option);
    });
  } catch {
    if (version !== searchVersion) return;
    searchStatus.textContent = 'City search could not load. Try again.';
    const error = document.createElement('li');
    error.textContent = searchStatus.textContent;
    error.setAttribute('role', 'presentation');
    suggestions.replaceChildren(error);
    openSuggestions();
  }
}

city.addEventListener('input', scheduleSearch);
city.addEventListener('focus', scheduleSearch);
city.addEventListener('blur', closeSuggestions);
city.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeSuggestions();
  if (!results.length) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    selectCity(Math.max(0, active));
  }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  active = active < 0 && event.key === 'ArrowUp' ? results.length - 1
    : (active + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
  city.setAttribute('aria-activedescendant', `city-option-${active}`);
  [...suggestions.children].forEach((option, i) => option.setAttribute('aria-selected', String(i === active)));
});

useLocation();
