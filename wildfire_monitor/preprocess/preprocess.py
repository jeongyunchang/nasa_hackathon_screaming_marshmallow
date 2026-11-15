"""Build compact, region-filterable data for the multi-screen website.

Input : source_data/california_500m_2006_2026_with_event_id_and_size.csv
Outputs (site/data/):
  core.js  - base64(gzip(columnar binary)) of every pixel-date value + the event table
  geo.js   - California outline/counties/cities (grid coords), lon/lat <-> grid polynomials,
             and a worldwide gazetteer (countries, US states, cities) for search
"""
import base64, gzip, json, os
import numpy as np
import polars as pl

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "site", "data")
os.makedirs(OUT, exist_ok=True)
SRC = os.path.join(ROOT, "source_data", "california_500m_2006_2026_with_event_id_and_size.csv")
FRP = "integrated_modis_equiv_index_mw"
EPOCH = np.datetime64("2006-01-01")
CLASSES = ["Extreme", "Large", "Small"]  # stored as 0/1/2

cols = ["time_utc", "grid_x", "grid_y", "latitude", "longitude", FRP, "event_id", "fire_size_class"]
raw = (pl.scan_csv(SRC, schema_overrides={FRP: pl.Float64, "grid_x": pl.Int32, "grid_y": pl.Int32}).select(cols)
       .with_columns(pl.col("time_utc").str.slice(0, 19).str.to_datetime("%Y-%m-%dT%H:%M:%S").alias("t"))
       .drop("time_utc").collect()
       .with_columns(pl.col("t").dt.date().alias("date")))
print("rows", raw.height)

# ---- events (grid_fire_event_summary.csv.gz is not available, so derive it) ----
ev = (raw.group_by("event_id").agg(
        pl.col("t").min().alias("first"), pl.col("t").max().alias("last"),
        pl.struct("grid_x", "grid_y").n_unique().alias("cells"),
        pl.col("fire_size_class").first().alias("cls"),
        pl.col("fire_size_class").n_unique().alias("ncls"))
      .with_columns(((pl.col("last") - pl.col("first")).dt.total_seconds() / 86400).alias("dur"))
      .sort("first", "event_id").with_row_index("eidx"))
assert ev["ncls"].max() == 1, "fire_size_class varies within an event"
assert set(ev["cls"].unique().to_list()) <= set(CLASSES), ev["cls"].unique().to_list()
first_min = ((ev["first"].cast(pl.Datetime("us")).to_numpy() - EPOCH.astype("datetime64[us]")) / np.timedelta64(1, "m")).astype(np.uint32)

# ---- pixel-date table: mean FRP per UTC date and grid cell (nulls stay missing) ----
pd = (raw.group_by("date", "grid_x", "grid_y").agg(
        pl.col(FRP).mean().alias("frp"),
        pl.col("event_id").mode().sort().first().alias("event_id"),
        pl.col("latitude").mean().alias("lat"), pl.col("longitude").mean().alias("lon"))
      .join(ev.select("event_id", "eidx"), on="event_id", how="left"))
cells = (pd.group_by("grid_x", "grid_y").agg(pl.col("lat").mean(), pl.col("lon").mean())
         .sort("grid_x", "grid_y").with_row_index("cidx"))
pd = (pd.join(cells.select("grid_x", "grid_y", "cidx"), on=["grid_x", "grid_y"])
      .with_columns(((pl.col("date") - pl.lit(EPOCH.astype("datetime64[D]").item())).dt.total_days()).alias("day"))
      .sort("day", "cidx"))
print("pixel-dates", pd.height, "cells", cells.height, "events", ev.height)
print(ev.group_by("cls").agg(pl.len(), pl.col("cells").min().alias("min"), pl.col("cells").max().alias("max")))

parts = [("frp", pd["frp"].fill_null(float("nan")).to_numpy().astype(np.float32)),
         ("cid", pd["cidx"].to_numpy().astype(np.uint32)),
         ("eid", pd["eidx"].to_numpy().astype(np.uint32)),
         ("efirst", first_min),
         ("edur", ev["dur"].to_numpy().astype(np.float32)),
         ("ecells", ev["cells"].to_numpy().astype(np.uint32)),
         ("clat", cells["lat"].to_numpy().astype(np.float32)),
         ("clon", cells["lon"].to_numpy().astype(np.float32)),
         ("day", pd["day"].to_numpy().astype(np.uint16)),
         ("cx", cells["grid_x"].to_numpy().astype(np.int16)),
         ("cy", cells["grid_y"].to_numpy().astype(np.int16)),
         ("ecls", ev["cls"].replace_strict({c: i for i, c in enumerate(CLASSES)}).to_numpy().astype(np.uint8))]
layout, buf, off = [], bytearray(), 0
for name, arr in parts:
    bts = arr.tobytes()
    layout.append({"name": name, "type": str(arr.dtype), "offset": off, "length": int(arr.size)})
    buf += bts; off += len(bts)
    pad = (-off) % 4; buf += b"\0" * pad; off += pad
gz = gzip.compress(bytes(buf), 9)
print("raw MB", len(buf) / 1e6, "gz MB", len(gz) / 1e6)
with open(os.path.join(OUT, "core.js"), "w", encoding="ascii") as f:
    f.write("window.FRP_CORE={layout:" + json.dumps(layout) + ",classes:" + json.dumps(CLASSES)
            + ",lastDate:'" + str(raw["date"].max()) + "',firstDate:'" + str(raw["date"].min())
            + "',rows:" + str(raw.height) + ",b64:'" + base64.b64encode(gz).decode() + "'};\n")

# ---- geography: lon/lat <-> grid ----
lat = cells["lat"].to_numpy(); lon = cells["lon"].to_numpy()
gx = cells["grid_x"].to_numpy().astype(float); gy = cells["grid_y"].to_numpy().astype(float)
def design(u, v):
    return np.stack([np.ones_like(u), u, v, u * u, u * v, v * v, u ** 3, u * u * v, u * v * v, v ** 3], 1)
A = design(lon + 120, lat - 37)
fx = np.linalg.lstsq(A, gx, rcond=None)[0]; fy = np.linalg.lstsq(A, gy, rcond=None)[0]
B = design(gx / 1000, gy / 1000)
ilon = np.linalg.lstsq(B, lon, rcond=None)[0]; ilat = np.linalg.lstsq(B, lat, rcond=None)[0]
print("fit rmse cells", float(np.sqrt(np.mean((A @ fx - gx) ** 2))), "inverse rmse deg", float(np.sqrt(np.mean((B @ ilat - lat) ** 2))))
def to_grid(pts):
    p = np.array(pts); P = design(p[:, 0] + 120, p[:, 1] - 37)
    return [[round(float(x), 1), round(float(y), 1)] for x, y in zip(P @ fx, P @ fy)]
def to_ll(pts):
    r = [[round(x, 3), round(y, 3)] for x, y in pts]
    lons = [p[0] for p in r]
    if max(lons) - min(lons) > 180:  # ring crosses the antimeridian
        r = [[x + 360 if x < 0 else x, y] for x, y in r]
    return r

def topo_rings(path, objname, pred, conv):
    topo = json.load(open(path, encoding="utf-8"))
    sc, tr = topo["transform"]["scale"], topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0; pts = []
        for dx, dy in arc:
            x += dx; y += dy; pts.append((x * sc[0] + tr[0], y * sc[1] + tr[1]))
        arcs.append(pts)
    ap = lambda i: arcs[i] if i >= 0 else arcs[~i][::-1]
    out = []
    for g in topo["objects"][objname]["geometries"]:
        if not pred(g) or "arcs" not in g:
            continue
        polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
        rings = []
        for poly in polys:
            ring = []
            for ai in poly[0]:  # outer ring only
                ring.extend(ap(ai))
            rings.append(conv(ring))
        out.append({"id": g.get("id"), "name": g.get("properties", {}).get("name", ""), "rings": rings})
    return out

ca = topo_rings(os.path.join(HERE, "states.json"), "states", lambda g: g["id"] == "06", to_grid)[0]
counties = topo_rings(os.path.join(HERE, "counties.json"), "counties", lambda g: g["id"].startswith("06"), to_grid)
states = topo_rings(os.path.join(HERE, "states.json"), "states", lambda g: g["id"] != "06", to_ll)
countries = topo_rings(os.path.join(HERE, "countries.json"), "countries", lambda g: True, to_ll)

ca_cities = {"San Francisco": (-122.42, 37.77), "Los Angeles": (-118.24, 34.05), "Sacramento": (-121.49, 38.58),
             "Fresno": (-119.79, 36.74), "San Diego": (-117.16, 32.72), "Redding": (-122.39, 40.59)}
# Extra California places for search (lon, lat)
ca_search = {**ca_cities, "San Jose": (-121.89, 37.34), "Oakland": (-122.27, 37.80), "Santa Barbara": (-119.70, 34.42),
             "Bakersfield": (-119.02, 35.37), "Riverside": (-117.40, 33.95), "Santa Rosa": (-122.71, 38.44),
             "Paradise": (-121.62, 39.76), "Chico": (-121.84, 39.73), "Malibu": (-118.78, 34.03), "Lake Tahoe": (-120.04, 39.10),
             "Yosemite National Park": (-119.54, 37.87), "Big Sur": (-121.81, 36.27), "Napa": (-122.29, 38.30)}
world_cities = [("Seoul", "South Korea", 126.98, 37.57), ("Busan", "South Korea", 129.08, 35.18), ("Tokyo", "Japan", 139.69, 35.69),
    ("Beijing", "China", 116.40, 39.90), ("Shanghai", "China", 121.47, 31.23), ("Sydney", "Australia", 151.21, -33.87),
    ("Melbourne", "Australia", 144.96, -37.81), ("London", "United Kingdom", -0.13, 51.51), ("Paris", "France", 2.35, 48.86),
    ("Berlin", "Germany", 13.40, 52.52), ("Madrid", "Spain", -3.70, 40.42), ("Rome", "Italy", 12.50, 41.90),
    ("Athens", "Greece", 23.73, 37.98), ("Lisbon", "Portugal", -9.14, 38.72), ("Moscow", "Russia", 37.62, 55.76),
    ("Istanbul", "Turkey", 28.98, 41.01), ("Cairo", "Egypt", 31.24, 30.04), ("Nairobi", "Kenya", 36.82, -1.29),
    ("Cape Town", "South Africa", 18.42, -33.92), ("Mumbai", "India", 72.88, 19.08), ("Delhi", "India", 77.21, 28.61),
    ("Bangkok", "Thailand", 100.50, 13.76), ("Jakarta", "Indonesia", 106.85, -6.21), ("Singapore", "Singapore", 103.82, 1.35),
    ("Manila", "Philippines", 120.98, 14.60), ("Hanoi", "Vietnam", 105.85, 21.03), ("Toronto", "Canada", -79.38, 43.65),
    ("Vancouver", "Canada", -123.12, 49.28), ("Mexico City", "Mexico", -99.13, 19.43), ("São Paulo", "Brazil", -46.63, -23.55),
    ("Rio de Janeiro", "Brazil", -43.17, -22.91), ("Buenos Aires", "Argentina", -58.38, -34.60), ("Santiago", "Chile", -70.67, -33.45),
    ("Lima", "Peru", -77.04, -12.05), ("New York", "United States", -74.01, 40.71), ("Chicago", "United States", -87.63, 41.88),
    ("Seattle", "United States", -122.33, 47.61), ("Portland", "United States", -122.68, 45.52), ("Las Vegas", "United States", -115.14, 36.17),
    ("Phoenix", "United States", -112.07, 33.45), ("Denver", "United States", -104.99, 39.74), ("Houston", "United States", -95.37, 29.76),
    ("Miami", "United States", -80.19, 25.76), ("Honolulu", "United States", -157.86, 21.31), ("Anchorage", "United States", -149.90, 61.22),
    ("Dubai", "United Arab Emirates", 55.27, 25.20), ("Tehran", "Iran", 51.39, 35.69), ("Auckland", "New Zealand", 174.76, -36.85)]

geo = {"ca": ca["rings"], "counties": [{"name": c["name"], "rings": c["rings"]} for c in sorted(counties, key=lambda c: c["name"])],
       "cities": {k: to_grid([v])[0] for k, v in ca_cities.items()},
       "caPlaces": [{"name": k, "lon": v[0], "lat": v[1]} for k, v in ca_search.items()],
       "fwd": {"x": fx.tolist(), "y": fy.tolist()}, "inv": {"lon": ilon.tolist(), "lat": ilat.tolist()},
       "countries": [{"name": c["name"], "rings": c["rings"]} for c in sorted(countries, key=lambda c: c["name"])],
       "states": [{"name": c["name"], "rings": c["rings"]} for c in sorted(states, key=lambda c: c["name"])],
       "worldCities": [{"name": n, "country": c, "lon": lo, "lat": la} for n, c, lo, la in world_cities]}
with open(os.path.join(OUT, "geo.js"), "w", encoding="utf-8") as f:
    f.write("window.FRP_GEO=" + json.dumps(geo, separators=(",", ":"), ensure_ascii=False) + ";\n")
print("geo KB", os.path.getsize(os.path.join(OUT, "geo.js")) / 1e3)
print("done")
