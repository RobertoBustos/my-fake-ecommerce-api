import fs from "fs";

export const readFile = (path) => {
  return new Promise((resolve, reject) => {
    fs.readFile(new URL(path, import.meta.url), "utf8", (err, data) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(JSON.parse(data));
    });
  });
};

export const writeFile = (path, content) => {
  return new Promise((resolve, reject) => {
    fs.writeFile(
      new URL(path, import.meta.url),
      JSON.stringify(content),
      (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(true);
      }
    );
  });
};
