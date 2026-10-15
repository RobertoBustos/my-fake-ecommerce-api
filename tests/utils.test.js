import { describe, it, expect } from "vitest";
import { readFile } from "../src/utils/fileUtils.js";
import { fakePromise } from "../src/utils/fakePromise.js";

describe("fileUtils (H8)", () => {
  it("readFile de un archivo inexistente rechaza una sola vez, sin tronar después", async () => {
    // Antes del fix, faltaba un `return` después de reject(err): seguía
    // ejecutando y JSON.parse(undefined) tronaba por fuera de la promesa.
    await expect(readFile("../data/no-existe.json")).rejects.toBeTruthy();
  });
});

describe("fakePromise (H14)", () => {
  it("respeta los milisegundos que recibe, no 1000 fijo", async () => {
    const start = Date.now();
    await fakePromise(30);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(500);
  });
});
