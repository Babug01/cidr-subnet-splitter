import { useState } from "react";
import Header from "./components/Header";

const REPO_URL = "https://github.com/Babug01/cidr-subnet-splitter";

// --- IPv4 / CIDR core math ---------------------------------------------
// Adapted from the ip-cidr-calculator tool in this same portfolio so the
// address-range arithmetic stays consistent across both tools. Verified
// with a throwaway Node script (deleted after use) against known-correct
// values, including the exact case in this tool's own spec: splitting
// 10.0.0.0/24 into 4 equal subnets yields /26 blocks at .0/.64/.128/.192,
// and 10.0.0.0/24 vs 10.0.0.128/25 are flagged as overlapping.

const IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidOctets(parts) {
  return parts.every((p) => p >= 0 && p <= 255);
}

function ipToInt(ip) {
  const m = ip.trim().match(IP_RE);
  if (!m) throw new Error(`"${ip}" is not a valid IPv4 address`);
  const parts = m.slice(1, 5).map(Number);
  if (!isValidOctets(parts)) throw new Error(`"${ip}" has an octet outside 0-255`);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function maskFromPrefix(prefix) {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function parseCidr(cidr) {
  const [ip, prefixStr] = cidr.trim().split("/");
  if (!prefixStr) throw new Error(`"${cidr}" — enter a CIDR in the form ip/prefix, e.g. 10.0.0.0/16`);
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`"${cidr}" — prefix must be an integer from 0 to 32`);
  return { ipInt: ipToInt(ip), prefix };
}

function cidrInfo(cidr) {
  const { ipInt, prefix } = parseCidr(cidr);
  const maskInt = maskFromPrefix(prefix);
  const network = (ipInt & maskInt) >>> 0;
  const broadcast = (network | (~maskInt >>> 0)) >>> 0;
  const total = Math.pow(2, 32 - prefix);
  const usable = prefix >= 31 ? 0 : total - 2;
  return {
    cidr: `${intToIp(network)}/${prefix}`, prefix,
    network: intToIp(network), broadcast: intToIp(broadcast),
    firstHost: prefix >= 31 ? intToIp(network) : intToIp(network + 1),
    lastHost: prefix >= 31 ? intToIp(broadcast) : intToIp(broadcast - 1),
    total, usable,
    networkInt: network, broadcastInt: broadcast,
  };
}

// Every equal-size subnet the parent divides into at the given new prefix.
function splitCidr(cidr, newPrefix) {
  const { ipInt, prefix } = parseCidr(cidr);
  const np = Number(newPrefix);
  if (!Number.isInteger(np) || np < prefix || np > 32) throw new Error(`New prefix must be between /${prefix} and /32`);
  const maskInt = maskFromPrefix(prefix);
  const network = (ipInt & maskInt) >>> 0;
  const count = Math.pow(2, np - prefix);
  if (count > 4096) throw new Error(`That split would produce ${count.toLocaleString()} subnets — narrow the range or raise the starting prefix`);
  const blockSize = Math.pow(2, 32 - np);
  const subnets = [];
  for (let i = 0; i < count; i++) {
    subnets.push(cidrInfo(`${intToIp((network + i * blockSize) >>> 0)}/${np}`));
  }
  return subnets;
}

// Smallest prefix whose block can fit `hosts` usable addresses (+ network + broadcast).
function prefixForHosts(hosts) {
  const needed = hosts + 2;
  for (let p = 32; p >= 0; p--) {
    if (Math.pow(2, 32 - p) >= needed) return p;
  }
  return 0;
}

// --- Mode (a): split parent into N equal-size subnets -------------------
// Block sizes are always powers of two, so N equal-size subnets that
// exactly tile the parent only exist when N itself is a power of two.
// For any other N we compute the smallest power-of-two subnet count that
// covers it (matching common subnet-calculator behavior) and surface only
// the first N — flagging clearly that the rest of that split is unused.
function splitIntoNSubnets(parentCidr, n) {
  const { prefix } = parseCidr(parentCidr);
  const requested = Number(n);
  if (!Number.isInteger(requested) || requested < 1) throw new Error("Number of subnets must be a positive integer");
  const bitsNeeded = Math.ceil(Math.log2(requested));
  const newPrefix = prefix + bitsNeeded;
  if (newPrefix > 32) throw new Error(`Cannot split ${parentCidr} into ${requested} subnets — that would need a /${newPrefix} prefix, beyond /32`);
  const allSubnets = splitCidr(parentCidr, newPrefix);
  return {
    requested,
    newPrefix,
    actualBlockCount: allSubnets.length,
    roundedUp: allSubnets.length !== requested,
    subnets: allSubnets.slice(0, requested),
    unusedCount: allSubnets.length - requested,
  };
}

// --- Mode (b): VLSM — split by a list of desired host counts ------------
// Greedy, largest-first: sort descending, walk the parent block handing
// out the smallest prefix that fits each requirement in turn. Because
// every block size is a power of two and larger blocks are always
// allocated before smaller ones, the running cursor stays aligned to
// every subsequent (smaller-or-equal) block size automatically.
function vlsmSplit(parentCidr, hostCounts) {
  const { ipInt, prefix } = parseCidr(parentCidr);
  const parentMask = maskFromPrefix(prefix);
  const parentNetwork = (ipInt & parentMask) >>> 0;
  const parentSize = Math.pow(2, 32 - prefix);
  const parentEnd = parentNetwork + parentSize - 1;

  const items = hostCounts
    .map((h, idx) => ({ originalIndex: idx, hosts: Number(h) }))
    .filter((it) => Number.isFinite(it.hosts) && it.hosts > 0)
    .sort((a, b) => b.hosts - a.hosts);

  let cursor = parentNetwork;
  const allocations = [];
  const failed = [];
  for (const item of items) {
    const p = prefixForHosts(item.hosts);
    const size = Math.pow(2, 32 - p);
    if (cursor + size - 1 > parentEnd) {
      failed.push({ ...item, neededPrefix: p, neededSize: size });
      continue;
    }
    allocations.push({ ...item, ...cidrInfo(`${intToIp(cursor)}/${p}`) });
    cursor += size;
  }
  return {
    allocations,
    failed,
    parentSize,
    usedSize: cursor - parentNetwork,
    fitsAll: failed.length === 0,
  };
}

// --- Overlap checker ------------------------------------------------------
function rangeOfCidr(cidr) {
  const { ipInt, prefix } = parseCidr(cidr);
  const mask = maskFromPrefix(prefix);
  const network = (ipInt & mask) >>> 0;
  const size = Math.pow(2, 32 - prefix);
  return { cidr: `${intToIp(network)}/${prefix}`, input: cidr, start: network, end: network + size - 1 };
}

function findOverlaps(lines) {
  const parsed = [];
  const errors = [];
  lines.forEach((raw, i) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    try {
      parsed.push(rangeOfCidr(trimmed));
    } catch (e) {
      errors.push({ line: trimmed, lineNumber: i + 1, message: e.message });
    }
  });
  const overlaps = [];
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const a = parsed[i], b = parsed[j];
      if (a.start <= b.end && b.start <= a.end) {
        overlaps.push({ a: a.input, b: b.input });
      }
    }
  }
  return { parsed, overlaps, errors };
}

// --- Styling (matches the rest of this portfolio) ------------------------
const styles = {
  root: { minHeight: "100dvh", display: "flex", flexDirection: "column" },
  content: { fontFamily: "system-ui, sans-serif", padding: "24px 32px", maxWidth: 1000, margin: "0 auto", color: "var(--text, #1a1a1a)", width: "100%", boxSizing: "border-box", background: "var(--bg-subtle, #f0efed)", flex: 1 },
  title: { fontSize: 22, fontWeight: 700, margin: 0 },
  subtitle: { fontSize: 13, opacity: 0.6, margin: "4px 0 20px" },
  tabs: { display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" },
  tabBtn: (active) => ({
    padding: "8px 16px", borderRadius: 8, border: active ? "none" : "1px solid var(--border, #e5e7eb)",
    background: active ? "var(--accent, #4f46e5)" : "transparent", color: active ? "#fff" : "var(--text, #1a1a1a)",
    cursor: "pointer", fontSize: 13, fontWeight: 600,
  }),
  row: { display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" },
  input: {
    padding: "9px 12px", borderRadius: 6, border: "1px solid var(--border, #e5e7eb)",
    background: "var(--input-bg, #f9fafb)", color: "var(--text, #1a1a1a)", fontSize: 13, minWidth: 220,
    fontFamily: "'SFMono-Regular', Consolas, monospace",
  },
  textarea: {
    width: "100%", minHeight: 120, padding: 12, borderRadius: 8, border: "1px solid var(--border, #e5e7eb)",
    background: "var(--input-bg, #f9fafb)", color: "var(--text, #1a1a1a)", fontSize: 13, boxSizing: "border-box",
    fontFamily: "'SFMono-Regular', Consolas, monospace", resize: "vertical",
  },
  btn: {
    padding: "9px 18px", borderRadius: 6, border: "none", background: "var(--accent, #4f46e5)",
    color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600,
  },
  errorBox: {
    padding: 14, borderRadius: 8, border: "1px solid #e05c5c", background: "rgba(224,92,92,0.08)",
    color: "#e05c5c", fontSize: 13, marginTop: 8,
  },
  warnBox: {
    padding: "10px 14px", borderRadius: 8, border: "1px solid #e0a05c", background: "rgba(224,160,92,0.1)",
    color: "#c97f2e", fontSize: 13, marginBottom: 16, fontWeight: 600,
  },
  okBox: {
    padding: "10px 14px", borderRadius: 8, border: "1px solid #3fb950", background: "rgba(63,185,80,0.1)",
    color: "#2e9140", fontSize: 13, marginBottom: 16, fontWeight: 600,
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 8 },
  th: { textAlign: "left", padding: "8px 10px", borderBottom: "2px solid var(--border, #e5e7eb)", opacity: 0.6, fontWeight: 600, fontSize: 11, textTransform: "uppercase" },
  td: { padding: "8px 10px", borderBottom: "1px solid var(--border, #e5e7eb)", fontFamily: "'SFMono-Regular', Consolas, monospace" },
  sectionTitle: { fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", opacity: 0.6, marginBottom: 10, marginTop: 20 },
  hint: { fontSize: 12, opacity: 0.6, margin: "4px 0 0" },
};

function EqualSplitTab() {
  const [cidr, setCidr] = useState("10.0.0.0/16");
  const [n, setN] = useState("4");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  function run() {
    try {
      setResult(splitIntoNSubnets(cidr, n));
      setError(null);
    } catch (e) {
      setResult(null);
      setError(e.message);
    }
  }

  return (
    <div>
      <div style={styles.row}>
        <input style={styles.input} value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="10.0.0.0/16" />
        <input style={{ ...styles.input, minWidth: 100 }} type="number" min="1" value={n} onChange={(e) => setN(e.target.value)} placeholder="subnets" />
        <button style={styles.btn} onClick={run}>Split</button>
      </div>
      {error && <div style={styles.errorBox}>{error}</div>}
      {result && (
        <>
          <p style={styles.hint}>
            Resulting prefix: /{result.newPrefix}
            {result.roundedUp && ` — ${result.requested} isn't a power of two, so the parent actually divides into ${result.actualBlockCount} equal /${result.newPrefix} blocks; only the first ${result.requested} are shown (${result.unusedCount} unused).`}
          </p>
          <table style={styles.table}>
            <thead>
              <tr><th style={styles.th}>Subnet</th><th style={styles.th}>Network</th><th style={styles.th}>Broadcast</th><th style={styles.th}>Usable Range</th><th style={styles.th}>Usable Hosts</th></tr>
            </thead>
            <tbody>
              {result.subnets.map((s) => (
                <tr key={s.cidr}>
                  <td style={styles.td}>{s.cidr}</td>
                  <td style={styles.td}>{s.network}</td>
                  <td style={styles.td}>{s.broadcast}</td>
                  <td style={styles.td}>{s.firstHost} - {s.lastHost}</td>
                  <td style={styles.td}>{s.usable.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function VlsmTab() {
  const [cidr, setCidr] = useState("10.0.0.0/24");
  const [hostsText, setHostsText] = useState("50\n20\n10\n5");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  function run() {
    try {
      const lines = hostsText.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) throw new Error("Enter at least one host count, one per line");
      setResult(vlsmSplit(cidr, lines));
      setError(null);
    } catch (e) {
      setResult(null);
      setError(e.message);
    }
  }

  return (
    <div>
      <div style={styles.row}>
        <input style={styles.input} value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="10.0.0.0/24" />
        <button style={styles.btn} onClick={run}>Allocate (VLSM)</button>
      </div>
      <p style={styles.hint}>One desired host count per line. Allocated largest-first from the start of the parent block.</p>
      <textarea style={{ ...styles.textarea, minHeight: 90 }} value={hostsText} onChange={(e) => setHostsText(e.target.value)} placeholder="50&#10;20&#10;10&#10;5" spellCheck={false} />
      {error && <div style={styles.errorBox}>{error}</div>}
      {result && (
        <>
          {result.fitsAll ? (
            <div style={styles.okBox}>All {result.allocations.length} requirement(s) fit — {result.usedSize.toLocaleString()} of {result.parentSize.toLocaleString()} addresses used.</div>
          ) : (
            <div style={styles.warnBox}>
              {result.failed.length} requirement(s) don't fit in this parent block: {result.failed.map((f) => `${f.hosts} hosts (needs /${f.neededPrefix})`).join(", ")}. Used {result.usedSize.toLocaleString()} of {result.parentSize.toLocaleString()} addresses before running out of room.
            </div>
          )}
          {result.allocations.length > 0 && (
            <table style={styles.table}>
              <thead>
                <tr><th style={styles.th}>Requested Hosts</th><th style={styles.th}>Subnet</th><th style={styles.th}>Network</th><th style={styles.th}>Broadcast</th><th style={styles.th}>Usable Range</th><th style={styles.th}>Usable Hosts</th></tr>
              </thead>
              <tbody>
                {result.allocations.map((a, i) => (
                  <tr key={i}>
                    <td style={styles.td}>{a.hosts}</td>
                    <td style={styles.td}>{a.cidr}</td>
                    <td style={styles.td}>{a.network}</td>
                    <td style={styles.td}>{a.broadcast}</td>
                    <td style={styles.td}>{a.firstHost} - {a.lastHost}</td>
                    <td style={styles.td}>{a.usable.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function OverlapCheckerTab() {
  const [text, setText] = useState("10.0.0.0/24\n10.0.0.128/25\n192.168.1.0/24");
  const [result, setResult] = useState(null);

  function run() {
    const lines = text.split("\n");
    setResult(findOverlaps(lines));
  }

  return (
    <div>
      <p style={styles.hint}>Paste CIDR blocks, one per line. Every pairwise overlap is flagged by comparing address integer ranges.</p>
      <textarea style={styles.textarea} value={text} onChange={(e) => setText(e.target.value)} placeholder={"10.0.0.0/24\n10.0.0.128/25"} spellCheck={false} />
      <div style={styles.row}>
        <button style={styles.btn} onClick={run}>Check for Overlaps</button>
      </div>
      {result && (
        <>
          {result.errors.length > 0 && (
            <div style={styles.errorBox}>
              {result.errors.map((e, i) => <div key={i}>Line {e.lineNumber} ("{e.line}"): {e.message}</div>)}
            </div>
          )}
          {result.parsed.length > 0 && (
            result.overlaps.length === 0 ? (
              <div style={styles.okBox}>No overlaps found among {result.parsed.length} valid block(s).</div>
            ) : (
              <div style={styles.warnBox}>
                {result.overlaps.length} overlapping pair(s) found:
                {result.overlaps.map((o, i) => <div key={i}>{o.a} overlaps {o.b}</div>)}
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}

const TABS = [
  { id: "equal", label: "Split into N Subnets", Component: EqualSplitTab },
  { id: "vlsm", label: "VLSM (by host counts)", Component: VlsmTab },
  { id: "overlap", label: "Overlap Checker", Component: OverlapCheckerTab },
];

export default function CidrSubnetSplitterTool() {
  const [tab, setTab] = useState("equal");
  const Active = TABS.find((t) => t.id === tab).Component;

  return (
    <div style={styles.root}>
      <Header title="CIDR Subnet Splitter" repoUrl={REPO_URL} />
      <div style={styles.content}>
        <h1 style={styles.title}>CIDR Subnet Splitter</h1>
        <p style={styles.subtitle}>
          Split a parent CIDR into equal-size subnets or a VLSM-style allocation by host counts, and check a list of
          CIDR blocks for overlaps. All computed locally, nothing leaves the browser.
        </p>
        <div style={styles.tabs}>
          {TABS.map((t) => (
            <button key={t.id} style={styles.tabBtn(tab === t.id)} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>
        <Active />
      </div>
    </div>
  );
}
