// Correo del radar: elige candidatos nuevos frente al tablero publicado y arma el HTML.
// Uso: node correo.mjs candidatos <html> <datos.json> <razones.json>
//      node correo.mjs armar <html> <datos.json> <razones.json> <relevantes.json> <salida>
import fs from "node:fs";

const [modo, htmlPath, datosPath, razonesPath, relevantesPath, salida] = process.argv.slice(2);
const TABLERO = "https://claude.ai/code/artifact/03d2c973-94be-4bea-91ab-99f2af2b4c27";

const m = fs.readFileSync(htmlPath, "utf8").match(/const DATA = ([\s\S]*?);\n\/\* DATA_BLOCK_END/);
if (!m) {
  console.error("ERROR: no se encontro el bloque DATA en el tablero anterior.");
  process.exit(1);
}
const antes = JSON.parse(m[1]);
const yaReportados = new Set([...(antes.items || []), ...(antes.oportunidades || [])].map((i) => i.id_proceso));

const d = JSON.parse(fs.readFileSync(datosPath, "utf8"));
const razones = new Map(JSON.parse(fs.readFileSync(razonesPath, "utf8")).map((r) => [r.id_proceso, r.razon]));

const categoria = (it) => (/solicitud de informaci/i.test(it.modalidad || "") ? "RFI" : "RFP");
const abierto = (it) => /public|present|abiert|convocad|borrador/i.test(it.estado || "");
const soloUnspsc = (it) => (it.matched_groups || []).length === 1 && it.matched_groups[0] === "Codigo UNSPSC";

const nuevos = [
  ...d.items.filter((it) => !soloUnspsc(it)).map((it) => ({ ...it, kw: it.matched_keywords || [] })),
  ...(d.candidatos_exploratorios || [])
    .filter((c) => razones.has(c.id_proceso))
    .map((c) => ({ ...c, kw: c.matched_broad_keywords || [], matched_groups: ["Otras oportunidades"] })),
]
  .filter((it) => !yaReportados.has(it.id_proceso))
  .map((it) => ({ ...it, cat: categoria(it) }));
const elegibles = nuevos.filter(abierto).sort((a, b) => (b.valor || 0) - (a.valor || 0));

if (modo === "candidatos") {
  console.log(`NUEVOS: ${nuevos.length} desde el reporte anterior, ${elegibles.length} siguen abiertos.`);
  for (const it of elegibles)
    console.log(
      JSON.stringify({
        id: it.id_proceso,
        cat: it.cat,
        entidad: it.entidad,
        valor: it.valor,
        modalidad: it.modalidad,
        grupos: it.matched_groups,
        kw: it.kw,
        destacado: !!it.destacado,
        desc: (it.descripcion || "").slice(0, 350),
      }),
    );
  process.exit(0);
}

if (modo !== "armar") {
  console.error("ERROR: modo debe ser 'candidatos' o 'armar'.");
  process.exit(1);
}

const porId = new Map(elegibles.map((it) => [it.id_proceso, it]));
const elegidos = [];
for (const r of JSON.parse(fs.readFileSync(relevantesPath, "utf8"))) {
  const it = porId.get(r.id_proceso);
  if (!it) console.warn(`Aviso: ${r.id_proceso} no esta entre los elegibles, se omite.`);
  else if (!elegidos.some((e) => e.id_proceso === it.id_proceso)) elegidos.push({ ...it, porque: r.razon });
}
elegidos.sort((a, b) => (a.cat === b.cat ? (b.valor || 0) - (a.valor || 0) : a.cat === "RFP" ? -1 : 1));
elegidos.splice(10);

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cop = (n) => (n > 0 ? "$" + Math.round(n).toLocaleString("es-CO") : "Sin valor publicado");
const corto = (s, n) => (s && s.length > n ? s.slice(0, n).trimEnd() + "…" : s || "");

const td = 'valign="top"';
const fila = (it) =>
  `<tr><td ${td}><b>${it.cat}</b></td><td ${td}>${esc(it.entidad)}</td>` +
  `<td ${td}>${esc(corto(it.descripcion, 300))}${it.porque ? `<br><i>Por qué: ${esc(it.porque)}</i>` : ""}</td>` +
  `<td ${td}>${esc(it.kw.join(", "))}</td><td ${td} nowrap>${cop(it.valor)}</td>` +
  `<td ${td}><a href="${esc(it.url)}">Ver</a></td><td ${td} nowrap>${esc((it.fecha_publicacion || "").slice(0, 10))}</td></tr>`;
const th = (t) => `<th align="left" bgcolor="#f2f2f2">${t}</th>`;

const rfp = elegidos.filter((i) => i.cat === "RFP").length;
const rfi = elegidos.length - rfp;
const intro = !nuevos.length
  ? `No entraron procesos nuevos al radar desde el reporte anterior.`
  : elegidos.length
    ? `Desde el reporte anterior entraron ${nuevos.length} procesos nuevos al radar. Estos ${elegidos.length} son los más relevantes para ARIA por afinidad con nuestro portafolio y valor del contrato (${rfp} RFP, ${rfi} RFI).`
    : `Desde el reporte anterior entraron ${nuevos.length} procesos nuevos al radar, pero ninguno es relevante para ARIA (ya adjudicados, contratos con personas naturales o fuera de nuestro portafolio).`;

const cuerpo =
  `<div style="font-family:Arial,sans-serif;font-size:13px;color:#222">` +
  `<p>Radar SECOP · dato del ${esc(d.dia)}</p><p>${intro}</p>` +
  (elegidos.length
    ? `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;border-color:#ddd;font-size:12px"><tr>${["Tipo", "Entidad", "Objeto", "Palabras clave", "Monto", "Link", "Publicación"].map(th).join("")}</tr>` +
      elegidos.map(fila).join("") +
      `</table>`
    : "") +
  `<p>El detalle de todos los procesos (${d.items.length} en el radar) está en el tablero: <a href="${TABLERO}">${TABLERO}</a></p></div>`;

fs.writeFileSync(salida, cuerpo);
console.log(`ASUNTO: Radar SECOP ${d.dia}: ${elegidos.length} relevantes de ${nuevos.length} nuevos`);
console.log(`OK: ${elegidos.length} procesos en el correo, ${cuerpo.length} caracteres.`);
