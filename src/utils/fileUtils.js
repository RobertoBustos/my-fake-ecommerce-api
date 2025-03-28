import fs from "fs";

export const readFile = (path) => {
  const fileContent = fs.readFileSync(new URL(path, import.meta.url), "utf8");
  return JSON.parse(fileContent);
};

export const writeFile = (path, content, callback) => {
  return fs.writeFile(
    new URL(path, import.meta.url),
    JSON.stringify(content),
    callback
  );
};
