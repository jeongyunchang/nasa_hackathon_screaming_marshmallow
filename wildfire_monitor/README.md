# Wildfire Monitor — California FRP 2006–2026

Interactive website for exploring California fire radiative power (FRP) observations on a 500 m grid, 2006 – Aug 31, 2026.

## View the site

Open `site/index.html` in a browser (recent Chrome or Edge). No server or internet connection is needed.

Screens:
1. **Search** — worldwide search (countries, U.S. states, California counties and cities). Fire data exists for California only; other places show a "no data yet" notice.
2. **Select area** — drag a rectangle on the map, enter two corners, upload GeoJSON, or use the whole place.
3. **Graphs & calendar** — 12 weekly graphs (3 metrics × All / Extreme / Large / Small, one line per period, darker toward 2026), ±7-day / ±1-month / year calendars, supporting charts.
4. **Burning activity** — 15-day map time-lapse around the selected date, compared with the 2016–2025 normal.

## Folder layout

| Path | Contents |
|---|---|
| `site/` | The website (HTML/CSS/JS). `site/data/core.js` and `site/data/geo.js` are generated. |
| `source_data/california_500m_2006_2026_with_event_id_and_size.csv` | Source FRP observations (6,009,425 rows, 756 MB, stored with Git LFS). |
| `preprocess/preprocess.py` | Builds `site/data/*.js` from the source CSV and the boundary files. |
| `preprocess/*.json` | Boundary files: `states.json`, `counties.json` (us-atlas 3.0.1), `countries.json` (world-atlas 2.0.2). |

## Rebuild the data

```bash
git lfs pull                      # fetch the source CSV
pip install polars numpy
python preprocess/preprocess.py   # writes site/data/core.js and site/data/geo.js
```

## Notes on the calculations

- Pixel-date FRP = mean `integrated_modis_equiv_index_mw` of the same pixel on the same UTC date. Missing values stay missing (never 0).
- Size classes are the `fire_size_class` values (Extreme, Large, Small); All combines them.
- `grid_fire_event_summary.csv.gz` was not available, so per-event values are derived from the same CSV: first observation time, `duration_days` = last − first observation, `unique_grid_cells` = distinct grid cells.
- Weeks are 7-day blocks from 1 January (leftover days go into week 52). Weekly values are computed per year, then years in each period are averaged with equal weight. 2026 is shown as a single year.
- Calendar days are coloured by the mean FRP of fire pixels in the selected area; days without measurements count as 0.
