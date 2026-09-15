// Arma el tablero sin que los datos pasen por el modelo.
//
// Por que existe: el bloque DATA son ~195.000 caracteres (218 procesos). Pedirle
// a la rutina que los transcriba es caro y fragil --- se trunca o se corrompe, y
// un solo caracter mal copiado rompe el tablero para todo el equipo. Aqui el
// modelo solo aporta las razones de las oportunidades, que son cuatro frases.
//
//   node armar-dashboard.mjs <html-actual> <datos.json> <razones.json> <salida>
//
// razones.json: [{ "id_proceso": "CO1.REQ.123", "razon": "..." }]

import fs from "node:fs";

const [htmlPath, datosPath, razonesPath, salida] = process.argv.slice(2);
if (!htmlPath || !datosPath || !razonesPath || !salida) {
  console.error("Uso: node armar-dashboard.mjs <html> <datos.json> <razones.json> <salida>");
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, "utf8");
const d = JSON.parse(fs.readFileSync(datosPath, "utf8"));
const razones = JSON.parse(fs.readFileSync(razonesPath, "utf8"));

const porId = new Map((d.candidatos_exploratorios || []).map((c) => [c.id_proceso, c]));
const oportunidades = [];
const huerfanas = [];
for (const r of razones) {
  const c = porId.get(r.id_proceso);
  if (c) oportunidades.push({ ...c, razon: r.razon });
  else huerfanas.push(r.id_proceso);
}
if (huerfanas.length) console.warn(`Aviso: ids sin candidato, se omiten: ${huerfanas.join(", ")}`);

const DATA = {
  generated_at: d.generated_at,
  dia: d.dia,
  window_days: d.window_days,
  source_dataset: d.source_dataset,
  total_scanned: d.total_scanned,
  total_matched: d.total_matched,
  total_destacados: d.total_destacados,
  total_nuevos: d.total_nuevos,
  items: d.items,
  oportunidades,
  parametros: d.parametros,
};

const marca = /\/\* DATA_BLOCK_START \*\/[\s\S]*?\/\* DATA_BLOCK_END \*\//;
if (!marca.test(html)) {
  console.error("ERROR: no se encontro el bloque DATA en el HTML. No se escribe nada.");
  process.exit(1);
}
// La funcion en el reemplazo es obligatoria: sin ella, un "$&" o "$1" dentro de
// una descripcion de SECOP se interpretaria como referencia y corromperia el JSON.
const bloque =
  "/* DATA_BLOCK_START */\nconst DATA = " + JSON.stringify(DATA) + ";\n/* DATA_BLOCK_END */";
const resultado = html.replace(marca, () => bloque);

// Verificacion antes de escribir: el resto del tablero tiene que seguir intacto.
for (const senal of ["itemsVisibles", "alternarSeguimiento", "renderFrescura", "cablearFiltros"]) {
  if (!resultado.includes(senal)) {
    console.error(`ERROR: falta "${senal}" en el resultado; el HTML quedo mal. No se escribe nada.`);
    process.exit(1);
  }
}
const comprobar = resultado.match(marca)[0];
JSON.parse(comprobar.slice(comprobar.indexOf("{"), comprobar.lastIndexOf("}") + 1));

fs.writeFileSync(salida, resultado);
console.log(
  `OK: ${DATA.items.length} procesos, ${oportunidades.length} oportunidades, dia ${DATA.dia}, ${resultado.length} caracteres.`,
);
