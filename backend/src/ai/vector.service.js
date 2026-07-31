import fs from "fs";

const DB_PATH = "./vector-db.json";

export function saveVectors(vectors) {
  fs.writeFileSync(DB_PATH, JSON.stringify(vectors, null, 2));
}

export function loadVectors() {
  if (!fs.existsSync(DB_PATH)) return [];
  return JSON.parse(fs.readFileSync(DB_PATH));
}