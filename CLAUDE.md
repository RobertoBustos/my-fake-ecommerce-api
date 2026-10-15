# Convenciones de este repo

## Ramas y releases
- Todo el desarrollo entra a `dev` por PR; `main` solo recibe releases (`release/sprint-<n>`) y hotfixes.
- Protegidas: `dev` y `main` (PR obligatorio, checks `lint` y `test` en verde).
- Commits y PRs: clave de Jira al inicio del mensaje (`ECOMAPI-<n>: ...`).

## Mensajes de commit y de PR
- **En inglés.** Cualquier texto que termine en GitHub —mensajes de commit (lo que
  viaja con el `push`), título y descripción del PR, nombre de la rama, tags, notas
  de release— va en inglés, aunque el resto de la conversación sea en español. La
  clave de Jira al inicio se mantiene igual (`ECOMAPI-<n>: ...`).
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
  el título o descripción del PR.
