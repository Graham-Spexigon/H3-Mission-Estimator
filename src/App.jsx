import { useState, useRef } from "react";
import JSZip from "jszip";
import * as turf from "@turf/turf";
import { latLngToCell, cellToBoundary, gridDisk } from "h3-js";
import toGeoJSON from "@mapbox/togeojson";

const H3_RESOLUTION = 9;

// Overall status derived from counts
function getStatus(counts) {
  if (!counts) return null;
  if (counts.prohibited > 0) return "restricted";
  if (counts.limited > 0) return "limited";
  return "flyable";
}

const STATUS_CONFIG = {
  flyable: {
    label: "Fully Flyable",
    sublabel: "AOI has no restricted or limited zones.",
    color: "#22c55e",
    bg: "rgba(34, 197, 94, 0.12)",
    border: "rgba(34, 197, 94, 0.35)",
  },
  limited: {
    label: "Limitations Apply",
    sublabel: "Speak with ops before confirming with the customer.",
    color: "#f59e0b",
    bg: "rgba(245, 158, 11, 0.12)",
    border: "rgba(245, 158, 11, 0.35)",
  },
  restricted: {
    label: "Contains Restricted Zones",
    sublabel: "Escalate to ops before confirming with the customer.",
    color: "#ef4444",
    bg: "rgba(239, 68, 68, 0.12)",
    border: "rgba(239, 68, 68, 0.35)",
  },
};

export default function App() {
  const [polygonFeatures, setPolygonFeatures] = useState([]);
  const [hexes, setHexes] = useState(null); // {flyable, limited, prohibited} arrays
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const lookupRef = useRef(null); // { prohibited: Set, limited: Set }

  async function loadLookup() {
    if (lookupRef.current) return lookupRef.current;
    setLookupLoading(true);
    try {
      const res = await fetch("/flyability-lookup.json");
      if (!res.ok) throw new Error("Could not load flyability data.");
      const data = await res.json();
      lookupRef.current = {
        prohibited: new Set(data.p),
        limited: new Set(data.l),
      };
      return lookupRef.current;
    } finally {
      setLookupLoading(false);
    }
  }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    setFileName(file.name);
    setHexes(null);

    try {
      const [polygons, lookup] = await Promise.all([
        parseFile(file),
        loadLookup(),
      ]);
      setPolygonFeatures(polygons);
      const allCells = computeHexes(polygons);
      const categorized = { flyable: [], limited: [], prohibited: [] };
      for (const cell of allCells) {
        if (lookup.prohibited.has(cell)) categorized.prohibited.push(cell);
        else if (lookup.limited.has(cell)) categorized.limited.push(cell);
        else categorized.flyable.push(cell);
      }
      setHexes(categorized);
    } catch (err) {
      console.error(err);
      setPolygonFeatures([]);
      setHexes(null);
      setError(err.message || "Could not process file.");
    }
  }

  function downloadKML() {
    if (!hexes) return;
    const allCells = [
      ...hexes.flyable.map((c) => ({ cell: c, type: "flyable" })),
      ...hexes.limited.map((c) => ({ cell: c, type: "limited" })),
      ...hexes.prohibited.map((c) => ({ cell: c, type: "prohibited" })),
    ];
    if (!allCells.length) return;

    const kml = buildKML(allCells);
    const blob = new Blob([kml], { type: "application/vnd.google-earth.kml+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const base = (fileName || "aoi").replace(/\.[^/.]+$/, "");
    const total = allCells.length;
    a.download = `${base}_H3_Res${H3_RESOLUTION}_${total}.kml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const totalCells = hexes
    ? hexes.flyable.length + hexes.limited.length + hexes.prohibited.length
    : 0;
  const status = hexes ? getStatus(hexes) : null;
  const statusCfg = status ? STATUS_CONFIG[status] : null;

  return (
    <>
      <style>{`
        @keyframes countPop {
          0% { transform: scale(0.92); opacity: 0.7; }
          70% { transform: scale(1.04); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div
        style={{
          minHeight: "100vh",
          background: "radial-gradient(circle at top, #16213d 0%, #0b1020 45%, #060914 100%)",
          color: "#f8fafc",
          fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          padding: "40px 20px",
        }}
      >
        <div style={{ maxWidth: 880, margin: "0 auto" }}>
          <div
            style={{
              background: "rgba(15, 23, 42, 0.78)",
              border: "1px solid rgba(148, 163, 184, 0.18)",
              borderRadius: 28,
              padding: 32,
              boxShadow: "0 24px 80px rgba(0,0,0,0.35)",
              backdropFilter: "blur(12px)",
            }}
          >
            {/* Header */}
            <div style={{ marginBottom: 40, textAlign: "center", paddingTop: 8, paddingBottom: 10 }}>
              <div
                style={{
                  display: "inline-block",
                  padding: "8px 14px",
                  borderRadius: 999,
                  background: "rgba(59, 130, 246, 0.14)",
                  color: "#93c5fd",
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  marginBottom: 18,
                }}
              >
                Internal Tool
              </div>
              <h1 style={{ margin: 0, fontSize: 56, lineHeight: 0.96, letterSpacing: "-0.04em" }}>
                Mission Count Estimator
              </h1>
              <p
                style={{
                  marginTop: 18,
                  marginBottom: 0,
                  color: "#cbd5e1",
                  fontSize: 18,
                  lineHeight: 1.6,
                  maxWidth: 700,
                  marginLeft: "auto",
                  marginRight: "auto",
                }}
              >
                Upload an AOI to count intersecting res 9 H3 cells and check flyability.
              </p>
            </div>

            {/* Upload row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                gap: 18,
                marginBottom: 20,
              }}
            >
              <div
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(148, 163, 184, 0.16)",
                  borderRadius: 22,
                  padding: 20,
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: "#94a3b8",
                    marginBottom: 14,
                    fontWeight: 700,
                  }}
                >
                  Upload your AOI
                </div>
                <label
                  style={{
                    display: "block",
                    border: "1px dashed rgba(148, 163, 184, 0.36)",
                    borderRadius: 18,
                    padding: 22,
                    background: "rgba(15, 23, 42, 0.55)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="file"
                    accept=".kml,.kmz,.json,.geojson"
                    onChange={handleFile}
                    style={{ display: "none" }}
                  />
                  <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>
                    {lookupLoading ? "Loading flyability data…" : "Upload your AOI"}
                  </div>
                  <div style={{ fontSize: 14, color: "#94a3b8", lineHeight: 1.5 }}>
                    Accepts .kml, .kmz, .json, and .geojson files.
                  </div>
                </label>
                <div
                  style={{
                    marginTop: 14,
                    fontSize: 14,
                    color: fileName ? "#f8fafc" : "#94a3b8",
                    wordBreak: "break-word",
                    background: fileName ? "rgba(59, 130, 246, 0.18)" : "rgba(255,255,255,0.03)",
                    border: fileName
                      ? "1px solid rgba(96, 165, 250, 0.35)"
                      : "1px solid rgba(148, 163, 184, 0.12)",
                    borderRadius: 14,
                    padding: "12px 14px",
                  }}
                >
                  {fileName || "No file uploaded yet"}
                </div>
              </div>

              {/* Status banner — shows after upload, otherwise shows warning */}
              {statusCfg ? (
                <div
                  key={status}
                  style={{
                    background: statusCfg.bg,
                    border: `1px solid ${statusCfg.border}`,
                    borderRadius: 22,
                    padding: 20,
                    animation: "fadeIn 300ms ease-out",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                  }}
                >
                  <div
                    style={{
                      fontSize: 13,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      color: statusCfg.color,
                      marginBottom: 10,
                      fontWeight: 700,
                    }}
                  >
                    Flyability Status
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: statusCfg.color, marginBottom: 8 }}>
                    {statusCfg.label}
                  </div>
                  <div style={{ color: "#cbd5e1", fontSize: 15, lineHeight: 1.6 }}>
                    {statusCfg.sublabel}
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    background: "rgba(245, 158, 11, 0.10)",
                    border: "1px solid rgba(245, 158, 11, 0.28)",
                    borderRadius: 22,
                    padding: 20,
                  }}
                >
                  <div
                    style={{
                      fontSize: 13,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      color: "#fbbf24",
                      marginBottom: 14,
                      fontWeight: 700,
                    }}
                  >
                    Estimation warning
                  </div>
                  <div style={{ color: "#fde68a", fontSize: 15, lineHeight: 1.7 }}>
                    Results are estimates based on H3 cell intersections. Always confirm with ops before committing to a customer.
                  </div>
                </div>
              )}
            </div>

            {/* Results row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 18,
                alignItems: "stretch",
              }}
            >
              {/* Flyable */}
              <StatCard
                label="Flyable"
                count={hexes?.flyable.length ?? null}
                color="#22c55e"
                bg="linear-gradient(135deg, #15803d 0%, #166534 100%)"
              />

              {/* Limited */}
              <StatCard
                label="Limited"
                count={hexes?.limited.length ?? null}
                color="#fbbf24"
                bg="linear-gradient(135deg, #b45309 0%, #92400e 100%)"
              />

              {/* Prohibited */}
              <StatCard
                label="Prohibited"
                count={hexes?.prohibited.length ?? null}
                color="#f87171"
                bg="linear-gradient(135deg, #b91c1c 0%, #991b1b 100%)"
              />

              {/* Export */}
              <div
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(148, 163, 184, 0.16)",
                  borderRadius: 24,
                  padding: 24,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: 13,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      color: "#94a3b8",
                      marginBottom: 12,
                      fontWeight: 700,
                    }}
                  >
                    Export
                  </div>
                  <div style={{ color: "#cbd5e1", fontSize: 14, lineHeight: 1.6 }}>
                    KML with cells color-coded by flyability. Open in Google Earth.
                  </div>
                  {hexes && (
                    <div style={{ marginTop: 10, fontSize: 13, color: "#64748b" }}>
                      {totalCells.toLocaleString()} total cells
                    </div>
                  )}
                </div>
                <button
                  onClick={downloadKML}
                  disabled={!hexes}
                  style={{
                    marginTop: 20,
                    padding: "14px 18px",
                    borderRadius: 16,
                    border: "none",
                    background: hexes
                      ? "linear-gradient(135deg, #f8fafc 0%, #cbd5e1 100%)"
                      : "rgba(148, 163, 184, 0.2)",
                    color: hexes ? "#0f172a" : "#64748b",
                    fontWeight: 700,
                    fontSize: 15,
                    cursor: hexes ? "pointer" : "not-allowed",
                  }}
                >
                  Download KML
                </button>
              </div>
            </div>

            {error && (
              <div
                style={{
                  marginTop: 20,
                  padding: 16,
                  borderRadius: 16,
                  background: "rgba(127, 29, 29, 0.28)",
                  border: "1px solid rgba(248, 113, 113, 0.26)",
                  color: "#fecaca",
                }}
              >
                <strong>Error:</strong> {error}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function StatCard({ label, count, color, bg }) {
  return (
    <div
      style={{
        borderRadius: 24,
        padding: 24,
        background: bg,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12)",
      }}
    >
      <div
        style={{
          fontSize: 13,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "rgba(255,255,255,0.75)",
          fontWeight: 700,
          marginBottom: 12,
        }}
      >
        {label}
      </div>
      <div
        key={count}
        style={{
          fontSize: 48,
          fontWeight: 800,
          lineHeight: 1,
          color: "#fff",
          animation: count !== null ? "countPop 280ms ease-out" : "none",
        }}
      >
        {count !== null ? count.toLocaleString() : "—"}
      </div>
      <div style={{ marginTop: 10, color: "rgba(255,255,255,0.65)", fontSize: 13 }}>
        res 9 cells
      </div>
    </div>
  );
}

// ── File parsing (unchanged) ────────────────────────────────────────────────

async function parseFile(file) {
  const name = file.name.toLowerCase();
  let geojson;
  if (name.endsWith(".json") || name.endsWith(".geojson")) {
    geojson = JSON.parse(await file.text());
  } else if (name.endsWith(".kml")) {
    const text = await file.text();
    geojson = kmlToGeoJSON(text);
  } else if (name.endsWith(".kmz")) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const kmlFile = Object.keys(zip.files).find((f) => f.toLowerCase().endsWith(".kml"));
    if (!kmlFile) throw new Error("KMZ does not contain a KML file.");
    const text = await zip.files[kmlFile].async("string");
    geojson = kmlToGeoJSON(text);
  } else {
    throw new Error("Unsupported file type.");
  }
  const polygons = extractPolygonFeatures(geojson);
  if (!polygons.length) throw new Error("No polygon geometry found in uploaded file.");
  return polygons;
}

function kmlToGeoJSON(text) {
  const xml = new window.DOMParser().parseFromString(text, "text/xml");
  return toGeoJSON.kml(xml.documentElement);
}

function extractPolygonFeatures(geojson) {
  if (!geojson) return [];
  if (geojson.type === "FeatureCollection") {
    return geojson.features.filter(
      (f) => f?.geometry?.type === "Polygon" || f?.geometry?.type === "MultiPolygon"
    );
  }
  if (
    geojson.type === "Feature" &&
    (geojson.geometry?.type === "Polygon" || geojson.geometry?.type === "MultiPolygon")
  ) {
    return [geojson];
  }
  if (geojson.type === "Polygon" || geojson.type === "MultiPolygon") {
    return [{ type: "Feature", properties: {}, geometry: geojson }];
  }
  return [];
}

// ── H3 computation (unchanged) ──────────────────────────────────────────────

function computeHexes(polygons) {
  const fc = turf.featureCollection(polygons);
  const bbox = turf.bbox(fc);
  const [minX, minY, maxX, maxY] = bbox;
  const stepX = (maxX - minX) / 4;
  const stepY = (maxY - minY) / 4;
  const seedPoints = [];
  for (let ix = 0; ix <= 4; ix++) {
    for (let iy = 0; iy <= 4; iy++) {
      seedPoints.push([minY + stepY * iy, minX + stepX * ix]);
    }
  }
  for (const poly of polygons) {
    const pt = turf.pointOnFeature(poly);
    seedPoints.push([pt.geometry.coordinates[1], pt.geometry.coordinates[0]]);
  }
  const candidateCells = new Set();
  for (const [lat, lng] of seedPoints) {
    try {
      const seed = latLngToCell(lat, lng, H3_RESOLUTION);
      for (const cell of gridDisk(seed, 10)) candidateCells.add(cell);
    } catch (err) {
      console.error("Seed point failed", err);
    }
  }
  const selected = [];
  for (const cell of Array.from(candidateCells).sort()) {
    const hexFeature = h3ToPolygonFeature(cell);
    let intersects = false;
    for (const poly of polygons) {
      let inter = null;
      try {
        inter = turf.intersect(turf.featureCollection([hexFeature, poly]));
      } catch {
        inter = null;
      }
      if (inter) { intersects = true; break; }
    }
    if (intersects) selected.push(cell);
  }
  return selected;
}

function h3ToPolygonFeature(cell) {
  const boundary = cellToBoundary(cell, true);
  const coords = boundary.map(([lng, lat]) => [lng, lat]);
  coords.push(coords[0]);
  return turf.polygon([coords]);
}

// ── KML export (color-coded) ────────────────────────────────────────────────

// KML colors: aabbggrr
const KML_COLORS = {
  flyable:    { line: "ff00cc44", poly: "4400cc44" }, // green
  limited:    { line: "ff00aaff", poly: "4400aaff" }, // amber
  prohibited: { line: "ff0000ff", poly: "440000ff" }, // red
};

function buildKML(cells) {
  const styles = Object.entries(KML_COLORS)
    .map(([type, { line, poly }]) => `
    <Style id="${type}">
      <LineStyle><color>${line}</color><width>1.5</width></LineStyle>
      <PolyStyle><color>${poly}</color></PolyStyle>
    </Style>`)
    .join("");

  const placemarks = cells
    .map(({ cell, type }) => {
      const coordsArray = cellToBoundary(cell, true).map(([lng, lat]) => [lng, lat]);
      coordsArray.push(coordsArray[0]);
      const coords = coordsArray.map(([lng, lat]) => `${lng},${lat},0`).join(" ");
      return `
    <Placemark>
      <name>${cell}</name>
      <styleUrl>#${type}</styleUrl>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing><coordinates>${coords}</coordinates></LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    ${styles}
    ${placemarks}
  </Document>
</kml>`;
}
