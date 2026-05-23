import { useState, useRef } from "react";
import JSZip from "jszip";
import jsPDF from "jspdf";
import * as turf from "@turf/turf";
import { latLngToCell, cellToBoundary, gridDisk } from "h3-js";
import toGeoJSON from "@mapbox/togeojson";

const H3_RESOLUTION = 9;
const LOOKUP_FILE_NAME = "flyability-lookup.json";

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
    kicker: "Flyability Status",
    label: "Fully Flyable",
    sublabel: "AOI has no restricted or limited zones.",
    color: "#22c55e",
    bg: "rgba(34, 197, 94, 0.12)",
    border: "rgba(34, 197, 94, 0.35)",
  },
  limited: {
    kicker: "Flyability Status",
    label: "Limitations Apply",
    sublabel: "Speak with ops before confirming with the customer.",
    color: "#f59e0b",
    bg: "rgba(245, 158, 11, 0.12)",
    border: "rgba(245, 158, 11, 0.35)",
  },
  restricted: {
    kicker: "Ops Review Required",
    label: "Contains Restricted Zones",
    sublabel: "Escalate to ops before confirming pricing with the customer.",
    color: "#ef4444",
    bg: "rgba(239, 68, 68, 0.12)",
    border: "rgba(239, 68, 68, 0.35)",
  },
};

export default function App() {
  const [hexes, setHexes] = useState(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const lookupRef = useRef(null);

  async function loadLookup() {
    if (lookupRef.current) return lookupRef.current;

    setLookupLoading(true);
    try {
      const res = await fetch(`/${LOOKUP_FILE_NAME}`, { cache: "force-cache" });
      if (!res.ok) throw new Error(`Could not load ${LOOKUP_FILE_NAME}.`);

      const data = await res.json();
      if (!data || !Array.isArray(data.p) || !Array.isArray(data.l)) {
        throw new Error(`Invalid ${LOOKUP_FILE_NAME}. Expected { "p": [], "l": [] }.`);
      }

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

      const perPolygon = computeHexes(polygons);
      const categorized = perPolygon.map(({ name, cells }) => {
        const flyable = [];
        const limited = [];
        const prohibited = [];

        for (const cell of cells) {
          if (lookup.prohibited.has(cell)) prohibited.push(cell);
          else if (lookup.limited.has(cell)) limited.push(cell);
          else flyable.push(cell);
        }

        return { name, flyable, limited, prohibited };
      });

      setHexes(categorized);
    } catch (err) {
      console.error(err);
      setHexes(null);
      setError(err.message || "Could not process file.");
    } finally {
      e.target.value = "";
    }
  }

  const aggregate = hexes
    ? {
        flyable: hexes.flatMap((p) => p.flyable),
        limited: hexes.flatMap((p) => p.limited),
        prohibited: hexes.flatMap((p) => p.prohibited),
      }
    : null;

  const totalCells = aggregate
    ? aggregate.flyable.length + aggregate.limited.length + aggregate.prohibited.length
    : 0;

  const status = aggregate ? getStatus(aggregate) : null;
  const statusCfg = status ? STATUS_CONFIG[status] : null;

  const creditRows = hexes
    ? hexes.map((p) => ({
        name: p.name,
        flyable: p.flyable.length,
        limited: p.limited.length,
        prohibited: p.prohibited.length,
        hasRestrictions: p.limited.length > 0 || p.prohibited.length > 0,
        price: priceForFlyableCount(p.flyable.length),
      }))
    : [];

  const totalCredits = creditRows.reduce((sum, row) => sum + row.price, 0);
  const anyRestrictions = creditRows.some((row) => row.hasRestrictions);

  function downloadKML() {
    if (!hexes) return;

    const allCells = hexes.flatMap((polygon) => [
      ...polygon.flyable.map((cell) => ({ cell, type: "flyable" })),
      ...polygon.limited.map((cell) => ({ cell, type: "limited" })),
      ...polygon.prohibited.map((cell) => ({ cell, type: "prohibited" })),
    ]);

    if (!allCells.length) return;

    const kml = buildKML(allCells);
    const blob = new Blob([kml], { type: "application/vnd.google-earth.kml+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const base = (fileName || "aoi").replace(/\.[^/.]+$/, "");

    a.href = url;
    a.download = `${base}_H3_Res${H3_RESOLUTION}_${totalCells}.kml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function generatePDFSummary() {
    if (!hexes || !aggregate || !statusCfg) return;

    const base = (fileName || "aoi").replace(/\.[^/.]+$/, "");
    const doc = new jsPDF({ unit: "pt", format: "letter" });
    const marginX = 48;
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const usableWidth = pageWidth - marginX * 2;
    let y = 52;

    const addFooter = () => {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(120, 120, 120);
      doc.text("Generated by Spexi Mission Count Estimator", marginX, pageHeight - 28);
    };

    const newPageIfNeeded = (needed = 24) => {
      if (y + needed <= pageHeight - 52) return;
      addFooter();
      doc.addPage();
      y = 52;
    };

    const addSectionTitle = (text) => {
      newPageIfNeeded(34);
      y += 8;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(40, 40, 40);
      doc.text(text.toUpperCase(), marginX, y);
      y += 12;
      doc.setDrawColor(220, 220, 220);
      doc.line(marginX, y, pageWidth - marginX, y);
      y += 16;
    };

    const addLine = (label, value) => {
      newPageIfNeeded(18);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(60, 60, 60);
      doc.text(`${label}:`, marginX, y);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(30, 30, 30);
      doc.text(String(value), marginX + 155, y);
      y += 16;
    };

    const addWrappedText = (text) => {
      const lines = doc.splitTextToSize(text, usableWidth);
      newPageIfNeeded(lines.length * 14 + 8);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(60, 60, 60);
      doc.text(lines, marginX, y);
      y += lines.length * 14 + 6;
    };

    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.setTextColor(20, 20, 20);
    doc.text("Spexi AOI Review Summary", marginX, y);
    y += 22;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(90, 90, 90);
    doc.text(new Date().toLocaleString(), marginX, y);
    y += 28;

    addSectionTitle("Uploaded AOI");
    addLine("File", fileName || "Not available");
    addLine("H3 Resolution", H3_RESOLUTION);

    addSectionTitle("Flyability Status");
    addLine("Status", status === "restricted" ? "Ops Review Required" : statusCfg.label);
    if (status === "restricted") addLine("Reason", "Contains restricted zones");
    addWrappedText(statusCfg.sublabel);

    addSectionTitle("Cell Summary");
    addLine("Flyable", aggregate.flyable.length.toLocaleString());
    addLine("Limited", aggregate.limited.length.toLocaleString());
    addLine("Prohibited", aggregate.prohibited.length.toLocaleString());
    addLine("Total Cells", totalCells.toLocaleString());

    addSectionTitle("Preliminary Credit Estimate");
    addLine("Credits", totalCredits.toLocaleString());
    addLine("Price", `$${totalCredits.toLocaleString()}`);
    addWrappedText("Pricing is based on flyable Spexigons only. Limited and prohibited Spexigons are excluded from the preliminary price.");

    addSectionTitle("Polygon Breakdown");

    const colX = {
      name: marginX,
      flyable: marginX + 230,
      limited: marginX + 300,
      prohibited: marginX + 370,
      credits: marginX + 455,
    };

    newPageIfNeeded(26);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(70, 70, 70);
    doc.text("Polygon", colX.name, y);
    doc.text("Flyable", colX.flyable, y, { align: "right" });
    doc.text("Limited", colX.limited, y, { align: "right" });
    doc.text("Prohibited", colX.prohibited, y, { align: "right" });
    doc.text("Credits", colX.credits, y, { align: "right" });
    y += 8;
    doc.setDrawColor(220, 220, 220);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 16;

    creditRows.forEach((row) => {
      newPageIfNeeded(24);
      const displayName = row.hasRestrictions ? `${row.name} *` : row.name;
      const nameLines = doc.splitTextToSize(displayName, 205);
      const rowHeight = Math.max(16, nameLines.length * 12);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(40, 40, 40);
      doc.text(nameLines, colX.name, y);
      doc.text(row.flyable.toLocaleString(), colX.flyable, y, { align: "right" });
      doc.text(row.limited.toLocaleString(), colX.limited, y, { align: "right" });
      doc.text(row.prohibited.toLocaleString(), colX.prohibited, y, { align: "right" });
      doc.text(row.price.toLocaleString(), colX.credits, y, { align: "right" });
      y += rowHeight;
    });

    y += 6;
    doc.setDrawColor(220, 220, 220);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 16;

    newPageIfNeeded(24);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(25, 25, 25);
    doc.text("Total", colX.name, y);
    doc.text(aggregate.flyable.length.toLocaleString(), colX.flyable, y, { align: "right" });
    doc.text(aggregate.limited.length.toLocaleString(), colX.limited, y, { align: "right" });
    doc.text(aggregate.prohibited.length.toLocaleString(), colX.prohibited, y, { align: "right" });
    doc.text(totalCredits.toLocaleString(), colX.credits, y, { align: "right" });
    y += 26;

    if (anyRestrictions) {
      addSectionTitle("Notes");
      addWrappedText("* Limited or restricted zones detected. Ops review is required before confirming final pricing with the customer.");
    }

    addFooter();
    doc.save(`${base}_Spexi_AOI_Review_Summary.pdf`);
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
        .pdf-btn:hover:not(:disabled) { background: #c4b5fd !important; }
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
          <LogoBar />

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
            <div style={{ marginBottom: 36 }}>
              <div style={eyebrowStyle}>Sales &amp; Ops Tool</div>
              <h1 style={titleStyle}>Mission Count Estimator</h1>
              <p style={subtitleStyle}>
                Upload an AOI file to assess flyability and generate a preliminary credit estimate per polygon.
              </p>
            </div>

            <Divider marginBottom={28} />

            <div style={topGridStyle}>
              <UploadCard
                fileName={fileName}
                lookupLoading={lookupLoading}
                onFileChange={handleFile}
              />
              <StatusCard statusCfg={statusCfg} status={status} />
            </div>

            <div style={statsGridStyle}>
              <StatCard label="Flyable" count={aggregate?.flyable.length ?? null} color="#22c55e" />
              <StatCard label="Limited" count={aggregate?.limited.length ?? null} color="#f59e0b" />
              <StatCard label="Prohibited" count={aggregate?.prohibited.length ?? null} color="#f87171" />
              <ActionCard
                hasResults={Boolean(hexes)}
                onDownloadKML={downloadKML}
                onGeneratePDF={generatePDFSummary}
              />
            </div>

            {hexes && (
              <CreditEstimate
                aggregate={aggregate}
                anyRestrictions={anyRestrictions}
                creditRows={creditRows}
                totalCredits={totalCredits}
              />
            )}

            {error && <ErrorBox error={error} />}
          </div>
        </div>
      </div>
    </>
  );
}

function LogoBar() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 48 }}>
      <img
        src="/spexi-logo.svg"
        alt="Spexi"
        style={{ height: 28 }}
        onError={(e) => { e.currentTarget.style.display = "none"; }}
      />
      <svg width="30" height="30" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <polygon points="50,50 71,14 29,14" fill="white" stroke="#0d0a1e" strokeWidth="6" strokeLinejoin="round" />
        <polygon points="50,50 92,50 71,14" fill="white" stroke="#0d0a1e" strokeWidth="6" strokeLinejoin="round" />
        <polygon points="50,50 71,86 92,50" fill="white" stroke="#0d0a1e" strokeWidth="6" strokeLinejoin="round" />
        <polygon points="50,50 29,86 71,86" fill="white" stroke="#0d0a1e" strokeWidth="6" strokeLinejoin="round" />
        <polygon points="50,50 8,50 29,86" fill="white" stroke="#0d0a1e" strokeWidth="6" strokeLinejoin="round" />
        <polygon points="50,50 29,14 8,50" fill="white" stroke="#0d0a1e" strokeWidth="6" strokeLinejoin="round" />
      </svg>
      <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em", color: "#f8fafc" }}>
        Spexi
      </span>
    </div>
  );
}

function UploadCard({ fileName, lookupLoading, onFileChange }) {
  return (
    <div style={panelStyle}>
      <div style={panelLabelStyle}>AOI File</div>
      <label className="upload-btn" style={uploadButtonStyle}>
        <input
          type="file"
          accept=".kml,.kmz,.json,.geojson"
          onChange={onFileChange}
          style={{ display: "none" }}
        />
        {lookupLoading ? "Loading data…" : "Upload AOI"}
      </label>
      <div style={{ marginTop: 8, fontSize: 11, color: "#475569", textAlign: "center" }}>
        .kml · .kmz · .json · .geojson
      </div>
      {fileName && (
        <div style={{ marginTop: 14, fontSize: 13, color: "#94a3b8", wordBreak: "break-word", animation: "fadeIn 200ms ease-out" }}>
          <span style={{ color: "#64748b" }}>File: </span>{fileName}
        </div>
      )}
    </div>
  );
}

function StatusCard({ statusCfg, status }) {
  if (!statusCfg) {
    return (
      <div style={emptyStatusStyle}>
        <div style={{ ...panelLabelStyle, color: "#475569", marginBottom: 10 }}>Flyability Status</div>
        <div style={{ color: "#475569", fontSize: 14, lineHeight: 1.65 }}>
          Upload an AOI to see results.
        </div>
      </div>
    );
  }

  return (
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
      <div style={{ ...panelLabelStyle, color: statusCfg.color, marginBottom: 10, opacity: 0.85 }}>
        {statusCfg.kicker}
      </div>
      <div style={{ fontSize: 20, fontWeight: 800, color: statusCfg.color, marginBottom: 6, letterSpacing: "-0.01em" }}>
        {statusCfg.label}
      </div>
      <div style={{ color: "#94a3b8", fontSize: 14, lineHeight: 1.6 }}>
        {statusCfg.sublabel}
      </div>
    </div>
  );
}

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
      <div style={panelLabelStyle}>{label}</div>
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
      <div style={{ color: "#334155", fontSize: 11 }}>res 9 cells</div>
    </div>
  );
}

function ActionCard({ hasResults, onDownloadKML, onGeneratePDF }) {
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(148, 163, 184, 0.12)",
        borderRadius: 18,
        padding: "18px 22px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        justifyContent: "space-between",
      }}
    >
      <button
        className="kml-btn"
        onClick={onDownloadKML}
        disabled={!hasResults}
        style={{ ...actionButtonStyle, background: hasResults ? "#f8fafc" : disabledButtonBg, color: hasResults ? "#0f172a" : "#334155", cursor: hasResults ? "pointer" : "not-allowed" }}
      >
        Download KML
      </button>
      <button
        className="pdf-btn"
        onClick={onGeneratePDF}
        disabled={!hasResults}
        style={{ ...actionButtonStyle, background: hasResults ? "#a78bfa" : disabledButtonBg, color: hasResults ? "#1e123b" : "#334155", cursor: hasResults ? "pointer" : "not-allowed", fontWeight: 800 }}
      >
        Generate PDF Summary
      </button>
    </div>
  );
}

function CreditEstimate({ aggregate, anyRestrictions, creditRows, totalCredits }) {
  return (
    <div style={{ animation: "fadeIn 300ms ease-out" }}>
      <Divider margin="28px 0" />

      <div style={{ marginBottom: 16 }}>
        <div style={{ ...panelLabelStyle, marginBottom: 4 }}>Preliminary Credit Estimate</div>
        <div style={{ color: "#64748b", fontSize: 13 }}>
          Per polygon · flyable Spexigons only · 1 credit = $1
        </div>
      </div>

      <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(148, 163, 184, 0.1)", borderRadius: 16, overflow: "hidden" }}>
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
            {creditRows.map((row, index) => (
              <tr key={`${row.name}-${index}`} style={{ borderTop: index > 0 ? "1px solid rgba(148, 163, 184, 0.07)" : "none" }}>
                <td style={tdStyle}>
                  {row.name}
                  {row.hasRestrictions && <span style={{ color: "#f59e0b", marginLeft: 5, fontSize: 12 }}>*</span>}
                </td>
                <td style={{ ...tdStyle, textAlign: "right", color: "#22c55e", fontVariantNumeric: "tabular-nums" }}>{row.flyable.toLocaleString()}</td>
                <td style={{ ...tdStyle, textAlign: "right", color: row.limited > 0 ? "#f59e0b" : "#334155", fontVariantNumeric: "tabular-nums" }}>{row.limited.toLocaleString()}</td>
                <td style={{ ...tdStyle, textAlign: "right", color: row.prohibited > 0 ? "#f87171" : "#334155", fontVariantNumeric: "tabular-nums" }}>{row.prohibited.toLocaleString()}</td>
                <td style={{ ...tdStyle, textAlign: "right", fontWeight: 600, color: "#e2e8f0", fontVariantNumeric: "tabular-nums" }}>{row.price.toLocaleString()}</td>
                <td style={{ ...tdStyle, textAlign: "right", color: "#e2e8f0", fontVariantNumeric: "tabular-nums" }}>${row.price.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: "1px solid rgba(148, 163, 184, 0.14)", background: "rgba(167, 139, 250, 0.05)" }}>
              <td style={{ ...tdStyle, fontWeight: 700, color: "#f8fafc" }}>Total</td>
              <td style={{ ...tdStyle, textAlign: "right", fontWeight: 600, color: "#22c55e", fontVariantNumeric: "tabular-nums" }}>{aggregate.flyable.length.toLocaleString()}</td>
              <td style={{ ...tdStyle, textAlign: "right", fontWeight: 600, color: aggregate.limited.length > 0 ? "#f59e0b" : "#334155", fontVariantNumeric: "tabular-nums" }}>{aggregate.limited.length.toLocaleString()}</td>
              <td style={{ ...tdStyle, textAlign: "right", fontWeight: 600, color: aggregate.prohibited.length > 0 ? "#f87171" : "#334155", fontVariantNumeric: "tabular-nums" }}>{aggregate.prohibited.length.toLocaleString()}</td>
              <td style={{ ...tdStyle, textAlign: "right", fontWeight: 800, fontSize: 16, color: "#f8fafc", fontVariantNumeric: "tabular-nums" }}>{totalCredits.toLocaleString()}</td>
              <td style={{ ...tdStyle, textAlign: "right", fontWeight: 700, color: "#f8fafc", fontVariantNumeric: "tabular-nums" }}>${totalCredits.toLocaleString()}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {anyRestrictions && (
        <div style={{ marginTop: 10, fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
          * Price based on flyable zones only. Limited or restricted zones detected. Ops review required before confirming.
        </div>
      )}
    </div>
  );
}

function ErrorBox({ error }) {
  return (
    <div
      style={{
        marginTop: 20,
        padding: "14px 18px",
        borderRadius: 14,
        background: "rgba(127, 29, 29, 0.22)",
        border: "1px solid rgba(248, 113, 113, 0.2)",
        color: "#fca5a5",
        fontSize: 14,
        whiteSpace: "pre-line",
      }}
    >
      <strong>Error:</strong> {error}
    </div>
  );
}

function Divider({ margin = 0, marginBottom = 0 }) {
  return <div style={{ height: 1, background: "rgba(148, 163, 184, 0.08)", margin, marginBottom }} />;
}

// ── File parsing ─────────────────────────────────────────────────────────────

async function parseFile(file) {
  const name = file.name.toLowerCase();
  let geojson;

  if (name.endsWith(".json") || name.endsWith(".geojson")) {
    geojson = JSON.parse(await file.text());
  } else if (name.endsWith(".kml")) {
    geojson = kmlToGeoJSON(await file.text());
  } else if (name.endsWith(".kmz")) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const kmlFile = Object.keys(zip.files).find((entry) => entry.toLowerCase().endsWith(".kml"));
    if (!kmlFile) throw new Error("KMZ does not contain a KML file.");
    geojson = kmlToGeoJSON(await zip.files[kmlFile].async("string"));
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
  if (geojson.type === "FeatureCollection") return geojson.features.flatMap(extractFromFeature);
  if (geojson.type === "Feature") return extractFromFeature(geojson);
  if (geojson.type === "Polygon" || geojson.type === "MultiPolygon") {
    return [{ type: "Feature", properties: {}, geometry: geojson }];
  }
  return [];
}

function extractFromFeature(feature) {
  if (!feature?.geometry) return [];
  const { geometry, properties } = feature;

  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") return [feature];

  if (geometry.type === "GeometryCollection") {
    const polygonGeoms = geometry.geometries.filter((geometryItem) =>
      geometryItem.type === "Polygon" || geometryItem.type === "MultiPolygon"
    );
    const baseName = properties?.name || "Polygon";

    return polygonGeoms.map((geometryItem, index) => ({
      type: "Feature",
      properties: {
        ...properties,
        name: polygonGeoms.length === 1 ? baseName : `${baseName} ${index + 1}`,
      },
      geometry: geometryItem,
    }));
  }

  return [];
}

// ── H3 computation ───────────────────────────────────────────────────────────

function computeHexes(polygons) {
  return polygons.map((polygon, index) => ({
    name: polygon.properties?.name || `Polygon ${index + 1}`,
    cells: computeHexesForPolygon(polygon),
  }));
}

function computeHexesForPolygon(polygon) {
  const [minX, minY, maxX, maxY] = turf.bbox(polygon);
  const stepX = (maxX - minX) / 4 || 0.01;
  const stepY = (maxY - minY) / 4 || 0.01;
  const seedPoints = [];

  for (let ix = 0; ix <= 4; ix++) {
    for (let iy = 0; iy <= 4; iy++) {
      seedPoints.push([minY + stepY * iy, minX + stepX * ix]);
    }
  }

  const pointOnFeature = turf.pointOnFeature(polygon);
  seedPoints.push([pointOnFeature.geometry.coordinates[1], pointOnFeature.geometry.coordinates[0]]);

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
    try {
      if (turf.intersect(turf.featureCollection([hexFeature, polygon]))) selected.push(cell);
    } catch {
      // Ignore turf intersection errors for malformed candidate cells.
    }
  }

  return selected;
}

function h3ToPolygonFeature(cell) {
  const coords = cellToBoundary(cell, true).map(([lng, lat]) => [lng, lat]);
  coords.push(coords[0]);
  return turf.polygon([coords]);
}

// ── KML export ───────────────────────────────────────────────────────────────

const KML_COLORS = {
  flyable: { line: "ff00cc44", poly: "4400cc44" },
  limited: { line: "ff00aaff", poly: "4400aaff" },
  prohibited: { line: "ff0000ff", poly: "440000ff" },
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

// ── Styles ───────────────────────────────────────────────────────────────────

const disabledButtonBg = "rgba(148, 163, 184, 0.1)";

const eyebrowStyle = {
  fontSize: 13,
  fontWeight: 600,
  color: "#a78bfa",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  marginBottom: 10,
};

const titleStyle = {
  margin: "0 0 12px",
  fontSize: 40,
  fontWeight: 800,
  lineHeight: 1.1,
  letterSpacing: "-0.03em",
  color: "#f8fafc",
};

const subtitleStyle = {
  margin: 0,
  color: "#94a3b8",
  fontSize: 15,
  lineHeight: 1.65,
  textAlign: "center",
};

const topGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: 14,
  marginBottom: 14,
};

const statsGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 14,
  alignItems: "stretch",
  marginBottom: 0,
};

const panelStyle = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(148, 163, 184, 0.12)",
  borderRadius: 18,
  padding: "20px 22px",
};

const emptyStatusStyle = {
  background: "rgba(255,255,255,0.02)",
  border: "1px dashed rgba(148, 163, 184, 0.16)",
  borderRadius: 18,
  padding: "20px 22px",
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
};

const panelLabelStyle = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "#64748b",
  fontWeight: 700,
};

const uploadButtonStyle = {
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
};

const actionButtonStyle = {
  padding: "12px 16px",
  borderRadius: 12,
  border: "none",
  fontWeight: 700,
  fontSize: 14,
  transition: "background 150ms",
};

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
