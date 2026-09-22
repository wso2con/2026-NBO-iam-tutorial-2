/**
 * Seed global flight data into the B2B app SQLite database.
 * Flights are shared across all organizations — only bookings are org-scoped.
 *
 * Usage:
 *   node scripts/seed-flights.js           (seed if not already seeded)
 *   node scripts/seed-flights.js --force   (reset and re-seed)
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const schemaPath = resolve(root, "app/lib/db/schema.sql");
const dbPath = resolve(root, process.env.DB_PATH ?? "data/app.db");
const force = process.argv.includes("--force") || process.argv.includes("-f");

// ─── Flight catalog (global, shared across all orgs) ─────────────────────────
// Nairobi-centred catalogue for the Kenya event, weighted towards the
// November/December peak. Economy routes mirror the B2C tutorial catalogue;
// the premium cabins below exist so cabin-level policy checks still demo.

const flights = [
  // ── Economy — within typical $500 policy cap ──────────────────────────────
  {
    id: "flight-nbo-mba-01",
    from_city: "Nairobi",
    to_city: "Mombasa",
    airline: "Jambojet",
    departure_time: "07:30",
    arrival_time: "08:35",
    duration: "1h 05m",
    stops: 0,
    price: 78,
    currency: "USD",
    cabin: "Economy",
    dates: "Sep 21 - Sep 27",
    tags: JSON.stringify(["Domestic", "Morning"]),
  },
  {
    id: "flight-nbo-add-01",
    from_city: "Nairobi",
    to_city: "Addis Ababa",
    airline: "Ethiopian Airlines",
    departure_time: "08:45",
    arrival_time: "10:50",
    duration: "2h 05m",
    stops: 0,
    price: 214,
    currency: "USD",
    cabin: "Economy",
    dates: "Sep 24 - Sep 30",
    tags: JSON.stringify(["Regional", "Nonstop"]),
  },
  {
    id: "flight-mba-nbo-01",
    from_city: "Mombasa",
    to_city: "Nairobi",
    airline: "Jambojet",
    departure_time: "17:45",
    arrival_time: "18:50",
    duration: "1h 05m",
    stops: 0,
    price: 82,
    currency: "USD",
    cabin: "Economy",
    dates: "Sep 26 - Oct 02",
    tags: JSON.stringify(["Domestic", "Evening"]),
  },
  {
    id: "flight-nbo-dxb-01",
    from_city: "Nairobi",
    to_city: "Dubai",
    airline: "Emirates",
    departure_time: "04:20",
    arrival_time: "10:25",
    duration: "5h 05m",
    stops: 0,
    price: 396,
    currency: "USD",
    cabin: "Economy",
    dates: "Oct 08 - Oct 16",
    tags: JSON.stringify(["Nonstop", "Popular"]),
  },
  {
    id: "flight-nbo-kgl-01",
    from_city: "Nairobi",
    to_city: "Kigali",
    airline: "RwandAir",
    departure_time: "13:40",
    arrival_time: "14:15",
    duration: "1h 35m",
    stops: 0,
    price: 186,
    currency: "USD",
    cabin: "Economy",
    dates: "Oct 15 - Oct 21",
    tags: JSON.stringify(["Regional", "Quick trip"]),
  },
  {
    id: "flight-nbo-mra-01",
    from_city: "Nairobi",
    to_city: "Maasai Mara",
    airline: "Safarilink",
    departure_time: "10:00",
    arrival_time: "10:45",
    duration: "45m",
    stops: 0,
    price: 198,
    currency: "USD",
    cabin: "Economy",
    dates: "Oct 22 - Oct 26",
    tags: JSON.stringify(["Safari", "Scenic"]),
  },
  {
    id: "flight-nbo-dxb-02",
    from_city: "Nairobi",
    to_city: "Dubai",
    airline: "Kenya Airways",
    departure_time: "15:35",
    arrival_time: "21:40",
    duration: "5h 05m",
    stops: 0,
    price: 352,
    currency: "USD",
    cabin: "Economy",
    dates: "Nov 14 - Nov 21",
    tags: JSON.stringify(["Best value", "Nonstop"]),
  },
  {
    id: "flight-nbo-jnb-01",
    from_city: "Nairobi",
    to_city: "Johannesburg",
    airline: "Kenya Airways",
    departure_time: "09:50",
    arrival_time: "12:55",
    duration: "4h 05m",
    stops: 0,
    price: 368,
    currency: "USD",
    cabin: "Economy",
    dates: "Nov 18 - Nov 24",
    tags: JSON.stringify(["Nonstop", "Business friendly"]),
  },
  {
    id: "flight-nbo-doh-01",
    from_city: "Nairobi",
    to_city: "Doha",
    airline: "Qatar Airways",
    departure_time: "03:55",
    arrival_time: "09:20",
    duration: "5h 25m",
    stops: 0,
    price: 432,
    currency: "USD",
    cabin: "Economy",
    dates: "Dec 03 - Dec 12",
    tags: JSON.stringify(["Nonstop", "Carry-on included"]),
  },
  {
    id: "flight-nbo-znz-01",
    from_city: "Nairobi",
    to_city: "Zanzibar",
    airline: "Kenya Airways",
    departure_time: "11:15",
    arrival_time: "12:40",
    duration: "1h 25m",
    stops: 0,
    price: 208,
    currency: "USD",
    cabin: "Economy",
    dates: "Dec 18 - Dec 27",
    tags: JSON.stringify(["Beach trip", "Nonstop"]),
  },
  {
    id: "flight-nbo-uku-01",
    from_city: "Nairobi",
    to_city: "Diani",
    airline: "Safarilink",
    departure_time: "09:20",
    arrival_time: "10:35",
    duration: "1h 15m",
    stops: 0,
    price: 124,
    currency: "USD",
    cabin: "Economy",
    dates: "Dec 22 - Dec 30",
    tags: JSON.stringify(["Beach trip", "Domestic"]),
  },

  // ── Economy — above the $500 cap (approval-required territory) ─────────────
  {
    id: "flight-nbo-lhr-02",
    from_city: "Nairobi",
    to_city: "London",
    airline: "Qatar Airways",
    departure_time: "03:55",
    arrival_time: "16:10",
    duration: "13h 50m",
    stops: 1,
    price: 528,
    currency: "USD",
    cabin: "Economy",
    dates: "Dec 05 - Dec 15",
    tags: JSON.stringify(["Good price", "One stop"]),
  },
  {
    id: "flight-nbo-ist-01",
    from_city: "Nairobi",
    to_city: "Istanbul",
    airline: "Turkish Airlines",
    departure_time: "16:05",
    arrival_time: "23:20",
    duration: "7h 15m",
    stops: 0,
    price: 556,
    currency: "USD",
    cabin: "Economy",
    dates: "Dec 10 - Dec 19",
    tags: JSON.stringify(["Nonstop", "Europe"]),
  },
  {
    id: "flight-nbo-lhr-01",
    from_city: "Nairobi",
    to_city: "London",
    airline: "Kenya Airways",
    departure_time: "23:30",
    arrival_time: "05:05",
    duration: "8h 35m",
    stops: 0,
    price: 614,
    currency: "USD",
    cabin: "Economy",
    dates: "Nov 05 - Nov 14",
    tags: JSON.stringify(["Nonstop", "Overnight"]),
  },
  {
    id: "flight-nbo-ams-01",
    from_city: "Nairobi",
    to_city: "Amsterdam",
    airline: "KLM",
    departure_time: "23:55",
    arrival_time: "06:20",
    duration: "8h 25m",
    stops: 0,
    price: 648,
    currency: "USD",
    cabin: "Economy",
    dates: "Nov 12 - Nov 20",
    tags: JSON.stringify(["Nonstop", "Europe"]),
  },
  {
    id: "flight-lhr-nbo-01",
    from_city: "London",
    to_city: "Nairobi",
    airline: "British Airways",
    departure_time: "18:40",
    arrival_time: "06:20",
    duration: "8h 40m",
    stops: 0,
    price: 672,
    currency: "USD",
    cabin: "Economy",
    dates: "Nov 21 - Nov 29",
    tags: JSON.stringify(["Nonstop", "Evening"]),
  },
  {
    id: "flight-nbo-hnd-01",
    from_city: "Nairobi",
    to_city: "Tokyo",
    airline: "Kenya Airways",
    departure_time: "13:20",
    arrival_time: "22:35",
    duration: "19h 45m",
    stops: 1,
    price: 1148,
    currency: "USD",
    cabin: "Economy",
    dates: "Nov 09 - Nov 22",
    tags: JSON.stringify(["One stop", "Long haul"]),
  },

  // ── Premium Economy ────────────────────────────────────────────────────────
  {
    id: "flight-nbo-mba-pe-01",
    from_city: "Nairobi",
    to_city: "Mombasa",
    airline: "Kenya Airways",
    departure_time: "12:10",
    arrival_time: "13:15",
    duration: "1h 05m",
    stops: 0,
    price: 168,
    currency: "USD",
    cabin: "Premium Economy",
    dates: "Sep 21 - Sep 27",
    tags: JSON.stringify(["Domestic", "Extra legroom"]),
  },
  {
    id: "flight-nbo-dxb-pe-01",
    from_city: "Nairobi",
    to_city: "Dubai",
    airline: "Emirates",
    departure_time: "04:20",
    arrival_time: "10:25",
    duration: "5h 05m",
    stops: 0,
    price: 498,
    currency: "USD",
    cabin: "Premium Economy",
    dates: "Oct 08 - Oct 16",
    tags: JSON.stringify(["Extra legroom", "Nonstop"]),
  },
  {
    id: "flight-nbo-jnb-pe-01",
    from_city: "Nairobi",
    to_city: "Johannesburg",
    airline: "Kenya Airways",
    departure_time: "09:50",
    arrival_time: "12:55",
    duration: "4h 05m",
    stops: 0,
    price: 542,
    currency: "USD",
    cabin: "Premium Economy",
    dates: "Nov 18 - Nov 24",
    tags: JSON.stringify(["Extra legroom", "Business friendly"]),
  },
  {
    id: "flight-nbo-ams-pe-01",
    from_city: "Nairobi",
    to_city: "Amsterdam",
    airline: "KLM",
    departure_time: "23:55",
    arrival_time: "06:20",
    duration: "8h 25m",
    stops: 0,
    price: 884,
    currency: "USD",
    cabin: "Premium Economy",
    dates: "Nov 12 - Nov 20",
    tags: JSON.stringify(["Extra legroom", "Europe"]),
  },

  // ── Business class ─────────────────────────────────────────────────────────
  {
    id: "flight-nbo-jnb-biz-01",
    from_city: "Nairobi",
    to_city: "Johannesburg",
    airline: "Kenya Airways",
    departure_time: "14:25",
    arrival_time: "17:30",
    duration: "4h 05m",
    stops: 0,
    price: 1120,
    currency: "USD",
    cabin: "Business",
    dates: "Nov 18 - Nov 24",
    tags: JSON.stringify(["Lie-flat seat", "Lounge access"]),
  },
  {
    id: "flight-nbo-dxb-biz-01",
    from_city: "Nairobi",
    to_city: "Dubai",
    airline: "Emirates",
    departure_time: "04:20",
    arrival_time: "10:25",
    duration: "5h 05m",
    stops: 0,
    price: 1480,
    currency: "USD",
    cabin: "Business",
    dates: "Oct 08 - Oct 16",
    tags: JSON.stringify(["Lie-flat seat", "Chauffeur transfer"]),
  },
  {
    id: "flight-nbo-doh-biz-01",
    from_city: "Nairobi",
    to_city: "Doha",
    airline: "Qatar Airways",
    departure_time: "03:55",
    arrival_time: "09:20",
    duration: "5h 25m",
    stops: 0,
    price: 1690,
    currency: "USD",
    cabin: "Business",
    dates: "Dec 03 - Dec 12",
    tags: JSON.stringify(["Lie-flat seat", "Lounge access"]),
  },
  {
    id: "flight-nbo-lhr-biz-01",
    from_city: "Nairobi",
    to_city: "London",
    airline: "Kenya Airways",
    departure_time: "23:30",
    arrival_time: "05:05",
    duration: "8h 35m",
    stops: 0,
    price: 2140,
    currency: "USD",
    cabin: "Business",
    dates: "Nov 05 - Nov 14",
    tags: JSON.stringify(["Lie-flat seat", "Overnight"]),
  },

  // ── First class ────────────────────────────────────────────────────────────
  {
    id: "flight-nbo-dxb-first-01",
    from_city: "Nairobi",
    to_city: "Dubai",
    airline: "Emirates",
    departure_time: "04:20",
    arrival_time: "10:25",
    duration: "5h 05m",
    stops: 0,
    price: 3860,
    currency: "USD",
    cabin: "First Class",
    dates: "Oct 08 - Oct 16",
    tags: JSON.stringify(["Private suite", "Chauffeur transfer"]),
  },
];

// ─── Seeding ──────────────────────────────────────────────────────────────────

if (!existsSync(dirname(dbPath))) {
  mkdirSync(dirname(dbPath), { recursive: true });
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(readFileSync(schemaPath, "utf8"));

const existing = db.prepare("SELECT COUNT(*) as count FROM flights").get();
if (existing.count > 0 && !force) {
  console.log(`Flights already seeded (${existing.count} rows). Use npm run seed:flights -- --force to re-seed.`);
  db.close();
  process.exit(0);
}

if (force) {
  db.pragma("foreign_keys = OFF");
  db.prepare("DELETE FROM flights").run();
  db.pragma("foreign_keys = ON");
  console.log("Cleared existing flights.");
}

const insert = db.prepare(`
  INSERT OR REPLACE INTO flights
    (id, from_city, to_city, airline, departure_time, arrival_time, duration, stops, price, currency, cabin, dates, tags)
  VALUES
    (@id, @from_city, @to_city, @airline, @departure_time, @arrival_time, @duration, @stops, @price, @currency, @cabin, @dates, @tags)
`);

const seed = db.transaction(() => {
  for (const f of flights) insert.run(f);
  return flights.length;
});

const count = seed();
db.close();

console.log(`Seeded ${count} flights into ${dbPath}`);
console.log("\nFlight mix (Nairobi catalogue):");
console.log("  Economy (≤$432):          11 flights — in-policy for typical $500 cap");
console.log("  Economy ($528-$1148):      6 flights — approval-required zone");
console.log("  Premium Economy:           4 flights — cabin upgrade, mixed prices");
console.log("  Business:                  4 flights — out-of-policy for Economy policies");
console.log("  First Class:               1 flight  — always out-of-policy");
