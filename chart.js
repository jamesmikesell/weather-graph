import {HOUR, FORECAST_HOURS, ACCUMULATIONS, SERIES, TYPES, isNight, temperatureTurns} from './forecast.js?v=10';

const NS = 'http://www.w3.org/2000/svg';

function svg(parent, name, attributes, label) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (label != null) node.textContent = label;
  parent.append(node);
  return node;
}

function createSwatch(series) {
  const swatch = document.createElement('span');
  swatch.className = `swatch ${series.style ?? ''}`;
  swatch.style.setProperty('--series', `var(--${series.color})`);
  swatch.setAttribute('aria-hidden', 'true');
  return swatch;
}

function trimZeroRuns(visible, full, offset) {
  return visible.map((value, index) => {
    if (value !== 0) return value;
    const before = full[offset + index - 1];
    const after = full[offset + index + 1];
    const inRun = before === 0 || after === 0;
    const touchesNonzero = before > 0 || after > 0;
    return inRun && !touchesNonzero ? null : value;
  });
}

function formatInches(inches) {
  return inches > 0 && inches < .01 ? '<0.01' : inches.toFixed(2);
}

function accumulationPeriods(amounts, offset, count) {
  const periods = [];
  for (let start = 0; start < offset + count;) {
    const amount = amounts[start];
    let end = start + 1;
    while (end < amounts.length && amounts[end] === amount) end++;
    if (amount?.inches > 0 && end > offset) {
      const fraction = Math.min(1, (end - start) / amount.hours);
      periods.push({
        start: Math.max(start, offset) - offset,
        end: Math.min(end, offset + count) - offset,
        inches: amount.inches * fraction,
        estimated: fraction < 1,
      });
    }
    start = end;
  }
  return periods;
}

function axisBounds(values, fromZero = false) {
  const min = fromZero ? 0 : Math.min(...values) - 5;
  const max = fromZero ? Math.max(5, ...values) : Math.max(...values) + 5;
  const raw = (max - min) / 5;
  const base = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(n => n * base).find(n => n >= raw);
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step, step];
}

export function createChart(plot, legend, tooltip, readout) {
  const hidden = new Set();
  let current;
  let days;
  let offset = 0;
  let drag;
  let metrics;
  let inspection = -1;

  function clearInspection() {
    inspection = -1;
    tooltip.hidden = true;
    if (metrics) metrics.cursor.setAttribute('visibility', 'hidden');
  }

  function render() {
    if (!current || !plot.clientWidth) return;
    clearInspection();

    const {point, lat, lon} = current;
    const count = days * 24;
    const first = current.first + offset * HOUR;
    const values = Object.fromEntries(Object.entries(current.values)
      .map(([key, series]) => [key, series.slice(offset, offset + count)]));
    const lineValues = Object.fromEntries(SERIES.map(({key, panel}) => {
      const full = current.values[key];
      const visible = values[key].slice();
      const lastHour = visible.at(-1);
      // Hourly values cover the interval up to the next hour boundary.
      visible.push(lastHour == null ? null : full[offset + count] ?? lastHour);
      return [key, panel === 'probability' ? trimZeroRuns(visible, full, offset) : visible];
    }));
    const width = plot.clientWidth;
    const left = width < 450 ? 44 : 63;
    const right = width - 10;
    const x = index => left + index / count * (right - left);
    const zone = point.timeZone || 'UTC';
    const hourFormat = new Intl.DateTimeFormat('en-US', {timeZone: zone, hour: 'numeric', hourCycle: 'h23'});
    const dayFormat = new Intl.DateTimeFormat('en-US', {timeZone: zone, weekday: 'short', day: 'numeric'});
    const timeFormat = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', timeZoneName: 'short',
    });
    const activeTypes = TYPES.filter(type => values[type.key].some(Boolean));
    const panels = {
      temperature: {top: 4, height: width < 450 ? 235 : 302, label: 'Temperature (°F)'},
      probability: {top: width < 450 ? 271 : 338, height: width < 450 ? 205 : 264, label: 'Probability (%)'},
    };
    const probabilityEnd = panels.probability.top + panels.probability.height;
    // Keep the current plot in place while measuring labels for the next frame.
    const root = svg(plot, 'svg', {'aria-hidden': 'true', 'data-pending': ''});
    const pendingLabels = svg(root, 'g', {});
    const amountRows = new Map();
    for (const {key, type, shortLabel, color} of ACCUMULATIONS) {
      const labels = [];
      const laneEnds = [];
      const groups = [];
      const sample = svg(pendingLabels, 'text', {class: 'precip-amount'});
      function placeAmount(period) {
        const {start, end, inches, estimated} = period;
        const xStart = x(start);
        const xEnd = x(end);
        const caption = `${estimated ? '≈' : ''}${formatInches(inches)}"${shortLabel ? ` ${shortLabel}` : ''}`;
        sample.textContent = caption;
        const half = sample.getComputedTextLength() / 2;
        const position = Math.max(left + half, Math.min(right - half, (xStart + xEnd) / 2));
        return {...period, caption, xStart, xEnd, position, leftEdge: position - half, rightEdge: position + half};
      }

      for (const period of accumulationPeriods(current.accumulations[key], offset, count)) {
        const placed = placeAmount(period);
        const previous = groups.at(-1);
        if (previous?.end === placed.start && previous.rightEdge + 4 > placed.leftEdge) {
          groups[groups.length - 1] = placeAmount({
            start: previous.start, end: placed.end,
            inches: previous.inches + placed.inches, estimated: previous.estimated || placed.estimated,
          });
        } else {
          groups.push(placed);
        }
      }
      sample.remove();

      for (const {caption, xStart, xEnd, position, leftEdge, rightEdge} of groups) {
        const label = svg(pendingLabels, 'text', {class: 'precip-amount', x: position,
          'text-anchor': 'middle', 'dominant-baseline': 'central'}, caption);
        const available = laneEnds.findIndex(end => end + 4 <= leftEdge);
        const lane = available < 0 ? laneEnds.length : available;
        laneEnds[lane] = rightEdge;
        labels.push({label, lane, xStart, xEnd, color});
      }
      if (labels.length) amountRows.set(type, {labels, height: laneEnds.length * 18});
    }
    const typeRows = new Map();
    let typeHeight = 0;
    for (const key of new Set([...activeTypes.map(type => type.key), ...amountRows.keys()])) {
      if (activeTypes.some(type => type.key === key)) {
        typeRows.set(key, typeHeight);
        typeHeight += 27;
      }
      const amounts = amountRows.get(key);
      if (amounts) {
        amounts.top = typeHeight;
        typeHeight += amounts.height;
      }
    }
    if (typeHeight) panels.category = {top: probabilityEnd + 15, height: typeHeight};
    panels.wind = {top: probabilityEnd + (typeHeight ? typeHeight + 30 : 16), height: 118, label: 'Wind (mph)'};
    const bottom = panels.wind.top + panels.wind.height;
    root.setAttribute('viewBox', `0 0 ${width} ${bottom + 54}`);
    const temps = SERIES.filter(s => s.panel === 'temperature')
      .flatMap(s => lineValues[s.key].filter(Number.isFinite));
    const winds = SERIES.filter(s => s.panel === 'wind')
      .flatMap(s => lineValues[s.key].filter(Number.isFinite));
    panels.temperature.bounds = temps.length ? axisBounds(temps) : [0, 100, 25];
    panels.probability.bounds = [0, 100, 25];
    panels.wind.bounds = axisBounds(winds, true);

    const ticks = [];
    for (let i = 0; i < count; i++) {
      const time = first + i * HOUR;
      const hour = Number(hourFormat.format(time));
      if (days === 1 ? hour % (width < 450 ? 6 : 3) === 0 : hour === 12) {
        const day = dayFormat.formatToParts(time);
        const weekday = day.find(part => part.type === 'weekday').value.slice(0, 2);
        const label = days === 1 ? `${weekday} ${hour % 12 || 12}${hour < 12 ? 'am' : 'pm'}`
          : `${weekday} ${day.find(part => part.type === 'day').value}`;
        ticks.push({i, label});
      }
    }
    const night = [];
    let start = null;
    for (let i = 0; i <= count * 4; i++) {
      const dark = i < count * 4 && isNight(first + i * HOUR / 4, lat, lon);
      if (dark && start === null) start = i / 4;
      if (!dark && start !== null) {
        night.push([start, i / 4]);
        start = null;
      }
    }

    function line(parent, x1, y1, x2, y2, stroke = 'var(--grid)') {
      return svg(parent, 'line', {x1, y1, x2, y2, stroke});
    }

    for (const [key, panel] of Object.entries(panels)) {
      const {top, height, label, bounds} = panel;
      const end = top + height;
      svg(root, 'rect', {x: left, y: top, width: right - left, height, fill: 'var(--plot)'});
      for (const [a, b] of night) {
        svg(root, 'rect', {x: x(a), y: top, width: x(b) - x(a), height, fill: 'var(--night)'});
      }
      for (const {i} of ticks) line(root, x(i), top, x(i), end);
      if (key === 'temperature' || key === 'wind') {
        for (const {i, label: tick} of ticks) {
          const position = x(i);
          const anchor = position < left + 14 ? 'start' : position > right - 14 ? 'end' : 'middle';
          svg(root, 'text', {x: position, y: end + 17, 'text-anchor': anchor}, tick);
        }
      }
      if (!bounds) continue;
      const [min, max, step] = bounds;
      panel.y = value => end - (value - min) / (max - min) * height;
      for (let value = min; value <= max; value += step) {
        const y = panel.y(value);
        line(root, left, y, right, y);
        svg(root, 'text', {x: left - 5, y, 'text-anchor': 'end', 'dominant-baseline': 'central'}, value);
      }
      svg(root, 'text', {transform: `translate(12 ${top + height / 2}) rotate(-90)`, 'text-anchor': 'middle', class: 'axis-label'}, label);
    }

    for (const series of SERIES) {
      if (hidden.has(series.key)) continue;
      const {y} = panels[series.panel];
      let previous = null;
      let path = '';
      const percentage = series.panel === 'probability';
      const visible = lineValues[series.key];
      visible.forEach((value, index) => {
        if (value != null) {
          const connectsBefore = previous != null && !(percentage && previous === 0 && value === 0);
          const next = visible[index + 1];
          const connectsAfter = next != null && !(percentage && value === 0 && next === 0);
          if (!connectsBefore && !connectsAfter) {
            svg(root, 'circle', {cx: x(index), cy: y(value), r: 2, fill: `var(--${series.color})`});
          }
          path += `${connectsBefore ? 'L' : 'M'}${x(index)},${y(value)}`;
        }
        previous = value;
      });
      if (path) svg(root, 'path', {
        d: path, fill: 'none', stroke: `var(--${series.color})`, 'stroke-width': series.key === 'temperature' ? 1.8 : 1.45,
        'stroke-dasharray': series.style === 'dotted' ? '2 4' : series.style === 'dashed' ? '8 6' : 'none',
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      });
    }
    if (!hidden.has('temperature')) {
      let lastHighX = -Infinity;
      let lastLowX = -Infinity;
      for (const {value, index, high} of temperatureTurns(current.values.temperature)
        .filter(turn => turn.index >= offset && turn.index < offset + count)
        .map(turn => ({...turn, index: turn.index - offset}))) {
        const position = x(index);
        const lastX = high ? lastHighX : lastLowX;
        if (position - lastX < 26) continue;
        if (high) lastHighX = position;
        else lastLowX = position;
        svg(root, 'text', {x: position, y: panels.temperature.y(value) + (high ? -9 : 15),
          'text-anchor': 'middle', class: high ? 'turn high' : 'turn low'}, Math.round(value));
      }
    }

    activeTypes.forEach(type => {
      const y = panels.category.top + typeRows.get(type.key) + 13;
      const label = type.key === 'freezingRain' ? 'Fz Rain' : type.label;
      svg(root, 'text', {x: left - 3, y, 'text-anchor': 'end', 'dominant-baseline': 'central'}, label);
      if (hidden.has(type.key)) return;
      let start = null;
      for (let i = 0; i <= count; i++) {
        if (i < count && values[type.key][i]) {
          start ??= i;
        } else if (start !== null) {
          svg(root, 'rect', {x: x(start), y: y - 4, width: x(i) - x(start), height: 8, fill: `var(--${type.color})`});
          start = null;
        }
      }
    });

    for (const {top, labels} of amountRows.values()) {
      for (const {label, lane, xStart, xEnd, color} of labels) {
        const y = panels.category.top + top + 8 + lane * 18;
        label.setAttribute('y', y);
        line(pendingLabels, xStart, y + 7, xEnd, y + 7, `var(--${color})`);
      }
    }
    root.append(pendingLabels);

    svg(root, 'text', {x: (left + right) / 2, y: bottom + 44, 'text-anchor': 'middle', class: 'axis-label'}, 'Forecast Time');
    const cursor = svg(root, 'g', {visibility: 'hidden'});
    for (const panel of Object.values(panels)) {
      const guide = line(cursor, 0, panel.top, 0, panel.top + panel.height, 'var(--muted)');
      guide.setAttribute('stroke-dasharray', '3 4');
    }
    plot.replaceChildren(root);
    root.removeAttribute('data-pending');
    metrics = {left, right, x, count, cursor, bottom, timeFormat, activeTypes, width};

    const previousFocus = document.activeElement?.dataset.series;
    legend.replaceChildren();
    for (const series of [...SERIES, ...activeTypes]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.series = series.key;
      button.setAttribute('aria-pressed', String(!hidden.has(series.key)));
      button.append(createSwatch(series), series.label);
      button.addEventListener('click', () => {
        if (!hidden.delete(series.key)) hidden.add(series.key);
        render();
      });
      legend.append(button);
      if (series.key === previousFocus) button.focus({preventScroll: true});
    }
  }

  function inspect(index, offsetY, announce = false) {
    inspection = Math.max(0, Math.min(metrics.count - 1, index));
    const x = metrics.x(inspection);
    metrics.cursor.setAttribute('visibility', 'visible');
    metrics.cursor.setAttribute('transform', `translate(${x} 0)`);
    const title = metrics.timeFormat.format(current.first + (offset + inspection) * HOUR);
    const heading = document.createElement('strong');
    heading.textContent = title;
    const lines = [];
    const rows = [];
    for (const series of [...SERIES, ...metrics.activeTypes]) {
      if (hidden.has(series.key)) continue;
      const value = current.values[series.key][offset + inspection];
      const category = series.style === 'category';
      if (category ? !value : value == null) continue;
      const unit = {temperature: ' °F', wind: ' mph', probability: '%'}[series.panel];
      const line = category ? series.label : `${series.label}: ${Math.round(value)}${unit}`;
      const row = document.createElement('div');
      row.append(createSwatch(series), line);
      lines.push(line);
      rows.push(row);
    }
    for (const {key, label} of ACCUMULATIONS) {
      const amount = current.accumulations[key][offset + inspection];
      if (key === 'snowfallAmount' && !(amount?.inches > 0)) continue;
      const detail = amount == null ? 'Unavailable'
        : `${formatInches(amount.inches)} in (${Number(amount.hours.toFixed(2))} h total)`;
      const line = `${label}: ${detail}`;
      const row = document.createElement('div');
      row.textContent = line;
      lines.push(line);
      rows.push(row);
    }
    tooltip.replaceChildren(heading, ...rows);
    tooltip.hidden = false;
    tooltip.style.left = `${Math.max(0, Math.min(plot.clientWidth - tooltip.offsetWidth, x + (x > plot.clientWidth / 2 ? -tooltip.offsetWidth - 10 : 10)))}px`;
    tooltip.style.top = `${Math.max(0, Math.min(metrics.bottom - tooltip.offsetHeight, offsetY + 10))}px`;
    if (announce) readout.textContent = [title, ...lines].join('. ');
  }

  function clampOffset(value) {
    return Math.max(0, Math.min(FORECAST_HOURS - days * 24, value));
  }

  function pan(value) {
    const next = clampOffset(value);
    if (offset === next) return false;
    offset = next;
    render();
    return true;
  }

  function plotPosition(event) {
    if (!metrics) return null;
    const bounds = plot.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    if (x < metrics.left || x > metrics.right || y < 0 || y > metrics.bottom) return null;
    return {index: Math.round((x - metrics.left) / (metrics.right - metrics.left) * metrics.count), y};
  }

  plot.addEventListener('pointerdown', event => {
    const touch = event.pointerType !== 'mouse';
    if (!event.isPrimary || event.button !== 0 || (!touch && days === 7) || !plotPosition(event)) return;
    drag = {id: event.pointerId, x: event.clientX, y: event.clientY, offset, touch, moved: false,
      hoursPerPixel: metrics.count / (metrics.right - metrics.left)};
    plot.setPointerCapture(event.pointerId);
    if (days < 7) plot.classList.add('dragging');
    clearInspection();
  });

  function endDrag(event) {
    if (event.pointerId !== drag?.id) return;
    const {id, touch, moved} = drag;
    drag = undefined;
    plot.classList.remove('dragging');
    if (plot.hasPointerCapture(id)) plot.releasePointerCapture(id);
    if (touch && !moved && event.type === 'pointerup') {
      const position = plotPosition(event);
      if (position) inspect(position.index, position.y, true);
    }
  }

  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    plot.addEventListener(name, endDrag);
  }

  plot.addEventListener('pointermove', event => {
    if (drag) {
      if (event.pointerId !== drag.id) return;
      const deltaX = drag.x - event.clientX;
      drag.moved ||= Math.hypot(deltaX, drag.y - event.clientY) > (drag.touch ? 8 : 0);
      if (drag.moved && days < 7) pan(drag.offset + Math.round(deltaX * drag.hoursPerPixel));
      return;
    }
    if (event.pointerType !== 'mouse') return;
    const position = plotPosition(event);
    if (position) inspect(position.index, position.y);
    else clearInspection();
  });
  plot.addEventListener('pointerleave', event => {
    if (event.pointerType === 'mouse') clearInspection();
  });
  document.addEventListener('pointerdown', event => {
    if (!plot.contains(event.target)) clearInspection();
  });
  plot.addEventListener('blur', clearInspection);
  plot.addEventListener('keydown', event => {
    if (!metrics) return;
    if (event.key === 'Escape') clearInspection();
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    if (event.shiftKey) {
      if (pan(offset + step * 6)) inspect(0, 0, true);
      return;
    }
    inspect(inspection < 0 ? 0 : inspection + step, 0, true);
  });
  new ResizeObserver(() => {
    if (plot.clientWidth !== metrics?.width) render();
  }).observe(plot);
  return (forecast, length) => {
    if (drag) endDrag({pointerId: drag.id});
    if (current !== forecast) offset = 0;
    current = forecast;
    days = length;
    offset = clampOffset(offset);
    plot.classList.toggle('pannable', days < 7);
    render();
  };
}
