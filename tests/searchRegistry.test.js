import { afterEach, describe, expect, it } from "vitest";
import {
  assertSearchEngineConfig,
  getSearchIndex,
  SearchEngineNotConfiguredError,
  UnknownSearchEngineError,
} from "../src/search/registry.js";
import { createApp } from "../src/app.js";

const original = process.env.SEARCH_ENGINE;

afterEach(() => {
  if (original === undefined) delete process.env.SEARCH_ENGINE;
  else process.env.SEARCH_ENGINE = original;
});

describe("search engine selection (SEARCH_ENGINE)", () => {
  it("serves the in-memory index for SEARCH_ENGINE=memory, the same one on every call", () => {
    process.env.SEARCH_ENGINE = "memory";
    const index = getSearchIndex();
    expect(index.key).toBe("memory");
    expect(getSearchIndex()).toBe(index);
  });

  it("rejects an engine the code doesn't know, naming the known ones", () => {
    process.env.SEARCH_ENGINE = "elastic";
    expect(() => assertSearchEngineConfig()).toThrow(UnknownSearchEngineError);
    expect(() => getSearchIndex()).toThrow(/known engines: memory/);
  });

  it("allows an unset SEARCH_ENGINE at startup but not when something searches", () => {
    delete process.env.SEARCH_ENGINE;
    expect(() => assertSearchEngineConfig()).not.toThrow();
    expect(() => getSearchIndex()).toThrow(SearchEngineNotConfiguredError);
  });

  it("stops the app from starting with an unknown engine", async () => {
    process.env.SEARCH_ENGINE = "elastic";
    await expect(createApp()).rejects.toThrow(UnknownSearchEngineError);
  });
});
