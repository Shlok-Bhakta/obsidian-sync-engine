import { expect, test } from "bun:test";
import * as Y from "yjs";

test("concurrent Yjs updates converge when delivered in different orders", () => {
  const seed = new Y.Doc();
  seed.getText("content").insert(0, "hello");
  const initial = Y.encodeStateAsUpdate(seed);
  const left = new Y.Doc();
  const right = new Y.Doc();
  Y.applyUpdate(left, initial);
  Y.applyUpdate(right, initial);
  left.getText("content").insert(5, " left");
  right.getText("content").insert(0, "right ");
  const leftUpdate = Y.encodeStateAsUpdate(left, Y.encodeStateVector(seed));
  const rightUpdate = Y.encodeStateAsUpdate(right, Y.encodeStateVector(seed));
  const first = new Y.Doc();
  const second = new Y.Doc();
  for (const update of [initial, leftUpdate, rightUpdate]) Y.applyUpdate(first, update);
  for (const update of [rightUpdate, initial, leftUpdate]) Y.applyUpdate(second, update);
  expect(first.getText("content").toJSON()).toBe(second.getText("content").toJSON());
  expect(Y.encodeStateAsUpdate(first)).toEqual(Y.encodeStateAsUpdate(second));
});
