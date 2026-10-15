// `npm start` carga .env con el flag nativo de Node (--env-file=.env), así
// que process.env ya está listo cuando este archivo se importa. No hace
// falta una segunda carga con dotenv: dos mecanismos para lo mismo es
// justo el hallazgo H12 (configuración duplicada y frágil).
export default process.env;
