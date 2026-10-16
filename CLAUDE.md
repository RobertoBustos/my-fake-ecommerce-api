# Convenciones de este repo

## Ramas y releases
- Todo el desarrollo entra a `dev` por PR; `main` solo recibe releases (`release/sprint-<n>`) y hotfixes.
- Protegidas: `dev` y `main` (PR obligatorio, checks `lint` y `test` en verde).
- Commits y PRs: clave de Jira al inicio del mensaje (`ECOMAPI-<n>: ...`).

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
