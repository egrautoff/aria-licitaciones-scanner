// Radar de licitaciones SECOP II para ARIA PSW.
// Consulta el dataset publico de SECOP II (datos.gov.co, Socrata p6dx-8zbt),
// filtra por las palabras clave del portafolio de ARIA y guarda data/latest.json.

const DATASET_URL = "https://www.datos.gov.co/resource/p6dx-8zbt.json";
const WINDOW_DAYS = 15;
// Umbral de "destacado": valor del contrato + que haya matcheado por una
// palabra clave fuerte (no las genericas de soporte/mesa de ayuda, que dan ruido).
const DESTACADO_VALOR_MIN = 1_000_000_000;
// Candidatos "exploratorios": procesos que NO calzan con las palabras clave
// estrictas (RULES) pero mencionan temas adyacentes al portafolio de ARIA.
// Se dejan sin juzgar aqui (eso lo hace la rutina diaria con criterio); esto
// solo acota el universo a un tamano razonable para esa revision.
const EXPLORATORIO_VALOR_MIN = 30_000_000;
const EXPLORATORIO_MAX_ITEMS = 40;
const BROAD_TERMS = [
  "inteligencia de negocios",
  "business intelligence",
  "tablero de control",
  "reportes gerenciales",
  "bodega de datos",
  "data warehouse",
  "gobierno de datos",
  "calidad de datos",
  "arquitectura de datos",
  "big data",
  "migracion a la nube",
  "arquitectura empresarial",
  "modernizacion tecnologica",
  "modernizacion de aplicaciones",
  "transformacion digital",
  "gobierno digital",
  "gestion documental",
  "fabrica de aplicaciones",
  "arquitectura de microservicios",
  "consultoria tecnologica",
  "consultoria ti",
];

const RULES = [
  { group: "Liferay / Portal", any: ["liferay"] },
  { group: "Liferay / Portal", all: ["portal web", "desarrollo"] },
  { group: "Liferay / Portal", any: ["gestor de contenidos"] },
  { group: "Liferay / Portal", any: ["portal transaccional"] },
  { group: "Liferay / Portal", any: ["intranet corporativa"] },
  { group: "Liferay / Portal", any: ["rediseno de portal"] },

  { group: "Desarrollo / Fabrica", any: ["fabrica de software"] },
  { group: "Desarrollo / Fabrica", any: ["desarrollo de software a la medida"] },
  { group: "Desarrollo / Fabrica", any: ["mantenimiento evolutivo"] },
  { group: "Desarrollo / Fabrica", all: ["desarrollo", "implementacion", "soporte"] },
  { group: "Desarrollo / Fabrica", any: ["mesa de ayuda", "soporte tecnico nivel 2", "soporte tecnico nivel 3"], weak: true },

  { group: "IA / Agentes", all: ["inteligencia artificial", "agentes"] },
  { group: "IA / Agentes", any: ["automatizacion de procesos"] },
  { group: "IA / Agentes", any: ["chatbot", "asistente virtual"] },
  { group: "IA / Agentes", all: ["analitica de datos", "inteligencia artificial"] },
  { group: "IA / Agentes", any: ["modelos de lenguaje", "llm"] },
  { group: "IA / Agentes", any: ["optimizacion seo"] },
  { group: "IA / Agentes", any: ["posicionamiento web"] },
  { group: "IA / Agentes", any: ["auditoria de contenido digital"] },

  { group: "Integracion / BUS", any: ["bus de servicios empresariales", "esb"] },
  { group: "Integracion / BUS", any: ["integracion tibco"] },
  { group: "Integracion / BUS", any: ["integracion de sistemas"] },
];

function norm(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function hasPhrase(normalizedText, phrase) {
  const p = norm(phrase);
  if (p.length <= 4) {
    return new RegExp(`\\b${p}\\b`, "i").test(normalizedText);
  }
  return normalizedText.includes(p);
}

function matchRules(text) {
  const t = norm(text);
  const matched = [];
  for (const rule of RULES) {
    const hit = rule.any
      ? rule.any.some((p) => hasPhrase(t, p))
      : rule.all.every((p) => hasPhrase(t, p));
    if (hit) {
      const kw = rule.any ? rule.any.find((p) => hasPhrase(t, p)) : rule.all.join(" + ");
      matched.push({ group: rule.group, keyword: kw, weak: !!rule.weak });
    }
  }
  return matched;
}

function uniqueSearchTerms() {
  const terms = new Set();
  for (const rule of RULES) {
    for (const p of rule.any || rule.all) terms.add(p);
  }
  return [...terms];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The dataset has ~5k new processes/day, so a plain date-window scan would need
// tens of thousands of rows. Instead we run one $q full-text search per keyword
// (which SECOP indexes) and merge the results — far fewer rows, same coverage,
// since the exact-phrase / AND logic re-checks every candidate locally.
async function fetchByTerms(terms) {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const sinceStr = since.toISOString().slice(0, 19);
  const byId = new Map();

  for (const term of terms) {
    const params = new URLSearchParams({
      "$where": `fecha_de_publicacion_del >= '${sinceStr}'`,
      "$q": term,
      "$order": "fecha_de_publicacion_del DESC",
      "$limit": "500",
    });
    const res = await fetch(`${DATASET_URL}?${params.toString()}`);
    if (!res.ok) {
      console.warn(`Aviso: busqueda "${term}" fallo con ${res.status}, se omite.`);
      continue;
    }
    const rows = await res.json();
    for (const row of rows) {
      const id = row.id_del_proceso || row.referencia_del_proceso;
      if (id) byId.set(id, row);
    }
    await sleep(250);
  }

  return byId;
}

function toItem(row, matched) {
  const valor = row.precio_base ? Number(row.precio_base) : null;
  const hasStrongMatch = matched.some((m) => !m.weak);
  return {
    id_proceso: row.id_del_proceso || row.referencia_del_proceso || null,
    fuente: "SECOP II",
    entidad: row.entidad || null,
    unspsc: row.codigo_principal_de_categoria || null,
    fecha_publicacion: row.fecha_de_publicacion_del || null,
    descripcion: row.descripci_n_del_procedimiento || row.nombre_del_procedimiento || null,
    valor,
    estado: row.estado_del_procedimiento || row.estado_resumen || null,
    modalidad: row.modalidad_de_contratacion || null,
    url: row.urlproceso && row.urlproceso.url ? row.urlproceso.url : null,
    matched_groups: [...new Set(matched.map((m) => m.group))],
    matched_keywords: matched.map((m) => m.keyword),
    destacado: !!(valor && valor >= DESTACADO_VALOR_MIN && hasStrongMatch),
  };
}

function matchBroadTerms(text) {
  const t = norm(text);
  return BROAD_TERMS.filter((term) => hasPhrase(t, term));
}

function toExploratorioItem(row, broadKeywords) {
  return {
    id_proceso: row.id_del_proceso || row.referencia_del_proceso || null,
    fuente: "SECOP II",
    entidad: row.entidad || null,
    unspsc: row.codigo_principal_de_categoria || null,
    fecha_publicacion: row.fecha_de_publicacion_del || null,
    descripcion: row.descripci_n_del_procedimiento || row.nombre_del_procedimiento || null,
    valor: row.precio_base ? Number(row.precio_base) : null,
    estado: row.estado_del_procedimiento || row.estado_resumen || null,
    modalidad: row.modalidad_de_contratacion || null,
    url: row.urlproceso && row.urlproceso.url ? row.urlproceso.url : null,
    matched_broad_keywords: broadKeywords,
  };
}

async function main() {
  const coreById = await fetchByTerms(uniqueSearchTerms());
  const seen = new Set();
  const items = [];

  for (const row of coreById.values()) {
    const id = row.id_del_proceso || row.referencia_del_proceso;
    if (!id || seen.has(id)) continue;

    const text = `${row.nombre_del_procedimiento || ""} ${row.descripci_n_del_procedimiento || ""}`;
    const matched = matchRules(text);
    if (matched.length === 0) continue;

    seen.add(id);
    items.push(toItem(row, matched));
  }

  items.sort((a, b) => (b.fecha_publicacion || "").localeCompare(a.fecha_publicacion || ""));

  // Segunda red, mas amplia: procesos que NO calzaron con RULES pero tocan
  // temas adyacentes al portafolio de ARIA (BI, datos, transformacion digital,
  // arquitectura empresarial...). Sin juzgar todavia — eso lo hace la rutina
  // diaria con criterio, aqui solo se acota el universo.
  const broadById = await fetchByTerms(BROAD_TERMS);
  const exploratorios = [];
  const seenExploratorio = new Set();
  for (const row of broadById.values()) {
    const id = row.id_del_proceso || row.referencia_del_proceso;
    if (!id || seen.has(id) || seenExploratorio.has(id)) continue;

    const text = `${row.nombre_del_procedimiento || ""} ${row.descripci_n_del_procedimiento || ""}`;
    const broadKeywords = matchBroadTerms(text);
    if (broadKeywords.length === 0) continue;

    const valor = row.precio_base ? Number(row.precio_base) : 0;
    if (valor < EXPLORATORIO_VALOR_MIN) continue;

    seenExploratorio.add(id);
    exploratorios.push(toExploratorioItem(row, broadKeywords));
  }
  exploratorios.sort((a, b) => (b.valor || 0) - (a.valor || 0));
  const candidatos_exploratorios = exploratorios.slice(0, EXPLORATORIO_MAX_ITEMS);

  const output = {
    generated_at: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    source_dataset: "datos.gov.co / p6dx-8zbt (SECOP II)",
    total_scanned: coreById.size + broadById.size,
    total_matched: items.length,
    total_destacados: items.filter((it) => it.destacado).length,
    items,
    candidatos_exploratorios,
  };

  const fs = await import("node:fs/promises");
  await fs.mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await fs.writeFile(
    new URL("../data/latest.json", import.meta.url),
    JSON.stringify(output, null, 2),
  );
  console.log(
    `Escaneados: ${output.total_scanned} | Coinciden: ${items.length} | Exploratorios: ${candidatos_exploratorios.length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
