// Correo de error cuando la rutina no pudo bajar los datos.
// Uso: node correo-error.mjs <html> <motivo> <salida>
import fs from "node:fs";

const [htmlPath, motivo, salida] = process.argv.slice(2);
const TABLERO = "https://claude.ai/code/artifact/03d2c973-94be-4bea-91ab-99f2af2b4c27";
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let ultima = "no se pudo determinar";
try {
  const m = fs.readFileSync(htmlPath, "utf8").match(/const DATA = ([\s\S]*?);\n\/\* DATA_BLOCK_END/);
  const d = JSON.parse(m[1]);
  const cuando = d.generated_at
    ? new Date(d.generated_at).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "long", timeStyle: "short" })
    : null;
  ultima = cuando ? `${cuando} (hora Colombia), datos del ${d.dia}` : `datos del ${d.dia}`;
} catch {}

const cuerpo =
  `<div style="font-family:Arial,sans-serif;font-size:13px;color:#222">` +
  `<p><b>Error en el Radar SECOP:</b> esta corrida no pudo descargar los datos de SECOP, así que no hay procesos nuevos que reportar y el tablero no se actualizó.</p>` +
  `<p>Detalle: ${esc(motivo)}</p>` +
  `<p>Última revisión exitosa: ${esc(ultima)}. El tablero sigue mostrando esa información.</p>` +
  `<p>La próxima corrida lo intentará de nuevo automáticamente.</p>` +
  `<p>Tablero: <a href="${TABLERO}">${TABLERO}</a></p></div>`;

fs.writeFileSync(salida, cuerpo);
const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
console.log(`ASUNTO: ERROR Radar SECOP ${hoy}: no se pudieron descargar los datos`);
