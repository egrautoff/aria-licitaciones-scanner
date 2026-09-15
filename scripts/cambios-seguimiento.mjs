// Detecta que cambio en los procesos que el equipo marco con la estrella.
//
// Por que existe: el tablero ya hacia esta comparacion, pero solo cuando alguien
// abria la pagina. Si nadie entraba en tres dias, el cambio quedaba anotado como
// "entre el 12 y el 15" --- honesto, pero impreciso. Corriendo aqui, dentro de la
// rutina diaria, la fecha es exacta.
//
//   node cambios-seguimiento.mjs <dir-docs> <datos.json> <dir-salida>
//
// dir-docs: donde ArtifactData dejo los documentos de la coleccion seguimiento.
// dir-salida: un archivo por proceso a actualizar, para pasarlos a ArtifactData
// batch como file_path. Asi los documentos tampoco pasan por el modelo al
// escribirlos de vuelta.

import fs from "node:fs";
import path from "node:path";

const [dirDocs, datosPath, dirSalida] = process.argv.slice(2);
if (!dirDocs || !datosPath || !dirSalida) {
  console.error("Uso: node cambios-seguimiento.mjs <dir-docs> <datos.json> <dir-salida>");
  process.exit(1);
}

const datos = JSON.parse(fs.readFileSync(datosPath, "utf8"));
const porId = new Map(datos.items.map((it) => [it.id_proceso, it]));

// SECOP puede reemitir el mismo valor con otra tilde o espaciado. Eso no es un
// cambio del proceso y avisarlo seria una falsa alarma, asi que el texto se
// compara normalizado --- pero se guarda tal como vino.
const norm = (s) =>
  String(s === null || s === undefined ? "" : s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
const mismo = (a, b) =>
  typeof a === "string" || typeof b === "string" ? norm(a) === norm(b) : a === b;

function buscarArchivos(dir) {
  const salida = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) salida.push(...buscarArchivos(p));
    else if (e.name.endsWith(".json")) salida.push(p);
  }
  return salida;
}

const escrituras = [];
const resumen = { revisados: 0, cambiados: 0, fuera_de_ventana: 0, ya_comparados: 0 };

for (const archivo of buscarArchivos(dirDocs)) {
  const crudo = JSON.parse(fs.readFileSync(archivo, "utf8"));
  // ArtifactData puede entregar el documento envuelto o pelado: se aceptan ambos.
  const doc = crudo && crudo.data && crudo.data.id_proceso ? crudo.data : crudo;
  if (!doc || !doc.id_proceso) continue;
  resumen.revisados++;

  const hoy = porId.get(doc.id_proceso);
  if (!hoy) {
    resumen.fuera_de_ventana++;
    continue;
  }
  if (doc.visto_en === datos.dia) {
    resumen.ya_comparados++;
    continue;
  }

  const cambios = [];
  for (const campo of ["estado", "valor", "modalidad"]) {
    const antes = doc[campo] === undefined ? null : doc[campo];
    const ahora = hoy[campo] === undefined ? null : hoy[campo];
    if (!mismo(antes, ahora)) {
      cambios.push({ campo, de: antes, a: ahora, desde: doc.visto_en || null, hasta: datos.dia });
    }
  }
  if (cambios.length) resumen.cambiados++;

  escrituras.push({
    doc_id: doc.id_proceso,
    data: {
      entidad: hoy.entidad || null,
      descripcion: hoy.descripcion || null,
      url: hoy.url || null,
      unspsc: hoy.unspsc || null,
      modalidad: hoy.modalidad || null,
      estado: hoy.estado || null,
      valor: hoy.valor === undefined ? null : hoy.valor,
      fecha_publicacion: hoy.fecha_publicacion || null,
      visto_en: datos.dia,
      cambios: [...(doc.cambios || []), ...cambios].slice(-50),
    },
  });

  for (const c of cambios) {
    console.log(`  ${doc.id_proceso} · ${c.campo}: ${JSON.stringify(c.de)} -> ${JSON.stringify(c.a)}`);
  }
}

fs.mkdirSync(dirSalida, { recursive: true });
for (const e of escrituras) {
  const destino = path.join(dirSalida, `${e.doc_id}.json`);
  fs.writeFileSync(destino, JSON.stringify(e.data, null, 2));
  console.log(`ESCRIBIR ${e.doc_id} <- ${destino}`);
}
console.log(
  `Revisados ${resumen.revisados} · con cambios ${resumen.cambiados} · ` +
    `ya comparados ${resumen.ya_comparados} · fuera de ventana ${resumen.fuera_de_ventana} · ` +
    `escrituras a aplicar ${escrituras.length}`,
);
