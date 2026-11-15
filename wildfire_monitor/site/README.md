# Wildfire Monitor — California FRP 2006–2026

Open `index.html` directly in a browser (no server needed; recent Chrome/Edge recommended).
The look comes from the website.zip Dawn Atlas theme (`prototype-styles.css`); `app.css` only adds to it.

Screens
1. Search — worldwide search (countries, U.S. states, California counties and cities). Fire data exists for California only; other places show a "no data yet" notice.
2. Select area — drag a rectangle, enter two corners, upload GeoJSON, or use the whole place.
3. Graphs & calendar — 12 weekly graphs (3 metrics × All / Extreme / Large / Small, one line per period, darker toward 2026), ±7-day / ±1-month / year calendars, supporting charts → Go See Burning Activity.
4. Burning activity — 15-day map time-lapse around the selected date, compared with the 2016–2025 normal.

Rebuild data: `python work/preprocess.py` (polars, numpy) reads `california_500m_2006_2026_with_event_id_and_size.csv` and writes `site/data/core.js` and `site/data/geo.js`.
