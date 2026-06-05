import { useState, useRef } from "react";
import JSZip from "jszip";
import { latLngToCell, cellToBoundary, polygonToCells } from "h3-js";
import toGeoJSON from "@mapbox/togeojson";

const H3_RESOLUTION = 9;

// ── Pricing ──────────────────────────────────────────────────────────────────

function priceForFlyableCount(count) {
  const n = Math.max(0, Number(count) || 0);
  if (n === 0) return 0;
  if (n === 1) return 120;
  if (n === 2) return 150;
  if (n === 3) return 165;
  if (n === 4) return 175;
  return n * 35;
}

// ── Status ───────────────────────────────────────────────────────────────────

function getStatus(aggregate) {
  if (!aggregate) return null;
  if (aggregate.prohibited.length > 0) return "restricted";
  if (aggregate.limited.length > 0) return "limited";
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
  // hexes: [{name, flyable[], limited:[{id,desc}], prohibited:[{id,desc}]}]
  const [hexes, setHexes] = useState(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [expandedRows, setExpandedRows] = useState(new Set());
  const lookupRef = useRef(null);

  function toggleRow(i) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  async function loadLookup() {
    if (lookupRef.current) return lookupRef.current;
    setLookupLoading(true);
    try {
      const res = await fetch("/flyability-lookup.json");
      if (!res.ok) throw new Error("Could not load flyability data.");
      const data = await res.json();
      // Build description map: cellId -> human-readable label
      const desc = new Map();
      if (data.dl && data.pd) {
        data.p.forEach((id, i) => { if (data.pd[i] >= 0) desc.set(id, data.dl[data.pd[i]]); });
      }
      if (data.dl && data.ld) {
        data.l.forEach((id, i) => { if (data.ld[i] >= 0) desc.set(id, data.dl[data.ld[i]]); });
      }
      lookupRef.current = {
        prohibited: new Set(data.p),
        limited: new Set(data.l),
        desc,
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

      // Compute H3 cells per polygon, then classify each
      const perPolygon = computeHexes(polygons);
      const categorized = perPolygon.map(({ name, cells }) => {
        const flyable = [];
        const limited = [];    // [{id, desc}]
        const prohibited = []; // [{id, desc}]
        for (const cell of cells) {
          if (lookup.prohibited.has(cell))
            prohibited.push({ id: cell, desc: lookup.desc.get(cell) || "Restricted" });
          else if (lookup.limited.has(cell))
            limited.push({ id: cell, desc: lookup.desc.get(cell) || "Limited" });
          else
            flyable.push(cell);
        }
        return { name, flyable, limited, prohibited };
      });
      setHexes(categorized);
    } catch (err) {
      console.error(err);
      setPolygonFeatures([]);
      setHexes(null);
      setError(err.message || "Could not process file.");
    }
  }

  // Aggregate all polygons for stat cards, status banner, and KML export
  const aggregate = hexes
    ? {
        flyable:    hexes.flatMap((p) => p.flyable),
        limited:    hexes.flatMap((p) => p.limited),
        prohibited: hexes.flatMap((p) => p.prohibited),
        // counts
        flyableCount:    hexes.reduce((s, p) => s + p.flyable.length, 0),
        limitedCount:    hexes.reduce((s, p) => s + p.limited.length, 0),
        prohibitedCount: hexes.reduce((s, p) => s + p.prohibited.length, 0),
      }
    : null;

  const totalCells = aggregate
    ? aggregate.flyableCount + aggregate.limitedCount + aggregate.prohibitedCount
    : 0;
  const status = aggregate ? getStatus(aggregate) : null;
  const statusCfg = status ? STATUS_CONFIG[status] : null;

  // Credit rows — one per polygon
  const creditRows = hexes
    ? hexes.map((p) => ({
        name:            p.name,
        flyable:         p.flyable.length,
        limited:         p.limited.length,
        prohibited:      p.prohibited.length,
        limitedZones:    p.limited,    // [{id, desc}]
        prohibitedZones: p.prohibited, // [{id, desc}]
        hasRestrictions: p.limited.length > 0 || p.prohibited.length > 0,
        price:           priceForFlyableCount(p.flyable.length),
      }))
    : [];
  const totalCredits = creditRows.reduce((sum, r) => sum + r.price, 0);
  const anyRestrictions = creditRows.some((r) => r.hasRestrictions);

  function downloadKML() {
    if (!hexes) return;
    const allCells = hexes.flatMap((p) => [
      ...p.flyable.map((c)    => ({ cell: c,    type: "flyable" })),
      ...p.limited.map((z)    => ({ cell: z.id, type: "limited" })),
      ...p.prohibited.map((z) => ({ cell: z.id, type: "prohibited" })),
    ]);
    if (!allCells.length) return;

    const kml = buildKML(allCells);
    const blob = new Blob([kml], { type: "application/vnd.google-earth.kml+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const base = (fileName || "aoi").replace(/\.[^/.]+$/, "");
    a.download = `${base}_H3_Res${H3_RESOLUTION}_${totalCells}.kml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        @keyframes countPop {
          0% { transform: scale(0.92); opacity: 0.7; }
          70% { transform: scale(1.04); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .upload-btn:hover { background: #e2e8f0 !important; }
        .upload-btn:active { background: #cbd5e1 !important; }
        .kml-btn:hover:not(:disabled) { background: #e2e8f0 !important; }
      `}</style>
      <div
        style={{
          minHeight: "100vh",
          background: "radial-gradient(ellipse at top, #1a1040 0%, #0d0a1e 50%, #060914 100%)",
          color: "#f8fafc",
          fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          padding: "48px 20px 64px",
        }}
      >
        <div style={{ maxWidth: 860, margin: "0 auto" }}>

          {/* ── Logo bar ─────────────────────────────────────────────────── */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 48 }}>
            {/* Drop spexi-logo.svg into /public/ to replace this placeholder */}
            <img
              src="/spexi-logo.svg"
              alt="Spexi"
              style={{ height: 28 }}
              onError={(e) => { e.target.style.display = "none"; }}
            />
            {/* Spexi logo — 6-segment hexagon matching brand mark */}
            <svg width="30" height="30" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
              <polygon points="50,50 71,14 29,14" fill="white" stroke="#0d0a1e" strokeWidth="6" strokeLinejoin="round"/>
              <polygon points="50,50 92,50 71,14" fill="white" stroke="#0d0a1e" strokeWidth="6" strokeLinejoin="round"/>
              <polygon points="50,50 71,86 92,50" fill="white" stroke="#0d0a1e" strokeWidth="6" strokeLinejoin="round"/>
              <polygon points="50,50 29,86 71,86" fill="white" stroke="#0d0a1e" strokeWidth="6" strokeLinejoin="round"/>
              <polygon points="50,50 8,50 29,86" fill="white" stroke="#0d0a1e" strokeWidth="6" strokeLinejoin="round"/>
              <polygon points="50,50 29,14 8,50" fill="white" stroke="#0d0a1e" strokeWidth="6" strokeLinejoin="round"/>
            </svg>
            <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em", color: "#f8fafc" }}>
              Spexi
            </span>
          </div>

          {/* ── Main card ────────────────────────────────────────────────── */}
          <div
            style={{
              background: "rgba(15, 10, 30, 0.72)",
              border: "1px solid rgba(167, 139, 250, 0.14)",
              borderRadius: 24,
              padding: "40px 36px",
              boxShadow: "0 32px 96px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset",
              backdropFilter: "blur(16px)",
            }}
          >
            {/* Header */}
            <div style={{ marginBottom: 36 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#a78bfa", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 10 }}>
                Sales &amp; Ops Tool
              </div>
              <h1 style={{ margin: "0 0 12px", fontSize: 40, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.03em", color: "#f8fafc" }}>
                Mission Count Estimator
              </h1>
              <p style={{ margin: 0, color: "#94a3b8", fontSize: 15, lineHeight: 1.65, textAlign: "center" }}>
                Upload an AOI file to assess flyability and generate a credit estimate per polygon.
              </p>
            </div>

            <div style={{ height: 1, background: "rgba(148, 163, 184, 0.08)", marginBottom: 28 }} />

            {/* Upload + Status row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                gap: 14,
                marginBottom: 14,
              }}
            >
              {/* Upload card */}
              <div
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(148, 163, 184, 0.12)",
                  borderRadius: 18,
                  padding: "20px 22px",
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#64748b", marginBottom: 14 }}>
                  AOI File
                </div>
                <label
                  className="upload-btn"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    borderRadius: 12,
                    padding: "13px 20px",
                    background: "#f8fafc",
                    cursor: "pointer",
                    fontWeight: 700,
                    fontSize: 14,
                    color: "#0f172a",
                    transition: "background 150ms",
                    userSelect: "none",
                  }}
                >
                  <input
                    type="file"
                    accept=".kml,.kmz,.json,.geojson"
                    onChange={handleFile}
                    style={{ display: "none" }}
                  />
                  {lookupLoading ? "Loading data…" : "Upload AOI"}
                </label>
                <div style={{ marginTop: 8, fontSize: 11, color: "#475569", textAlign: "center" }}>
                  .kml · .kmz · .json · .geojson
                </div>
                {fileName && (
                  <div
                    style={{
                      marginTop: 14,
                      fontSize: 13,
                      color: "#94a3b8",
                      wordBreak: "break-word",
                      animation: "fadeIn 200ms ease-out",
                    }}
                  >
                    <span style={{ color: "#64748b" }}>File: </span>{fileName}
                  </div>
                )}
              </div>

              {/* Status panel */}
              {statusCfg ? (
                <div
                  key={status}
                  style={{
                    background: statusCfg.bg,
                    border: `1px solid ${statusCfg.border}`,
                    borderRadius: 18,
                    padding: "20px 22px",
                    animation: "fadeIn 300ms ease-out",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: statusCfg.color, marginBottom: 10, opacity: 0.85 }}>
                    Flyability Status
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: statusCfg.color, marginBottom: 6, letterSpacing: "-0.01em" }}>
                    {statusCfg.label}
                  </div>
                  <div style={{ color: "#94a3b8", fontSize: 14, lineHeight: 1.6 }}>
                    {statusCfg.sublabel}
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    background: "rgba(255,255,255,0.02)",
                    border: "1px dashed rgba(148, 163, 184, 0.16)",
                    borderRadius: 18,
                    padding: "20px 22px",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#475569", marginBottom: 10 }}>
                    Flyability Status
                  </div>
                  <div style={{ color: "#475569", fontSize: 14, lineHeight: 1.65 }}>
                    Upload an AOI to see results.
                  </div>
                </div>
              )}
            </div>

            {/* Stat cards + export row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: 14,
                alignItems: "stretch",
                marginBottom: 0,
              }}
            >
              <StatCard label="Flyable"    count={aggregate?.flyableCount    ?? null} color="#22c55e" />
              <StatCard label="Limited"    count={aggregate?.limitedCount    ?? null} color="#f59e0b" />
              <StatCard label="Prohibited" count={aggregate?.prohibitedCount ?? null} color="#f87171" />

              {/* Export */}
              <div
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(148, 163, 184, 0.12)",
                  borderRadius: 18,
                  padding: "18px 22px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}
              >
                <button
                  className="kml-btn"
                  onClick={downloadKML}
                  disabled={!hexes}
                  style={{
                    marginTop: 14,
                    padding: "12px 16px",
                    borderRadius: 12,
                    border: "none",
                    background: hexes ? "#f8fafc" : "rgba(148, 163, 184, 0.1)",
                    color: hexes ? "#0f172a" : "#334155",
                    fontWeight: 700,
                    fontSize: 14,
                    cursor: hexes ? "pointer" : "not-allowed",
                    transition: "background 150ms",
                  }}
                >
                  Download KML
                </button>
              </div>
            </div>

            {/* ── Credit Estimate ───────────────────────────────────────── */}
            {hexes && (
              <div style={{ animation: "fadeIn 300ms ease-out" }}>
                <div style={{ height: 1, background: "rgba(148, 163, 184, 0.08)", margin: "28px 0" }} />

                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#64748b", marginBottom: 4 }}>
                    Credit Estimate
                  </div>
                  <div style={{ color: "#64748b", fontSize: 13 }}>
                    Per polygon · flyable Spexigons only · 1 credit = $1
                  </div>
                </div>

                <div
                  style={{
                    background: "rgba(255,255,255,0.02)",
                    border: "1px solid rgba(148, 163, 184, 0.1)",
                    borderRadius: 16,
                    overflow: "hidden",
                  }}
                >
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid rgba(148, 163, 184, 0.1)" }}>
                        <th style={thStyle}>Polygon</th>
                        <th style={{ ...thStyle, textAlign: "right", color: "#22c55e" }}>Flyable</th>
                        <th style={{ ...thStyle, textAlign: "right", color: "#f59e0b" }}>Limited</th>
                        <th style={{ ...thStyle, textAlign: "right", color: "#f87171" }}>Prohibited</th>
                        <th style={{ ...thStyle, textAlign: "right" }}>Credits</th>
                        <th style={{ ...thStyle, textAlign: "right" }}>Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {creditRows.map((row, i) => {
                        const isExpanded = expandedRows.has(i);
                        const canExpand = row.hasRestrictions;
                        return (
                          <>
                            <tr
                              key={`row-${i}`}
                              onClick={canExpand ? () => toggleRow(i) : undefined}
                              style={{
                                borderTop: i > 0 ? "1px solid rgba(148, 163, 184, 0.07)" : "none",
                                cursor: canExpand ? "pointer" : "default",
                              }}
                            >
                              <td style={{ ...tdStyle, display: "flex", alignItems: "center", gap: 8 }}>
                                {canExpand ? (
                                  <span style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    width: 18,
                                    height: 18,
                                    color: "#a78bfa",
                                    fontSize: 11,
                                    transition: "transform 180ms",
                                    transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                                    flexShrink: 0,
                                  }}>▶</span>
                                ) : (
                                  <span style={{ width: 18, flexShrink: 0 }} />
                                )}
                                {row.name}
                                {row.hasRestrictions && (
                                  <span style={{ color: "#f59e0b", fontSize: 12 }}>*</span>
                                )}
                              </td>
                              <td style={{ ...tdStyle, textAlign: "right", color: "#22c55e", fontVariantNumeric: "tabular-nums" }}>
                                {row.flyable.toLocaleString()}
                              </td>
                              <td style={{ ...tdStyle, textAlign: "right", color: row.limited > 0 ? "#f59e0b" : "#334155", fontVariantNumeric: "tabular-nums" }}>
                                {row.limited.toLocaleString()}
                              </td>
                              <td style={{ ...tdStyle, textAlign: "right", color: row.prohibited > 0 ? "#f87171" : "#334155", fontVariantNumeric: "tabular-nums" }}>
                                {row.prohibited.toLocaleString()}
                              </td>
                              <td style={{ ...tdStyle, textAlign: "right", fontWeight: 600, color: "#e2e8f0", fontVariantNumeric: "tabular-nums" }}>
                                {row.price.toLocaleString()}
                              </td>
                              <td style={{ ...tdStyle, textAlign: "right", color: "#e2e8f0", fontVariantNumeric: "tabular-nums" }}>
                                ${row.price.toLocaleString()}
                              </td>
                            </tr>

                            {/* Expanded zone detail rows */}
                            {isExpanded && (
                              <tr key={`expand-${i}`} style={{ background: "rgba(0,0,0,0.18)" }}>
                                <td colSpan={6} style={{ padding: "0 0 8px 46px" }}>
                                  {[
                                    ...row.prohibitedZones.map((z) => ({ ...z, type: "prohibited" })),
                                    ...row.limitedZones.map((z) => ({ ...z, type: "limited" })),
                                  ].map((z, j) => {
                                    const color = z.type === "prohibited" ? "#f87171" : "#f59e0b";
                                    const label = z.type === "prohibited" ? "Prohibited" : "Limited";
                                    return (
                                      <div
                                        key={j}
                                        style={{
                                          display: "flex",
                                          alignItems: "center",
                                          gap: 10,
                                          padding: "5px 12px 5px 0",
                                          borderTop: j > 0 ? "1px solid rgba(148,163,184,0.06)" : "none",
                                        }}
                                      >
                                        <span style={{
                                          width: 6, height: 6, borderRadius: "50%",
                                          background: color, flexShrink: 0,
                                        }} />
                                        <span style={{ fontSize: 12, color, fontWeight: 600, minWidth: 68 }}>
                                          {label}
                                        </span>
                                        <span style={{ fontSize: 12, color: "#94a3b8" }}>
                                          {z.desc}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </td>
                              </tr>
                            )}
                          </>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={{ borderTop: "1px solid rgba(148, 163, 184, 0.14)", background: "rgba(167, 139, 250, 0.05)" }}>
                        <td style={{ ...tdStyle, fontWeight: 700, color: "#f8fafc" }}>Total</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontWeight: 600, color: "#22c55e", fontVariantNumeric: "tabular-nums" }}>
                          {aggregate.flyableCount.toLocaleString()}
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right", fontWeight: 600, color: aggregate.limitedCount > 0 ? "#f59e0b" : "#334155", fontVariantNumeric: "tabular-nums" }}>
                          {aggregate.limitedCount.toLocaleString()}
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right", fontWeight: 600, color: aggregate.prohibitedCount > 0 ? "#f87171" : "#334155", fontVariantNumeric: "tabular-nums" }}>
                          {aggregate.prohibitedCount.toLocaleString()}
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right", fontWeight: 800, fontSize: 16, color: "#f8fafc", fontVariantNumeric: "tabular-nums" }}>
                          {totalCredits.toLocaleString()}
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right", fontWeight: 700, color: "#f8fafc", fontVariantNumeric: "tabular-nums" }}>
                          ${totalCredits.toLocaleString()}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {anyRestrictions && (
                  <div style={{ marginTop: 10, fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
                    * Price based on flyable zones only. Limited or restricted zones detected — ops review required before confirming.
                  </div>
                )}
              </div>
            )}

            {error && (
              <div
                style={{
                  marginTop: 20,
                  padding: "14px 18px",
                  borderRadius: 14,
                  background: "rgba(127, 29, 29, 0.22)",
                  border: "1px solid rgba(248, 113, 113, 0.2)",
                  color: "#fca5a5",
                  fontSize: 14,
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

const thStyle = {
  padding: "12px 16px",
  textAlign: "left",
  fontSize: 12,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  color: "#64748b",
};

const tdStyle = {
  padding: "12px 16px",
  color: "#cbd5e1",
};

function StatCard({ label, count, color }) {
  return (
    <div
      style={{
        borderRadius: 18,
        padding: "18px 22px",
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(148, 163, 184, 0.12)",
        borderLeft: `3px solid ${color}`,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "#64748b",
          fontWeight: 700,
        }}
      >
        {label}
      </div>
      <div
        key={count}
        style={{
          fontSize: 36,
          fontWeight: 800,
          lineHeight: 1.1,
          color: count !== null && count > 0 ? color : "#f8fafc",
          animation: count !== null ? "countPop 280ms ease-out" : "none",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {count !== null ? count.toLocaleString() : "—"}
      </div>
      <div style={{ color: "#334155", fontSize: 11 }}>
        res 9 cells
      </div>
    </div>
  );
}

// ── File parsing ─────────────────────────────────────────────────────────────

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
    return geojson.features.flatMap((f) => extractFromFeature(f));
  }
  if (geojson.type === "Feature") {
    return extractFromFeature(geojson);
  }
  if (geojson.type === "Polygon" || geojson.type === "MultiPolygon") {
    return [{ type: "Feature", properties: {}, geometry: geojson }];
  }
  return [];
}

// Handles Polygon, MultiPolygon, and GeometryCollection (e.g. from KML <MultiGeometry>)
function extractFromFeature(feature) {
  if (!feature?.geometry) return [];
  const { geometry, properties } = feature;

  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
    return [feature];
  }

  if (geometry.type === "GeometryCollection") {
    const polygonGeoms = geometry.geometries.filter(
      (g) => g.type === "Polygon" || g.type === "MultiPolygon"
    );
    const baseName = properties?.name || "Polygon";
    return polygonGeoms.map((g, i) => ({
      type: "Feature",
      properties: {
        ...properties,
        name: polygonGeoms.length === 1 ? baseName : `${baseName} ${i + 1}`,
      },
      geometry: g,
    }));
  }

  return [];
}

// ── H3 computation ───────────────────────────────────────────────────────────

// Returns [{name, cells[]}] — one entry per polygon
function computeHexes(polygons) {
  return polygons.map((polygon, i) => ({
    name: polygon.properties?.name || `Polygon ${i + 1}`,
    cells: computeHexesForPolygon(polygon),
  }));
}

// Compute intersecting H3 cells for a single polygon feature
function computeHexesForPolygon(polygon) {
  const geom = polygon.geometry;

  if (geom.type === "Polygon") {
    return fillPolygonRings(geom.coordinates);
  }

  if (geom.type === "MultiPolygon") {
    const cells = new Set();
    for (const rings of geom.coordinates) {
      for (const cell of fillPolygonRings(rings)) cells.add(cell);
    }
    return Array.from(cells);
  }

  return [];
}

// GeoJSON coords are [lng, lat] — h3 polygonToCells expects [lat, lng]
function fillPolygonRings(rings) {
  const [outer, ...holes] = rings;
  return polygonToCells(
    {
      outer: outer.map(([lng, lat]) => [lat, lng]),
      holes: holes.map((ring) => ring.map(([lng, lat]) => [lat, lng])),
    },
    H3_RESOLUTION
  );
}

// ── KML export ───────────────────────────────────────────────────────────────

const KML_COLORS = {
  flyable:    { line: "ff00cc44", poly: "4400cc44" },
  limited:    { line: "ff00aaff", poly: "4400aaff" },
  prohibited: { line: "ff0000ff", poly: "440000ff" },
};

function buildKML(cells) {
  const styles = Object.entries(KML_COLORS)
    .map(
      ([type, { line, poly }]) => `
    <Style id="${type}">
      <LineStyle><color>${line}</color><width>1.5</width></LineStyle>
      <PolyStyle><color>${poly}</color></PolyStyle>
    </Style>`
    )
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
