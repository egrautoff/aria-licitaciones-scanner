// Analisis de requisitos: baja el pliego de los procesos que valen la pena y
// extrae que experiencia exigen.
//
// La eficiencia esta en no bajar casi nada:
//   1. Solo procesos ABIERTOS de la lista principal por encima de un piso de
//      valor. De 62 procesos, hoy son 6 --- nadie se presenta a uno de $2M.
//   2. Solo uno o dos documentos por proceso, elegidos por nombre. Los otros
//      quince son formatos en blanco, minutas y certificados.
//   3. Cache permanente: un proceso se analiza una vez. Como las licitaciones
//      duran semanas abiertas, sin cache bajariamos lo mismo cuarenta veces.
//   4. Se vuelve a mirar solo si le aparecieron documentos nuevos, y eso se
//      pregunta con una consulta que no descarga nada.
//
// Depende de `pdftotext` (poppler-utils) y `unzip`, no de paquetes npm.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const DS = "https://www.datos.gov.co/resource";
const raiz = new URL("../", import.meta.url).pathname;
const CFG = JSON.parse(readFileSync(path.join(raiz, "config/parametros.json"), "utf8"));
const REQ = CFG.requisitos;
const dirCache = path.join(raiz, "data/requisitos");
const datosPath = path.join(raiz, "data/latest.json");

// El portal de SECOP esta detras de un Azure Application Gateway que responde
// 403 al agente por defecto de curl. No es que pida autenticacion: es filtro de
// bots, y con un agente de navegador entrega el archivo sin credenciales.
const AGENTE =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

const norm = (s) =>
  (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const esAbierto = (estado) => /public|present|abiert|convocad|borrador/i.test(estado || "");

async function pedirJson(url, intentos = 3) {
  for (let i = 0; i < intentos; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j)) return j;
      }
    } catch {}
    await new Promise((s) => setTimeout(s, 1500));
  }
  return null;
}

function puntajeDocumento(nombre) {
  const n = norm(nombre);
  // Mas temprano en la lista de prioridad, mejor documento.
  for (let i = 0; i < REQ.prioridad_documentos.length; i++) {
    if (n.includes(norm(REQ.prioridad_documentos[i]))) return REQ.prioridad_documentos.length - i;
  }
  return 0;
}

function extraerTexto(archivo, extension) {
  try {
    if (extension === "pdf") {
      return execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", archivo, "-"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    }
    if (extension === "docx") {
      const xml = execFileSync("unzip", ["-p", archivo, "word/document.xml"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      return xml.replace(/<\/w:p>/g, "\n\n").replace(/<[^>]+>/g, " ");
    }
    if (extension === "xlsx") {
      const xml = execFileSync("unzip", ["-p", archivo, "xl/sharedStrings.xml"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      return xml.replace(/<\/si>/g, "\n\n").replace(/<[^>]+>/g, " ");
    }
  } catch (e) {
    console.warn(`    no se pudo extraer texto (${extension}): ${e.message.split("\n")[0]}`);
  }
  return "";
}

// Las palabras que marcan la seccion de requisitos habilitantes.
const SENALES = [
  "experiencia", "habilitante", "acreditar", "unspsc", "smmlv", "rup",
  "clasificador", "capacidad financiera", "indicador", "contratos ejecutados",
  "proponente", "certificacion",
];

function recorte(texto, limite = 3500) {
  const parrafos = texto
    .split(/\n\s*\n|\n(?=\s*[0-9]+\.[0-9])/)
    .map((p) => p.replace(/[ \t]+/g, " ").trim())
    .filter((p) => p.length > 60);

  const puntuados = parrafos.map((p, i) => {
    const n = norm(p);
    let s = 0;
    for (const señal of SENALES) if (n.includes(señal)) s++;
    // "experiencia" cerca de una cifra suele ser el requisito, no una mencion suelta.
    if (n.includes("experiencia") && /\d/.test(p)) s += 2;
    return { p, i, s };
  });

  const elegidos = puntuados
    .filter((x) => x.s >= 2)
    .sort((a, b) => b.s - a.s)
    .slice(0, 12)
    .sort((a, b) => a.i - b.i);

  let salida = [];
  let largo = 0;
  for (const x of elegidos) {
    if (largo + x.p.length > limite) break;
    salida.push(x.p);
    largo += x.p.length;
  }
  return salida.join("\n\n");
}

// Codigos UNSPSC: solo los que aparecen cerca de la palabra que los nombra. Un
// numero de ocho digitos suelto puede ser un NIT o un telefono.
function codigosUnspsc(texto) {
  const n = norm(texto);
  const codigos = new Set();
  const marcas = /unspsc|clasificador|codigo[s]? de bienes/g;
  let m;
  while ((m = marcas.exec(n)) !== null) {
    const ventana = texto.slice(Math.max(0, m.index - 400), m.index + 1200);
    for (const c of ventana.match(/\b\d{8}\b/g) || []) codigos.add(c);
  }
  return [...codigos].slice(0, 40);
}

function smmlv(texto) {
  const hallazgos = new Set();
  for (const m of texto.matchAll(/([\d.,]{1,12})\s*(?:\(\s*[^)]{0,40}\)\s*)?smmlv/gi)) {
    const v = m[1].replace(/[.,]$/, "").trim();
    if (/\d/.test(v)) hallazgos.add(v);
  }
  return [...hallazgos].slice(0, 12);
}

async function main() {
  const datos = JSON.parse(readFileSync(datosPath, "utf8"));
  mkdirSync(dirCache, { recursive: true });

  // "Abierto" en SECOP significa que el proceso sigue vivo, no que todavia se
  // pueda presentar oferta: el plazo de recepcion puede haber pasado y el
  // proceso estar en evaluacion. Analizar esos es gastar descargas en algo a lo
  // que ya nadie puede aplicar.
  const aunSePuedePresentar = (it) => {
    const dia = (it.fecha_cierre || "").slice(0, 10);
    if (!dia) return true; // sin fecha publicada, no se descarta por las dudas
    return dia >= datos.dia;
  };

  const candidatos = datos.items.filter(
    (it) =>
      it.id_portafolio &&
      esAbierto(it.estado) &&
      aunSePuedePresentar(it) &&
      (it.valor || 0) >= REQ.valor_min &&
      !(it.matched_groups.length === 1 && it.matched_groups[0] === "Codigo UNSPSC"),
  );
  console.log(
    `Candidatos a analisis: ${candidatos.length} de ${datos.items.length} procesos ` +
      `(abiertos, de la lista principal, >= $${REQ.valor_min.toLocaleString("es-CO")})`,
  );

  let analizados = 0, reusados = 0, sinDocumentos = 0;

  for (const it of candidatos) {
    const destino = path.join(dirCache, `${it.id_proceso}.json`);
    const cache = existsSync(destino) ? JSON.parse(readFileSync(destino, "utf8")) : null;

    // Consulta barata: cuenta documentos sin descargar ninguno.
    const conteo = await pedirJson(
      `${DS}/dmgg-8hin.json?${new URLSearchParams({
        proceso: it.id_portafolio,
        "$select": "count(*) as n",
      })}`,
    );
    const total = conteo ? Number(conteo[0]?.n ?? 0) : -1;

    if (cache && total >= 0 && cache.documentos_en_el_proceso === total) {
      reusados++;
      continue;
    }
    if (total === 0) {
      writeFileSync(
        destino,
        JSON.stringify(
          { id_proceso: it.id_proceso, revisado_en: datos.dia, documentos_en_el_proceso: 0,
            estado_analisis: "sin_documentos", documentos: [], texto: "", unspsc_exigidos: [], smmlv: [] },
          null, 2,
        ),
      );
      sinDocumentos++;
      continue;
    }

    const docs = (await pedirJson(
      `${DS}/dmgg-8hin.json?${new URLSearchParams({ proceso: it.id_portafolio, "$limit": "300" })}`,
    )) || [];
    const vistos = new Set();
    const elegidos = docs
      .filter((d) => !d.n_mero_de_contrato && puntajeDocumento(d.nombre_archivo) > 0)
      .map((d) => ({ ...d, _p: puntajeDocumento(d.nombre_archivo) }))
      .sort((a, b) => b._p - a._p)
      // El dataset repite el mismo archivo varias veces; sin esto se gastan las
      // dos descargas en el mismo documento.
      .filter((d) => {
        const clave = norm(d.nombre_archivo);
        if (vistos.has(clave)) return false;
        vistos.add(clave);
        return true;
      })
      .slice(0, REQ.max_documentos);

    console.log(`\n${it.entidad?.slice(0, 44)} · $${(it.valor || 0).toLocaleString("es-CO")}`);
    if (!elegidos.length) {
      console.log(`  ${docs.length} documentos, ninguno con pinta de requisitos`);
      writeFileSync(destino, JSON.stringify({
        id_proceso: it.id_proceso, revisado_en: datos.dia, documentos_en_el_proceso: total,
        estado_analisis: "sin_documentos_de_requisitos", documentos: [], texto: "",
        unspsc_exigidos: [], smmlv: [],
      }, null, 2));
      sinDocumentos++;
      continue;
    }

    const tmp = path.join(os.tmpdir(), `req-${it.id_proceso}`);
    mkdirSync(tmp, { recursive: true });
    let textoTotal = "";
    let sinTexto = 0;
    const usados = [];

    for (const d of elegidos) {
      const url = d.url_descarga_documento?.url;
      if (!url) continue;
      const ext = (d.extensi_n || "").toLowerCase();
      const archivo = path.join(tmp, `doc.${ext}`);
      try {
        execFileSync("curl", ["-sSL", "--max-time", "120", "-A", AGENTE, url, "-o", archivo], {
          stdio: ["ignore", "ignore", "pipe"],
        });
      } catch (e) {
        console.log(`  no se pudo bajar: ${d.nombre_archivo}`);
        continue;
      }
      const t = extraerTexto(archivo, ext);
      const escaneado = t.length <= 200;
      console.log(
        `  ${d.nombre_archivo?.slice(0, 58)} -> ${t.length.toLocaleString("es-CO")} caracteres` +
          (escaneado ? "  (sin capa de texto: escaneado)" : ""),
      );
      if (escaneado) sinTexto++;
      else {
        textoTotal += "\n\n" + t;
        usados.push({ nombre: d.nombre_archivo, extension: ext, url });
      }
    }
    rmSync(tmp, { recursive: true, force: true });

    const extracto = recorte(textoTotal);
    const salida = {
      id_proceso: it.id_proceso,
      entidad: it.entidad,
      revisado_en: datos.dia,
      documentos_en_el_proceso: total,
      estado_analisis: extracto
        ? "ok"
        : sinTexto && !usados.length
          ? "documentos_escaneados"
          : "sin_seccion_identificable",
      documentos: usados,
      texto: extracto,
      unspsc_exigidos: codigosUnspsc(textoTotal),
      smmlv: smmlv(textoTotal),
    };
    writeFileSync(destino, JSON.stringify(salida, null, 2));
    console.log(
      `  -> ${salida.estado_analisis} · ${extracto.length} caracteres · ` +
        `UNSPSC ${salida.unspsc_exigidos.length} · SMMLV ${salida.smmlv.join(", ") || "-"}`,
    );
    analizados++;
    await new Promise((r) => setTimeout(r, 500));
  }

  // Se adjunta a latest.json para que el tablero lo lleve consigo.
  const requisitos = {};
  for (const archivo of readdirSync(dirCache)) {
    if (!archivo.endsWith(".json")) continue;
    const r = JSON.parse(readFileSync(path.join(dirCache, archivo), "utf8"));
    if (datos.items.some((it) => it.id_proceso === r.id_proceso)) requisitos[r.id_proceso] = r;
  }
  datos.requisitos = requisitos;
  writeFileSync(datosPath, JSON.stringify(datos, null, 2));

  console.log(
    `\nAnalizados ${analizados} · reusados de cache ${reusados} · sin documentos ${sinDocumentos} · ` +
      `adjuntados al tablero ${Object.keys(requisitos).length}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
