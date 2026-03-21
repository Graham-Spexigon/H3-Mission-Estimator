import { useState } from "react";
import JSZip from "jszip";
import * as turf from "@turf/turf";
import { latLngToCell, cellToBoundary, gridDisk } from "h3-js";
import toGeoJSON from "@mapbox/togeojson";

const H3_RESOLUTION = 9;

export default function App() {
  const [polygonFeatures, setPolygonFeatures] = useState([]);
  const [hexes, setHexes] = useState([]);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError("");
    setFileName(file.name);

    try {
      const polygons = await parseFile(file);
      setPolygonFeatures(polygons);
      const results = computeHexes(polygons);
      setHexes(results);
    } catch (err) {
      console.error(err);
      setPolygonFeatures([]);
      setHexes([]);
      setError(err.message || "Could not process file.");
    }
  }

  function downloadKML() {
    if (!hexes.length) return;

    const kml = buildKML(hexes);
    const blob = new Blob([kml], {
      type: "application/vnd.google-earth.kml+xml",
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;

    const base = (fileName || "aoi").replace(/\.[^/.]+$/, "");
    const count = hexes.length;
    a.download = `${base}_H3_Res${H3_RESOLUTION}_${count}.kml`;

    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <style>{`
        @keyframes countPop {
          0% { transform: scale(0.92); opacity: 0.7; }
          70% { transform: scale(1.04); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
      <div
        style={{
          minHeight: "100vh",
          background:
            "radial-gradient(circle at top, #16213d 0%, #0b1020 45%, #060914 100%)",
          color: "#f8fafc",
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
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
              <h1
                style={{
                  margin: 0,
                  fontSize: 56,
                  lineHeight: 0.96,
                  letterSpacing: "-0.04em",
                }}
              >
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
                Upload an AOI and count all intersecting res 9 H3 cells for mission planning.
              </p>
            </div>

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
                    Upload your AOI
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
                    background: fileName
                      ? "rgba(59, 130, 246, 0.18)"
                      : "rgba(255,255,255,0.03)",
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
                  This tool is for estimation purposes only. It counts all intersecting H3 cells and does not account for restricted airspace, no-fly areas, or other unflyable zones.
                </div>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                gap: 18,
                alignItems: "stretch",
              }}
            >
              <div
                style={{
                  borderRadius: 24,
                  padding: 24,
                  background: "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)",
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
                  Mission count
                </div>
                <div
                  key={hexes.length}
                  style={{
                    fontSize: 56,
                    fontWeight: 800,
                    lineHeight: 1,
                    transform: "scale(1)",
                    animation: "countPop 280ms ease-out",
                  }}
                >
                  {hexes.length}
                </div>
                <div style={{ marginTop: 12, color: "rgba(255,255,255,0.8)", fontSize: 15 }}>
                  All intersecting res 9 cells for the uploaded AOI.
                </div>
              </div>

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
                  <div style={{ color: "#cbd5e1", fontSize: 15, lineHeight: 1.6 }}>
                    Download a KML containing all intersecting res 9 hexes so you can open them directly in Google Earth.
                  </div>
                </div>

                <button
                  onClick={downloadKML}
                  disabled={!hexes.length}
                  style={{
                    marginTop: 20,
                    padding: "14px 18px",
                    borderRadius: 16,
                    border: "none",
                    background: hexes.length
                      ? "linear-gradient(135deg, #f8fafc 0%, #cbd5e1 100%)"
                      : "rgba(148, 163, 184, 0.2)",
                    color: hexes.length ? "#0f172a" : "#64748b",
                    fontWeight: 700,
                    fontSize: 15,
                    cursor: hexes.length ? "pointer" : "not-allowed",
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
    const kmlFile = Object.keys(zip.files).find((f) =>
      f.toLowerCase().endsWith(".kml")
    );
    if (!kmlFile) {
      throw new Error("KMZ does not contain a KML file.");
    }
    const text = await zip.files[kmlFile].async("string");
    geojson = kmlToGeoJSON(text);
  } else {
    throw new Error("Unsupported file type.");
  }

  const polygons = extractPolygonFeatures(geojson);

  if (!polygons.length) {
    throw new Error("No polygon geometry found in uploaded file.");
  }

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
      (f) =>
        f?.geometry?.type === "Polygon" || f?.geometry?.type === "MultiPolygon"
    );
  }

  if (
    geojson.type === "Feature" &&
    (geojson.geometry?.type === "Polygon" ||
      geojson.geometry?.type === "MultiPolygon")
  ) {
    return [geojson];
  }

  if (geojson.type === "Polygon" || geojson.type === "MultiPolygon") {
    return [
      {
        type: "Feature",
        properties: {},
        geometry: geojson,
      },
    ];
  }

  return [];
}

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
      for (const cell of gridDisk(seed, 10)) {
        candidateCells.add(cell);
      }
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
      } catch (err) {
        inter = null;
      }

      if (inter) {
        intersects = true;
        break;
      }
    }

    if (intersects) {
      selected.push(cell);
    }
  }

  return selected;
}

function h3ToPolygonFeature(cell) {
  const boundary = cellToBoundary(cell, true);
  const coords = boundary.map(([lng, lat]) => [lng, lat]);
  coords.push(coords[0]);

  return turf.polygon([coords]);
}

function buildKML(hexes) {
  const placemarks = hexes
    .map((cell) => {
      const coordsArray = cellToBoundary(cell, true).map(([lng, lat]) => [
        lng,
        lat,
      ]);
      coordsArray.push(coordsArray[0]);

      const coords = coordsArray
        .map(([lng, lat]) => `${lng},${lat},0`)
        .join(" ");

      return `
        <Placemark>
          <name>${cell}</name>
          <Style>
            <LineStyle><width>1</width></LineStyle>
            <PolyStyle><fill>0</fill></PolyStyle>
          </Style>
          <Polygon>
            <outerBoundaryIs>
              <LinearRing>
                <coordinates>${coords}</coordinates>
              </LinearRing>
            </outerBoundaryIs>
          </Polygon>
        </Placemark>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    ${placemarks}
  </Document>
</kml>`;
}
