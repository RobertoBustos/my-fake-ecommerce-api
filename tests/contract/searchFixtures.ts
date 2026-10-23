import { readFileSync } from "node:fs";
import type { SearchDoc, SearchQuery } from "../../src/search/ports.js";

// The catalog and the 20 queries of the search engine spike (see its
// ADR in Confluence): the 20 seed products plus 1000 deterministic
// synthetic ones. Every product carries structured ground truth (kinds,
// brand, material, tags) that is never indexed, so relevance is judged on
// what a product is, not on the text the engine sees.

export interface SpikeProduct {
  id: string;
  title: string;
  description: string;
  category: string;
  brand: string;
  settlementPrice: number; // MXN cents
  inStock: boolean;
  // ground truth, not indexed
  kinds: string[];
  material: string;
  tags: string[];
}

const SEED_TRUTH: Record<string, { kinds: string[]; brand: string; material: string; tags?: string[] }> = {
  "1": { kinds: ["backpack"], brand: "Fjallraven", material: "" },
  "2": { kinds: ["t-shirt"], brand: "", material: "cotton" },
  "3": { kinds: ["jacket"], brand: "", material: "cotton" },
  "4": { kinds: ["shirt"], brand: "", material: "" },
  "5": { kinds: ["bracelet"], brand: "John Hardy", material: "gold" },
  "6": { kinds: ["ring"], brand: "", material: "gold" },
  "7": { kinds: ["ring"], brand: "", material: "gold" },
  "8": { kinds: ["earrings"], brand: "", material: "gold" },
  "9": { kinds: ["hard drive"], brand: "WD", material: "", tags: ["external"] },
  "10": { kinds: ["ssd"], brand: "SanDisk", material: "" },
  "11": { kinds: ["ssd"], brand: "Silicon Power", material: "" },
  "12": { kinds: ["hard drive"], brand: "WD", material: "", tags: ["external", "gaming"] },
  "13": { kinds: ["monitor"], brand: "Acer", material: "" },
  "14": { kinds: ["monitor"], brand: "Samsung", material: "", tags: ["gaming"] },
  "15": { kinds: ["jacket"], brand: "BIYLACLESEN", material: "", tags: ["snowboard"] },
  "16": { kinds: ["jacket"], brand: "Lock and Love", material: "leather" },
  "17": { kinds: ["raincoat", "jacket"], brand: "", material: "" },
  "18": { kinds: ["t-shirt"], brand: "MBJ", material: "", tags: ["short sleeve"] },
  "19": { kinds: ["t-shirt"], brand: "Opna", material: "", tags: ["short sleeve"] },
  "20": { kinds: ["t-shirt"], brand: "DANVOUY", material: "cotton", tags: ["short sleeve"] },
};

interface KindSpec {
  kind: string;
  labels: string[];
  extraKinds?: string[];
  price: [number, number];
}

const CATALOG: Record<string, { brands: string[]; materials: string[]; kinds: KindSpec[] }> = {
  "men's clothing": {
    brands: ["Northfield", "Urban Peak", "Calder", "Ridgeway", "Samsung"],
    materials: ["cotton", "denim", "wool", "polyester", "leather"],
    kinds: [
      { kind: "jacket", labels: ["Jacket", "Bomber Jacket", "Field Jacket"], price: [2500, 9000] },
      { kind: "t-shirt", labels: ["T-Shirt", "Crew Neck Tee"], price: [600, 2500] },
      { kind: "backpack", labels: ["Backpack", "Daypack Backpack"], price: [1500, 8000] },
      { kind: "shirt", labels: ["Oxford Shirt", "Button Down Shirt"], price: [900, 3500] },
      { kind: "hoodie", labels: ["Hoodie", "Zip Hoodie"], price: [1200, 4500] },
    ],
  },
  "women's clothing": {
    brands: ["Lumen", "Ivy Lane", "Solenne", "Marlow"],
    materials: ["cotton", "linen", "silk", "polyester", "leather"],
    kinds: [
      { kind: "jacket", labels: ["Jacket", "Cropped Jacket", "Puffer Jacket"], price: [2500, 9500] },
      { kind: "raincoat", labels: ["Raincoat", "Rain Jacket"], extraKinds: ["jacket"], price: [2000, 7000] },
      { kind: "t-shirt", labels: ["T-Shirt", "Short Sleeve Tee"], price: [500, 2200] },
      { kind: "dress", labels: ["Dress", "Midi Dress"], price: [1500, 7000] },
      { kind: "blouse", labels: ["Blouse", "Wrap Blouse"], price: [1000, 4000] },
    ],
  },
  jewelery: {
    brands: ["Aurelia", "Vesta", "Orion & Co"],
    materials: ["gold", "silver", "rose gold", "platinum"],
    kinds: [
      { kind: "bracelet", labels: ["Bracelet", "Chain Bracelet", "Bangle Bracelet"], price: [1500, 60000] },
      { kind: "ring", labels: ["Ring", "Band Ring"], price: [1000, 50000] },
      { kind: "necklace", labels: ["Necklace", "Pendant Necklace"], price: [1500, 55000] },
      { kind: "earrings", labels: ["Earrings", "Stud Earrings"], price: [800, 30000] },
    ],
  },
  electronics: {
    brands: ["Samsung", "Acer", "WD", "Kingston", "LG"],
    materials: [""],
    kinds: [
      { kind: "monitor", labels: ["Monitor", "Gaming Monitor", "IPS Monitor"], price: [25000, 120000] },
      { kind: "ssd", labels: ["SSD", "NVMe SSD"], price: [5000, 30000] },
      {
        kind: "hard drive",
        labels: ["External Hard Drive", "Portable Hard Drive", "Desktop Hard Drive"],
        price: [5000, 25000],
      },
      { kind: "headphones", labels: ["Headphones", "Wireless Headphones"], price: [3000, 40000] },
      { kind: "keyboard", labels: ["Keyboard", "Mechanical Keyboard"], price: [2000, 15000] },
    ],
  },
};

const ADJECTIVES = [
  "Classic",
  "Slim Fit",
  "Premium",
  "Lightweight",
  "Everyday",
  "Vintage",
  "Compact",
  "Pro",
  "Essential",
  "Deluxe",
];

// mulberry32: deterministic so every run (and both engines) gets the same data
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildDataset(): SpikeProduct[] {
  const seedUrl = new URL("../../scripts/seed-data/products.json", import.meta.url);
  const seed = JSON.parse(readFileSync(seedUrl, "utf8")) as Array<{
    id: string;
    title: string;
    description: string;
    category: string;
    unitPrice: number;
    stock: number;
  }>;
  const out: SpikeProduct[] = seed.map((p) => {
    const t = SEED_TRUTH[p.id];
    return {
      id: `seed-${p.id}`,
      title: p.title.trim(),
      description: p.description,
      category: p.category,
      brand: t.brand,
      settlementPrice: p.unitPrice,
      inStock: p.stock > 0,
      kinds: t.kinds,
      material: t.material,
      tags: t.tags ?? [],
    };
  });

  const rand = rng(42);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const categories = Object.keys(CATALOG);
  for (let i = 0; i < 1000; i++) {
    const category = categories[i % categories.length];
    const spec = CATALOG[category];
    const k = pick(spec.kinds);
    const brand = pick(spec.brands);
    const material = pick(spec.materials);
    const label = pick(k.labels);
    const adj = pick(ADJECTIVES);
    const tags: string[] = [];
    if (label.includes("Gaming")) tags.push("gaming");
    if (label.includes("External") || label.includes("Portable")) tags.push("external");
    if (label.includes("Short Sleeve") || (k.kind === "t-shirt" && rand() < 0.4)) tags.push("short sleeve");
    const materialWord = material ? `${material.replace(/\b\w/g, (c) => c.toUpperCase())} ` : "";
    const title = `${brand} ${adj} ${materialWord}${label}`;
    const sleeve = tags.includes("short sleeve") && !label.includes("Short Sleeve") ? " Short sleeve cut." : "";
    const description = `${adj} ${k.kind} by ${brand}.${material ? ` Made of ${material}.` : ""}${sleeve} Model ${1000 + i}.`;
    const [lo, hi] = k.price;
    out.push({
      id: `syn-${i}`,
      title,
      description,
      category,
      brand,
      settlementPrice: Math.round((lo + rand() * (hi - lo)) / 100) * 100 - 1,
      inStock: rand() > 0.15,
      kinds: [k.kind, ...(k.extraKinds ?? [])],
      material,
      tags,
    });
  }
  return out;
}

// What an index stores: ground truth stays out.
export const toSearchDoc = (p: SpikeProduct): SearchDoc => ({
  id: p.id,
  sourceKey: "fs",
  title: p.title,
  description: p.description,
  category: p.category,
  settlementPrice: p.settlementPrice,
  inStock: p.inStock,
});

export interface SpikeQuery {
  id: string;
  group: "exact" | "typo" | "prefix" | "multi" | "phrase" | "filter" | "sort";
  text: string;
  category?: string;
  minPrice?: number; // MXN cents, inclusive
  maxPrice?: number;
  sort?: "price_asc";
  facets?: boolean;
  relevant: (p: SpikeProduct) => boolean;
}

const has = (k: string) => (p: SpikeProduct) => p.kinds.includes(k);
const and =
  (...fs: Array<(p: SpikeProduct) => boolean>) =>
  (p: SpikeProduct) =>
    fs.every((f) => f(p));
const inPrice = (lo: number, hi: number) => (p: SpikeProduct) => p.settlementPrice >= lo && p.settlementPrice <= hi;
const cat = (c: string) => (p: SpikeProduct) => p.category === c;

export const QUERIES: SpikeQuery[] = [
  { id: "q01", group: "exact", text: "jacket", facets: true, relevant: has("jacket") },
  { id: "q02", group: "exact", text: "cotton", facets: true, relevant: (p) => p.material === "cotton" },
  { id: "q03", group: "typo", text: "jaket", facets: true, relevant: has("jacket") },
  { id: "q04", group: "typo", text: "monitr", relevant: has("monitor") },
  { id: "q05", group: "typo", text: "backpak", relevant: has("backpack") },
  { id: "q06", group: "typo", text: "braclet", relevant: has("bracelet") },
  { id: "q07", group: "typo", text: "snowbord jacket", relevant: (p) => p.tags.includes("snowboard") },
  { id: "q08", group: "prefix", text: "jac", relevant: has("jacket") },
  { id: "q09", group: "prefix", text: "mon", relevant: has("monitor") },
  { id: "q10", group: "prefix", text: "neckl", relevant: has("necklace") },
  {
    id: "q11",
    group: "multi",
    text: "gold bracelet",
    relevant: and(has("bracelet"), (p) => p.material.includes("gold")),
  },
  {
    id: "q12",
    group: "multi",
    text: "samsung gaming monitor",
    relevant: and(has("monitor"), (p) => p.brand === "Samsung" && p.tags.includes("gaming")),
  },
  { id: "q13", group: "multi", text: "rain jacket women", relevant: has("raincoat") },
  {
    id: "q14",
    group: "phrase",
    text: '"external hard drive"',
    relevant: and(has("hard drive"), (p) => p.tags.includes("external")),
  },
  { id: "q15", group: "phrase", text: '"short sleeve"', relevant: (p) => p.tags.includes("short sleeve") },
  {
    id: "q16",
    group: "filter",
    text: "jacket",
    category: "women's clothing",
    relevant: and(has("jacket"), cat("women's clothing")),
  },
  {
    id: "q17",
    group: "filter",
    text: "jacket",
    minPrice: 3000,
    maxPrice: 6000,
    relevant: and(has("jacket"), inPrice(3000, 6000)),
  },
  {
    id: "q18",
    group: "filter",
    text: "ssd",
    category: "electronics",
    maxPrice: 12000,
    relevant: and(has("ssd"), inPrice(0, 12000)),
  },
  {
    id: "q19",
    group: "filter",
    text: "gold",
    category: "jewelery",
    maxPrice: 20000,
    relevant: and(cat("jewelery"), (p) => p.material.includes("gold"), inPrice(0, 20000)),
  },
  { id: "q20", group: "sort", text: "monitor", sort: "price_asc", relevant: has("monitor") },
];

// The port query a spike query stands for, asking for the first `limit`.
export const toSearchQuery = (q: SpikeQuery, limit = 3): SearchQuery => ({
  text: q.text,
  filters: { category: q.category, minPrice: q.minPrice, maxPrice: q.maxPrice },
  sort: q.sort === "price_asc" ? "PRICE_ASC" : "RELEVANCE",
  page: { offset: 0, limit },
});
