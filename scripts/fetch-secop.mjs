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
// Red de seguridad estructural: el codigo UNSPSC no depende de como la entidad
// redacto el objeto, asi que atrapa lo que las palabras clave dejan pasar por
// diferencias de lenguaje. Solo dos familias sirven: medido contra la ventana
// real de 15 dias (64.960 procesos), 81.11 trae 734 y 43.23 trae 362, mientras
// que 80.11 (recursos humanos) trae 33.763 --- la mitad de todo SECOP, porque es
// el codigo que las entidades usan para cualquier contrato de prestacion de
// servicios. Con piso de $100M las dos familias utiles dan ~185 por ventana.
const UNSPSC_FAMILIAS = [
  { prefijo: "V1.8111", nombre: "81.11 servicios informaticos" },
  { prefijo: "V1.4323", nombre: "43.23 software" },
];
const UNSPSC_VALOR_MIN = 100_000_000;
// data/seen.json guarda, por proceso, unicamente dos fechas: cuando se vio por
// primera vez y cuando por ultima. No es un historial de los procesos --- eso
// solo se guarda para los que alguien marca como de interes, y vive en el
// tablero. Este registro existe para una sola cosa: poder decir "nuevo" con
// certeza, porque comparar contra la corrida anterior falla apenas se salte un dia.
const SEEN_RETENTION_DAYS = 180;
const BROAD_TERMS = [
  "tablero de control",
  "reportes gerenciales",
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
  // --- Liferay / Portal ---
  { group: "Liferay / Portal", any: ["liferay"] },
  { group: "Liferay / Portal", any: ["experiencia digital", "dxp"] },
  { group: "Liferay / Portal", all: ["portal web", "desarrollo"] },
  { group: "Liferay / Portal", all: ["portal web", "implementacion"] },
  { group: "Liferay / Portal", all: ["portal web", "migracion"] },
  { group: "Liferay / Portal", all: ["portal web", "suscripcion"] },
  { group: "Liferay / Portal", all: ["portal web", "licenciamiento"] },
  { group: "Liferay / Portal", all: ["portal web", "rediseno"] },
  { group: "Liferay / Portal", any: ["gestor de contenidos", "gestor de contenido web"] },
  { group: "Liferay / Portal", any: ["portal transaccional"] },
  { group: "Liferay / Portal", any: ["intranet corporativa"] },
  { group: "Liferay / Portal", any: ["rediseno de portal"] },
  { group: "Liferay / Portal", any: ["web master", "webmaster"] },
  { group: "Liferay / Portal", any: ["sede electronica"] },

  // --- Desarrollo / Fabrica ---
  { group: "Desarrollo / Fabrica", any: ["fabrica de software", "fabrica de aplicaciones"] },
  { group: "Desarrollo / Fabrica", any: ["desarrollo de software a la medida"] },
  { group: "Desarrollo / Fabrica", any: ["mantenimiento evolutivo", "mantenimiento adaptativo", "mantenimiento de aplicaciones"] },
  { group: "Desarrollo / Fabrica", any: ["ingenieria por demanda"] },
  { group: "Desarrollo / Fabrica", any: ["staffing"] },
  { group: "Desarrollo / Fabrica", all: ["desarrollo", "implementacion", "soporte"] },
  { group: "Desarrollo / Fabrica", any: ["mesa de ayuda", "soporte tecnico nivel 2", "soporte tecnico nivel 3"], weak: true },

  // --- IA / Agentes ---
  { group: "IA / Agentes", all: ["inteligencia artificial", "agentes"] },
  { group: "IA / Agentes", any: ["automatizacion de procesos"] },
  { group: "IA / Agentes", any: ["chatbot", "asistente virtual"] },
  { group: "IA / Agentes", all: ["analitica de datos", "inteligencia artificial"] },
  { group: "IA / Agentes", any: ["modelos de lenguaje", "llm"] },
  { group: "IA / Agentes", any: ["optimizacion seo"] },
  { group: "IA / Agentes", any: ["posicionamiento web"] },
  { group: "IA / Agentes", any: ["auditoria de contenido digital"] },

  // --- Integracion / BUS ---
  // El nombre del producto es la senal de mayor precision que existe: un proceso
  // que dice "TIBCO" es de ARIA casi con certeza. La regla anterior exigia la
  // frase "integracion tibco", que no aparece en ningun contrato real, y dejaba
  // ciego al radar frente a la linea de negocio mas grande de la empresa.
  { group: "Integracion / BUS", any: ["tibco"] },
  // En singular: los pliegos dicen "bus de servicios empresarial", no "empresariales".
  { group: "Integracion / BUS", any: ["bus de servicios", "esb"] },
  { group: "Integracion / BUS", any: ["integracion de sistemas"] },
  { group: "Integracion / BUS", any: ["interoperabilidad"], weak: true },
  // Sin la abreviatura "soa": con 3 letras engancha texto cualquiera (pesco
  // compra de mobiliario y gestion humana). Solo la frase completa.
  { group: "Integracion / BUS", any: ["arquitectura orientada a servicios"] },
  // Sin "mdm" por lo mismo: pesco suministro de material de laboratorio.
  { group: "Integracion / BUS", any: ["datos maestros", "gestion de datos maestros"] },

  // --- Nube / Plataforma ---
  { group: "Nube / Plataforma", any: ["azure"] },
  { group: "Nube / Plataforma", any: ["nube publica"] },

  // --- Analitica / BI ---
  // Categoria nueva. Era el hueco mas grande: el nucleo del portafolio de ARIA
  // (Teradata, Spotfire, bodegas de datos, BI) no tenia ni una regla.
  { group: "Analitica / BI", any: ["teradata"] },
  { group: "Analitica / BI", any: ["spotfire"] },
  { group: "Analitica / BI", any: ["jaspersoft"] },
  { group: "Analitica / BI", any: ["bodega de datos", "data warehouse"] },
  { group: "Analitica / BI", any: ["inteligencia de negocios", "business intelligence"] },
  { group: "Analitica / BI", any: ["analitica avanzada"] },
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

// Busqueda por codigo, no por texto: complementa a fetchByTerms, que solo ve
// procesos cuya redaccion contiene alguna de las frases buscadas.
async function fetchByUnspsc() {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const sinceStr = since.toISOString().slice(0, 19);
  const byId = new Map();

  for (const fam of UNSPSC_FAMILIAS) {
    const params = new URLSearchParams({
      "$where":
        `fecha_de_publicacion_del >= '${sinceStr}'` +
        ` AND starts_with(codigo_principal_de_categoria,'${fam.prefijo}')` +
        ` AND precio_base >= ${UNSPSC_VALOR_MIN}`,
      "$order": "precio_base DESC",
      "$limit": "500",
    });
    const res = await fetch(`${DATASET_URL}?${params.toString()}`);
    if (!res.ok) {
      console.warn(`Aviso: busqueda UNSPSC ${fam.prefijo} fallo con ${res.status}, se omite.`);
      continue;
    }
    for (const row of await res.json()) {
      const id = row.id_del_proceso || row.referencia_del_proceso;
      if (id && !byId.has(id)) byId.set(id, { row, fam });
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

// Las fechas se etiquetan en hora de Bogota, no UTC: quien consulta el radar
// esta en Colombia y "nuevos hoy" debe coincidir con su dia calendario.
function bogotaDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function diasEntre(desdeDia, hastaDia) {
  const ms = Date.parse(`${hastaDia}T00:00:00Z`) - Date.parse(`${desdeDia}T00:00:00Z`);
  if (!Number.isFinite(ms)) return 1;
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

async function leerJson(fs, url) {
  try {
    return JSON.parse(await fs.readFile(url, "utf8"));
  } catch {
    return null;
  }
}

// La primera corrida no tiene registro. En vez de marcar como nuevos los ~45
// procesos ya vigentes, se siembra el registro con el latest.json anterior.
async function cargarRegistro(fs, dataDir, hoy) {
  const registro = await leerJson(fs, new URL("seen.json", dataDir));
  if (registro && registro.procesos) return registro;

  const previo = await leerJson(fs, new URL("latest.json", dataDir));
  const procesos = {};
  if (previo) {
    const dia = previo.generated_at ? bogotaDay(new Date(previo.generated_at)) : hoy;
    for (const it of [...(previo.items || []), ...(previo.candidatos_exploratorios || [])]) {
      if (it.id_proceso) procesos[it.id_proceso] = { primera_vez: dia, ultima_vez: dia, sembrado: true };
    }
  }
  return { actualizado: null, procesos };
}

function aplicarHistorial(lista, registro, hoy) {
  let nuevos = 0;
  for (const it of lista) {
    if (!it.id_proceso) continue;
    const previo = registro.procesos[it.id_proceso];
    const primera = previo ? previo.primera_vez : hoy;
    // Un proceso sembrado al crear el registro ya estaba en el radar antes de
    // que existiera el historial: no se puede declarar nuevo aunque su
    // primera_vez coincida con hoy.
    const sembrado = !!(previo && previo.sembrado);
    registro.procesos[it.id_proceso] = sembrado
      ? { primera_vez: primera, ultima_vez: hoy, sembrado: true }
      : { primera_vez: primera, ultima_vez: hoy };
    it.primera_vez_visto = primera;
    it.dias_en_radar = diasEntre(primera, hoy);
    it.es_nuevo = primera === hoy && !sembrado;
    if (it.es_nuevo) nuevos++;
  }
  return nuevos;
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

  // Segunda pasada: por codigo UNSPSC. Se marcan debiles a proposito --- estar en
  // la familia correcta hace que valga la pena mirarlo, no que sea prioritario,
  // asi que por si solo no puede convertir un proceso en "destacado".
  const porUnspsc = await fetchByUnspsc();
  for (const { row, fam } of porUnspsc.values()) {
    const id = row.id_del_proceso || row.referencia_del_proceso;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push(toItem(row, [{ group: "Codigo UNSPSC", keyword: fam.nombre, weak: true }]));
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

  const fs = await import("node:fs/promises");
  const dataDir = new URL("../data/", import.meta.url);
  await fs.mkdir(dataDir, { recursive: true });

  const hoy = bogotaDay();
  const registro = await cargarRegistro(fs, dataDir, hoy);
  const total_nuevos = aplicarHistorial(items, registro, hoy);
  aplicarHistorial(candidatos_exploratorios, registro, hoy);

  const output = {
    generated_at: new Date().toISOString(),
    dia: hoy,
    window_days: WINDOW_DAYS,
    source_dataset: "datos.gov.co / p6dx-8zbt (SECOP II)",
    total_scanned: coreById.size + broadById.size + porUnspsc.size,
    total_matched: items.length,
    total_destacados: items.filter((it) => it.destacado).length,
    total_nuevos,
    items,
    candidatos_exploratorios,
  };

  await fs.writeFile(new URL("latest.json", dataDir), JSON.stringify(output, null, 2));

  // El registro solo conserva procesos vistos dentro de la ventana de retencion,
  // asi seen.json no crece sin limite.
  const limiteRegistro = Date.parse(`${hoy}T00:00:00Z`) - SEEN_RETENTION_DAYS * 86400000;
  registro.procesos = Object.fromEntries(
    Object.entries(registro.procesos).filter(
      ([, v]) => Date.parse(`${v.ultima_vez}T00:00:00Z`) >= limiteRegistro,
    ),
  );
  registro.actualizado = output.generated_at;
  await fs.writeFile(new URL("seen.json", dataDir), JSON.stringify(registro, null, 2));

  console.log(
    `Escaneados: ${output.total_scanned} | Coinciden: ${items.length} (${total_nuevos} nuevos) | Exploratorios: ${candidatos_exploratorios.length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
