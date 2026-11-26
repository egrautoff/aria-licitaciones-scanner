// Decide que paquetes de lectura subir junto al tablero en esta publicacion.
//
// La pagina del tablero no puede salir a internet: el boton "Analizar con IA"
// lee los paquetes como archivos publicados al lado del HTML (paquetes/<id>.json).
// La rutina los baja de raw.githubusercontent y los pasa en el `files` del
// publish. Para no subir todo cada vez, compara el indice del tablero publicado
// con el nuevo: sube los nuevos o cambiados (y los armados hoy o ayer, por si una
// publicacion anterior fallo) y marca para quitar los que salieron del radar.
//
//   node paquetes-publicar.mjs <html-publicado> <datos.json> <carpeta-destino>
//
// Escribe <carpeta-destino>/files.json: { "paquetes/<id>.json": "<ruta local>" | null }

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [htmlPath, datosPath, destinoArg] = process.argv.slice(2);
if (!htmlPath || !datosPath || !destinoArg) {
  console.error("Uso: node paquetes-publicar.mjs <html-publicado> <datos.json> <carpeta-destino>");
  process.exit(1);
}
const destino = path.resolve(destinoArg);
const RAW = "https://raw.githubusercontent.com/egrautoff/aria-licitaciones-scanner/main/data/paquetes";

let viejo = {};
try {
  const h = fs.readFileSync(htmlPath, "utf8");
  const m = h.match(/const DATA = ([\s\S]*?);\n\/\* DATA_BLOCK_END/);
  viejo = (m && JSON.parse(m[1]).paquetes) || {};
} catch {}
const nuevo = JSON.parse(fs.readFileSync(datosPath, "utf8")).paquetes || {};

const ayer = new Date(Date.now() - 36 * 3600 * 1000).toISOString().slice(0, 10);
fs.mkdirSync(path.join(destino, "paquetes"), { recursive: true });
const files = {};
let fallidos = 0;
for (const [id, m] of Object.entries(nuevo)) {
  const igual = viejo[id] && viejo[id].hash === m.hash;
  if (igual && (m.generado || "") < ayer) continue;
  const salida = path.join(destino, "paquetes", `${id}.json`);
  try {
    execFileSync("curl", ["-fsS", "--retry", "3", "--retry-delay", "5", "-o", salida, `${RAW}/${encodeURIComponent(id)}.json`]);
    JSON.parse(fs.readFileSync(salida, "utf8"));
    files[`paquetes/${id}.json`] = salida;
  } catch {
    fallidos++;
  }
}
for (const id of Object.keys(viejo)) if (!nuevo[id]) files[`paquetes/${id}.json`] = null;

fs.writeFileSync(path.join(destino, "files.json"), JSON.stringify(files, null, 1));
const subir = Object.values(files).filter(Boolean).length;
const quitar = Object.values(files).filter((v) => v === null).length;
console.log(
  `PAQUETES: ${subir} por subir, ${quitar} por quitar${fallidos ? `, ${fallidos} no se pudieron bajar` : ""}. ` +
    `Mapa en ${path.join(destino, "files.json")}`,
);
