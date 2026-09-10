# Radar de licitaciones SECOP — ARIA PSW

Escanea a diario el dataset público de SECOP II (datos.gov.co, `p6dx-8zbt`) y filtra los procesos de contratación que coinciden con el portafolio de ARIA PSW (Liferay/portales, fábrica de software, IA/agentes, integración TIBCO/ESB).

- `scripts/fetch-secop.mjs` — consulta la API, aplica las reglas de palabras clave y escribe `data/latest.json`.
- `.github/workflows/secop-fetch.yml` — corre el script todos los días a las 4:00 a.m. hora Colombia y hace commit del resultado.
- `data/latest.json` — última corrida; lo lee una rutina de Claude que publica el dashboard.

Para ajustar las palabras clave, edita el arreglo `RULES` en `scripts/fetch-secop.mjs`. Los procesos con valor ≥ $1.000 millones y que coincidan con una palabra clave "fuerte" (no solo mesa de ayuda/soporte genérico) se marcan `destacado: true` y aparecen en la sección "Destacados" del dashboard — ajustable con `DESTACADO_VALOR_MIN` y el flag `weak` de cada regla.
