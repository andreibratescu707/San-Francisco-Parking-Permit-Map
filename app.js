// Home location comes from config.js (gitignored — see config.example.js) so it's
// never committed to the repo.
const HOME = (window.PARKING_MAP_CONFIG && window.PARKING_MAP_CONFIG.home) || {
  lat: 37.7749,
  lng: -122.4194,
  label: "Set your address in config.js",
  sublabel: "",
};

// Colorblind-safe palette (Okabe-Ito), anchored on blue = "fine" / orange = "caution"
// so the permit and restrictions layers read consistently even for red-green color blindness.
const PERMIT_COLORS = { noPermit: "#0072B2", permitZone: "#E69F00" };

// Street sweeping needs 7 distinguishable categories, so it uses the full Okabe-Ito set
// (still colorblind-safe, just not limited to two hues like the other layers).
const WEEKDAYS = [
  { abbr: "Sun", label: "Sunday", color: "#D55E00" },
  { abbr: "Mon", label: "Monday", color: "#0072B2" },
  { abbr: "Tues", label: "Tuesday", color: "#009E73" },
  { abbr: "Wed", label: "Wednesday", color: "#E69F00" },
  { abbr: "Thu", label: "Thursday", color: "#CC79A7" },
  { abbr: "Fri", label: "Friday", color: "#56B4E9" },
  { abbr: "Sat", label: "Saturday", color: "#4B4B52" },
  { abbr: "Holiday", label: "Holiday schedule", color: "#8A8A8A" },
];
const WEEKDAY_COLORS = Object.fromEntries(WEEKDAYS.map((d) => [d.abbr, d.color]));
const WEEKDAY_LABELS = Object.fromEntries(WEEKDAYS.map((d) => [d.abbr, d.label]));

const RESTRICTION_RULES = [
  { test: (r) => /no parking any ?time/i.test(r), label: "No parking any time" },
  { test: (r) => /government permit/i.test(r), label: "Government permit only" },
  { test: (r) => /pay or permit|paid \+ permit/i.test(r), label: "Pay / metered or paid+permit" },
  { test: (r) => /no overnight parking/i.test(r), label: "No overnight parking" },
  { test: (r) => /limited no parking/i.test(r), label: "Limited / no parking" },
  // "No oversized vehicles" (usually an overnight RV/camper ban, midnight-6am) is excluded on
  // purpose: it doesn't restrict a normal passenger car and is present on nearly every
  // residential street, so showing it just makes ordinary streets look "restricted".
];
const RESTRICTION_COLOR = "#E69F00"; // one color (orange = caution); the popup gives the specifics

function classifyRestriction(regulation) {
  if (!regulation) return null;
  return RESTRICTION_RULES.find((rule) => rule.test(regulation)) || null;
}

function fmtHour(h) {
  if (h === null || h === undefined || h === "") return "?";
  const n = parseInt(h, 10);
  const period = n >= 12 ? "pm" : "am";
  let hour12 = n % 12;
  if (hour12 === 0) hour12 = 12;
  return `${hour12}${period}`;
}

function weekPattern(props) {
  const weeks = [];
  ["Week1", "Week2", "Week3", "Week4", "Week5"].forEach((k, i) => {
    if (props[k] === "1") weeks.push(["1st", "2nd", "3rd", "4th", "5th"][i]);
  });
  if (weeks.length === 5 || weeks.length === 0) return "every week";
  return weeks.join(", ");
}

const map = L.map("map", {
  zoomControl: false,
  attributionControl: true,
}).setView([HOME.lat, HOME.lng], 16);

L.control.zoom({ position: "bottomright" }).addTo(map);

L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 20,
  }
).addTo(map);

const homeIcon = L.divIcon({
  className: "",
  html: '<div class="home-marker"><div class="pulse"></div><div class="dot"></div></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

L.marker([HOME.lat, HOME.lng], { icon: homeIcon })
  .addTo(map)
  .bindPopup(`<span class="popup-title">🏠 ${HOME.label || "Home"}</span><span class="popup-row">${HOME.sublabel || ""}</span>`);

let permitLayer, restrictionsLayer, sweepingLayer, meterLayer, streetNetworkLayer;
const restrictionsMarkers = L.layerGroup();
const hourLimitBadges = L.layerGroup();
const HOUR_BADGE_MIN_ZOOM = 17;

function syncHourBadgeVisibility() {
  const shouldShow = map.getZoom() >= HOUR_BADGE_MIN_ZOOM && document.getElementById("toggle-permit").checked;
  const isShown = map.hasLayer(hourLimitBadges);
  if (shouldShow && !isShown) hourLimitBadges.addTo(map);
  if (!shouldShow && isShown) map.removeLayer(hourLimitBadges);
}
map.on("zoomend", syncHourBadgeVisibility);

// Base layer: every street we have geometry for, drawn underneath everything else,
// styled identically to a confirmed no-permit street. SFMTA has no regulation on file
// for these blocks (usually just means nobody bothered posting a rule), and for
// day-to-day purposes that's the same as a confirmed no-permit street, so it's not
// worth visually distinguishing the two.
fetch("data/street_network.geojson")
  .then((r) => r.json())
  .then((geojson) => {
    streetNetworkLayer = L.geoJSON(geojson, {
      style: () => ({
        color: PERMIT_COLORS.noPermit,
        weight: 5,
        opacity: 0.85,
      }),
      onEachFeature: (feature, layer) => {
        const p = feature.properties;
        const html = `
          <span class="popup-title">🔵 No permit required</span>
          <div class="popup-row">${p.corridor || ""} ${p.limits ? "(" + p.limits + ")" : ""}</div>
          <div class="popup-row">No SFMTA regulation on file for this block — no permit, no time limit.</div>
        `;
        layer.bindPopup(html);
      },
    }).addTo(map);
    // Always push behind whatever else has loaded so far — the regulations/sweeping/meter
    // fetches run in parallel and may resolve before or after this one.
    streetNetworkLayer.bringToBack();
  })
  .catch((err) => console.error("Failed to load street_network.geojson", err));

fetch("data/parking_regulations.geojson")
  .then((r) => r.json())
  .then((geojson) => {
    permitLayer = L.geoJSON(geojson, {
      // A metered no-permit block is already represented by the meter dots — showing
      // it as a plain blue "free parking" line on top of that is redundant/misleading,
      // so skip drawing blue there and let the meters speak for themselves.
      filter: (feature) => feature.properties.rpparea1 || !feature.properties.nearMeter,
      style: (feature) => {
        const hasPermit = !!feature.properties.rpparea1;
        return {
          // Same weight as the no-permit base layer underneath, so a permit-zone
          // segment fully covers it instead of leaving a blue halo on the edges.
          color: hasPermit ? PERMIT_COLORS.permitZone : PERMIT_COLORS.noPermit,
          weight: 5,
          opacity: 0.85,
        };
      },
      onEachFeature: (feature, layer) => {
        const p = feature.properties;
        const zone = p.rpparea1 ? `Permit zone ${p.rpparea1}` : "No permit required";
        const regulation = (p.regulation || "").trim();
        const isOversizedOnly = /oversized vehicles/i.test(regulation);

        let ruleHtml;
        if (!p.rpparea1 && isOversizedOnly) {
          // The only rule on record is the citywide overnight ban on RVs/campers,
          // which explicitly exempts regular cars — don't show it as a restriction.
          ruleHtml = `<div class="popup-row">No time limit, no restrictions for a normal car (just no RVs/campers overnight).</div>`;
        } else {
          ruleHtml = `
            <div class="popup-row"><b>Rule:</b> ${regulation || "—"}</div>
            <div class="popup-row"><b>Hours:</b> ${p.hours || "—"} (${p.days || "—"})</div>
            <div class="popup-row"><b>Limit:</b> ${p.hrlimit ? p.hrlimit + " hr" : "—"}</div>
            <div class="popup-row"><b>Exceptions:</b> ${p.exceptions || "—"}</div>
          `;
        }

        const html = `
          <span class="popup-title">${p.rpparea1 ? "🟠" : "🔵"} ${zone}</span>
          ${ruleHtml}
        `;
        layer.bindPopup(html);

        // "2 HRS"-style badge (like SFMTA's own street-parking signage/app) at the
        // segment midpoint — only for real posted time limits, not the oversized-vehicle
        // default. Zoom-gated (see syncHourBadgeVisibility) so it doesn't clutter zoomed-out views.
        const hrs = parseInt(p.hrlimit, 10);
        if (hrs > 0 && !isOversizedOnly) {
          const latlngs = layer.getLatLngs();
          const flat = Array.isArray(latlngs[0]) ? latlngs.flat() : latlngs;
          if (flat.length) {
            const mid = flat[Math.floor(flat.length / 2)];
            const badgeIcon = L.divIcon({
              className: "",
              html: `<div class="hour-badge">${hrs} HR${hrs === 1 ? "" : "S"}</div>`,
              iconSize: null,
            });
            L.marker(mid, { icon: badgeIcon, interactive: true })
              .bindPopup(html)
              .addTo(hourLimitBadges);
          }
        }
      },
    }).addTo(map);
    syncHourBadgeVisibility();

    // Restriction segments (meters, no-parking-any-time, gov-permit, etc.) are genuinely
    // rare in this residential area — a handful citywide-style spots, not on every block —
    // so they're styled bold and with a marker at each spot to make them easy to spot
    // once you pan to one, rather than blending into the regular street grid.
    restrictionsLayer = L.geoJSON(geojson, {
      filter: (feature) => classifyRestriction(feature.properties.regulation) !== null,
      style: () => ({ color: RESTRICTION_COLOR, weight: 6, opacity: 1 }),
      pointToLayer: (feature, latlng) =>
        L.circleMarker(latlng, { radius: 7, color: RESTRICTION_COLOR, fillColor: RESTRICTION_COLOR, fillOpacity: 1 }),
      onEachFeature: (feature, layer) => {
        const p = feature.properties;
        const rule = classifyRestriction(p.regulation);
        const html = `
          <span class="popup-title">🚧 ${rule.label}</span>
          <div class="popup-row"><b>Days:</b> ${p.days || "—"}</div>
          <div class="popup-row"><b>Hours:</b> ${p.hours || "—"}</div>
          <div class="popup-row"><b>Exceptions:</b> ${p.exceptions || "—"}</div>
        `;
        layer.bindPopup(html);

        // Also drop a small marker at the midpoint of the line so the restriction is
        // visible (as a dot) even when zoomed out past the point where the thin line reads.
        const latlngs = layer.getLatLngs();
        const flat = Array.isArray(latlngs[0]) ? latlngs.flat() : latlngs;
        if (flat.length) {
          const mid = flat[Math.floor(flat.length / 2)];
          L.circleMarker(mid, {
            radius: 6,
            color: RESTRICTION_COLOR,
            fillColor: RESTRICTION_COLOR,
            fillOpacity: 1,
            weight: 2,
          })
            .bindPopup(html)
            .addTo(restrictionsMarkers);
        }
      },
    }).addTo(map);
    restrictionsMarkers.addTo(map);
    restrictionsLayer.bringToFront();
  })
  .catch((err) => console.error("Failed to load parking_regulations.geojson", err));

fetch("data/parking_meters.geojson")
  .then((r) => r.json())
  .then((geojson) => {
    meterLayer = L.geoJSON(geojson, {
      pointToLayer: (feature, latlng) =>
        L.circleMarker(latlng, {
          radius: 3.5,
          color: "#ffffff",
          weight: 1,
          fillColor: RESTRICTION_COLOR,
          fillOpacity: 0.95,
        }),
      onEachFeature: (feature, layer) => {
        const p = feature.properties;
        const address = [p.STREET_NUM, p.STREET_NAME].filter(Boolean).join(" ");
        const html = `
          <span class="popup-title">🅿️💲 Metered parking</span>
          <div class="popup-row">${address || "—"}</div>
          <div class="popup-row"><b>Type:</b> ${p.ON_OFFSTREET_TYPE === "ON" ? "On-street" : p.ON_OFFSTREET_TYPE || "—"}</div>
        `;
        layer.bindPopup(html);
      },
    }).addTo(map);
  })
  .catch((err) => console.error("Failed to load parking_meters.geojson", err));

fetch("data/street_sweeping.geojson")
  .then((r) => r.json())
  .then((geojson) => {
    sweepingLayer = L.geoJSON(geojson, {
      style: (feature) => ({
        color: WEEKDAY_COLORS[feature.properties.WeekDay] || "#94a3b8",
        weight: 4,
        opacity: 0.85,
        dashArray: "1 8",
        lineCap: "round",
      }),
      onEachFeature: (feature, layer) => {
        const p = feature.properties;
        const dayLabel = WEEKDAY_LABELS[p.WeekDay] || p.WeekDay || "—";
        const html = `
          <span class="popup-title">🧹 ${p.Corridor || ""}</span>
          <div class="popup-row">${p.Limits || ""}</div>
          <div class="popup-row"><b>${dayLabel}</b> ${fmtHour(p.FromHour)}–${fmtHour(p.ToHour)}, ${weekPattern(p)}</div>
        `;
        layer.bindPopup(html);
      },
    }).addTo(map);

    buildSweepingLegend();
  })
  .catch((err) => console.error("Failed to load street_sweeping.geojson", err));

function buildSweepingLegend() {
  const list = document.getElementById("sweeping-swatches");
  list.innerHTML = "";
  WEEKDAYS.forEach(({ label, color }) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="swatch" style="background:${color}"></span> ${label}`;
    list.appendChild(li);
  });
}

function wireToggle(checkboxId, ...getLayers) {
  document.getElementById(checkboxId).addEventListener("change", (e) => {
    getLayers.forEach((getLayer) => {
      const layer = getLayer();
      if (!layer) return;
      if (e.target.checked) {
        map.addLayer(layer);
      } else {
        map.removeLayer(layer);
      }
    });
  });
}

wireToggle("toggle-permit", () => permitLayer, () => streetNetworkLayer);
document.getElementById("toggle-permit").addEventListener("change", syncHourBadgeVisibility);
wireToggle("toggle-restrictions", () => restrictionsLayer, () => restrictionsMarkers, () => meterLayer);
wireToggle("toggle-sweeping", () => sweepingLayer);

const legendToggle = document.getElementById("legend-toggle");
const legendSheet = document.getElementById("legend-sheet");
const legendClose = document.getElementById("legend-close");

function setLegendOpen(open) {
  legendSheet.classList.toggle("open", open);
  legendToggle.setAttribute("aria-expanded", String(open));
}

legendToggle.addEventListener("click", () => {
  setLegendOpen(!legendSheet.classList.contains("open"));
});
legendClose.addEventListener("click", () => setLegendOpen(false));

// Desktop: default to open (there's room), since the panel now starts collapsed
// everywhere by default. Mobile stays collapsed until the icon is tapped.
function syncLegendForViewport() {
  if (window.innerWidth >= 720) {
    setLegendOpen(true);
  }
}
syncLegendForViewport();
window.addEventListener("resize", syncLegendForViewport);
