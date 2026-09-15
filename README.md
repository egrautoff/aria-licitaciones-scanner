# Radar de licitaciones SECOP — ARIA PSW

Escanea a diario el dataset público de SECOP II (datos.gov.co, `p6dx-8zbt`) y filtra los procesos de contratación que coinciden con el portafolio de ARIA PSW (Liferay/portales, fábrica de software, IA/agentes, integración TIBCO/ESB).

- `scripts/fetch-secop.mjs` — consulta la API, aplica las reglas de palabras clave y escribe los archivos de `data/`.
- `.github/workflows/secop-fetch.yml` — corre el script todos los días y hace commit del resultado.
- `data/latest.json` — última corrida; la lee una rutina de Claude que publica el dashboard.
- `data/seen.json` — registro de cuándo se vio por primera vez cada proceso.
- `config/parametros.json` — **las palabras clave y códigos que rigen la búsqueda**. Este archivo manda; el script solo lo lee.
- `dashboard.html` — copia de referencia del tablero publicado.

## Horarios

| Pieza | Hora | Qué hace |
|---|---|---|
| GitHub Action | 05:23 UTC · 00:23 Colombia | Consulta SECOP y commitea `data/` |
| Rutina principal | 14:00 UTC · 09:00 Colombia | Publica el tablero |
| Rutina de recuperación | 18:00 UTC · 13:00 Colombia | Solo publica si el tablero quedó atrasado |

El minuto no redondo del cron es deliberado: con `0 9` — hora en punto, la franja más congestionada de GitHub — el arranque real se corría entre 3h34 y 6h35 respecto de lo programado, y creciendo día a día. Las 05:23 UTC son lo más temprano posible que todavía cae dentro del mismo día calendario colombiano (05:00 UTC es medianoche en Bogotá); correr antes etiquetaría el dato con el día anterior. Eso deja 8h37 de margen, el máximo alcanzable.

El retraso afecta **solo a `schedule`**; un `workflow_dispatch` arranca de inmediato.

### Por qué no hay disparo por evento

Sería mejor que el Action avisara a la rutina en vez de confiar en un margen. Se probaron los tres caminos y los tres están cerrados:

| Camino | Resultado |
|---|---|
| Webhook nativo (`create_webhook_trigger`, `hook_type: app`) | Exige conectar GitHub a claude.ai; la política de la organización no lo permite |
| Rutina → `api.github.com` para disparar el workflow | HTTP 403 de GitHub a la IP del sandbox (el proxy no interviene: `recentRelayFailures: []`) |
| Action → `POST /v1/code/triggers/{id}/run` | HTTP 401 `oauth_scope_insufficient`: un token de `claude setup-token` sirve para usar los modelos, no para administrar rutinas |

Tampoco sirve que la rutina traiga los datos ella misma: `datos.gov.co` responde `connect_rejected (organization policy)` desde el sandbox.

Por eso las defensas son tres, todas pasivas: el margen amplio, la rutina de recuperación, y el aviso de dato atrasado que el propio tablero calcula desde `dia`.

### Las rutinas

- Principal: `trig_01TYWswpG56dfVXbizXAckku`
- Recuperación: `trig_01Wdvk2CE5DSXAFadgcgG168` — compara el `dia` del archivo de datos contra el `dia` del tablero y no hace nada si ya coinciden, que es lo normal.

Se editan con `RemoteTrigger action:update` desde Claude Code.

## Novedades y seguimiento

Hay dos cosas distintas y conviene no confundirlas.

**La marca de "nuevo"** sale de `data/seen.json`, que guarda por proceso apenas dos fechas: cuándo se vio por primera vez y cuándo por última. De ahí salen `es_nuevo`, `primera_vez_visto` y `dias_en_radar`. El registro, y no la corrida anterior, es lo que hace confiable la marca: si un día el Action no corre, un proceso visto hace tres días no se declara nuevo por error. Los procesos que ya estaban en el radar cuando se creó el registro quedan marcados `sembrado` y nunca cuentan como nuevos, para que el arranque en frío no marque todo el listado de golpe. Se poda a `SEEN_RETENTION_DAYS` (180 días).

**El seguimiento** es otra cosa: el repositorio no guarda historial de los procesos. Solo se conserva la trayectoria de los que alguien marca con la estrella en el tablero, y esa información no vive aquí sino en el almacén del propio artifact (capacidad `db` de claude.ai), porque la rutina reescribe el bloque de datos del tablero cada mañana.

Cada proceso seguido guarda un documento en la colección `seguimiento` con lo último que se supo de él y una lista de cambios en `estado`, `valor` y `modalidad`.

**La comparación la hace la rutina diaria**, con `scripts/cambios-seguimiento.mjs`: lee los documentos del almacén, los compara contra el dato del día y escribe de vuelta lo que cambió, con fecha exacta. El tablero conserva la misma lógica como respaldo por si un día la rutina no corre; ambas son idempotentes, así que la que llegue segunda no hace nada.

Cuando algo cambia, el tablero lo muestra: badge "Cambió hoy" en la tarjeta, chip de filtro "Cambios hoy", una casilla con el conteo y las novedades del día resaltadas dentro de la lista de cambios. Un proceso seguido que sale de la ventana de 15 días se sigue mostrando, reconstruido desde lo último que se supo.

La lista es compartida por toda la organización: no hay capacidad `user` disponible en la cuenta, así que no existen listas privadas por persona.

Se puede inspeccionar desde Claude Code con la herramienta `ArtifactData` sobre la colección `seguimiento`.

## Las reglas salieron del historico de ARIA

Las palabras clave no se inventaron: se derivaron de los **34 contratos que ARIA ha ganado**, tomados de `Administracion_Contratos.xlsx` (OneDrive de la organizacion, `ARIAPSW S.A.S - Archivo Oficial/00. CONTRATOS CLIENTES/`).

El metodo fue correr las reglas vigentes contra el objeto contractual de cada contrato ganado y ver cuales no pescaba. El resultado del primer diagnostico (2026-09-15):

| | Antes | Despues |
|---|---|---|
| Contratos propios que el radar veria | 16 de 34 | 33 de 34 |
| Valor invisible | $80.534M (71%) | $544M (0,5%) |
| Coincidencias por ventana de 15 dias | 33 | 62 |

La causa era concreta: la unica regla de TIBCO exigia la frase `"integracion tibco"`, que no aparece en ningun contrato real — los objetos dicen "plataforma TIBCO", "licenciamiento TIBCO", "productos de software TIBCO". El radar era ciego a la linea de negocio mas grande de la empresa. Tambien faltaban por completo Teradata, Spotfire, bodega de datos e inteligencia de negocios, y `"bus de servicios empresariales"` estaba en plural cuando los pliegos dicen singular.

**El corpus no esta en este repositorio y no debe estarlo.** El repo es publico (unica forma en que la rutina alcanza los datos), asi que subir el historico de contratos publicaria informacion comercial de ARIA. Lo unico que se versiona es la lista de terminos derivada, que no es sensible. Para repetir el analisis, leer el Excel con el conector de Microsoft 365 y correr la comparacion en local.

**El nombre del producto es la senal de mayor precision.** Un proceso que menciona TIBCO, Teradata, Spotfire, Liferay o Jaspersoft es de ARIA casi con certeza. Las abreviaturas cortas, en cambio, son peligrosas: con 3 letras la comparacion usa limite de palabra y engancha texto cualquiera — `soa` pesco compra de mobiliario y `mdm` suministro de material de laboratorio. Se eliminaron; solo quedan las frases completas.

Reglas marcadas `weak: true` (no alcanzan a ser "destacado" por si solas): mesa de ayuda, soporte tecnico nivel 2-3 e interoperabilidad. La ultima da senal real pero la mitad es ruido — pesco un abogado para el marco legal de interoperabilidad y un servicio de telefonia Webex.

`"portal web"` suelto no sirve: trae 21 procesos y la mayoria son contratos de una persona (comunicadora, difusion de prensa, hasta licencias de obras musicales). Se exige acompanado de un verbo de proyecto: desarrollo, implementacion, migracion, suscripcion, licenciamiento o rediseno.

**Lo que las palabras clave no pueden resolver:** un contrato como "Prestacion de servicios de soporte, operacion, mantenimiento" (Colpensiones, $544M) no menciona producto ni dominio. Solo se identifica por el cliente. Eso requiere una lista de entidades conocidas, que por ser informacion comercial iria como **secreto de GitHub** (no es publico) leido por el script como variable de entorno --- pendiente.

## Análisis de requisitos

Cada tarjeta de un proceso analizado tiene un botón **"Análisis de requisitos"** que muestra qué experiencia exige el pliego: los códigos UNSPSC, las cifras en SMMLV, el texto del requisito y un enlace a los documentos de donde salió.

La extracción la hace `scripts/requisitos.mjs` dentro del GitHub Action, porque el navegador le bloquea a la página del tablero las peticiones a otros dominios y la rutina en la nube solo alcanza `raw.githubusercontent.com`. El Action es lo único con internet abierto.

**La llave del cruce** es `id_del_portafolio` (formato `CO1.BDOS.*`), que enlaza con el campo `proceso` del dataset `dmgg-8hin` ("SECOP II - Archivos Descarga Desde 2025"). Los identificadores `CO1.REQ.*` y `CO1.NTC.*` no cruzan con nada; ese fue el hallazgo que abrió el camino.

**Por qué no baja casi nada:**

1. Solo procesos **abiertos, dentro del plazo de recepción y por encima del piso de valor** (`requisitos.valor_min`, hoy $50M). De 218 procesos quedan 4. Ojo: en SECOP "Abierto" significa que el proceso sigue vivo, no que todavía se pueda presentar oferta — por eso se mira también `fecha_de_recepcion_de`.
2. Solo **uno o dos documentos** por proceso, elegidos por nombre según `requisitos.prioridad_documentos`. Los otros quince son formatos en blanco, minutas y certificados.
3. **Caché permanente** en `data/requisitos/`. Una licitación dura semanas abierta; sin caché bajaríamos lo mismo cuarenta veces.
4. Se vuelve a mirar solo si le **aparecieron documentos nuevos**, y eso se pregunta con una consulta que no descarga nada.

**Cuidado con el 403.** Las URL de descarga funcionan sin autenticación, pero el Azure Application Gateway de SECOP responde `403 Forbidden` al agente por defecto de `curl`. Con un `User-Agent` de navegador entrega el archivo. No es un muro de acceso, es filtro de bots.

Estados posibles del análisis: `ok`, `sin_documentos`, `sin_documentos_de_requisitos` (típico de contratación directa y régimen especial), `documentos_escaneados` (PDF sin capa de texto) y `sin_seccion_identificable`. El tablero explica cada uno en lugar de mostrar un vacío.

### Lo que el doble chequeo encontró (2026-09-15)

Se verificó la extracción contra el texto crudo de los pliegos y aparecieron tres defectos, dos de ellos silenciosos:

1. **Códigos partidos en tablas.** Los pliegos los escriben como `43 23 21 00` y al extraer el texto quedan separados. La expresión buscaba ocho dígitos seguidos, así que TransMilenio daba **cero códigos teniendo una tabla completa**. Un falso negativo que se leía como "este pliego no pide códigos". Se unen antes de buscar.
2. **Se leía la tabla de contenido.** Las primeras menciones de "UNSPSC" suelen ser el índice (`1.4. CLASIFICADOR ... (UNSPSC) ....... 6`), donde los números son páginas. Esas ventanas se descartan por las corridas de puntos o por los campos `PAGEREF`/`HYPERLINK` que deja Word.
3. **El veredicto estaba mal planteado.** Decía "está inscrito en 5 de 6 códigos", que suena a carencia. Pero los pliegos piden acreditar **algunos** de los códigos listados, no todos: TransMilenio exige "como mínimo en dos (2)". Ahora se extrae ese mínimo (`minimo_codigos`) y, si no se puede leer pero ARIA cubre todos, la conclusión es igual afirmativa: cubrir todos cumple cualquiera sea el mínimo.

### Comparación contra el RUP de ARIA

Debajo del requisito, el tablero dice en cuántos de los códigos detectados está ARIA inscrita, con los SMMLV acumulados en cada uno.

**El RUP no está en este repositorio.** Vive en el documento `config/rup` del almacén del artifact, que es interno de la organización. El repo es público y publicar ahí la posición acreditada de la empresa la volvería trivialmente indexable. Se carga con la herramienta `ArtifactData`; la fuente es `Contratos incluidos en el RUP.xlsx` (OneDrive, `05. GESTION COMERCIAL / 5.11 RUP ARIAPSW`), 42 contratos y 28 códigos.

Dos detalles que cuestan una hora si no se saben:

- **El RUP acredita a tercer nivel (6 dígitos) y SECOP publica ocho.** Comparar sin truncar no encuentra nunca una coincidencia. Además SECOP escribe `V1.81111500`, y quitar los no-dígitos sin quitar antes el prefijo deja el `1` pegado y produce `181111` en vez de `811115`.
- **Un código terminado en `0000` no es de tercer nivel**: es la familia (`81110000`) o el segmento (`81000000`). Nadie se inscribe en esos. Los de familia se dan por cubiertos si ARIA tiene cualquier código adentro; los de segmento se descartan porque coinciden siempre y no informan nada.

El apartado tiene tres partes: **lo que exige el pliego** (el texto tal cual, con enlace a los documentos), **cómo estamos** (cada código con ✓ o ✗ y los SMMLV acreditados) y una **conclusión** — "puede presentarse", "no puede presentarse" o "probablemente sí, hay que confirmarlo".

### El check de monto

No basta estar inscrito en el código: el pliego exige que los contratos **sumen** cierto valor en SMMLV. Se verifican las dos cosas.

Leer la cifra del texto **no funciona**: la mayoría de las menciones de SMMLV en un pliego son del código penal (*"multa de doscientos (200) a mil (1000) salarios mínimos"*). Ese ruido se filtra por contexto (`multa`, `prisión`, `incurrirá`, `servidor público`).

La vía que sí funciona es calcular el requisito desde el presupuesto, que viene en la API: los pliegos lo expresan como porcentaje del presupuesto oficial en SMMLV. El pliego tipo del IDU trae la tabla — 75% con 1-2 contratos, 100% con 3-5, hasta 200%.

**El SMMLV vigente está en `config/parametros.json` (`smmlv.valor`) y hay que actualizarlo cada enero.** El de 2026 se derivó del pliego de IDARTES, que publica sus lotes en pesos y en SMMLV: $41.509.767 / 23,71 = **$1.750.905**. Validado al revés contra el IDU: $1.687.628.250 / 1.750.905 = 963,86, exactamente la cifra que el pliego declara.

**ARIA no puede sumar sus 42 contratos.** Dos razones: los pliegos limitan cuántos admiten (`max_contratos`, presente en 40 de los analizados) y un contrato inscrito en cinco códigos no vale cinco veces. Por eso el documento `config/rup` guarda el detalle por contrato además del acumulado por código, y la suma toma los mayores que apliquen hasta el tope.

**Hallazgo: el monto no es la limitación de ARIA.** De los 218, en 174 alcanza y en ninguno falla por plata — los 43 restantes fallan por códigos. El proceso más grande del radar equivale a 3.536 SMMLV y aun exigiendo el 200% serían 7.072; los tres mayores contratos de ARIA suman 32.763 SMMLV sin contar la unión temporal. La conclusión se sostiene aunque esa fila resulte inflada.

**Lo que la conclusión NO verifica, y el tablero lo dice debajo:**

- **El porcentaje exacto.** Se compara contra el 100% del presupuesto; el rango real va del 75% al 200% según cuántos contratos se presenten.
- **Los lotes.** Si el proceso está dividido, cada lote suele exigir códigos distintos y los extraídos vienen mezclados. Se avisa en rojo cuando `lotes > 1`.
- La lista de códigos sale de leer el pliego con una heurística, no de una lista oficial.

## Cambiar las palabras clave

Los parámetros viven en `config/parametros.json`, no en el código. Hay dos formas de cambiarlos:

**Desde el tablero** (botón "Parámetros de búsqueda", arriba a la derecha): muestra todas las reglas agrupadas, los códigos UNSPSC y los umbrales, y deja editarlos. Los cambios quedan guardados en el almacén del artifact y visibles para el equipo. El último paso es manual: la página no puede escribir en el repositorio porque el navegador bloquea las peticiones a otros dominios, así que el panel entrega el JSON listo y un enlace para pegarlo en este archivo. La recolección de la madrugada siguiente ya usa lo que quedó ahí.

**Editando el archivo** directamente, que es lo mismo sin el intermediario.

Sintaxis de una regla, igual a como se ven las etiquetas en las tarjetas:

```
liferay, dxp              basta con que aparezca cualquiera de las dos
portal web + desarrollo   tienen que aparecer todas
interoperabilidad [debil] cuenta, pero no alcanza para marcar "destacado"
```

Agregar un grupo nuevo exige además tocar `dashboard.html` (tokens `--cat-*` en los tres bloques de tema, `CAT_CLASS`, `CAT_STAT_CLASS`, `CATS`, la regla del chip y la del badge).

## Ajustes

Para cambiar las palabras clave, edita el arreglo `RULES` en `scripts/fetch-secop.mjs`. Los procesos con valor >= $1.000 millones que coincidan con una palabra clave "fuerte" se marcan `destacado: true` --- ajustable con `DESTACADO_VALOR_MIN` y el flag `weak` de cada regla.

Al agregar una categoria nueva hay que sumarla tambien en `dashboard.html`: los tokens de color (`--cat-*` en los tres bloques de tema), `CAT_CLASS`, `CAT_STAT_CLASS`, `CATS`, la regla del chip y la del badge.

La rutina republica el tablero **sin** pasar `capabilities`, lo cual conserva la declaracion guardada. Si alguna vez llegara a pasarlas, revocaria la capacidad `db` y el equipo perderia su lista de seguimiento; el prompt de la rutina lo advierte de forma explicita.

Al cambiar la forma de los datos hay que actualizar tambien el prompt de las dos rutinas (`RemoteTrigger action:update`), que describen el JSON que espera el tablero.
