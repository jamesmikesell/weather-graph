import {fetchForecast} from './forecast.js?v=3';
import {createChart} from './chart.js?v=6';

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
const refresh = byId('refresh');
const range = byId('range');
const chart = byId('chart');
const draw = createChart(byId('plot'), byId('legend'), byId('tooltip'), byId('chart-readout'));
const fallback = {lat: 40.6738, lon: -80.1207};

const {L} = window;
let map;
let marker;
let selection;
let forecast;
let request;
let locationAttempt = 0;
let days = 7;

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

if (L) {
  map = L.map('map', {scrollWheelZoom: false, worldCopyJump: true, minZoom: 2})
    .setView([38, -97], 2);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  map.on('click', ({latlng}) => choosePoint(latlng.wrap(), {fromMap: true}));
  const centerButton = byId('map-center');
  centerButton.hidden = false;
  centerButton.addEventListener('click', () => choosePoint(map.getCenter().wrap(), {fromMap: true}));
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
    for (const item of range.children) item.setAttribute('aria-pressed', String(item === button));
    if (forecast) draw(forecast, days);
  });
  range.append(button);
}

function choosePoint(point, {fromMap = false, preserveStatus = false, fromDevice = false} = {}) {
  locationAttempt++;
  locate.disabled = false;
  if (!preserveStatus) showLocationStatus();
  closeSuggestions();
  selection = {lat: point.lat, lon: point.lon ?? point.lng, name: point.name, fromDevice};
  if (map) {
    const position = [selection.lat, selection.lon];
    if (!marker) marker = L.circleMarker(position, {radius: 6, color: '#fff', weight: 2, fillColor: '#247fd0', fillOpacity: 1, interactive: false}).addTo(map);
    else marker.setLatLng(position);
    if (fromMap) map.panTo(position);
    else if (map.getZoom() > 3 || !map.getBounds().contains(position)) map.setView(position, Math.max(4, map.getZoom()));
  }
  loadForecast();
}

async function loadForecast() {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  const selected = selection;
  const timeout = setTimeout(() => controller.abort('timeout'), 20000);
  forecast = null;
  const locationCoordinates = selected.fromDevice ? '' : coordinates(selected);
  const defaultLabel = locationCoordinates || 'Current location';
  place.textContent = selected.name || defaultLabel;
  status.textContent = 'Loading the NWS grid forecast…';
  status.hidden = false;
  metadata.textContent = locationCoordinates;
  metadata.hidden = !locationCoordinates;
  chart.hidden = range.hidden = true;
  refresh.hidden = false;
  refresh.disabled = true;
  try {
    const result = await fetchForecast(selected.lat, selected.lon, controller.signal);
    if (request !== controller) return;
    forecast = result;
    const nearby = result.point.relativeLocation?.properties;
    place.textContent = selected.name || (nearby?.city ? `Near ${nearby.city}, ${nearby.state}` : defaultLabel);
    const zone = result.point.timeZone || 'UTC';
    const update = Number.isFinite(result.updated) ? new Intl.DateTimeFormat('en-US', {
      timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(result.updated) : null;
    metadata.textContent = [locationCoordinates, update && `Updated ${update}`].filter(Boolean).join(' · ');
    metadata.hidden = !metadata.textContent;
    status.hidden = true;
    chart.hidden = range.hidden = false;
    draw(result, days);
  } catch (error) {
    if (request !== controller) return;
    if (error.status === 404) status.textContent = 'NWS has no forecast grid here. Try a point on land within the United States.';
    else if (controller.signal.reason === 'timeout') status.textContent = 'The NWS request timed out. Select Refresh to try again.';
    else status.textContent = 'Could not load the NWS forecast. Select Refresh to try again or choose another location.';
  } finally {
    clearTimeout(timeout);
    if (request === controller) refresh.disabled = false;
  }
}

function useLocation(initial = false) {
  const attempt = ++locationAttempt;
  locate.disabled = true;
  showLocationStatus('Finding your location…');
  const failed = () => {
    if (attempt !== locationAttempt) return;
    locate.disabled = false;
    if (initial && !selection) {
      showLocationStatus('Location unavailable. Showing the reference forecast near Pittsburgh, PA.');
      choosePoint(fallback, {preserveStatus: true});
    } else {
      showLocationStatus('Location unavailable. Check browser permissions or choose a location below.');
    }
  };
  const deadline = setTimeout(failed, 10000);
  if (!navigator.geolocation) {
    clearTimeout(deadline);
    failed();
    return;
  }
  navigator.geolocation.getCurrentPosition(({coords}) => {
    clearTimeout(deadline);
    if (attempt === locationAttempt) choosePoint({lat: coords.latitude, lon: coords.longitude}, {fromDevice: true});
  }, () => {
    clearTimeout(deadline);
    failed();
  }, {timeout: 8500, maximumAge: 300000});
}
locate.addEventListener('click', () => useLocation());
refresh.addEventListener('click', loadForecast);

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

useLocation(true);
