# Convenciones de este repo

## Ramas y releases
- Todo el desarrollo entra a `dev` por PR; `main` solo recibe releases (`release/sprint-<n>`) y hotfixes.
- Protegidas: `dev` y `main` (PR obligatorio, checks `lint` y `test` en verde).
- Commits y PRs: clave de Jira al inicio del mensaje (`ECOMAPI-<n>: ...`).

## Mensajes de commit y de PR
- No escribas la clave de otra tarea (`ECOMAPI-<n>`) en el título, la descripción o los
  commits de un PR, aunque sea solo para mencionarla de pasada.
  GitHub for Jira vincula cualquier clave que encuentre en ese texto, y las reglas de
  Automation se disparan para cada issue vinculado — así se movió ECOMAPI-10 a "En
  revision" sin querer, por mencionarla en el cuerpo del PR de ECOMAPI-9.
- Si necesitas referirte a una tarea futura o relacionada, descríbela sin su clave
  ("el lint real llega en la siguiente tarea") en vez de escribir `ECOMAPI-10`.
- (Pendiente, a reforzar más adelante: agregar una condición a la regla de Automation
  que compare la rama del PR contra la clave del issue, para que esto quede blindado
  también del lado de Jira.)
