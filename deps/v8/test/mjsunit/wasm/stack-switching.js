// Copyright 2024 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Flags: --experimental-wasm-stack-switching
// Flags: --allow-natives-syntax --experimental-wasm-type-reflection
// Flags: --expose-gc --wasm-stack-switching-stack-size=100

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

(function TestInvalidWrappers() {
  print(arguments.callee.name);
  assertThrows(() => WebAssembly.promising({}), TypeError,
      /Argument 0 must be a function/);
  assertThrows(() => WebAssembly.promising(() => {}), TypeError,
      /Argument 0 must be a WebAssembly exported function/);
  assertThrows(() => WebAssembly.Suspending(() => {}), TypeError,
      /WebAssembly.Suspending must be invoked with 'new'/);
  assertThrows(() => new WebAssembly.Suspending({}), TypeError,
      /Argument 0 must be a function/);
  function asmModule() {
    "use asm";
    function x(v) {
      v = v | 0;
    }
    return x;
  }
  assertThrows(() => WebAssembly.promising(asmModule()), TypeError,
      /Argument 0 must be a WebAssembly exported function/);

  let builder = new WasmModuleBuilder();
  builder.addFunction("forty2", kSig_i_v)
      .addBody([
          kExprI32Const, 42]).exportFunc();
  let instance = builder.instantiate();

  assertThrows(()=> new WebAssembly.Suspending(instance.exports.forty2), TypeError,
      /Argument 0 must not be a WebAssembly function/);

  let funcref = new WebAssembly.Function(
    {parameters: [], results: ['i32']},
      (() => 42));

  assertThrows(() => new WebAssembly.Suspending(funcref ), TypeError,
      /Argument 0 must not be a WebAssembly function/);
})();

(function TestStackSwitchNoSuspend() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  builder.addGlobal(kWasmI32, true, false).exportAs('g');
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprI32Const, 42,
          kExprGlobalSet, 0,
          kExprI32Const, 0]).exportFunc();
  let instance = builder.instantiate();
  let wrapper = WebAssembly.promising(instance.exports.test);
  wrapper();
  assertEquals(42, instance.exports.g.value);
})();

(function TestStackSwitchSuspend() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  import_index = builder.addImport('m', 'import', kSig_i_v);
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprCallFunction, import_index, // suspend
      ]).exportFunc();
  let js_import = new WebAssembly.Suspending(() => Promise.resolve(42));
  let instance = builder.instantiate({m: {import: js_import}});
  let wrapped_export = WebAssembly.promising(instance.exports.test);
  let combined_promise = wrapped_export();
  assertPromiseResult(combined_promise, v => assertEquals(42, v));

  // Also try with a JS function with a mismatching arity.
  js_import = new WebAssembly.Suspending((unused) => Promise.resolve(42));
  instance = builder.instantiate({m: {import: js_import}});
  wrapped_export = WebAssembly.promising(instance.exports.test);
  combined_promise = wrapped_export();
  assertPromiseResult(combined_promise, v => assertEquals(42, v));

  // Also try with a proxy.
  js_import = new WebAssembly.Suspending(new Proxy(() => Promise.resolve(42), {}));
  instance = builder.instantiate({m: {import: js_import}});
  wrapped_export = WebAssembly.promising(instance.exports.test);
  combined_promise = wrapped_export();
  assertPromiseResult(combined_promise, v => assertEquals(42, v));
  %CheckIsOnCentralStack();
})();

// Check that we can suspend back out of a resumed computation.
(function TestStackSwitchSuspendLoop() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  builder.addGlobal(kWasmI32, true, false).exportAs('g');
  import_index = builder.addImport('m', 'import', kSig_i_v);
  // Pseudo-code for the wasm function:
  // for (i = 0; i < 5; ++i) {
  //   g = g + import();
  // }
  builder.addFunction("test", kSig_i_v)
      .addLocals(kWasmI32, 1)
      .addBody([
          kExprI32Const, 5,
          kExprLocalSet, 0,
          kExprLoop, kWasmVoid,
            kExprCallFunction, import_index, // suspend
            kExprGlobalGet, 0, // resume
            kExprI32Add,
            kExprGlobalSet, 0,
            kExprLocalGet, 0,
            kExprI32Const, 1,
            kExprI32Sub,
            kExprLocalTee, 0,
            kExprBrIf, 0,
          kExprEnd,
          kExprI32Const, 0,
      ]).exportFunc();
  let i = 0;
  // The n-th call to the import returns a promise that resolves to n.
  function js_import() {
    return Promise.resolve(++i);
  };
  let wasm_js_import = new WebAssembly.Suspending(js_import);
  let instance = builder.instantiate({m: {import: wasm_js_import}});
  let wrapped_export = WebAssembly.promising(instance.exports.test);
  let chained_promise = wrapped_export();
  assertEquals(0, instance.exports.g.value);
  assertPromiseResult(chained_promise, _ => assertEquals(15, instance.exports.g.value));
})();

// Call the GC in the import call.
(function TestStackSwitchGC() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  let gc_index = builder.addImport('m', 'gc', kSig_v_v);
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprCallFunction, gc_index,
          kExprI32Const, 0
      ]).exportFunc();
  let js_import = new WebAssembly.Suspending(gc);
  let instance = builder.instantiate({'m': {'gc': js_import}});
  let wrapper = WebAssembly.promising(instance.exports.test);
  wrapper();
})();

// Call the GC during param conversion.
(function TestStackSwitchGC2() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  let import_index = builder.addImport('m', 'import', kSig_i_i);
  builder.addFunction("test", kSig_i_i)
      .addBody([
          kExprLocalGet, 0,
          kExprCallFunction, import_index,
      ]).exportFunc();
  let js_import = new WebAssembly.Suspending((v) => { return Promise.resolve(v) });
  let instance = builder.instantiate({'m': {'import': js_import}});
  let wrapper = WebAssembly.promising(instance.exports.test);
  let arg = { valueOf: () => { gc(); return 24; } };
  assertPromiseResult(wrapper(arg), v => assertEquals(arg.valueOf(), v));
})();

// Check that the suspender DOES suspend even if the import's
// return value is not a promise.
(function TestStackSwitchNoPromise() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  builder.addGlobal(kWasmI32, true, false).exportAs('g');
  import_index = builder.addImport('m', 'import', kSig_i_v);
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprCallFunction, import_index, // suspend
          kExprGlobalSet, 0, // resume
          kExprGlobalGet, 0,
      ]).exportFunc();
  function js_import() {
    return 42
  };
  let wasm_js_import = new WebAssembly.Suspending(js_import);
  let instance = builder.instantiate({m: {import: wasm_js_import}});
  let wrapped_export = WebAssembly.promising(instance.exports.test);
  let result = wrapped_export();
  assertEquals(0, instance.exports.g.value);
})();

(function TestStackSwitchSuspendArgs() {
  print(arguments.callee.name);
  function reduce(array) {
    // a[0] + a[1] * 2 + a[2] * 3 + ...
    return array.reduce((prev, cur, i) => prev + cur * (i + 1));
  }
  let builder = new WasmModuleBuilder();
  // Number of param registers + 1 for both types.
  let params = [kWasmI32, kWasmI32, kWasmI32, kWasmI32, kWasmI32, kWasmI32,
      kWasmF32, kWasmF32, kWasmF32, kWasmF32, kWasmF32, kWasmF32, kWasmF32];
  let sig = makeSig(params, [kWasmI32]);
  import_index = builder.addImport('m', 'import', sig);
  builder.addFunction("test", sig)
      .addBody([
          kExprLocalGet, 0, kExprLocalGet, 1, kExprLocalGet, 2, kExprLocalGet, 3,
          kExprLocalGet, 4, kExprLocalGet, 5, kExprLocalGet, 6, kExprLocalGet, 7,
          kExprLocalGet, 8, kExprLocalGet, 9, kExprLocalGet, 10, kExprLocalGet, 11,
          kExprLocalGet, 12,
          kExprCallFunction, import_index, // suspend
      ]).exportFunc();
  function js_import(i1, i2, i3, i4, i5, i6, f1, f2, f3, f4, f5, f6, f7) {
    return Promise.resolve(reduce(Array.from(arguments)));
  };
  let wasm_js_import = new WebAssembly.Suspending(js_import);

  let instance = builder.instantiate({m: {import: wasm_js_import}});
  let wrapped_export = WebAssembly.promising(instance.exports.test);
  let args = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  let combined_promise =
      wrapped_export.apply(null, args);
  assertPromiseResult(combined_promise, v => assertEquals(reduce(args), v));
})();

(function TestStackSwitchReturnFloat() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  import_index = builder.addImport('m', 'import', kSig_f_v);
  builder.addFunction("test", kSig_f_v)
      .addBody([
          kExprCallFunction, import_index, // suspend
      ]).exportFunc();
  function js_import() {
    return Promise.resolve(0.5);
  };
  let wasm_js_import = new WebAssembly.Suspending(js_import);

  let instance = builder.instantiate({m: {import: wasm_js_import}});
  let wrapped_export = WebAssembly.promising(instance.exports.test);
  let combined_promise = wrapped_export();
  assertPromiseResult(combined_promise, v => assertEquals(0.5, v));
})();

// Throw an exception before suspending. The export wrapper should return a
// promise rejected with the exception.
(function TestStackSwitchException1() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  let tag = builder.addTag(kSig_v_v);
  builder.addFunction("throw", kSig_i_v)
      .addBody([kExprThrow, tag]).exportFunc();
  let instance = builder.instantiate();
  let wrapper = WebAssembly.promising(instance.exports.throw);
  assertThrowsAsync(wrapper(), WebAssembly.Exception);
})();

// Throw an exception after the first resume event, which propagates to the
// promise wrapper.
(function TestStackSwitchException2() {
  print(arguments.callee.name);
  let tag = new WebAssembly.Tag({parameters: []});
  let builder = new WasmModuleBuilder();
  import_index = builder.addImport('m', 'import', kSig_i_v);
  tag_index = builder.addImportedTag('m', 'tag', kSig_v_v);
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprCallFunction, import_index,
          kExprThrow, tag_index
      ]).exportFunc();
  function js_import() {
    return Promise.resolve(42);
  };
  let wasm_js_import = new WebAssembly.Suspending(js_import);

  let instance = builder.instantiate({m: {import: wasm_js_import, tag: tag}});
  let wrapped_export = WebAssembly.promising(instance.exports.test);
  let combined_promise = wrapped_export();
  assertThrowsAsync(combined_promise, WebAssembly.Exception);
})();

(function TestStackSwitchPromiseReject() {
  print(arguments.callee.name);
  let tag = new WebAssembly.Tag({parameters: ['i32']});
  let builder = new WasmModuleBuilder();
  import_index = builder.addImport('m', 'import', kSig_i_v);
  tag_index = builder.addImportedTag('m', 'tag', kSig_v_i);
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprTry, kWasmI32,
          kExprCallFunction, import_index,
          kExprCatch, tag_index,
          kExprEnd,
      ]).exportFunc();
  function js_import() {
    return Promise.reject(new WebAssembly.Exception(tag, [42]));
  };
  let wasm_js_import = new WebAssembly.Suspending(js_import);

  let instance = builder.instantiate({m: {import: wasm_js_import, tag: tag}});
  let wrapped_export = WebAssembly.promising(instance.exports.test);
  let combined_promise = wrapped_export();
  assertPromiseResult(combined_promise, v => assertEquals(v, 42));
})();

function TestNestedSuspenders(suspend) {
  // Nest two suspenders. The call chain looks like:
  // outer (wasm) -> outer (js) -> inner (wasm) -> inner (js)
  // If 'suspend' is true, the inner JS function returns a Promise, which
  // suspends the inner wasm function, which returns a Promise, which suspends
  // the outer wasm function, which returns a Promise. The inner Promise
  // resolves first, which resumes the inner continuation. Then the outer
  // promise resolves which resumes the outer continuation.
  // If 'suspend' is false, the inner and outer JS functions return a regular
  // value and no computation is suspended.
  let builder = new WasmModuleBuilder();
  inner_index = builder.addImport('m', 'inner', kSig_i_v);
  outer_index = builder.addImport('m', 'outer', kSig_i_v);
  builder.addFunction("outer", kSig_i_v)
      .addBody([
          kExprCallFunction, outer_index
      ]).exportFunc();
  builder.addFunction("inner", kSig_i_v)
      .addBody([
          kExprCallFunction, inner_index
      ]).exportFunc();

  let inner = new WebAssembly.Suspending(() => suspend ? Promise.resolve(42) : 42);

  let export_inner;
  let outer = new WebAssembly.Suspending(() => suspend ? export_inner() : 42);

  let instance = builder.instantiate({m: {inner, outer}});
  export_inner = WebAssembly.promising(instance.exports.inner);
  let export_outer = WebAssembly.promising(instance.exports.outer);
  assertPromiseResult(export_outer(), v => assertEquals(42, v));
}

(function TestNestedSuspendersSuspend() {
  print(arguments.callee.name);
  TestNestedSuspenders(true);
})();

(function TestNestedSuspendersNoSuspend() {
  print(arguments.callee.name);
  TestNestedSuspenders(false);
})();

(function Regress13231() {
  print(arguments.callee.name);
  // Check that a promising function with no return is allowed.
  let builder = new WasmModuleBuilder();
  builder.addFunction("export", kSig_v_v).addBody([]).exportFunc();
  let instance = builder.instantiate();
  let export_wrapper = WebAssembly.promising(instance.exports.export);
  let export_sig = export_wrapper.type();
  assertEquals([], export_sig.parameters);
  assertEquals(['externref'], export_sig.results);
})();

(function TestStackOverflow() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprCallFunction, 0
          ]).exportFunc();
  let instance = builder.instantiate();
  let wrapper = WebAssembly.promising(instance.exports.test);
  assertThrowsAsync(wrapper(), RangeError, /Maximum call stack size exceeded/);
})();

(function SuspendCallRef() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  let funcref_type = builder.addType(kSig_i_v);
  let table = builder.addTable(wasmRefNullType(funcref_type), 1)
                         .exportAs('table');
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprI32Const, 0, kExprTableGet, table.index,
          kExprCallRef, funcref_type,
      ]).exportFunc();
  let instance = builder.instantiate();

  let funcref = new WebAssembly.Function(
      {parameters: [], results: ['i32']},
        new WebAssembly.Suspending(() => Promise.resolve(42)));
  instance.exports.table.set(0, funcref);

  let exp = WebAssembly.promising(instance.exports.test);
  assertPromiseResult(exp(), v => assertEquals(42, v));
})();

(function SuspendCallIndirect() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  let functype = builder.addType(kSig_i_v);
  let table = builder.addTable(kWasmFuncRef, 10, 10);
  let callee = builder.addImport('m', 'f', kSig_i_v);
  builder.addActiveElementSegment(table, wasmI32Const(0), [callee]);
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprI32Const, 0,
          kExprCallIndirect, functype, table.index,
      ]).exportFunc();

  let create_promise = new WebAssembly.Suspending(() => Promise.resolve(42));

  let instance = builder.instantiate({m: {f: create_promise}});

  let exp = WebAssembly.promising(instance.exports.test);
  assertPromiseResult(exp(), v => assertEquals(42, v));
})();

(function TestSwitchingToTheCentralStackForJS() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  import_index = builder.addImport('m', 'import', kSig_i_v);
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprCallFunction, import_index,
      ]).exportFunc();
  let js_import = new WebAssembly.Suspending(
      () => {
        %CheckIsOnCentralStack();
        return 123;
      });
  let instance = builder.instantiate({m: {import: js_import}});
  let wrapped_export = WebAssembly.promising(instance.exports.test);
  assertPromiseResult(wrapped_export(), v => assertEquals(123, v));
})();

// Test that the wasm-to-js stack params get scanned.
(function TestSwitchingToTheCentralStackManyParams() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  const num_params = 10;
  const sig = makeSig(Array(num_params).fill(kWasmExternRef), [kWasmExternRef]);
  const import_index = builder.addImport('m', 'import_', sig);
  let body = [];
  for (let i = 0; i < num_params; ++i) {
    body.push(kExprLocalGet, i);
  }
  body.push(kExprCallFunction, import_index);
  builder.addFunction("test", sig)
      .addBody(body).exportFunc();
  function import_js(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    gc();
    return [arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9];
  };
  import_js();
  let import_ = new WebAssembly.Suspending(import_js);
  let instance = builder.instantiate({m: {import_}});
  let wrapper = WebAssembly.promising(instance.exports.test);
  let args = Array(num_params).fill({});
  assertPromiseResult(wrapper(...args), results => { assertEquals(args, results); });
})();

// Similar to TestNestedSuspenders, but trigger an infinite recursion inside the
// outer wasm function after the import call. This is likely to crash if the
// stack limit is not properly restored when we return from the central stack.
// In particular in the nested case, we should preserve and restore the limit of
// each intermediate secondary stack.
(function TestCentralStackReentrency() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  inner_index = builder.addImport('m', 'inner', kSig_i_v);
  outer_index = builder.addImport('m', 'outer', kSig_i_v);
  let stack_overflow = builder.addFunction('stack_overflow', kSig_v_v)
      .addBody([kExprCallFunction, 2]);
  builder.addFunction("outer", kSig_i_v)
      .addBody([
          kExprCallFunction, outer_index,
          kExprCallFunction, stack_overflow.index,
      ]).exportFunc();
  builder.addFunction("inner", kSig_i_v)
      .addBody([
          kExprCallFunction, inner_index
      ]).exportFunc();

  let inner = new WebAssembly.Suspending(() => Promise.resolve(42));

  let export_inner;
  let outer = new WebAssembly.Suspending(() => export_inner());

  let instance = builder.instantiate({m: {inner, outer}});
  export_inner = WebAssembly.promising(instance.exports.inner);
  let export_outer = WebAssembly.promising(instance.exports.outer);
  assertThrowsAsync(export_outer(), RangeError,
      /Maximum call stack size exceeded/);
})();

(function TestStackSwitchRegressStackLimit() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  suspend_index = builder.addImport('m', 'suspend', kSig_v_r);
  let leaf_index = builder.addFunction("leaf", kSig_v_v)
      .addBody([
      ]).index;
  let stackcheck_index = builder.addFunction("stackcheck", kSig_v_v)
      .addBody([
          kExprCallFunction, leaf_index,
      ]).index;
  builder.addFunction("test", kSig_v_r)
      .addBody([
          kExprLocalGet, 0,
          kExprCallFunction, suspend_index,
          // This call should not throw a stack overflow.
          kExprCallFunction, stackcheck_index,
      ]).exportFunc();
  let suspend = new WebAssembly.Suspending(() => Promise.resolve());
  let instance = builder.instantiate({m: {suspend}});
  let wrapped_export = WebAssembly.promising(instance.exports.test);
  assertPromiseResult(wrapped_export(), v => assertEquals(undefined, v));
})();

(function TestSuspendTwoModules() {
  print(arguments.callee.name);
  let builder1 = new WasmModuleBuilder();
  import_index = builder1.addImport('m', 'import', kSig_i_v);
  builder1.addFunction("f", kSig_i_v)
      .addBody([
          kExprCallFunction, import_index, // suspend
          kExprI32Const, 1,
          kExprI32Add,
      ]).exportFunc();
  let js_import = new WebAssembly.Suspending(() => Promise.resolve(1));
  let instance1 = builder1.instantiate({m: {import: js_import}});
  let builder2 = new WasmModuleBuilder();
  import_index = builder2.addImport('m', 'import', kSig_i_v);
  builder2.addFunction("main", kSig_i_v)
      .addBody([
          kExprCallFunction, import_index,
          kExprI32Const, 1,
          kExprI32Add,
      ]).exportFunc();
  let instance2 = builder2.instantiate({m: {import: instance1.exports.f}});
  let wrapped_export = WebAssembly.promising(instance2.exports.main);
  let combined_promise = wrapped_export();
  assertPromiseResult(combined_promise, v => assertEquals(3, v));
})();

(function ReImportedSuspendingImport() {
  print(arguments.callee.name);
  let builder1 = new WasmModuleBuilder();
  import_index = builder1.addImport('m', 'import', kSig_i_v);
  builder1.addExport("f", import_index);
  let js_import = new WebAssembly.Suspending(() => Promise.resolve(1));
  let instance1 = builder1.instantiate({m: {import: js_import}});
  let builder2 = new WasmModuleBuilder();
  import_index = builder2.addImport('m', 'import', kSig_i_v);
  builder2.addFunction("main", kSig_i_v)
      .addBody([
          kExprCallFunction, import_index,
          kExprI32Const, 1,
          kExprI32Add,
      ]).exportFunc();
  let instance2 = builder2.instantiate({m: {import: instance1.exports.f}});
  let wrapped_export = WebAssembly.promising(instance2.exports.main);
  let combined_promise = wrapped_export();
  assertPromiseResult(combined_promise, v => assertEquals(2, v));
})();

// Send a termination request to a worker with a full stack pool, to check that
// retiring the stack does not invalidate the stack memory that the unwinder is
// currently using.
(function TestTerminationWithFullStackPool() {
  print(arguments.callee.name);
  const builder = new WasmModuleBuilder();
  let js_async = builder.addImport('m', 'js_async', kSig_v_v);
  let fill_stack_pool = builder.addImport('m', 'fill_stack_pool', kSig_v_v);
  builder.addFunction('wasm_async', kSig_v_v).addBody([
      kExprCallFunction, js_async,
  ]).exportFunc();
  builder.addFunction('main', kSig_v_v).addBody([
    kExprCallFunction, fill_stack_pool,
    kExprLoop, kWasmVoid, kExprBr, 0, kExprEnd
  ]).exportFunc();
  const module = builder.toModule();

  function workerCode() {
    d8.test.enableJSPI();
    onmessage = async function({data:module}) {
      let wasm_async;
      let instance = new WebAssembly.Instance(module, {m: {
        js_async: new WebAssembly.Suspending(() => {
          return Promise.resolve();
        }),
        fill_stack_pool: new WebAssembly.Suspending(async () => {
          let promises = [];
          // Suspend multiple concurrent calls to create multiple stacks.
          for (let i = 0; i < 50; ++i) {
            promises.push(wasm_async());
          }
          // Await them now, which returns the finished stacks to the stack pool.
          for (let i = 0; i < 50; ++i) {
            await promises[i];
          }
          // Terminate the worker. This unwinds the main stack and attempts to
          // return it to the stack pool, which is already full.
          postMessage('terminate');
        })
      }});
      wasm_async = WebAssembly.promising(instance.exports.wasm_async);
      WebAssembly.promising(instance.exports.main)();
    };
  }

  const worker = new Worker(workerCode, {type: 'function'});
  worker.postMessage(module);
  assertEquals('terminate', worker.getMessage());
  worker.terminateAndWait();
})();

// A promising export splits the logical stack into multiple segments in memory.
// Check that the stack frame iterator still iterates the full logical stack
// where we expect it to, e.g. in error stack traces.
(function TestStackTrace() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  import_index = builder.addImport('m', 'check_stack', kSig_v_v);
  builder.addFunction("test", kSig_v_v)
      .addBody([
          kExprCallFunction, import_index
      ]).exportFunc();
  stacks = [];
  function check_stack() {
    let e = new Error();
    stacks.push(e.stack);
  }
  let instance = builder.instantiate({m: {check_stack}});
  let wrapper_sync = instance.exports.test;
  let wrapper_async = WebAssembly.promising(instance.exports.test);
  // Perform the calls in a loop so that the source location of the call is
  // the same, which makes it easy to compare their call stack below.
  for (let exp of [wrapper_sync, wrapper_async]) {
    exp();
  }
  assertEquals(stacks[0], stacks[1]);
})();

(function RegressPCAuthFailure() {
  print(arguments.callee.name);
  var builder = new WasmModuleBuilder();
  builder.addImport("mod", "func", kSig_v_v);
  builder.addFunction("main", kSig_v_v)
    .addBody([kExprCallFunction, 0])
    .exportAs("main");
  var main = builder.instantiate({
    mod: {
      func: ()=>{%DebugTrace();}
    }
  }).exports.main;
  WebAssembly.promising(main)();
})();
