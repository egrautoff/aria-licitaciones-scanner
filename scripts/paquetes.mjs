// Paquetes de lectura para el boton "Analizar con IA" del tablero.
//
// El tablero no puede llegar a SECOP (el navegador bloquea otros dominios), asi
// que los documentos se preparan aqui, de noche, y la rutina los publica como
// archivos del propio tablero. Cuando alguien hace clic, la pagina le manda el
// paquete a Claude por partes y consolida.
//
// Principio: la IA lee el pliego COMPLETO, no recortes. Lo unico que se quita es
// lo que no aporta contenido:
//   - documentos administrativos, analisis del sector y cotizaciones, SOLO si el
//     proceso tiene pliego o invitacion (si no, son lo unico que hay y se leen);
//   - encabezados y pies de pagina que se repiten en cada hoja;
//   - frases identicas que ya estan en un documento de mayor autoridad (el
//     proyecto de pliego queda reducido a lo que cambio frente al definitivo).
// Lo que queda se parte en bloques que caben en una consulta (~256 KiB), sin
// cortar nunca una pagina.
//
// Eficiencia: un proceso se vuelve a armar solo si cambio su lista de
// documentos (consulta que no descarga nada). El OCR corre solo sobre las
// PAGINAS sin texto, no sobre documentos enteros. Hay un tope de minutos por
// corrida; lo que no alcance sigue en la corrida siguiente.
//
// Depende de pdftotext/pdftoppm (poppler-utils), tesseract-ocr (+spa) y unzip.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

const DS = "https://www.datos.gov.co/resource";
const raiz = new URL("../", import.meta.url).pathname;
const CFG = JSON.parse(readFileSync(path.join(raiz, "config/parametros.json"), "utf8"));
const P = {
  excluir_modalidades: ["Contratación directa"],
  limite_parte_kb: 240,
  max_minutos: 35,
  concurrencia: 4,
  retencion_dias: 30,
  max_paginas_ocr: 200,
  ...(CFG.paquetes || {}),
};
const dirPaq = path.join(raiz, "data/paquetes");
const datosPath = path.join(raiz, "data/latest.json");
const INICIO = Date.now();
const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });

// El portal de SECOP esta detras de un Azure Application Gateway que responde
// 403 al agente por defecto. Con un agente de navegador entrega el archivo.
const AGENTE =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const sha = (s) => createHash("sha1").update(s).digest("hex");
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Clasificacion por nombre. El orden es la autoridad: arriba manda. -------
const TIPOS = [
  ["adenda", /adenda/],
  ["respuesta_observaciones", /respuesta|observaci/],
  ["pliego_definitivo", /definitiv/],
  ["proyecto_pliego", /pliego/],
  ["invitacion", /invitaci/],
  ["estudios_previos", /estudios?.{0,3}prev|estudio_prev/],
  ["anexo_tecnico", /anexo.{0,3}tecnic|ficha tecnic|especificacion/],
  ["formatos_anexos", /anexo|formato|matriz.{0,3}\d|experiencia/],
  ["acto_apertura", /apertura|aviso|convocatoria/],
  ["analisis_sector", /analisis.{0,6}(del )?sector|estudio.{0,6}(de )?mercado|analisis.{0,3}econ|estudio.{0,3}econ/],
  ["matriz_riesgos", /riesgo/],
  ["cotizacion", /cotizaci|propuesta/],
  [
    "administrativo",
    /cdp|crp|certificad|constancia|designaci|oficio|solicitud|libreta|redam|antecedentes|sarlaft|renta|bancaria|salud|factura|acta de inicio|memorando|disponibilidad|resoluci/,
  ],
];
const ORDEN = [...TIPOS.map((t) => t[0]), "otro"];
// Se saltan solo cuando hay pliego o invitacion: no obligan al oferente.
const CONDICIONALES = new Set(["analisis_sector", "matriz_riesgos", "cotizacion", "administrativo"]);

function tipoDe(nombre) {
  const n = norm(nombre);
  // Un documento que habla de requisitos se lee siempre, se llame como se llame.
  if (/indicador|habilitante|requisito|experiencia/.test(n) && !/definitiv|proyecto|pliego/.test(n)) {
    return "formatos_anexos";
  }
  for (const [t, rx] of TIPOS) if (rx.test(n)) return t;
  return "otro";
}

const EXT_LEGIBLES = new Set(["pdf", "docx", "xlsx", "xlsm", "odt", "zip", "jpg", "jpeg", "png", "tif", "tiff", "txt", "csv"]);

// --- Datos abiertos --------------------------------------------------------
async function pedirJson(url, intentos = 3) {
  for (let i = 0; i < intentos; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j)) return j;
      }
    } catch {}
    await espera(2000 * (i + 1));
  }
  return null;
}

async function listarDocumentos(portafolio) {
  const q = new URLSearchParams({ proceso: portafolio, $limit: "500" });
  const filas = await pedirJson(`${DS}/dmgg-8hin.json?${q}`);
  if (!filas) return null;
  const vistos = new Set();
  const docs = [];
  for (const f of filas) {
    // Los que traen numero de contrato son de la ejecucion, no de la seleccion.
    if (f.n_mero_de_contrato) continue;
    const url = typeof f.url_descarga_documento === "object" ? f.url_descarga_documento?.url : f.url_descarga_documento;
    if (!url) continue;
    const clave = `${f.nombre_archivo}|${f.tamanno_archivo}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    docs.push({
      nombre: f.nombre_archivo || "documento",
      ext: norm(f.extensi_n || path.extname(f.nombre_archivo || "").slice(1)).replace(/^\./, ""),
      bytes: Number(f.tamanno_archivo) || 0,
      fecha: (f.fecha_carga || "").slice(0, 10),
      url,
    });
  }
  return docs;
}

async function descargar(url, destino) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": AGENTE }, signal: AbortSignal.timeout(300000) });
      if (r.ok) {
        writeFileSync(destino, Buffer.from(await r.arrayBuffer()));
        return true;
      }
    } catch {}
    await espera(4000 * (i + 1));
  }
  return false;
}

// --- Texto ----------------------------------------------------------------
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], ...opts });

let paginasOcr = 0;
function ocrImagen(img) {
  try {
    return sh("tesseract", [img, "-", "-l", "spa", "--psm", "6"], { timeout: 120000 });
  } catch {
    return "";
  }
}

// Devuelve [{num, texto}] por pagina. Las paginas sin texto se pasan por OCR.
function textoPdf(archivo, tmp, nota) {
  let crudo = "";
  try {
    crudo = sh("pdftotext", ["-layout", "-enc", "UTF-8", archivo, "-"], { timeout: 180000 });
  } catch {
    return [];
  }
  const paginas = crudo.split("\f").map((t, i) => ({ num: i + 1, texto: t }));
  if (paginas.length && !paginas[paginas.length - 1].texto.trim()) paginas.pop();
  for (const p of paginas) {
    if (p.texto.replace(/\s/g, "").length >= 40) continue;
    if (paginasOcr >= P.max_paginas_ocr) {
      nota.ocr_incompleto = true;
      continue;
    }
    const base = path.join(tmp, `ocr-${p.num}`);
    try {
      sh("pdftoppm", ["-f", String(p.num), "-l", String(p.num), "-r", "200", "-gray", "-png", "-singlefile", archivo, base], {
        timeout: 120000,
      });
      const t = ocrImagen(`${base}.png`);
      if (t.trim()) {
        p.texto = t;
        nota.ocr_paginas = (nota.ocr_paginas || 0) + 1;
      }
      paginasOcr++;
    } catch {}
  }
  return paginas;
}

const entidades = (s) =>
  s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

function textoZipXml(archivo, interno, finParrafo) {
  try {
    const xml = sh("unzip", ["-p", archivo, interno]);
    return entidades(xml.replace(finParrafo, "\n").replace(/<w:tab\/>|<\/w:tc>|<\/c>/g, " | ").replace(/<[^>]+>/g, ""));
  } catch {
    return "";
  }
}

function textoXlsx(archivo) {
  let comunes = [];
  try {
    const ss = sh("unzip", ["-p", archivo, "xl/sharedStrings.xml"]);
    comunes = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => entidades(m[1].replace(/<[^>]+>/g, "")));
  } catch {}
  let hojas = [];
  try {
    hojas = sh("unzip", ["-Z1", archivo]).split("\n").filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  } catch {}
  const salida = [];
  for (const h of hojas.sort()) {
    salida.push(`== ${h.replace(/.*\//, "").replace(".xml", "")} ==`);
    let xml = "";
    try {
      xml = sh("unzip", ["-p", archivo, h]);
    } catch {
      continue;
    }
    for (const fila of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const celdas = [];
      for (const c of fila[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const v = c[2].match(/<v>([\s\S]*?)<\/v>/);
        const t = c[2].match(/<t[^>]*>([\s\S]*?)<\/t>/);
        if (/t="s"/.test(c[1]) && v) celdas.push(comunes[Number(v[1])] ?? "");
        else if (t) celdas.push(entidades(t[1]));
        else if (v) celdas.push(v[1]);
      }
      if (celdas.some((x) => String(x).trim())) salida.push(celdas.join(" | "));
    }
  }
  return salida.join("\n");
}

// Un archivo -> lista de documentos [{nombre, paginas:[{num, texto}], nota}]
function leerArchivo(archivo, nombre, ext, tmp, profundidad = 0) {
  const nota = {};
  if (ext === "pdf") return [{ nombre, paginas: textoPdf(archivo, tmp, nota), nota }];
  if (ext === "docx") return [{ nombre, paginas: [{ num: null, texto: textoZipXml(archivo, "word/document.xml", /<\/w:p>/g) }], nota }];
  if (ext === "odt") return [{ nombre, paginas: [{ num: null, texto: textoZipXml(archivo, "content.xml", /<\/text:p>|<\/text:h>/g) }], nota }];
  if (ext === "xlsx" || ext === "xlsm") return [{ nombre, paginas: [{ num: null, texto: textoXlsx(archivo) }], nota }];
  if (ext === "txt" || ext === "csv") return [{ nombre, paginas: [{ num: null, texto: readFileSync(archivo, "utf8") }], nota }];
  if (["jpg", "jpeg", "png", "tif", "tiff"].includes(ext)) {
    nota.ocr_paginas = 1;
    paginasOcr++;
    return [{ nombre, paginas: [{ num: 1, texto: ocrImagen(archivo) }], nota }];
  }
  if (ext === "zip" && profundidad < 2) {
    const dir = path.join(tmp, `zip-${sha(archivo).slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    try {
      sh("unzip", ["-o", "-qq", archivo, "-d", dir], { timeout: 120000 });
    } catch {}
    const salida = [];
    const recorrer = (d) => {
      for (const f of readdirSync(d)) {
        const full = path.join(d, f);
        if (statSync(full).isDirectory()) recorrer(full);
        else {
          const e = norm(path.extname(f).slice(1));
          if (EXT_LEGIBLES.has(e)) salida.push(...leerArchivo(full, `${nombre} > ${path.relative(dir, full)}`, e, tmp, profundidad + 1));
        }
      }
    };
    recorrer(dir);
    return salida;
  }
  return [{ nombre, paginas: [], nota: { no_legible: `formato ${ext || "desconocido"}` } }];
}

// --- Compactacion (sin perder contenido) ------------------------------------
function limpiar(paginas) {
  const con = paginas.filter((p) => p.texto && p.texto.trim());
  const cuenta = new Map();
  for (const p of con) {
    const lineas = new Set(p.texto.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean));
    for (const l of lineas) cuenta.set(l, (cuenta.get(l) || 0) + 1);
  }
  const umbral = Math.max(3, 0.3 * con.length);
  const repetida = (l) => con.length >= 4 && l.length < 200 && (cuenta.get(l) || 0) >= umbral;
  return con
    .map((p) => {
      const ls = p.texto
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter((l) => l && !repetida(l) && !/^(p[aá]gina\s*)?\d+(\s*de\s*\d+)?$/i.test(l));
      return { num: p.num, texto: ls.join("\n") };
    })
    .filter((p) => p.texto);
}

function deduplicar(docs) {
  const vistas = new Set();
  for (const d of docs) {
    let quitadas = 0;
    d.paginas = d.paginas
      .map((p) => {
        const frases = p.texto.replace(/\s*\n\s*/g, " ").split(/(?<=[.;:])\s+/).filter((f) => f.trim());
        const quedan = [];
        for (const f of frases) {
          const k = norm(f).replace(/[^a-z0-9]+/g, " ").trim();
          if (k.length >= 60) {
            if (vistas.has(k)) {
              quitadas++;
              continue;
            }
            vistas.add(k);
          }
          quedan.push(f);
        }
        return { num: p.num, texto: quedan.join(" ") };
      })
      .filter((p) => p.texto.trim());
    d.frases_repetidas = quitadas;
  }
}

function partir(docs) {
  const LIM = P.limite_parte_kb * 1024;
  const partes = [];
  let actual = "";
  const bytes = (s) => Buffer.byteLength(s, "utf8");
  const cerrar = () => {
    if (actual) partes.push(actual);
    actual = "";
  };
  for (const d of docs) {
    const cab = `\n\n##### DOCUMENTO: ${d.nombre} (tipo: ${d.tipo})\n` +
      (d.frases_repetidas ? `[Se omitieron ${d.frases_repetidas} frases de este documento que aparecen idénticas en un documento de mayor autoridad ya incluido]\n` : "");
    const pags = d.paginas.map((p) => (p.num ? `[pág. ${p.num}]\n` : "") + p.texto);
    const entero = cab + pags.join("\n");
    if (bytes(actual + entero) <= LIM) {
      actual += entero;
      continue;
    }
    if (bytes(entero) <= LIM) {
      cerrar();
      actual = entero;
      continue;
    }
    pags.forEach((t, i) => {
      let trozo = (i === 0 ? cab : `\n\n##### DOCUMENTO: ${d.nombre} (continuación)\n`) + t;
      if (bytes(actual + trozo) > LIM) {
        cerrar();
        if (i > 0) trozo = `\n\n##### DOCUMENTO: ${d.nombre} (continuación)\n` + t;
      }
      // Una pagina sola mas grande que el limite (tablas enormes) se parte por lineas.
      while (bytes(trozo) > LIM) {
        let corte = Math.floor(trozo.length * (LIM / bytes(trozo)) * 0.95);
        corte = trozo.lastIndexOf("\n", corte) > 0 ? trozo.lastIndexOf("\n", corte) : corte;
        partes.push(trozo.slice(0, corte));
        trozo = `\n\n##### DOCUMENTO: ${d.nombre} (continuación)\n` + trozo.slice(corte);
      }
      actual += trozo;
    });
  }
  cerrar();
  return partes;
}

// --- Un proceso --------------------------------------------------------------
async function armar(it, docs) {
  const tmp = path.join(os.tmpdir(), `paq-${it.id_proceso}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  const conTipo = docs.map((d) => ({ ...d, tipo: tipoDe(d.nombre) }));
  const hayPliego = conTipo.some((d) => ["pliego_definitivo", "proyecto_pliego", "invitacion"].includes(d.tipo));
  const omitidos = [];
  const aLeer = [];
  for (const d of conTipo) {
    if (hayPliego && CONDICIONALES.has(d.tipo)) omitidos.push({ nombre: d.nombre, tipo: d.tipo, motivo: "no obliga al oferente" });
    else if (!EXT_LEGIBLES.has(d.ext)) omitidos.push({ nombre: d.nombre, tipo: d.tipo, motivo: `formato .${d.ext} no legible` });
    else aLeer.push(d);
  }

  const leidos = [];
  const problemas = [];
  for (const [i, d] of aLeer.entries()) {
    const archivo = path.join(tmp, `${String(i).padStart(2, "0")}.${d.ext}`);
    if (!(await descargar(d.url, archivo))) {
      problemas.push({ nombre: d.nombre, motivo: "no se pudo descargar de SECOP" });
      continue;
    }
    for (const sub of leerArchivo(archivo, d.nombre, d.ext, tmp)) {
      const paginas = limpiar(sub.paginas);
      if (!paginas.length) {
        problemas.push({ nombre: sub.nombre, motivo: sub.nota.no_legible || "sin texto legible" });
        continue;
      }
      leidos.push({
        nombre: sub.nombre,
        tipo: sub.nombre === d.nombre ? d.tipo : tipoDe(sub.nombre),
        fecha: d.fecha,
        paginas,
        ocr_paginas: sub.nota.ocr_paginas || 0,
        ocr_incompleto: !!sub.nota.ocr_incompleto,
      });
    }
  }
  rmSync(tmp, { recursive: true, force: true });

  // Mismo contenido subido dos veces: se deja uno.
  const huellas = new Set();
  const unicos = leidos.filter((d) => {
    const h = sha(d.paginas.map((p) => p.texto).join("\n"));
    if (huellas.has(h)) return false;
    huellas.add(h);
    return true;
  });

  const hayDefinitivo = unicos.some((d) => d.tipo === "pliego_definitivo");
  // El proyecto de pliego va al final: solo aporta lo que el resto no dice.
  const prio = (d) => (d.tipo === "proyecto_pliego" && hayDefinitivo ? ORDEN.length : ORDEN.indexOf(d.tipo));
  unicos.sort((a, b) => prio(a) - prio(b) || (b.fecha || "").localeCompare(a.fecha || ""));
  deduplicar(unicos);
  const finales = unicos.filter((d) => d.paginas.length);

  const partes = partir(finales);
  return {
    id_proceso: it.id_proceso,
    generado: new Date().toISOString(),
    documentos: finales.map((d) => ({
      nombre: d.nombre,
      tipo: d.tipo,
      fecha: d.fecha,
      kb: Math.round(Buffer.byteLength(d.paginas.map((p) => p.texto).join("\n")) / 1024),
      ocr_paginas: d.ocr_paginas,
      ocr_incompleto: d.ocr_incompleto || undefined,
      frases_repetidas: d.frases_repetidas || undefined,
    })),
    omitidos,
    problemas,
    partes,
  };
}

// --- Principal ---------------------------------------------------------------
async function main() {
  const datos = JSON.parse(readFileSync(datosPath, "utf8"));
  mkdirSync(dirPaq, { recursive: true });

  const todos = [...(datos.items || []), ...(datos.candidatos_exploratorios || [])];
  const porId = new Map();
  for (const it of todos) if (it.id_proceso && !porId.has(it.id_proceso)) porId.set(it.id_proceso, it);
  const excluida = (it) => P.excluir_modalidades.some((m) => (it.modalidad || "").trim() === m);
  const soloUnspsc = (it) => (it.matched_groups || []).every((g) => g === "Codigo UNSPSC");
  const abierto = (e) => /public|present|abiert|convocad|borrador|evaluaci/i.test(e || "");

  // Prioridad: abiertos primero, palabra clave antes que reserva UNSPSC, mayor valor primero.
  // PAQUETES_SOLO=id1,id2 limita la corrida (para pruebas locales).
  const solo = process.env.PAQUETES_SOLO ? new Set(process.env.PAQUETES_SOLO.split(",")) : null;
  const cola = [...porId.values()]
    .filter((it) => it.id_portafolio && !excluida(it) && (!solo || solo.has(it.id_proceso)))
    .sort(
      (a, b) =>
        Number(abierto(b.estado)) - Number(abierto(a.estado)) ||
        Number(soloUnspsc(a)) - Number(soloUnspsc(b)) ||
        (b.valor || 0) - (a.valor || 0),
    );

  const manifiesto = {};
  let armados = 0, sinCambios = 0, pendientes = 0, sinDocs = 0;

  const resumen = (paq) => ({
    hash: sha(paq.partes.join("\u0000")).slice(0, 12),
    partes: paq.partes.length,
    kb: Math.round(paq.partes.reduce((s, p) => s + Buffer.byteLength(p), 0) / 1024),
    documentos: paq.documentos.length,
    ocr: paq.documentos.some((d) => d.ocr_paginas) || undefined,
    generado: paq.generado.slice(0, 10),
  });

  let i = 0;
  const trabajador = async () => {
    while (i < cola.length) {
      const it = cola[i++];
      const archivo = path.join(dirPaq, `${it.id_proceso}.json`);
      const previo = existsSync(archivo) ? JSON.parse(readFileSync(archivo, "utf8")) : null;
      if ((Date.now() - INICIO) / 60000 > P.max_minutos) {
        if (previo?.partes?.length) manifiesto[it.id_proceso] = resumen(previo);
        pendientes++;
        continue;
      }
      const docs = await listarDocumentos(it.id_portafolio);
      if (!docs) {
        if (previo?.partes?.length) manifiesto[it.id_proceso] = resumen(previo);
        continue;
      }
      if (!docs.length) {
        sinDocs++;
        continue;
      }
      const firma = sha(docs.map((d) => `${d.nombre}|${d.bytes}|${d.fecha}`).sort().join("\n"));
      if (previo && previo.firma === firma) {
        previo.ultima_vez_en_radar = hoy;
        writeFileSync(archivo, JSON.stringify(previo));
        if (previo.partes?.length) manifiesto[it.id_proceso] = resumen(previo);
        sinCambios++;
        continue;
      }
      try {
        const paq = await armar(it, docs);
        paq.firma = firma;
        paq.ultima_vez_en_radar = hoy;
        writeFileSync(archivo, JSON.stringify(paq));
        if (paq.partes.length) manifiesto[it.id_proceso] = resumen(paq);
        armados++;
        console.log(
          `  ${it.id_proceso}: ${paq.documentos.length} documentos, ${paq.partes.length} parte(s), ` +
            `${manifiesto[it.id_proceso]?.kb ?? 0} KB` +
            (paq.problemas.length ? `, ${paq.problemas.length} con problemas` : ""),
        );
      } catch (e) {
        console.warn(`  ${it.id_proceso}: fallo al armar (${e.message.split("\n")[0]})`);
        if (previo?.partes?.length) manifiesto[it.id_proceso] = resumen(previo);
      }
    }
  };
  await Promise.all(Array.from({ length: P.concurrencia }, trabajador));

  // Poda: paquetes de procesos que salieron del radar hace mas de N dias.
  let podados = 0;
  for (const f of readdirSync(dirPaq)) {
    const id = f.replace(/\.json$/, "");
    if (porId.has(id)) continue;
    try {
      const p = JSON.parse(readFileSync(path.join(dirPaq, f), "utf8"));
      const dias = (Date.parse(hoy) - Date.parse(p.ultima_vez_en_radar || "2000-01-01")) / 86400000;
      if (dias > P.retencion_dias) {
        rmSync(path.join(dirPaq, f));
        podados++;
      }
    } catch {}
  }

  datos.paquetes = manifiesto;
  writeFileSync(datosPath, JSON.stringify(datos, null, 2));
  console.log(
    `Paquetes: ${Object.keys(manifiesto).length} listos · ${armados} armados hoy · ${sinCambios} sin cambios · ` +
      `${sinDocs} sin documentos · ${pendientes} pendientes para la proxima corrida · ${podados} podados · ` +
      `${paginasOcr} paginas por OCR · ${Math.round((Date.now() - INICIO) / 1000)} s`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
