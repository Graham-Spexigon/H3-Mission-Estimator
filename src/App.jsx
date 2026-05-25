import { useState, useRef } from "react";
import JSZip from "jszip";
import * as turf from "@turf/turf";
import { latLngToCell, cellToBoundary, gridDisk } from "h3-js";
import toGeoJSON from "@mapbox/togeojson";
const H3_RESOLUTION = 9;
const H3_RES9_KM2   = 0.1052; // approx area of one H3 res-9 cell in km²
function cellsToKm2(n) {
  if (!n) return "0";
  const v = n * H3_RES9_KM2;
  return v < 1 ? v.toFixed(2) : v.toFixed(1);
}
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
// ── Contiguity grouping ───────────────────────────────────────────────────────
function groupContiguousPolygons(hexes) {
  const n = hexes.length;
  if (n <= 1) return hexes.map((_, i) => [i]);
  const allCells = hexes.map((p) => [
    ...p.flyable,
    ...p.limited.map((z) => z.id),
    ...p.prohibited.map((z) => z.id),
  ]);
  const expandedSets = allCells.map((cells) => {
    const expanded = new Set();
    for (const cell of cells) {
      for (const neighbor of gridDisk(cell, 1)) expanded.add(neighbor);
    }
    return expanded;
  });
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(i, j) { parent[find(i)] = find(j); }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue;
      for (const cell of allCells[j]) {
        if (expandedSets[i].has(cell)) { union(i, j); break; }
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  return Array.from(groups.values());
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

const MISSION_TYPES = ["Hybrid", "Multi Pano", "Mapping", "Grid", "Single Pano"];

export default function App() {
  const [polygonFeatures, setPolygonFeatures] = useState([]);
  const [hexes, setHexes] = useState(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [expandedRows, setExpandedRows] = useState(new Set());
  const [isDragging, setIsDragging] = useState(false);

  // ── JIRA form state ───────────────────────────────────────────────────────
  const [jiraOpen, setJiraOpen] = useState(false);
  const [jiraForm, setJiraForm] = useState({
    projectName: "",
    clientName: "",
    missionType: "Mapping",
    notes: "",
  });
  const [jiraSubmitting, setJiraSubmitting] = useState(false);
  const [jiraResult, setJiraResult] = useState(null); // { url, key } from API
  const [jiraError, setJiraError] = useState("");

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
  async function processFile(file) {
    if (!file) return;
    setError("");
    setFileName(file.name);
    setHexes(null);
    setExpandedRows(new Set());
    try {
      const [polygons, lookup] = await Promise.all([
        parseFile(file),
        loadLookup(),
      ]);
      setPolygonFeatures(polygons);
      const perPolygon = computeHexes(polygons);
      const categorized = perPolygon.map(({ name, cells }) => {
        const flyable = [];
        const limited = [];
        const prohibited = [];
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
  function handleFile(e) { processFile(e.target.files?.[0]); }
  function handleDragOver(e) { e.preventDefault(); setIsDragging(true); }
  function handleDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) setIsDragging(false); }
  function handleDrop(e) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  }

  const aggregate = hexes
    ? {
        flyable:    hexes.flatMap((p) => p.flyable),
        limited:    hexes.flatMap((p) => p.limited),
        prohibited: hexes.flatMap((p) => p.prohibited),
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

  const creditRows = hexes
    ? groupContiguousPolygons(hexes).map((indices) => {
        const polys = indices.map((i) => hexes[i]);
        const flyable    = polys.reduce((s, p) => s + p.flyable.length, 0);
        const limited    = polys.reduce((s, p) => s + p.limited.length, 0);
        const prohibited = polys.reduce((s, p) => s + p.prohibited.length, 0);
        const price      = priceForFlyableCount(flyable + limited + prohibited);
        const hasRestrictions = limited > 0 || prohibited > 0;
        const rowColor   = prohibited > 0 ? "#f87171" : limited > 0 ? "#f59e0b" : "#22c55e";
        const name = polys.length === 1
          ? polys[0].name
          : polys.map((p) => p.name).join(" + ");
        const limitedZones    = polys.flatMap((p) => p.limited);
        const prohibitedZones = polys.flatMap((p) => p.prohibited);
        return { name, flyable, limited, prohibited, price, rowColor, hasRestrictions, isGroup: polys.length > 1, limitedZones, prohibitedZones };
      })
    : [];
  const totalCredits       = creditRows.reduce((sum, r) => sum + r.price, 0);
  const flyableOnlyTotal   = creditRows.filter(r => !r.hasRestrictions).reduce((sum, r) => sum + r.price, 0);
  const restrictedTotal    = creditRows.filter(r =>  r.hasRestrictions).reduce((sum, r) => sum + r.price, 0);
  const restrictedHasProhibited = creditRows.some(r => r.hasRestrictions && r.prohibited > 0);
  const anyRestrictions    = creditRows.some(r => r.hasRestrictions);
  const anyFlyableOnly     = creditRows.some(r => !r.hasRestrictions);

  // Auto-detected ticket type — matches API label logic (ticketType === 'feasibility' → feasibility-request)
  const ticketType = status === "flyable" ? "new-mission" : "feasibility";
  const ticketTypeLabel = status === "flyable" ? "New Mission Request" : "Feasibility Request";

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

  // ── JIRA handlers ─────────────────────────────────────────────────────────
  function openJiraForm() {
    setJiraResult(null);
    setJiraError("");
    setJiraOpen(true);
  }

  function closeJiraForm() {
    setJiraOpen(false);
  }

  async function submitJiraTicket(e) {
    e.preventDefault();
    setJiraSubmitting(true);
    setJiraError("");
    try {
      const summary = `[${ticketTypeLabel}] ${jiraForm.projectName} – ${jiraForm.clientName}`;

      const restrictionLines = [];
      if ((aggregate?.limitedCount ?? 0) > 0)
        restrictionLines.push(`Limited cells: ${aggregate.limitedCount.toLocaleString()} (~${cellsToKm2(aggregate.limitedCount)} km²)`);
      if ((aggregate?.prohibitedCount ?? 0) > 0)
        restrictionLines.push(`Prohibited cells: ${aggregate.prohibitedCount.toLocaleString()} (~${cellsToKm2(aggregate.prohibitedCount)} km²)`);

      const description = [
        `Mission Type: ${jiraForm.missionType}`,
        `Client: ${jiraForm.clientName}`,
        `Project: ${jiraForm.projectName}`,
        ``,
        `AOI Summary`,
        `Flyable cells: ${(aggregate?.flyableCount ?? 0).toLocaleString()} (~${cellsToKm2(aggregate?.flyableCount ?? 0)} km²)`,
        ...restrictionLines,
        `Total cells: ${totalCells.toLocaleString()} (~${cellsToKm2(totalCells)} km²)`,
        `Credit estimate: $${totalCredits.toLocaleString()}`,
        `Source file: ${fileName}`,
        ...(jiraForm.notes ? [``, `Notes`, jiraForm.notes] : []),
      ].join("\n");

      const res = await fetch("/api/create-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary, description, ticketType, missionType: jiraForm.missionType }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const errMsg = typeof errData.error === "string"
          ? errData.error
          : errData.error?.message || JSON.stringify(errData.error) || `Server error: ${res.status}`;
        throw new Error(errMsg);
      }
      const data = await res.json();
      setJiraResult(data);
    } catch (err) {
      setJiraError(err.message || "Failed to create ticket.");
    } finally {
      setJiraSubmitting(false);
    }
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
        @keyframes modalIn {
          from { opacity: 0; transform: scale(0.97) translateY(8px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        .upload-btn:hover { background: #e2e8f0 !important; }
        .upload-btn:active { background: #cbd5e1 !important; }
        .kml-btn:hover:not(:disabled) { background: #e2e8f0 !important; }
        .jira-btn:hover:not(:disabled) { background: rgba(167, 139, 250, 0.25) !important; }
        .jira-submit-btn:hover:not(:disabled) { background: #7c3aed !important; }
        .jira-input {
          width: 100%;
          box-sizing: border-box;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(148, 163, 184, 0.2);
          border-radius: 10px;
          padding: 10px 14px;
          color: #f8fafc;
          font-size: 14px;
          font-family: inherit;
          outline: none;
          transition: border-color 150ms;
        }
        .jira-input:focus { border-color: rgba(167, 139, 250, 0.5); }
        .jira-input option { background: #1a1040; color: #f8fafc; }
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
            <img
              src="/spexi-logo.svg"
              alt="Spexi"
              style={{ height: 28 }}
              onError={(e) => { e.target.style.display = "none"; }}
            />
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
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                style={{
                  background: isDragging ? "rgba(167,139,250,0.08)" : "rgba(255,255,255,0.03)",
                  border: isDragging
                    ? "1.5px dashed rgba(167,139,250,0.6)"
                    : "1px solid rgba(148, 163, 184, 0.12)",
                  borderRadius: 18,
                  padding: "20px 22px",
                  transition: "background 150ms, border 150ms",
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
                <div style={{ marginTop: 8, fontSize: 11, color: isDragging ? "#a78bfa" : "#475569", textAlign: "center", transition: "color 150ms" }}>
                  {isDragging ? "Drop to load" : "or drag & drop · .kml · .kmz · .json · .geojson"}
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
                  gap: 10,
                  justifyContent: "flex-end",
                }}
              >
                <button
                  className="kml-btn"
                  onClick={downloadKML}
                  disabled={!hexes}
                  style={{
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
                {/* ── JIRA ticket button ── */}
                <button
                  className="jira-btn"
                  onClick={openJiraForm}
                  disabled={!hexes}
                  style={{
                    padding: "12px 16px",
                    borderRadius: 12,
                    border: hexes
                      ? "1px solid rgba(167, 139, 250, 0.35)"
                      : "1px solid rgba(148, 163, 184, 0.1)",
                    background: hexes
                      ? "rgba(167, 139, 250, 0.12)"
                      : "rgba(148, 163, 184, 0.05)",
                    color: hexes ? "#a78bfa" : "#334155",
                    fontWeight: 700,
                    fontSize: 14,
                    cursor: hexes ? "pointer" : "not-allowed",
                    transition: "background 150ms",
                  }}
                >
                  Prepare JIRA Ticket
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
                    Grouped by contiguity · flyable Spexigons only · 1 credit = $1
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
                        <th style={{ ...thStyle, textAlign: "right", color: "#22c55e" }}>Flyable<div style={{ fontWeight: 400, fontSize: 10, color: "#334155", textTransform: "none", letterSpacing: 0 }}>km²</div></th>
                        <th style={{ ...thStyle, textAlign: "right", color: "#f59e0b" }}>Limited<div style={{ fontWeight: 400, fontSize: 10, color: "#334155", textTransform: "none", letterSpacing: 0 }}>km²</div></th>
                        <th style={{ ...thStyle, textAlign: "right", color: "#f87171" }}>Prohibited<div style={{ fontWeight: 400, fontSize: 10, color: "#334155", textTransform: "none", letterSpacing: 0 }}>km²</div></th>
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
                              <td style={{ ...tdStyle }}>
                                {(() => {
                                  const prohibChips = [...new Set(row.prohibitedZones.map(z => z.desc))];
                                  const limitChips  = [...new Set(row.limitedZones.map(z => z.desc))];
                                  const allChips = [
                                    ...prohibChips.map(d => ({ d, color: "#f87171", bg: "rgba(248,113,113,0.1)", border: "rgba(248,113,113,0.25)" })),
                                    ...limitChips.map(d =>  ({ d, color: "#f59e0b", bg: "rgba(245,158,11,0.1)",  border: "rgba(245,158,11,0.25)" })),
                                  ];
                                  const visibleChips = allChips.slice(0, 3);
                                  const extraCount   = allChips.length - visibleChips.length;
                                  return (
                                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                                      {canExpand ? (
                                        <span style={{
                                          display: "inline-flex", alignItems: "center", justifyContent: "center",
                                          width: 18, height: 18, marginTop: 1,
                                          color: "#a78bfa", fontSize: 11,
                                          transition: "transform 180ms",
                                          transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                                          flexShrink: 0,
                                        }}>▶</span>
                                      ) : (
                                        <span style={{ width: 18, flexShrink: 0 }} />
                                      )}
                                      <div>
                                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                          <span>{row.name}</span>
                                          {row.isGroup && (
                                            <span style={{
                                              fontSize: 10, fontWeight: 700, color: "#a78bfa",
                                              background: "rgba(167,139,250,0.12)", border: "1px solid rgba(167,139,250,0.25)",
                                              borderRadius: 4, padding: "1px 5px",
                                              letterSpacing: "0.05em", textTransform: "uppercase",
                                            }}>Group</span>
                                          )}
                                        </div>
                                        {visibleChips.length > 0 && (
                                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
                                            {visibleChips.map((chip, ci) => (
                                              <span key={ci} style={{
                                                fontSize: 11, fontWeight: 500,
                                                color: chip.color, background: chip.bg,
                                                border: `1px solid ${chip.border}`,
                                                borderRadius: 4, padding: "1px 6px",
                                                whiteSpace: "nowrap",
                                              }}>{chip.d}</span>
                                            ))}
                                            {extraCount > 0 && (
                                              <span style={{ fontSize: 11, color: "#64748b", padding: "1px 4px" }}>+{extraCount} more</span>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })()}
                              </td>
                              <td style={{ ...tdStyle, textAlign: "right", color: "#22c55e", fontVariantNumeric: "tabular-nums", lineHeight: 1.3 }}>
                                {row.flyable.toLocaleString()}
                                <div style={{ fontSize: 11, color: "#334155" }}>~{cellsToKm2(row.flyable)}</div>
                              </td>
                              <td style={{ ...tdStyle, textAlign: "right", color: row.limited > 0 ? "#f59e0b" : "#334155", fontVariantNumeric: "tabular-nums", lineHeight: 1.3 }}>
                                {row.limited > 0 ? row.limited.toLocaleString() : <span style={{ color: "#1e293b" }}>—</span>}
                                {row.limited > 0 && <div style={{ fontSize: 11, color: "#334155" }}>~{cellsToKm2(row.limited)}</div>}
                              </td>
                              <td style={{ ...tdStyle, textAlign: "right", color: row.prohibited > 0 ? "#f87171" : "#334155", fontVariantNumeric: "tabular-nums", lineHeight: 1.3 }}>
                                {row.prohibited > 0 ? row.prohibited.toLocaleString() : <span style={{ color: "#1e293b" }}>—</span>}
                                {row.prohibited > 0 && <div style={{ fontSize: 11, color: "#334155" }}>~{cellsToKm2(row.prohibited)}</div>}
                              </td>
                              <td style={{ ...tdStyle, textAlign: "right", fontWeight: 600, color: row.rowColor, fontVariantNumeric: "tabular-nums" }}>
                                ${row.price.toLocaleString()}{row.hasRestrictions && <span style={{ fontSize: 11, marginLeft: 1 }}>*</span>}
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr key={`expand-${i}`} style={{ background: "rgba(0,0,0,0.18)" }}>
                                <td colSpan={5} style={{ padding: "0 0 8px 46px" }}>
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
                                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
                                        <span style={{ fontSize: 12, color, fontWeight: 600, minWidth: 68 }}>{label}</span>
                                        <span style={{ fontSize: 12, color: "#94a3b8" }}>{z.desc}</span>
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
                      <tr>
                        <td colSpan={5} style={{ padding: 0, borderTop: "2px solid rgba(148, 163, 184, 0.3)", height: 0 }} />
                      </tr>
                      {anyRestrictions && anyFlyableOnly && (
                        <tr>
                          <td colSpan={4} style={{ ...tdStyle, fontWeight: 600, color: "#22c55e", fontSize: 13 }}>
                            Flyable subtotal
                          </td>
                          <td style={{ ...tdStyle, textAlign: "right", fontWeight: 600, color: "#22c55e", fontVariantNumeric: "tabular-nums" }}>
                            ${flyableOnlyTotal.toLocaleString()}
                          </td>
                        </tr>
                      )}
                      {anyRestrictions && (
                        <tr>
                          <td colSpan={4} style={{ ...tdStyle, fontWeight: 600, color: restrictedHasProhibited ? "#f87171" : "#f59e0b", fontSize: 13 }}>
                            Restricted subtotal*
                          </td>
                          <td style={{ ...tdStyle, textAlign: "right", fontWeight: 600, color: restrictedHasProhibited ? "#f87171" : "#f59e0b", fontVariantNumeric: "tabular-nums" }}>
                            ${restrictedTotal.toLocaleString()}*
                          </td>
                        </tr>
                      )}
                      <tr style={{ borderTop: "1px solid rgba(148, 163, 184, 0.14)", background: "rgba(167, 139, 250, 0.05)" }}>
                        <td style={{ ...tdStyle, fontWeight: 700, color: "#f8fafc" }}>Total</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontWeight: 600, color: "#22c55e", fontVariantNumeric: "tabular-nums", lineHeight: 1.3 }}>
                          {aggregate.flyableCount.toLocaleString()}
                          <div style={{ fontSize: 11, color: "#334155", fontWeight: 400 }}>~{cellsToKm2(aggregate.flyableCount)}</div>
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right", fontWeight: 600, color: aggregate.limitedCount > 0 ? "#f59e0b" : "#334155", fontVariantNumeric: "tabular-nums", lineHeight: 1.3 }}>
                          {aggregate.limitedCount > 0 ? aggregate.limitedCount.toLocaleString() : <span style={{ color: "#1e293b" }}>—</span>}
                          {aggregate.limitedCount > 0 && <div style={{ fontSize: 11, color: "#334155", fontWeight: 400 }}>~{cellsToKm2(aggregate.limitedCount)}</div>}
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right", fontWeight: 600, color: aggregate.prohibitedCount > 0 ? "#f87171" : "#334155", fontVariantNumeric: "tabular-nums", lineHeight: 1.3 }}>
                          {aggregate.prohibitedCount > 0 ? aggregate.prohibitedCount.toLocaleString() : <span style={{ color: "#1e293b" }}>—</span>}
                          {aggregate.prohibitedCount > 0 && <div style={{ fontSize: 11, color: "#334155", fontWeight: 400 }}>~{cellsToKm2(aggregate.prohibitedCount)}</div>}
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right", fontWeight: 800, fontSize: 16, color: "#f8fafc", fontVariantNumeric: "tabular-nums" }}>
                          ${totalCredits.toLocaleString()}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {anyRestrictions && (
                  <div style={{ marginTop: 10, fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
                    * Restricted zone pricing is estimated only. Ops review required before confirming with the customer.
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

      {/* ── JIRA Ticket Modal ───────────────────────────────────────────────── */}
      {jiraOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) closeJiraForm(); }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.7)",
            backdropFilter: "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "20px",
          }}
        >
          <div
            style={{
              background: "rgba(15, 10, 30, 0.96)",
              border: "1px solid rgba(167, 139, 250, 0.25)",
              borderRadius: 20,
              padding: "32px 32px 28px",
              width: "100%",
              maxWidth: 480,
              boxShadow: "0 32px 80px rgba(0,0,0,0.6)",
              animation: "modalIn 200ms ease-out",
            }}
          >
            {/* Modal header */}
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#a78bfa", marginBottom: 6 }}>
                  JIRA · Project OP
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#f8fafc", letterSpacing: "-0.02em" }}>
                  Prepare Ticket
                </div>
              </div>
              <button
                onClick={closeJiraForm}
                style={{
                  background: "none",
                  border: "none",
                  color: "#475569",
                  fontSize: 20,
                  cursor: "pointer",
                  lineHeight: 1,
                  padding: "2px 6px",
                  borderRadius: 6,
                }}
              >
                ✕
              </button>
            </div>

            {/* Auto-detected ticket type badge */}
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 24,
              padding: "12px 16px",
              borderRadius: 12,
              background: ticketType === "new-mission"
                ? "rgba(34, 197, 94, 0.08)"
                : "rgba(245, 158, 11, 0.08)",
              border: `1px solid ${ticketType === "new-mission"
                ? "rgba(34, 197, 94, 0.25)"
                : "rgba(245, 158, 11, 0.25)"}`,
            }}>
              <span style={{ fontSize: 16 }}>{ticketType === "new-mission" ? "✅" : "⚠️"}</span>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#64748b", marginBottom: 2 }}>
                  Auto-detected ticket type
                </div>
                <div style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: ticketType === "new-mission" ? "#22c55e" : "#f59e0b",
                }}>
                  {ticketTypeLabel}
                </div>
              </div>
            </div>

            {/* Success state */}
            {jiraResult ? (
              <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>🎉</div>
                <div style={{ fontSize: 17, fontWeight: 700, color: "#f8fafc", marginBottom: 8 }}>
                  Ticket created
                </div>
                <div style={{ fontSize: 13, color: "#64748b", marginBottom: 20 }}>
                  {jiraResult.key && (
                    <span style={{ color: "#a78bfa", fontWeight: 600 }}>{jiraResult.key} · </span>
                  )}
                  JIRA · Project OP
                </div>
                {jiraResult.url && (
                  <a
                    href={jiraResult.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: "inline-block",
                      padding: "11px 24px",
                      borderRadius: 12,
                      background: "rgba(167, 139, 250, 0.15)",
                      border: "1px solid rgba(167, 139, 250, 0.35)",
                      color: "#a78bfa",
                      fontWeight: 700,
                      fontSize: 14,
                      textDecoration: "none",
                      marginBottom: 12,
                    }}
                  >
                    Open in JIRA →
                  </a>
                )}
                <div>
                  <button
                    onClick={closeJiraForm}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#475569",
                      fontSize: 13,
                      cursor: "pointer",
                      textDecoration: "underline",
                    }}
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : (
              /* Form */
              <form onSubmit={submitJiraTicket}>
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div>
                    <label style={labelStyle}>Project Name</label>
                    <input
                      className="jira-input"
                      type="text"
                      required
                      placeholder="e.g. Downtown Vancouver Survey"
                      value={jiraForm.projectName}
                      onChange={(e) => setJiraForm(f => ({ ...f, projectName: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Client Name</label>
                    <input
                      className="jira-input"
                      type="text"
                      required
                      placeholder="e.g. Acme Corp"
                      value={jiraForm.clientName}
                      onChange={(e) => setJiraForm(f => ({ ...f, clientName: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Mission Type</label>
                    <select
                      className="jira-input"
                      value={jiraForm.missionType}
                      onChange={(e) => setJiraForm(f => ({ ...f, missionType: e.target.value }))}
                    >
                      {MISSION_TYPES.map(t => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Notes <span style={{ color: "#475569", fontWeight: 400 }}>(optional)</span></label>
                    <textarea
                      className="jira-input"
                      rows={3}
                      placeholder="Any additional context for ops…"
                      value={jiraForm.notes}
                      onChange={(e) => setJiraForm(f => ({ ...f, notes: e.target.value }))}
                      style={{ resize: "vertical", minHeight: 72 }}
                    />
                  </div>
                </div>

                {/* Stat summary strip */}
                <div style={{
                  display: "flex",
                  gap: 8,
                  marginTop: 20,
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(148,163,184,0.1)",
                  fontSize: 12,
                  color: "#64748b",
                  flexWrap: "wrap",
                }}>
                  <span style={{ color: "#22c55e", fontWeight: 600 }}>{aggregate?.flyableCount?.toLocaleString() ?? 0} flyable</span>
                  {(aggregate?.limitedCount ?? 0) > 0 && (
                    <><span style={{ color: "#334155" }}>·</span><span style={{ color: "#f59e0b", fontWeight: 600 }}>{aggregate.limitedCount.toLocaleString()} limited</span></>
                  )}
                  {(aggregate?.prohibitedCount ?? 0) > 0 && (
                    <><span style={{ color: "#334155" }}>·</span><span style={{ color: "#f87171", fontWeight: 600 }}>{aggregate.prohibitedCount.toLocaleString()} prohibited</span></>
                  )}
                  <span style={{ color: "#334155" }}>·</span>
                  <span style={{ color: "#f8fafc", fontWeight: 600 }}>${totalCredits.toLocaleString()} est.</span>
                </div>

                {jiraError && (
                  <div style={{
                    marginTop: 14,
                    padding: "10px 14px",
                    borderRadius: 10,
                    background: "rgba(127, 29, 29, 0.22)",
                    border: "1px solid rgba(248, 113, 113, 0.2)",
                    color: "#fca5a5",
                    fontSize: 13,
                  }}>
                    {jiraError}
                  </div>
                )}

                <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
                  <button
                    type="button"
                    onClick={closeJiraForm}
                    style={{
                      flex: 1,
                      padding: "12px",
                      borderRadius: 12,
                      border: "1px solid rgba(148,163,184,0.15)",
                      background: "rgba(255,255,255,0.04)",
                      color: "#94a3b8",
                      fontWeight: 600,
                      fontSize: 14,
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="jira-submit-btn"
                    disabled={jiraSubmitting}
                    style={{
                      flex: 2,
                      padding: "12px",
                      borderRadius: 12,
                      border: "none",
                      background: jiraSubmitting ? "rgba(109, 40, 217, 0.5)" : "#6d28d9",
                      color: "#f8fafc",
                      fontWeight: 700,
                      fontSize: 14,
                      cursor: jiraSubmitting ? "not-allowed" : "pointer",
                      transition: "background 150ms",
                    }}
                  >
                    {jiraSubmitting ? "Creating…" : "Create Ticket"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
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
const labelStyle = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  color: "#64748b",
  marginBottom: 6,
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
        {count !== null && count > 0 ? `~${cellsToKm2(count)} km²` : "km²"}
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
function computeHexes(polygons) {
  return polygons.map((polygon, i) => ({
    name: polygon.properties?.name || `Polygon ${i + 1}`,
    cells: computeHexesForPolygon(polygon),
  }));
}
function computeHexesForPolygon(polygon) {
  const bbox = turf.bbox(polygon);
  const [minX, minY, maxX, maxY] = bbox;
  const stepX = (maxX - minX) / 4 || 0.01;
  const stepY = (maxY - minY) / 4 || 0.01;
  const seedPoints = [];
  for (let ix = 0; ix <= 4; ix++) {
    for (let iy = 0; iy <= 4; iy++) {
      seedPoints.push([minY + stepY * iy, minX + stepX * ix]);
    }
  }
  const pt = turf.pointOnFeature(polygon);
  seedPoints.push([pt.geometry.coordinates[1], pt.geometry.coordinates[0]]);
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
    try {
      const inter = turf.intersect(turf.featureCollection([hexFeature, polygon]));
      if (inter) intersects = true;
    } catch {
      intersects = false;
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
