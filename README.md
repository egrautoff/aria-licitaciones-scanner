# Radar de licitaciones SECOP — ARIA PSW

Escanea a diario el dataset público de SECOP II (datos.gov.co, `p6dx-8zbt`) y filtra los procesos de contratación que coinciden con el portafolio de ARIA PSW (Liferay/portales, fábrica de software, IA/agentes, integración TIBCO/ESB).

- `scripts/fetch-secop.mjs` — consulta la API, aplica las reglas de palabras clave y escribe los archivos de `data/`.
- `.github/workflows/secop-fetch.yml` — corre el script todos los días y hace commit del resultado.
- `data/latest.json` — última corrida; la lee una rutina de Claude que publica el dashboard.
- `data/seen.json` — registro de cuándo se vio por primera vez cada proceso.
- `dashboard.html` — copia de referencia del tablero publicado.

## Horarios y disparo

El Action corre a las **06:23 UTC (01:23 hora Colombia)**. Al terminar de commitear, dispara la rutina de Claude que publica el tablero. La rutina además tiene su propio cron a las **14:00 UTC (09:00 hora Colombia)** como red de seguridad, por si el disparo falla.

El minuto no redondo del cron es deliberado. Con `0 9` — hora en punto, la franja más congestionada de GitHub — el arranque real se corría entre 3h30 y 6h35 respecto de lo programado, así que la rutina siempre alcanzaba a leer el archivo del día anterior y republicaba datos viejos sin que nada lo advirtiera. Importante: **ese retraso solo afecta a `schedule`**; un `workflow_dispatch` arranca de inmediato.

### Por qué el Action llama a la rutina y no al revés

Se probaron los tres caminos (2026-09-15, desde rutinas desechables en el sandbox de Claude):

| Camino | Resultado |
|---|---|
| Rutina → `datos.gov.co` | bloqueado por el proxy: `connect_rejected (organization policy)` |
| Rutina → `raw.githubusercontent.com` | HTTP 200 |
| Rutina → `api.github.com` y `github.com` | HTTP 403 de GitHub (el proxy no lo bloquea: `recentRelayFailures: []`) |

O sea que la rutina no puede traer los datos ella misma ni disparar el workflow. El runner de GitHub, en cambio, tiene internet abierto y puede llamar a `POST https://api.anthropic.com/v1/code/triggers/{id}/run`. Esa es la única dirección libre y por eso el disparo va en ese sentido.

El camino nativo (`create_webhook_trigger` con `hook_type: app`, que engancharía el evento `push` de GitHub a la rutina) está descartado: exige conectar la cuenta de GitHub en claude.ai y la política de la organización no lo permite.

### Activar el disparo

El paso se salta solo mientras no exista el secreto, así que el repositorio funciona igual sin él. Para activarlo:

```
claude setup-token
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo egrautoff/aria-licitaciones-scanner
```

El token no debe quedar en ningún archivo del repositorio ni en un historial de comandos: se pega solo en el prompt de `gh secret set`.

## Novedades y seguimiento

Hay dos cosas distintas y conviene no confundirlas.

**La marca de "nuevo"** sale de `data/seen.json`, que guarda por proceso apenas dos fechas: cuándo se vio por primera vez y cuándo por última. De ahí salen `es_nuevo`, `primera_vez_visto` y `dias_en_radar`. El registro, y no la corrida anterior, es lo que hace confiable la marca: si un día el Action no corre, un proceso visto hace tres días no se declara nuevo por error. Los procesos que ya estaban en el radar cuando se creó el registro quedan marcados `sembrado` y nunca cuentan como nuevos, para que el arranque en frío no marque todo el listado de golpe. Se poda a `SEEN_RETENTION_DAYS` (180 días).

**El seguimiento** es otra cosa: el repositorio no guarda historial de los procesos. Solo se conserva la trayectoria de los que alguien marca con la estrella en el tablero, y esa información no vive aquí sino en el almacén del propio artifact (capacidad `db` de claude.ai), porque la rutina reescribe el bloque de datos del tablero cada mañana.

Cada proceso seguido guarda un documento en la colección `seguimiento` con lo último que se supo de él y una lista de cambios en `estado`, `valor` y `modalidad`. El tablero compara contra el dato del día al abrirse y anota lo que cambió. Si nadie lo abre en varios días, el cambio se registra como un intervalo ("entre el 15 y el 18 de sept") en vez de inventar una fecha exacta. Un proceso seguido que sale de la ventana de 15 días se sigue mostrando, reconstruido desde lo último que se supo.

La lista es compartida por toda la organización: no hay capacidad `user` disponible en la cuenta, así que no existen listas privadas por persona.

Se puede inspeccionar desde Claude Code con la herramienta `ArtifactData` sobre la colección `seguimiento`.

## Ajustes

Para cambiar las palabras clave, edita el arreglo `RULES` en `scripts/fetch-secop.mjs`. Los procesos con valor ≥ $1.000 millones que coincidan con una palabra clave "fuerte" (no solo mesa de ayuda/soporte genérico) se marcan `destacado: true` — ajustable con `DESTACADO_VALOR_MIN` y el flag `weak` de cada regla.

La rutina republica el tablero **sin** pasar `capabilities`, lo cual conserva la declaración guardada. Si alguna vez llegara a pasarlas, revocaría la capacidad `db` y el equipo perdería su lista de seguimiento; el prompt de la rutina lo advierte de forma explícita.

Al cambiar la forma de los datos hay que actualizar también el prompt de la rutina (`RemoteTrigger action:update`, trigger `trig_01TYWswpG56dfVXbizXAckku`), que describe el JSON que espera el tablero.
