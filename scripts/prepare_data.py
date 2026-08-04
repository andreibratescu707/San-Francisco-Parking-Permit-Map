#!/usr/bin/env python3
"""Filter citywide SFMTA parking regulation, street sweeping, and parking
meter data down to one neighborhood, for use in the local parking map site.

Run from the project root:
    python3 scripts/prepare_data.py
"""
import csv
import json
import math
import re
from pathlib import Path

from shapely.geometry import shape, mapping
from shapely.ops import substring
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parent.parent
REGULATIONS_IN = ROOT / "Parking regulations (except non-metered color curb).geojson"
SWEEPING_IN = ROOT / "Street_Sweeping_Schedule_20260803.csv"
METERS_IN = ROOT / "Parking_Meters_20260803.csv"
DATA_OUT = ROOT / "data"

# Neighborhood bounding box, roughly a 0.75 mile radius. Update to your own area —
# see README.md.
LAT_MIN, LAT_MAX = 37.760, 37.784
LON_MIN, LON_MAX = -122.459, -122.429


def in_bbox(lon, lat):
    return LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX


def geometry_in_bbox(geometry):
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "LineString":
        return any(in_bbox(lon, lat) for lon, lat in coords)
    if gtype == "MultiLineString":
        return any(
            in_bbox(lon, lat) for line in coords for lon, lat in line
        )
    if gtype == "Point":
        lon, lat = coords
        return in_bbox(lon, lat)
    return False


METERS_PER_DEG = 111320  # approx, at this latitude, close enough for short residential blocks


def split_by_meter_proximity(geom, meter_tree, meter_points, threshold_deg, sample_spacing_m=8):
    """Cut a block's line into runs of "near a meter" / "not near a meter", instead of
    one boolean for the whole block. A block is often only partially metered (one meter
    near a corner, the rest free), so classifying the whole line from a handful of sample
    points either misses a small cluster of meters or, worse, blanks out the entire block
    for a restriction that only covers a few meters of curb.

    Returns a list of (geometry_dict, near_meter_bool) covering the full original line.
    Handles MultiLineString input by splitting each part separately (some regulation
    segments come as multiple disconnected pieces, e.g. a driveway gap).
    """
    shape_geom = shape(geom)
    if shape_geom.geom_type == "MultiLineString":
        out = []
        for part in shape_geom.geoms:
            out.extend(_split_line_by_meter_proximity(part, meter_tree, meter_points, threshold_deg, sample_spacing_m))
        return out
    return _split_line_by_meter_proximity(shape_geom, meter_tree, meter_points, threshold_deg, sample_spacing_m)


def _split_line_by_meter_proximity(line, meter_tree, meter_points, threshold_deg, sample_spacing_m):
    length_m = line.length * METERS_PER_DEG
    n_samples = max(2, int(length_m / sample_spacing_m) + 1)
    fractions = [i / (n_samples - 1) for i in range(n_samples)]

    flags = []
    for t in fractions:
        pt = line.interpolate(t, normalized=True)
        nearby_idx = meter_tree.query(pt.buffer(threshold_deg))
        near = any(pt.distance(meter_points[i]) < threshold_deg for i in nearby_idx)
        flags.append(near)

    # Group consecutive same-classification samples into (start_frac, end_frac, flag) runs.
    runs = []
    run_start = 0
    for i in range(1, len(flags)):
        if flags[i] != flags[run_start]:
            runs.append((fractions[run_start], fractions[i - 1], flags[run_start]))
            run_start = i
    runs.append((fractions[run_start], fractions[-1], flags[run_start]))

    out = []
    for start_f, end_f, flag in runs:
        if start_f == end_f:
            continue
        sub = substring(line, start_f, end_f, normalized=True)
        if sub.is_empty or sub.length == 0:
            continue
        out.append((mapping(sub), flag))
    return out


def prepare_regulations(meter_tree, meter_points):
    with open(REGULATIONS_IN) as f:
        data = json.load(f)

    keep_props = {
        "rpparea1", "regulation", "days", "hours", "from_time", "to_time",
        "hrlimit", "exceptions", "analysis_neighborhood",
    }
    METER_NEARBY_DEG = 0.00013  # ~14m — tight, since sampling is now dense (every ~8m) rather than 3 points per block

    out_features = []
    for feat in data["features"]:
        geom = feat.get("geometry")
        if not geom or not geometry_in_bbox(geom):
            continue
        props = feat.get("properties", {})
        trimmed = {k: props.get(k) for k in keep_props}
        # Only relevant for the no-permit (blue) case — a permit-zone segment stays
        # orange regardless of whether it's also metered.
        if not trimmed.get("rpparea1"):
            for sub_geom, near_meter in split_by_meter_proximity(geom, meter_tree, meter_points, METER_NEARBY_DEG):
                out_features.append({
                    "type": "Feature",
                    "geometry": sub_geom,
                    "properties": {**trimmed, "nearMeter": near_meter},
                })
            continue
        out_features.append({
            "type": "Feature",
            "geometry": geom,
            "properties": trimmed,
        })

    out = {"type": "FeatureCollection", "features": out_features}
    out_path = DATA_OUT / "parking_regulations.geojson"
    with open(out_path, "w") as f:
        json.dump(out, f)

    print(f"regulations: {len(data['features'])} -> {len(out_features)} features -> {out_path}")
    return out_features


WKT_LINESTRING_RE = re.compile(r"LINESTRING\s*\(([^)]+)\)")


def parse_wkt_linestring(wkt):
    m = WKT_LINESTRING_RE.search(wkt)
    if not m:
        return None
    coords = []
    for pair in m.group(1).split(","):
        lon_str, lat_str = pair.strip().split()
        coords.append([float(lon_str), float(lat_str)])
    return {"type": "LineString", "coordinates": coords}


# The sweeping export gives both sides of a block the exact same centerline geometry —
# BlockSide is just a text field, not reflected in the coordinates — so two sides with
# different sweep days would otherwise draw directly on top of each other and one would
# hide the other. Nudge each side a few meters toward its named compass direction so
# both render as visibly separate lines, like a real curb-offset would look.
COMPASS_OFFSET = {
    "North": (0, 1), "South": (0, -1), "East": (1, 0), "West": (-1, 0),
    "NorthEast": (0.7071, 0.7071), "NorthWest": (-0.7071, 0.7071),
    "SouthEast": (0.7071, -0.7071), "SouthWest": (-0.7071, -0.7071),
}
SWEEPING_SIDE_OFFSET_M = 3.5


def offset_geometry(geom, block_side, lat_for_scale):
    dx, dy = COMPASS_OFFSET.get(block_side, (0, 0))
    if dx == 0 and dy == 0:
        return geom
    dlat = SWEEPING_SIDE_OFFSET_M * dy / METERS_PER_DEG
    dlon = SWEEPING_SIDE_OFFSET_M * dx / (METERS_PER_DEG * math.cos(math.radians(lat_for_scale)))
    return {
        "type": "LineString",
        "coordinates": [[lon + dlon, lat + dlat] for lon, lat in geom["coordinates"]],
    }


def prepare_sweeping():
    keep_cols = [
        "Corridor", "Limits", "BlockSide", "WeekDay", "FromHour", "ToHour",
        "Week1", "Week2", "Week3", "Week4", "Week5", "Holidays",
    ]

    total = 0
    out_features = []
    with open(SWEEPING_IN, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            total += 1
            geom = parse_wkt_linestring(row.get("Line", ""))
            if not geom or not geometry_in_bbox(geom):
                continue
            block_side = row.get("BlockSide", "")
            avg_lat = sum(pt[1] for pt in geom["coordinates"]) / len(geom["coordinates"])
            offset_geom = offset_geometry(geom, block_side, avg_lat)
            props = {k: row.get(k) for k in keep_cols}
            out_features.append({
                "type": "Feature",
                "geometry": offset_geom,
                "properties": props,
            })

    out = {"type": "FeatureCollection", "features": out_features}
    out_path = DATA_OUT / "street_sweeping.geojson"
    with open(out_path, "w") as f:
        json.dump(out, f)

    print(f"sweeping: {total} -> {len(out_features)} features -> {out_path}")


def prepare_street_network(regulation_features, meter_tree, meter_points):
    """The SFMTA regulations dataset only has a feature where a specific rule was
    posted/entered — it has no record at all for lots of ordinary blocks, so those
    streets would otherwise render as blank gaps. The street-sweeping export has much
    broader coverage (sweeping is posted almost everywhere), so we use its deduplicated
    line geometries as a "this street exists, but has no regulation on file" base layer
    that draws underneath the regulations layer.

    The sweeping data gives one centerline per block, while the regulations data gives
    a separate line per side of the street, offset a few meters from the centerline —
    so on a block that already has real regulation data, naively drawing both produces
    a blue centerline running alongside the orange/blue curb-side lines instead of one
    clean line. To avoid that, drop any street-network segment whose MIDPOINT falls
    within ~20m of an existing regulation feature — i.e. only keep segments SFMTA has
    literally no regulation record for.

    Midpoint (not the whole line) is what we test on purpose: a block's endpoints sit
    right at intersections, where a *perpendicular* cross street's regulation line can
    also pass within a few meters — testing the whole line against that would wrongly
    match the cross street and blank out a block that's actually uncovered. The midpoint
    sits mid-block, far from any corner, so it only lands near a regulation line that
    genuinely runs alongside this same block (a curb-offset line for this street).
    """
    reg_geoms = [shape(f["geometry"]) for f in regulation_features]
    tree = STRtree(reg_geoms)
    NEARBY_DEG = 0.00018  # ~20m at this latitude — wide enough for curb offset, narrow enough to stay mid-block

    seen = set()
    candidates = []
    total = 0
    with open(SWEEPING_IN, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            total += 1
            geom = parse_wkt_linestring(row.get("Line", ""))
            if not geom or not geometry_in_bbox(geom):
                continue
            key = tuple(tuple(round(c, 6) for c in pt) for pt in geom["coordinates"])
            if key in seen:
                continue
            seen.add(key)
            candidates.append((geom, row.get("Corridor"), row.get("Limits")))

    METER_NEARBY_DEG = 0.00013  # ~14m, same tight threshold as the regulations-layer meter check

    out_features = []
    skipped_regulated = 0
    metered_runs_dropped = 0
    for geom, corridor, limits in candidates:
        line = shape(geom)
        midpoint = line.interpolate(0.5, normalized=True)
        nearby_idx = tree.query(midpoint.buffer(NEARBY_DEG))
        has_regulation_nearby = any(midpoint.distance(reg_geoms[i]) < NEARBY_DEG for i in nearby_idx)
        if has_regulation_nearby:
            skipped_regulated += 1
            continue
        # No regulation on file. Split by meter proximity so only the actually-metered
        # stretch is dropped — the meter dots already say "this part isn't free" — while
        # the rest of the block still shows as a plain no-permit street.
        for sub_geom, near_meter in split_by_meter_proximity(geom, meter_tree, meter_points, METER_NEARBY_DEG):
            if near_meter:
                metered_runs_dropped += 1
                continue
            out_features.append({
                "type": "Feature",
                "geometry": sub_geom,
                "properties": {"corridor": corridor, "limits": limits},
            })

    out = {"type": "FeatureCollection", "features": out_features}
    out_path = DATA_OUT / "street_network.geojson"
    with open(out_path, "w") as f:
        json.dump(out, f)

    print(
        f"street network (dedup'd from sweeping): {total} rows -> {len(candidates)} unique segments, "
        f"{skipped_regulated} already covered by regulation data, {metered_runs_dropped} metered runs dropped -> "
        f"{len(out_features)} kept -> {out_path}"
    )


def prepare_meters():
    keep_cols = ["STREET_NAME", "STREET_NUM", "ON_OFFSTREET_TYPE", "CAP_COLOR", "PM_DISTRICT_ID"]

    total = 0
    out_features = []
    with open(METERS_IN, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            total += 1
            # "M" = active/metered. Other flags (U=unmetered space, T=temporarily
            # suspended, P/L=other statuses) aren't a live paid-meter restriction.
            if row.get("ACTIVE_METER_FLAG") != "M":
                continue
            try:
                lon = float(row["LONGITUDE"])
                lat = float(row["LATITUDE"])
            except (TypeError, ValueError):
                continue
            if not in_bbox(lon, lat):
                continue
            props = {k: row.get(k) for k in keep_cols}
            out_features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": props,
            })

    out = {"type": "FeatureCollection", "features": out_features}
    out_path = DATA_OUT / "parking_meters.geojson"
    with open(out_path, "w") as f:
        json.dump(out, f)

    print(f"meters: {total} -> {len(out_features)} features -> {out_path}")
    return out_features


if __name__ == "__main__":
    DATA_OUT.mkdir(exist_ok=True)
    meter_features = prepare_meters()
    meter_points = [shape(f["geometry"]) for f in meter_features]
    meter_tree = STRtree(meter_points)

    regulation_features = prepare_regulations(meter_tree, meter_points)
    prepare_sweeping()
    prepare_street_network(regulation_features, meter_tree, meter_points)
