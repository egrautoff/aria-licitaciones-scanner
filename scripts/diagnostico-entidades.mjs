// Diagnostico de una sola vez: entidades que llegan en las alertas como "No SECOP"
// pero que si publican en SECOP II. Para cada una trae sus procesos recientes del
// dataset y dice si las palabras clave del radar los habrian capturado, para
// separar "no estan en SECOP" de "estan, pero ninguna regla los toca".
//
//   node scripts/diagnostico-entidades.mjs [dias]   (por defecto 60)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const DATASET_URL = "https://www.datos.gov.co/resource/p6dx-8zbt.json";
const DIAS = Number(process.argv[2]) || 60;
const CFG = JSON.parse(readFileSync(new URL("../config/parametros.json", import.meta.url), "utf8"));

// Cada entidad: lista de alternativas; cada alternativa, fragmentos que deben
// aparecer todos en el nombre. Sin tildes, porque SECOP las escribe a veces si y
// a veces no, y un fragmento sin la letra acentuada calza en ambos casos.
const ENTIDADES = [
  { n: 6, nombre: "Fiduprevisora", buscar: [["FIDUCIARIA LA PREVISORA"], ["FIDUPREVISORA"]] },
  { n: 7, nombre: "Fiducoldex", buscar: [["FIDUCOLDEX"], ["FIDUCIARIA COLOMBIANA DE COMERCIO"]] },
  { n: 9, nombre: "La Previsora Seguros", buscar: [["PREVISORA", "SEGUROS"], ["PREVISORA", "COMPA"]] },
  { n: 16, nombre: "Loteria de Medellin", buscar: [["LOTER", "MEDELL"]] },
  { n: 31, nombre: "Puerta de Oro", buscar: [["PUERTA DE ORO"]] },
  { n: 36, nombre: "SATENA", buscar: [["SATENA"], ["TERRITORIOS NACIONALES"]] },
  { n: 37, nombre: "Hospital Manuel Uribe Angel", buscar: [["MANUEL URIBE"]] },
  { n: 40, nombre: "Afinia (Caribemar)", buscar: [["CARIBEMAR"], ["AFINIA"]] },
  { n: 42, nombre: "Aguas de Manizales", buscar: [["AGUAS DE MANIZALES"]] },
  { n: 43, nombre: "Energia de Pereira", buscar: [["ENERG", "PEREIRA"]] },
  { n: 52, nombre: "SINCHI", buscar: [["SINCHI"], ["AMAZ", "INVESTIGACIONES CIENT"]] },
  { n: 53, nombre: "Univalle", buscar: [["UNIVERSIDAD DEL VALLE"]] },
  { n: 59, nombre: "Universidad de Cordoba", buscar: [["UNIVERSIDAD DE C", "RDOBA"]] },
];

// Copia de la logica de coincidencia de fetch-secop.mjs. Este script es de una
// sola vez; si se vuelve permanente, conviene sacar estas funciones a un modulo.
const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function hasPhrase(t, phrase) {
  const p = norm(phrase);
  return p.length <= 4 ? new RegExp(`\\b${p}\\b`, "i").test(t) : t.includes(p);
}
function reglas(texto) {
  const t = norm(texto);
  return CFG.reglas
    .filter((r) => (r.cualquiera ? r.cualquiera.some((p) => hasPhrase(t, p)) : r.todas.every((p) => hasPhrase(t, p))))
    .map((r) => `${r.grupo}: ${r.cualquiera ? r.cualquiera.find((p) => hasPhrase(t, p)) : r.todas.join(" + ")}`);
}
const amplios = (texto) => CFG.terminos_amplios.filter((term) => hasPhrase(norm(texto), term));

const condicion = (alternativas) =>
  "(" +
  alternativas
    .map((frags) => "(" + frags.map((f) => `upper(entidad) like '%${f.replace(/'/g, "''")}%'`).join(" AND ") + ")")
    .join(" OR ") +
  ")";

const latest = JSON.parse(readFileSync(new URL("../data/latest.json", import.meta.url), "utf8"));
const enRadar = new Set([...(latest.items || []), ...(latest.candidatos_exploratorios || [])].map((i) => i.id_proceso));

const desde = new Date(Date.now() - DIAS * 86400000).toISOString().slice(0, 19);
const resultado = { generado: new Date().toISOString(), dias: DIAS, entidades: [] };

for (const e of ENTIDADES) {
  const params = new URLSearchParams({
    $where: `fecha_de_publicacion_del >= '${desde}' AND ${condicion(e.buscar)}`,
    $order: "fecha_de_publicacion_del DESC",
    $limit: "300",
  });
  const res = await fetch(`${DATASET_URL}?${params}`);
  if (!res.ok) {
    resultado.entidades.push({ ...e, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` });
    continue;
  }
  const filas = await res.json();
  const procesos = filas.map((r) => {
    const texto = `${r.nombre_del_procedimiento || ""} ${r.descripci_n_del_procedimiento || ""}`;
    const id = r.id_del_proceso || r.referencia_del_proceso;
    return {
      id,
      entidad_secop: r.entidad,
      fecha: (r.fecha_de_publicacion_del || "").slice(0, 10),
      modalidad: r.modalidad_de_contratacion,
      estado: r.estado_del_procedimiento,
      valor: r.precio_base ? Number(r.precio_base) : null,
      unspsc: r.codigo_principal_de_categoria,
      objeto: (r.descripci_n_del_procedimiento || r.nombre_del_procedimiento || "").slice(0, 300),
      reglas: reglas(texto),
      amplios: amplios(texto),
      en_radar_hoy: enRadar.has(id),
    };
  });
  resultado.entidades.push({
    n: e.n,
    nombre: e.nombre,
    nombres_en_secop: [...new Set(procesos.map((p) => p.entidad_secop))],
    total: procesos.length,
    con_regla: procesos.filter((p) => p.reglas.length).length,
    solo_amplios: procesos.filter((p) => !p.reglas.length && p.amplios.length).length,
    en_radar_hoy: procesos.filter((p) => p.en_radar_hoy).length,
    procesos,
  });
  await new Promise((r) => setTimeout(r, 300));
}

mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
writeFileSync(new URL("../data/diagnostico-entidades.json", import.meta.url), JSON.stringify(resultado, null, 2));
for (const e of resultado.entidades)
  console.log(
    e.error
      ? `${e.nombre}: ERROR ${e.error}`
      : `${e.nombre}: ${e.total} procesos en ${DIAS} dias | con regla ${e.con_regla} | solo amplios ${e.solo_amplios} | en radar hoy ${e.en_radar_hoy} | nombres: ${e.nombres_en_secop.join(" / ")}`,
  );
