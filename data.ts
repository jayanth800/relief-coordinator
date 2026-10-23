// In-memory data store for the demo. Everything is fake seed data.
// To move to AWS, replace the functions at the bottom with DynamoDB calls
// (see README, "Next: connect AWS").

export type SupplyKey = "water" | "food" | "medical" | "blankets";
export const SUPPLY_KEYS: SupplyKey[] = ["water", "food", "medical", "blankets"];

export interface Supply { have: number; need: number }
export type Level = "critical" | "warning" | "ok";

interface ShelterRaw {
  id: string;
  name: string;
  x: number; // map units, map is 100 x 70
  y: number;
  capacity: number;
  occupancy: number;
  supplies: Record<SupplyKey, Supply>;
}
export interface Shelter extends ShelterRaw { urgency: number; level: Level }

export interface Volunteer {
  id: string;
  name: string;
  skill: "medic" | "driver" | "logistics" | "general";
  x: number;
  y: number;
  status: "free" | "assigned";
  shelterId?: string;
}

export interface Depot {
  name: string;
  x: number;
  y: number;
  stock: Record<SupplyKey, number>;
}

export interface Assignment {
  id: string;
  shelterId: string;
  volunteerIds: string[];
  supplies: Partial<Record<SupplyKey, number>>;
  at: string;
}

export interface Suggestion {
  shelterId: string;
  volunteerIds: string[];
  supplies: Partial<Record<SupplyKey, number>>;
  reason: string;
}

export interface State {
  shelters: Shelter[];
  volunteers: Volunteer[];
  depot: Depot;
  assignments: Assignment[];
  stats: {
    peopleSheltered: number;
    criticalSites: number;
    volunteersFree: number;
    volunteersTotal: number;
  };
}

interface Db {
  shelters: ShelterRaw[];
  volunteers: Volunteer[];
  depot: Depot;
  assignments: Assignment[];
}

const sup = (hw: number, nw: number, hf: number, nf: number, hm: number, nm: number, hb: number, nb: number) => ({
  water: { have: hw, need: nw },
  food: { have: hf, need: nf },
  medical: { have: hm, need: nm },
  blankets: { have: hb, need: nb },
});

function seed(): Db {
  return {
    shelters: [
      { id: "S1", name: "Riverside School", x: 22, y: 22, capacity: 300, occupancy: 280, supplies: sup(40, 300, 100, 280, 5, 40, 80, 280) },
      { id: "S2", name: "Community Hall", x: 38, y: 54, capacity: 150, occupancy: 90, supplies: sup(120, 90, 80, 90, 12, 15, 70, 90) },
      { id: "S3", name: "Hilltop Temple", x: 74, y: 14, capacity: 200, occupancy: 60, supplies: sup(80, 60, 70, 60, 10, 10, 60, 60) },
      { id: "S4", name: "Market Stadium", x: 64, y: 46, capacity: 500, occupancy: 430, supplies: sup(200, 430, 150, 430, 10, 60, 200, 430) },
      { id: "S5", name: "North Clinic", x: 46, y: 9, capacity: 80, occupancy: 75, supplies: sup(70, 75, 60, 75, 20, 30, 50, 75) },
      { id: "S6", name: "East Park Camp", x: 88, y: 42, capacity: 120, occupancy: 100, supplies: sup(60, 100, 50, 100, 6, 20, 40, 100) },
    ],
    volunteers: [
      { id: "V1", name: "Asha", skill: "medic", x: 30, y: 30, status: "free" },
      { id: "V2", name: "Ravi", skill: "driver", x: 55, y: 38, status: "free" },
      { id: "V3", name: "Meera", skill: "logistics", x: 70, y: 28, status: "free" },
      { id: "V4", name: "Karthik", skill: "general", x: 44, y: 46, status: "free" },
      { id: "V5", name: "Divya", skill: "medic", x: 80, y: 50, status: "free" },
      { id: "V6", name: "Imran", skill: "driver", x: 18, y: 40, status: "free" },
      { id: "V7", name: "Sana", skill: "general", x: 60, y: 20, status: "free" },
      { id: "V8", name: "Arjun", skill: "logistics", x: 90, y: 30, status: "free" },
    ],
    depot: {
      name: "Central Depot",
      x: 50,
      y: 34,
      stock: { water: 600, food: 500, medical: 80, blankets: 400 },
    },
    assignments: [],
  };
}

let db: Db = seed();

const WEIGHTS: Record<SupplyKey, number> = { water: 0.3, food: 0.25, medical: 0.3, blankets: 0.15 };

function score(s: ShelterRaw): Shelter {
  let shortage = 0;
  for (const k of SUPPLY_KEYS) {
    const { have, need } = s.supplies[k];
    shortage += WEIGHTS[k] * (need > 0 ? Math.max(0, need - have) / need : 0);
  }
  const crowd = Math.min(1, s.occupancy / s.capacity);
  const urgency = Math.round((0.7 * shortage + 0.3 * crowd) * 100) / 100;
  const level: Level = urgency >= 0.5 ? "critical" : urgency >= 0.25 ? "warning" : "ok";
  return { ...s, urgency, level };
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

export function resetStore(): void {
  db = seed();
}

export function snapshot(): State {
  const shelters = db.shelters.map(score);
  return {
    shelters,
    volunteers: db.volunteers.map((v) => ({ ...v })),
    depot: { ...db.depot, stock: { ...db.depot.stock } },
    assignments: db.assignments.map((a) => ({ ...a })),
    stats: {
      peopleSheltered: db.shelters.reduce((n, s) => n + s.occupancy, 0),
      criticalSites: shelters.filter((s) => s.level === "critical").length,
      volunteersFree: db.volunteers.filter((v) => v.status === "free").length,
      volunteersTotal: db.volunteers.length,
    },
  };
}

/** Rule-based suggestion. Swap this for a Bedrock call to get AI reasoning. */
export function suggest(shelterId?: string): Suggestion | null {
  const st = snapshot();
  const target = shelterId
    ? st.shelters.find((s) => s.id === shelterId)
    : [...st.shelters].sort((a, b) => b.urgency - a.urgency)[0];
  if (!target) return null;

  const supplies: Partial<Record<SupplyKey, number>> = {};
  for (const k of SUPPLY_KEYS) {
    const shortage = Math.max(0, target.supplies[k].need - target.supplies[k].have);
    const amount = Math.min(shortage, st.depot.stock[k]);
    if (amount > 0) supplies[k] = amount;
  }

  const free = st.volunteers.filter((v) => v.status === "free").sort((a, b) => dist(a, target) - dist(b, target));
  const want = target.level === "critical" ? 3 : 2;
  const picked: Volunteer[] = [];
  if ((supplies.medical ?? 0) > 0) {
    const medic = free.find((v) => v.skill === "medic");
    if (medic) picked.push(medic);
  }
  for (const v of free) {
    if (picked.length >= want) break;
    if (!picked.includes(v)) picked.push(v);
  }

  const short = SUPPLY_KEYS.filter((k) => (supplies[k] ?? 0) > 0).join(", ") || "nothing";
  const reason =
    `${target.name} is ${target.level} (urgency ${target.urgency.toFixed(2)}), ` +
    `${target.occupancy}/${target.capacity} people sheltered, short on: ${short}. ` +
    `Sending the nearest ${picked.length} free volunteer(s)` +
    (picked.some((v) => v.skill === "medic") ? ", including a medic for the medical shortage." : ".");

  return { shelterId: target.id, volunteerIds: picked.map((v) => v.id), supplies, reason };
}

export type AssignResult = { ok: true; assignment: Assignment } | { ok: false; error: string };

export function assign(
  shelterId: string,
  volunteerIds: string[],
  supplies: Partial<Record<SupplyKey, number>>,
): AssignResult {
  const shelter = db.shelters.find((s) => s.id === shelterId);
  if (!shelter) return { ok: false, error: `Unknown shelter: ${shelterId}` };

  const vols = volunteerIds.map((id) => db.volunteers.find((v) => v.id === id));
  if (vols.some((v) => !v)) return { ok: false, error: "One or more volunteers do not exist." };
  const busy = vols.filter((v) => v && v.status !== "free");
  if (busy.length) return { ok: false, error: `Already assigned: ${busy.map((v) => v!.name).join(", ")}` };

  for (const k of SUPPLY_KEYS) {
    const amt = supplies[k] ?? 0;
    if (amt < 0) return { ok: false, error: `Invalid amount for ${k}.` };
    if (amt > db.depot.stock[k]) {
      return { ok: false, error: `Depot only has ${db.depot.stock[k]} of ${k}, requested ${amt}.` };
    }
  }
  if (volunteerIds.length === 0 && SUPPLY_KEYS.every((k) => !(supplies[k] ?? 0))) {
    return { ok: false, error: "Pick at least one volunteer or one supply to send." };
  }

  const clean: Partial<Record<SupplyKey, number>> = {};
  for (const k of SUPPLY_KEYS) {
    const amt = Math.floor(supplies[k] ?? 0);
    if (amt > 0) {
      db.depot.stock[k] -= amt;
      shelter.supplies[k].have += amt;
      clean[k] = amt;
    }
  }
  for (const v of vols) {
    v!.status = "assigned";
    v!.shelterId = shelterId;
  }
  const assignment: Assignment = {
    id: `A${db.assignments.length + 1}`,
    shelterId,
    volunteerIds,
    supplies: clean,
    at: new Date().toISOString(),
  };
  db.assignments.push(assignment);
  // TODO (AWS): notify volunteers with SNS here.
  return { ok: true, assignment };
}

export function sitrep(): string {
  const st = snapshot();
  const lines: string[] = [];
  lines.push(`SITUATION REPORT - ${new Date().toLocaleString()}`);
  lines.push(
    `${st.stats.peopleSheltered} people sheltered across ${st.shelters.length} sites. ` +
      `${st.stats.criticalSites} critical. ${st.stats.volunteersFree}/${st.stats.volunteersTotal} volunteers free.`,
  );
  lines.push("");
  for (const s of [...st.shelters].sort((a, b) => b.urgency - a.urgency)) {
    const gaps = SUPPLY_KEYS.map((k) => ({ k, g: Math.max(0, s.supplies[k].need - s.supplies[k].have) }))
      .filter((x) => x.g > 0)
      .map((x) => `${x.k} -${x.g}`)
      .join(", ");
    lines.push(`[${s.level.toUpperCase()}] ${s.name}: ${s.occupancy}/${s.capacity} people. ${gaps ? "Gaps: " + gaps : "Fully stocked."}`);
  }
  lines.push("");
  lines.push(`Depot stock: ${SUPPLY_KEYS.map((k) => `${k} ${st.depot.stock[k]}`).join(", ")}.`);
  lines.push(`Assignments made: ${st.assignments.length}. All assignments were confirmed by a human coordinator.`);
  return lines.join("\n");
}
