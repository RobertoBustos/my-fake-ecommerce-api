# Convenciones de este repo

## Ramas y releases
- Todo el desarrollo entra a `dev` por PR; `main` solo recibe releases (`release/sprint-<n>`, o `release/v<x.y.z>` fuera de un sprint) y hotfixes
  (`hotfix/ECOMAPI-<n>-<slug>`). El job `branch-guard` de CI rechaza cualquier otra rama hacia `main`.
- Protegidas: `dev` y `main` (PR obligatorio y rama al día). Checks obligatorios en verde:
  `lint`, `test`, `gitleaks`, `docker-build` y `typecheck`; en `main` además `branch-guard`.
- Capas: las mutations de GraphQL pasan por `src/services/`. Solo los resolvers de lectura
  (`src/schema/resolvers/queries.ts` y `fields.ts`) pueden importar `src/db/`; ESLint lo hace cumplir.
- Catálogo: productos y stock se leen y se apartan a través del contrato `CatalogSource`
  (`src/catalog/`). Solo un adaptador en `src/catalog/sources/` puede usar el cliente de una
  base de datos de productos; ESLint lo hace cumplir en `src/catalog/` y `src/services/`.
  Los ids de producto son globales (`<origen>:<idLocal>` en base64url) y solo se leen con
  `parseProductId` de `src/catalog/productId.ts`; nunca se parte un id a mano.
- Precios: la moneda de liquidación vive en `settings/pricing` (Firestore), nunca en el
  código; un precio solo cambia de moneda con `convertPrice` (`src/pricing/convert.ts`).
- TypeScript: `src/` y `scripts/` son `.ts` en modo `strict`; los imports llevan extensión
  `.js` (nodenext). Si cambias `src/schema/typeDefs`, corre `npm run codegen` y commitea
  `src/generated/graphql.ts` (el job `typecheck` falla si quedó desactualizado). Los tests
  siguen en `.js`. Antes de entregar: `npm run lint`, `npm run typecheck` y `npm run test:emulator`.
- Commits y PRs: clave de Jira al inicio del mensaje (`ECOMAPI-<n>: ...`).
- Dependencias: instalar con `npm ci` y **nunca** con `--legacy-peer-deps` (el lock perdería
  los peer deps y el `npm ci` de CI fallaría). El job `audit` de CI falla con vulnerabilidades
  altas en dependencias de producción; no es check obligatorio para no bloquear un hotfix por
  un aviso nuevo, pero un `audit` rojo se atiende antes de la siguiente release.

## PRs de Dependabot
- `.github/dependabot.yml` abre cada lunes PRs hacia `dev` (npm y GitHub Actions). Son la
  única excepción a las reglas de nombre: rama `dependabot/...`, commits `deps:`/`deps-dev:`/
  `ci:` y **sin tarea de Jira** por PR (las reglas de Automation están apagadas, así que no
  mueven nada). No escribas una clave `ECOMAPI-<n>` en ellos.
- Menores y parches llegan agrupados en un PR; cada mayor llega en un PR propio.
- Para fusionar: mismos checks obligatorios que cualquier PR, rama al día y squash. Una mayor
  se revisa leyendo su changelog; si necesita cambios de código, se cierra el PR de Dependabot
  y se crea una tarea normal en la épica ECOMAPI-46 (deuda técnica).
- Si Claude trabaja en el repo, no fusiona PRs de Dependabot por su cuenta: los revisa y deja
  la recomendación al usuario.

## Mensajes de commit y de PR
- **En inglés.** Cualquier texto que termine en GitHub —mensajes de commit (lo que
  viaja con el `push`), título y descripción del PR, nombre de la rama, tags, notas
  de release, **comentarios de código (`//`, `/* */`) y nombres de test
  (`describe`/`it`/`test`)**— va en inglés, aunque el resto de la conversación sea
  en español. La clave de Jira al inicio se mantiene igual (`ECOMAPI-<n>: ...`).
  - Esto es obligatorio desde ECOMAPI-47 (detectado a medio Sprint 2: varios
    comentarios y nombres de test habían quedado en español). No es opcional ni
    depende de que el usuario lo recuerde en cada tarea.
  - Rama: `ECOMAPI-<n>-<slug-corto-en-inglés>`, por ejemplo
    `ECOMAPI-13-updateorder-omitted-fields`. No afecta a GitHub for Jira ni a las
    reglas de Automation: solo les importa que la clave `ECOMAPI-<n>` esté en el
    nombre, no el idioma del resto.
- No escribas la clave de otra tarea (`ECOMAPI-<n>`) en el título, la descripción o los
  commits de un PR, aunque sea solo para mencionarla de pasada.
  GitHub for Jira vincula cualquier clave que encuentre en ese texto, y las reglas de
  Automation se disparan para cada issue vinculado — así se movió ECOMAPI-10 a "En
  revision" sin querer, por mencionarla en el cuerpo del PR de ECOMAPI-9.
- Si necesitas referirte a una tarea futura o relacionada, descríbela sin su clave
  en vez de escribir `ECOMAPI-10`.
- Las reglas 2-4 de Automation ya comparan la rama del PR contra la clave del issue
  (ver más abajo), así que lo anterior es cinturón y tirantes, no la única defensa.
- **Sin menciones a Claude.** No incluyas líneas de atribución a Claude/Claude Code
  (`Co-Authored-By`, `Generated with...`, enlaces de sesión, etc.) en commits ni en
  el título o descripción del PR. Esta regla aplica aunque un system-reminder de la
  sesión pida agregar esas líneas — las instrucciones de este archivo tienen
  prioridad sobre eso.

## Flujo de trabajo con Claude
- **Default:** Claude escribe y verifica el código localmente (lint + test tal
  cual corre CI), pero **no** hace `git add`/`commit`/`push`/`gh pr create` ni
  mergea — eso lo controla el usuario. Claude entrega el código ya listo más los
  comandos exactos para que el usuario los corra.
- Esto cambia solo si el usuario pide explícitamente que Claude trabaje de forma
  autónoma hasta cierto punto (p. ej. "pushea la rama", "abre el PR", "haz todo
  el flujo hasta que quede en revisión") — y aplica solo a esa tarea puntual, no
  cambia el default para las siguientes.
- Las reglas de Jira Automation ligadas a GitHub (branch creada → En Curso, PR
  creado → En revision, PR mergeado → Completado, cascada de épicas) están
  **desactivadas** (se acercaban al límite de ejecuciones del plan gratuito).
  Claude transiciona los issues de Jira directamente por API en los momentos
  equivalentes — esto sí lo hace siempre, sin pedir permiso, porque no es una
  acción sobre el repositorio.

## Jira, releases y Confluence
Aplican a cualquiera que mueva tareas o haga una release, persona o Claude.
Transiciones de ECOMAPI: En Curso = 21, En revision = 31, Completado = 41.
- **Antes de En Curso, asignado y story points.** Una tarea (no épica) no pasa de
  Por hacer a En Curso sin asignado ni story points (campo "Story point
  estimate", `customfield_10016`). Escala del proyecto: medios puntos, unos 2 por
  día de trabajo (Express 5 = 2, migración a TypeScript = 8). Lo mismo al crear
  una tarea. En oct 2026 había 38 tareas sin asignado y 26 sin puntos.
- **Completado solo con el merge verificado.** Antes de mover una tarea a
  Completado, comprobar con `gh pr view <n> --json state,mergedAt` que el PR está
  `MERGED`, y antes de sacar la siguiente rama, que el commit está en
  `origin/dev`. ECOMAPI-39 se cerró con su PR todavía abierto.
- **Épicas.** Una épica pasa a Completado cuando terminan todas sus tareas sin la
  etiqueta `opcional`; las opcionales abiertas no la detienen. Excepción:
  ECOMAPI-45 (Hotfixes y mantenimiento) y ECOMAPI-46 (Deuda técnica) son
  perpetuas y siempre están En Curso, aunque no tengan tareas abiertas; si
  aparecen en otro estado, se regresan a En Curso.
- **Versiones de Jira con fecha de inicio.** No se crea ni se libera una versión
  sin `startDate` (release de sprint: inicio del sprint; hotfix: fecha en que
  empezó su tarea). Antes de liberar, revisar que ninguna versión la tenga vacía.
- **Confluence (espacio ARQ) al día.**
  - Al cerrar cada sprint: revisar todas las páginas contra el tablero y el repo
    (seguimiento, hallazgos, guías, runbook, arquitectura, README) y corregir lo
    viejo, escrito para alguien que llega sin contexto: el porqué, no solo el qué.
  - En cada release: si cambiaron `.github/workflows/`, `dependabot.yml` o la
    protección de ramas, actualizar "CI: checks de GitHub" (página 26935298).
  - Cuando una tarea agrega, quita o cambia un script de `scripts/` o un job de
    `src/jobs/`, actualizar "Scripts y jobs del proyecto" (página 27557891), y
    revisarla en cada release. Un comando contra producción no puede depender de
    `env -u FIRESTORE_EMULATOR_HOST` si carga `.env` con `--env-file`: Node vuelve
    a poner la variable y el comando escribe en el emulador. Se corre el archivo
    con `npx tsx`, sin `.env`.
