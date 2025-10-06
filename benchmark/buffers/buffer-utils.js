'use strict';
const common = require('../common.js');

const bench = common.createBenchmark(main, {
  fn: ['native', 'js'],
  n: [1000],
}, {
  flags: ['--expose-internals']
});

function main({ fn, n }) {
  const { getArrayBufferViewBuffer, getArrayBufferViewByteLength, getArrayBufferViewByteOffset } = require('internal/util');
  const { TypedArrayPrototypeGetBuffer, TypedArrayPrototypeGetByteLength, TypedArrayPrototypeGetByteOffset, DataViewPrototypeGetBuffer, DataViewPrototypeGetByteLength, DataViewPrototypeGetByteOffset } = require('internal/test/binding').primordials;
  const { isTypedArray, isDataView } = require('internal/util/types');

  let getBuffer;
  switch (fn) {
    case 'native':
      getBuffer = getArrayBufferViewBuffer;
      break;
    case 'js':
      getBuffer = function getBuffer(buffer) {
        if (isTypedArray(buffer)) return TypedArrayPrototypeGetBuffer(buffer);
        if (isDataView(buffer)) return DataViewPrototypeGetBuffer(buffer);
        throw new TypeError(`${buffer}`);
      };
      break;
  }

  const buffer = Buffer.from('abcdefgh');
  let tmp;
  bench.start();

  for (let i = 0; i < n; i++)
    tmp = getBuffer(buffer);

  bench.end(n);
}
