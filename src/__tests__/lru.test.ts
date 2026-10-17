import { describe, expect, test } from "bun:test";
import { LruCache } from "../preview/lru";

describe("the preview image cache", () => {
  const cache = () => new LruCache<string>(10, (value) => value.length);

  test("keeps values within its size, dropping the least recently used first", () => {
    const c = cache();
    c.set("a", "aaaa");
    c.set("b", "bbbb");
    expect(c.get("a")).toBe("aaaa"); // a is now the most recently used
    c.set("c", "cccc");
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe("aaaa");
    expect(c.get("c")).toBe("cccc");
    expect(c.size).toBe(8);
  });

  test("replacing a value updates the total rather than adding to it", () => {
    const c = cache();
    c.set("a", "aaaa");
    c.set("a", "aaaaaa");
    expect(c.size).toBe(6);
    expect(c.count).toBe(1);
  });

  test("doesn't keep a value larger than the whole cache", () => {
    const c = cache();
    c.set("a", "aaaa");
    c.set("big", "x".repeat(11));
    expect(c.get("big")).toBeUndefined();
    expect(c.get("a")).toBe("aaaa");
  });
});
