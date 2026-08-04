# Personal Parking Map

A personal parking map built for a spot in San Francisco where getting a
residential parking permit (RPP) isn't an option. It answers three questions
for the streets right around home:

1. **Where can I park without a permit?** (blue streets — no RPP letter on
   file — vs. orange streets, which are in a lettered permit zone and only
   safe for the posted time limit)
2. **When does the street sweeper come?** (dashed lines, colored by weekday)
3. **What other restrictions apply?** (meters, no-parking-any-time,
   government-permit-only, no-overnight-parking)

Built on public SFMTA/DataSF open data: parking regulations, street sweeping
schedules, and active parking meters — filtered down to a roughly 0.75 mile
radius around one address so the map stays fast on a phone, with a real
OpenStreetMap-tile basemap (CARTO Positron) via Leaflet.

Design notes worth knowing about:
- **Colorblind-safe palette** — blue/orange (Okabe-Ito) throughout, not red/green.
- **"No regulation on file" ≠ blank.** SFMTA's regulation dataset only has an
  entry where a specific rule was posted, so plenty of ordinary blocks have no
  record at all. Those are filled in from the street-sweeping export (which has
  much broader street coverage) and shown the same as a confirmed no-permit
  street, since for parking purposes they're equivalent.
- **Meters are line-split, not block-level.** A block is often only partially
  metered — one meter near a corner, the rest free — so the "no permit" line is
  cut at the actual metered stretch instead of hiding the whole block.
- **"2 HRS" time-limit badges**, styled after SFMTA's own street signage,
  appear once you zoom in past street level.

## Setting your own home location

Your address is intentionally kept out of the repo. Copy the example config
and fill in your own coordinates:

```bash
cp config.example.js config.js
```

Edit `config.js` with your `lat`/`lng`/`label`. `config.js` is gitignored, so
it never gets committed.

You'll also want to update the bounding box in `scripts/prepare_data.py`
(`LAT_MIN`/`LAT_MAX`/`LON_MIN`/`LON_MAX`) to center on your own neighborhood.

## Project structure

```
index.html                          the page
style.css                           styling — top-right collapsible legend, popups, home marker pulse
app.js                               Leaflet map setup, layer rendering, toggle logic
config.example.js / config.js        home location (config.js is gitignored — see above)
scripts/prepare_data.py             filters the raw SFMTA exports down to the neighborhood bbox
data/parking_regulations.geojson    filtered regulations (generated)
data/street_sweeping.geojson        filtered sweeping schedule (generated)
data/street_network.geojson         "no regulation on file" fallback streets (generated)
data/parking_meters.geojson         active metered spots (generated)
```

## Regenerating the data

Download fresh exports from [DataSF](https://data.sfgov.org/) and place them
in the project root with these exact names:

- `Parking regulations (except non-metered color curb).geojson`
- `Street_Sweeping_Schedule_<date>.csv` (update the filename in `prepare_data.py` if it changes)
- `Parking_Meters_<date>.csv` (same)

Then install the one dependency (used for the geometry matching/splitting)
and run the script:

```bash
pip install shapely
python3 scripts/prepare_data.py
```

This re-filters all three source files to the neighborhood bounding box and
overwrites `data/*.geojson`.

## Running locally

```bash
python3 -m http.server 8765
```

then open `http://localhost:8765`.

## Deploying to Vercel

This is a plain static site — no build step. From the project root:

```bash
npx vercel --prod
```

Follow the prompts (link/create a project, accept the defaults — Vercel
auto-detects a static site). You'll get a `https://<project>.vercel.app` URL
you can open on your phone and share.
