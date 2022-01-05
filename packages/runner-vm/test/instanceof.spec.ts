import vm from "vm";
import { defineHasInstances } from "@miniflare/runner-vm";
import test, { Macro } from "ava";

const instanceOfMacro: Macro<
  [type: string, create: () => any, invert?: boolean]
> = (t, type, create, invert) => {
  const ctx = vm.createContext({ outside: create() });
  defineHasInstances(ctx);
  const result = vm.runInContext(
    `({
      outsideInstanceOf: outside instanceof ${type},
      insideInstanceOf: (${create.toString()})() instanceof ${type},
    })`,
    ctx
  );
  const assert = invert ? t.false : t.true;
  const message = invert ? "instanceof" : "not instanceof";
  assert(result.outsideInstanceOf, "outside " + message);
  assert(result.insideInstanceOf, "inside " + message);
};
instanceOfMacro.title = (providedTitle, type) =>
  `proxiedGlobals: ${type}: ${
    providedTitle ?? "supports cross-realm instanceof"
  }`;
test(instanceOfMacro, "Object", () => ({ a: 1 }));
test(instanceOfMacro, "Array", () => [1]);
test(instanceOfMacro, "Promise", () => (async () => {})());
test(instanceOfMacro, "RegExp", () => /a/);
test(instanceOfMacro, "Error", () => new Error());
test(instanceOfMacro, "EvalError", () => new EvalError());
test(instanceOfMacro, "RangeError", () => new RangeError());
test(instanceOfMacro, "ReferenceError", () => new ReferenceError());
test(instanceOfMacro, "SyntaxError", () => new SyntaxError());
test(instanceOfMacro, "TypeError", () => new TypeError());
test(instanceOfMacro, "URIError", () => new URIError());
test(instanceOfMacro, "Function", () => () => {});

test(
  "supports subclass cross-realm instanceof",
  instanceOfMacro,
  "Error",
  () => new RangeError()
);
test(
  "supports not instanceof",
  instanceOfMacro,
  "EvalError",
  () => new TypeError(),
  true
);

test("calling defineHasInstances on same context multiple times doesn't throw", (t) => {
  const ctx = vm.createContext({});
  defineHasInstances(ctx);
  defineHasInstances(ctx);
  t.pass();
});
