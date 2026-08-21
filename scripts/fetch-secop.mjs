#!/usr/bin/env node
// Consulta el dataset abierto de SECOP II (Colombia Compra Eficiente) en datos.gov.co
// y devuelve, en JSON por stdout, los procesos publicados desde `--since` cuyo
// objeto/nombre coincide con alguna palabra clave del portafolio de ARIA PSW.

const SECOP_II_URL = "https://www.datos.gov.co/resource/p6dx-8zbt.json";

const KEYWORDS = [
  "ANALITICA",
  "INTELIGENCIA DE NEGOCIOS",
  "BUSINESS INTELLIGENCE",
  "TIBCO",
  "TERADATA",
  "LIFERAY",
  "BIG DATA",
  "DATA WAREHOUSE",
  "BODEGA DE DATOS",
];

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, ...v] = a.replace(/^--/, "").split("=");
      return [k, v.join("=")];
    })
  );
  if (!args.since) {
    throw new Error("Uso: fetch-secop.mjs --since=YYYY-MM-DDT00:00:00");
  }
  return args;
}

function buildWhereClause(since) {
  const keywordClause = KEYWORDS.map(
    (kw) =>
      `(upper(descripci_n_del_procedimiento) like '%${kw}%' OR upper(nombre_del_procedimiento) like '%${kw}%')`
  ).join(" OR ");
  return `fecha_de_publicacion_del >= '${since}' AND (${keywordClause})`;
}

async function main() {
  const { since, limit = "1000" } = parseArgs();
  const where = buildWhereClause(since);
  const url = `${SECOP_II_URL}?$where=${encodeURIComponent(where)}&$limit=${limit}&$order=fecha_de_publicacion_del DESC`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`SECOP II API respondió ${res.status}: ${await res.text()}`);
  }
  const rows = await res.json();

  const results = rows.map((r) => ({
    id_proceso: r.id_del_proceso ?? null,
    entidad: r.entidad ?? null,
    nombre: r.nombre_del_procedimiento ?? null,
    descripcion: r.descripci_n_del_procedimiento ?? null,
    fecha_publicacion: r.fecha_de_publicacion_del ?? null,
    valor_estimado: r.precio_base ?? null,
    modalidad: r.modalidad_de_contratacion ?? null,
    estado: r.estado_del_procedimiento ?? null,
    unspsc: r.codigo_principal_de_categoria ?? null,
    url_proceso: r.urlproceso?.url ?? r.urlproceso ?? null,
  }));

  process.stdout.write(JSON.stringify({
    fetched_at: new Date().toISOString(),
    since,
    count: results.length,
    items: results,
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
