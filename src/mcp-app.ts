import { App } from "@modelcontextprotocol/ext-apps";
import type { State, Shelter, Suggestion, SupplyKey } from "../data.js";

const SUPPLY_KEYS: SupplyKey[] = ["water", "food", "medical", "blankets"];
const LABEL: Record<SupplyKey, string> = {
  water: "Water (L)",
  food: "Food (meals)",
  medical: "Medical kits",
  blankets: "Blankets",
};

const root = document.getElementById("root") as HTMLElement;
const app = new App({ name: "Relief Coordinator", version: "1.0.0" });

let state: State | null = null;
let suggestion: Suggestion | null = null;
let sitrep = "";
let message = "";
let busy = false;
let selectedId: string | null = null;
let picked = new Set<string>();
let plan: Partial<Record<SupplyKey, number>> = {};

type Pt = { x: number; y: number };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const eta = (a: Pt, b: Pt) => Math.max(1, Math.round(dist(a, b) * 0.9)); // demo: ~minutes by road
const esc = (t: string) =>
  t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

// ---------- data in ----------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function apply(result: any): void {
  if (!result) return;
  if (result.isError) {
    message = result.content?.[0]?.text ?? "Something went wrong.";
    return;
  }
  const sc = result.structuredContent;
  if (!sc) return;
  if (sc.state) state = sc.state as State;
  if ("suggestion" in sc) suggestion = (sc.suggestion as Suggestion | null) ?? null;
  if (typeof sc.sitrep === "string") sitrep = sc.sitrep;
  if (typeof sc.message === "string") message = sc.message;
  if (!selectedId && state) {
    selectedId = [...state.shelters].sort((a, b) => b.urgency - a.urgency)[0]?.id ?? null;
  }
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<void> {
  busy = true;
  message = "";
  render();
  try {
    apply(await app.callServerTool({ name, arguments: args }));
  } catch (err) {
    message = "Could not reach the server: " + (err instanceof Error ? err.message : String(err));
  }
  busy = false;
  render();
}

app.ontoolresult = (result) => {
  apply(result);
  render();
};

// ---------- rendering ----------
function mapSvg(s: State, sel: Shelter | null): string {
  const routes: string[] = [];
  if (sel) {
    routes.push(`<line class="route" x1="${s.depot.x}" y1="${s.depot.y}" x2="${sel.x}" y2="${sel.y}"/>`);
    for (const id of picked) {
      const v = s.volunteers.find((x) => x.id === id);
      if (v) routes.push(`<line class="vroute" x1="${v.x}" y1="${v.y}" x2="${sel.x}" y2="${sel.y}"/>`);
    }
  }
  const vols = s.volunteers
    .map(
      (v) =>
        `<g class="vol ${v.status} ${picked.has(v.id) ? "picked" : ""}"><title>${esc(v.name)} (${v.skill}, ${v.status})</title>` +
        `<rect x="${v.x - 1}" y="${v.y - 1}" width="2" height="2" rx="0.4"/></g>`,
    )
    .join("");
  const shelters = s.shelters
    .map((sh) => {
      const pct = Math.round((sh.occupancy / sh.capacity) * 100);
      return (
        `<g class="shelter ${sh.level} ${sh.id === selectedId ? "sel" : ""}" data-shelter="${sh.id}" tabindex="0" role="button" aria-label="${esc(sh.name)}, ${sh.level}">` +
        `<title>${esc(sh.name)}: ${sh.level}</title>` +
        `<circle cx="${sh.x}" cy="${sh.y}" r="3.4"/>` +
        `<text class="pct" x="${sh.x}" y="${sh.y + 0.8}">${pct}%</text>` +
        `<text class="lbl" x="${sh.x}" y="${sh.y + 6.6}">${esc(sh.name)}</text></g>`
      );
    })
    .join("");
  const d = s.depot;
  return `
  <svg class="map" viewBox="0 0 100 70" role="img" aria-label="Map of the flood-hit district">
    <path class="flood" d="M0 24 C 18 14, 30 36, 50 28 S 82 18, 100 26 L100 36 C 82 30, 66 42, 50 38 S 18 48, 0 34 Z"/>
    <path class="road" d="M0 60 L100 58 M10 0 L18 70 M50 0 L52 70 M82 0 L78 70 M0 12 L100 8"/>
    ${routes.join("")}
    <g class="depot"><title>${esc(d.name)}</title>
      <polygon points="${d.x},${d.y - 2.6} ${d.x + 2.6},${d.y} ${d.x},${d.y + 2.6} ${d.x - 2.6},${d.y}"/>
      <text x="${d.x}" y="${d.y + 5.6}">${esc(d.name)}</text></g>
    ${vols}
    ${shelters}
  </svg>
  <div class="legend">
    <span><i class="dot" style="background:var(--crit)"></i>Critical</span>
    <span><i class="dot" style="background:var(--warn)"></i>Needs support</span>
    <span><i class="dot" style="background:var(--ok)"></i>Stocked</span>
    <span><i class="dot sq" style="background:var(--accent)"></i>Free volunteer</span>
    <span><i class="dot sq" style="background:var(--muted)"></i>Assigned</span>
    <span>Circle number = how full the shelter is</span>
  </div>`;
}

function supplyBars(sh: Shelter): string {
  return SUPPLY_KEYS.map((k) => {
    const { have, need } = sh.supplies[k];
    const ratio = need > 0 ? have / need : 1;
    const cls = ratio < 0.4 ? "low" : ratio < 0.8 ? "mid" : "";
    return `<div class="bar-row"><span>${LABEL[k]}</span>
      <div class="bar"><i class="${cls}" style="width:${Math.min(100, Math.round(ratio * 100))}%"></i></div>
      <span class="num">${have} / ${need}</span></div>`;
  }).join("");
}

function panel(s: State, sel: Shelter | null): string {
  if (!sel) return `<p class="empty">Select a shelter on the map to see what it needs.</p>`;

  const free = s.volunteers.filter((v) => v.status === "free").sort((a, b) => dist(a, sel) - dist(b, sel));
  const volList = free.length
    ? free
        .map(
          (v) => `<label><input type="checkbox" data-vol="${v.id}" ${picked.has(v.id) ? "checked" : ""}/>
          <span>${esc(v.name)}</span><small>${v.skill} &middot; ${eta(v, sel)} min away</small></label>`,
        )
        .join("")
    : `<p class="note">No free volunteers left. Reset the demo to start again.</p>`;

  const sendInputs = SUPPLY_KEYS.map(
    (k) => `<label>${LABEL[k]}
      <input type="number" min="0" max="${s.depot.stock[k]}" data-supply="${k}" value="${plan[k] ?? 0}"/></label>`,
  ).join("");

  return `
    <h2>${esc(sel.name)}</h2>
    <div class="note" style="margin:0">${sel.occupancy} of ${sel.capacity} beds in use &middot; ${sel.level}, urgency ${sel.urgency.toFixed(2)}</div>
    <h3>Supplies on hand vs needed</h3>
    ${supplyBars(sel)}
    <h3>Send from ${esc(s.depot.name)} (${eta(s.depot, sel)} min)</h3>
    <div class="send">${sendInputs}</div>
    <h3>Volunteers (nearest first)</h3>
    <div class="vols">${volList}</div>
    ${suggestion && suggestion.shelterId === sel.id ? `<div class="reason">${esc(suggestion.reason)}</div>` : ""}
    <div class="actions">
      <button data-action="suggest" ${busy ? "disabled" : ""}>Suggest allocation</button>
      <button class="primary" data-action="assign" ${busy || (picked.size === 0 && SUPPLY_KEYS.every((k) => !plan[k])) ? "disabled" : ""}>Confirm assignment</button>
    </div>
    <div class="note">Suggestions are advice only. Nothing is sent until you confirm.</div>`;
}

function render(): void {
  if (!state) {
    root.innerHTML = `<p class="empty">Waiting for the relief map. Ask the assistant to "show the relief map".</p>`;
    return;
  }
  const s = state;
  const sel = s.shelters.find((x) => x.id === selectedId) ?? null;
  root.innerHTML = `
    <div class="top">
      <h1>Relief Coordinator</h1>
      <div class="stats">
        <div class="stat"><b>${s.stats.peopleSheltered}</b><span>people sheltered</span></div>
        <div class="stat crit"><b>${s.stats.criticalSites}</b><span>critical sites</span></div>
        <div class="stat"><b>${s.stats.volunteersFree}/${s.stats.volunteersTotal}</b><span>volunteers free</span></div>
        <div class="stat"><b>${s.assignments.length}</b><span>assignments</span></div>
      </div>
    </div>
    <div class="grid">
      <div class="card">${mapSvg(s, sel)}</div>
      <div class="card">
        ${panel(s, sel)}
        <div class="actions">
          <button data-action="sitrep" ${busy ? "disabled" : ""}>Generate situation report</button>
          <button data-action="reset" ${busy ? "disabled" : ""}>Reset demo</button>
        </div>
        ${message ? `<div class="msg" role="status">${esc(message)}</div>` : ""}
        ${sitrep ? `<pre class="sitrep"></pre>` : ""}
      </div>
    </div>`;
  const pre = root.querySelector("pre.sitrep");
  if (pre) pre.textContent = sitrep;
}

// ---------- events ----------
function selectShelter(id: string): void {
  selectedId = id;
  picked = new Set();
  plan = {};
  suggestion = null;
  message = "";
  render();
}

root.addEventListener("click", (e) => {
  const t = e.target as Element;
  const sh = t.closest("[data-shelter]") as HTMLElement | null;
  if (sh?.dataset.shelter) return selectShelter(sh.dataset.shelter);

  const btn = t.closest("[data-action]") as HTMLElement | null;
  if (!btn || !state) return;
  switch (btn.dataset.action) {
    case "suggest":
      if (selectedId) {
        void call("suggest_allocation", { shelterId: selectedId }).then(() => {
          if (suggestion && suggestion.shelterId === selectedId) {
            picked = new Set(suggestion.volunteerIds);
            plan = { ...suggestion.supplies };
            render();
          }
        });
      }
      break;
    case "assign":
      if (selectedId) {
        const supplies: Partial<Record<SupplyKey, number>> = {};
        for (const k of SUPPLY_KEYS) if (plan[k]) supplies[k] = plan[k];
        void call("assign_resources", { shelterId: selectedId, volunteerIds: [...picked], supplies }).then(() => {
          if (message.startsWith("Assignment")) {
            picked = new Set();
            plan = {};
            render();
          }
        });
      }
      break;
    case "sitrep":
      void call("generate_sitrep");
      break;
    case "reset":
      picked = new Set();
      plan = {};
      selectedId = null;
      void call("reset_demo");
      break;
  }
});

root.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const sh = (e.target as Element).closest("[data-shelter]") as HTMLElement | null;
  if (sh?.dataset.shelter) {
    e.preventDefault();
    selectShelter(sh.dataset.shelter);
  }
});

root.addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.dataset.vol) {
    if (t.checked) picked.add(t.dataset.vol);
    else picked.delete(t.dataset.vol);
    render();
  } else if (t.dataset.supply) {
    plan[t.dataset.supply as SupplyKey] = Math.max(0, Math.floor(Number(t.value) || 0));
    render();
  }
});

// ---------- go ----------
app.connect();
