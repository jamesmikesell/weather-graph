# Weather Grid

A static, forecast-only National Weather Service meteogram. The browser queries the NWS point lookup and grid forecast directly. City autocomplete uses the 2025 Census Gazetteer Places and County Subdivisions files. The index includes 35,635 entries with Census functional status A or B, meaning they have officials providing primary general-purpose local government services. It covers active incorporated places and governing county subdivisions, including New England towns and townships. County names distinguish same-named subdivisions in the same state. Census-designated places and subdivisions administered by another government are excluded.

Serve this directory on any static host. For local development, run:

```sh
npm install
npm start
```

Open [http://localhost:8000](http://localhost:8000). The browser reloads when you save changes to the HTML, CSS, JavaScript, or JSON data files. Device location requires HTTPS or localhost and browser permission. When it is unavailable on startup, the app uses the coordinates from the reference script near Pittsburgh, Pennsylvania.

## Install on your phone

Open the HTTPS-hosted app in your phone's browser. The installed app launches from the Weather Grid icon in its own window.

- iOS Safari — Share → Add to Home Screen → turn on Open as Web App if shown → Add.
- Android Chrome — Menu → Install app or Add to Home screen → Install.

Live forecasts and map tiles require an internet connection.

## Data sources

To regenerate the bundled search index, run `python3 scripts/update-places.py`.

The forecast uses the selected location’s time zone. Map controls use Leaflet and OpenStreetMap tiles. The map and live forecast require internet access.

- [NWS API documentation](https://www.weather.gov/documentation/services-web-api)
- [2025 Census Gazetteer Files](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.2025.html)
