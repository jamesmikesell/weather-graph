const ROOT = 'https://opengeo.ncep.noaa.gov/geoserver';
const FRAME_COUNT = 13;
const HISTORY_MS = 2 * 60 * 60 * 1000;
const REFRESH_MS = 5 * 60 * 1000;
const REGIONS = [
  ['alaska', -176, 50, -126, 72],
  ['hawaii', -164, 15, -151, 26],
  ['carib', -90, 10, -60, 23],
  ['guam', 140, 9, 150, 18],
  ['conus', -130, 20, -60, 55],
];

function coverage({lat, lng}) {
  return REGIONS.find(([, west, south, east, north]) =>
    lng >= west && lng <= east && lat >= south && lat <= north)?.[0];
}

async function radarTimes(endpoint, signal) {
  const response = await fetch(`${endpoint}?service=WMS&version=1.3.0&request=GetCapabilities`, {signal});
  if (!response.ok) throw new Error('Radar times are unavailable.');
  const document = new DOMParser().parseFromString(await response.text(), 'text/xml');
  const dimension = [...document.getElementsByTagNameNS('*', 'Dimension')]
    .find(element => element.getAttribute('name') === 'time');
  const times = (dimension?.textContent ?? '').split(',')
    .map(value => Date.parse(value.trim())).filter(Number.isFinite).sort((a, b) => a - b);
  if (!times.length) throw new Error('No radar frames are available.');

  const latest = times.at(-1);
  const recent = [...new Set(times.filter(time => time >= latest - HISTORY_MS))];
  const count = Math.min(FRAME_COUNT, recent.length);
  return Array.from({length: count}, (_, i) => recent[Math.round(i * (recent.length - 1) / Math.max(1, count - 1))]);
}

function frameImage(url, signal) {
  return new Promise(resolve => {
    const image = new Image();
    const stop = () => {
      finish(null);
      image.removeAttribute('src');
    };
    function finish(result) {
      image.onload = image.onerror = null;
      signal.removeEventListener('abort', stop);
      resolve(result);
    }
    if (signal.aborted) {
      finish(null);
      return;
    }
    image.alt = '';
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    signal.addEventListener('abort', stop, {once: true});
    image.src = url;
  });
}

export function addRadar(L, map, panel, controls, toggle, timestamp, dialog) {
  let playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  let frames = [];
  let shown = -1;
  let timer;
  let scheduled;
  let request;
  const timeFormat = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  const visible = () => (panel.open || dialog?.open) && !document.hidden;
  controls.hidden = false;

  function show(index) {
    if (shown >= 0) frames[shown].layer.remove();
    shown = index;
    const {layer, time} = frames[index];
    layer.addTo(map);
    timestamp.dateTime = new Date(time).toISOString();
    timestamp.textContent = timeFormat.format(time);
  }

  function setPlayback() {
    clearTimeout(timer);
    toggle.textContent = playing ? 'Pause radar' : 'Play radar';
    toggle.disabled = frames.length < 2;
    if (!playing || !visible() || frames.length < 2) return;
    timer = setTimeout(() => {
      show((shown + 1) % frames.length);
      setPlayback();
    }, shown === frames.length - 1 ? 1250 : 450);
  }

  function clearFrames() {
    clearTimeout(timer);
    if (shown >= 0) frames[shown].layer.remove();
    frames = [];
    shown = -1;
    toggle.disabled = true;
    timestamp.removeAttribute('datetime');
  }

  async function load() {
    if (!visible()) return;
    const region = coverage(map.getCenter().wrap());
    const size = map.getSize();
    if (!region || !size.x || !size.y) {
      clearFrames();
      timestamp.textContent = 'Radar unavailable for this map area.';
      return;
    }

    request?.abort();
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 12000);
    const bounds = map.getBounds();
    const projection = map.options.crs;
    const southwest = projection.project(bounds.getSouthWest());
    const northeast = projection.project(bounds.getNorthEast());
    const layer = `${region}_bref_qcd`;
    const endpoint = `${ROOT}/${region}/${layer}/ows`;
    const query = new URLSearchParams({
      SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap', LAYERS: layer, STYLES: '',
      FORMAT: 'image/png', TRANSPARENT: 'TRUE', CRS: projection.code,
      BBOX: [southwest.x, southwest.y, northeast.x, northeast.y].join(','),
      WIDTH: String(size.x), HEIGHT: String(size.y),
    });

    if (!frames.length) timestamp.textContent = 'Loading radar…';
    try {
      const times = await radarTimes(endpoint, controller.signal);
      const images = await Promise.all(times.map(async time => {
        const url = `${endpoint}?${query}&TIME=${encodeURIComponent(new Date(time).toISOString())}`;
        const image = await frameImage(url, controller.signal);
        return image ? {time, layer: L.imageOverlay(image, bounds, {opacity: .76, interactive: false})} : null;
      }));
      if (request !== controller || !visible()) return;
      const loaded = images.filter(Boolean);
      if (!loaded.length) throw new Error('Radar images are unavailable.');
      clearFrames();
      frames = loaded;
      show(frames.length - 1);
      setPlayback();
    } catch {
      if (request === controller && !frames.length) timestamp.textContent = 'Radar temporarily unavailable.';
    } finally {
      clearTimeout(timeout);
      if (request === controller) request = undefined;
    }
  }

  function schedule() {
    clearTimeout(scheduled);
    request?.abort();
    request = undefined;
    if (!visible()) {
      clearFrames();
      return;
    }
    scheduled = setTimeout(load, 300);
  }

  map.on('moveend resize', schedule);
  panel.addEventListener('toggle', schedule);
  document.addEventListener('visibilitychange', schedule);
  toggle.addEventListener('click', () => {
    playing = !playing;
    setPlayback();
  });
  setInterval(() => {
    if (visible() && !request) load();
  }, REFRESH_MS);
  setPlayback();
  schedule();
}
