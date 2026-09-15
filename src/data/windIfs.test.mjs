import test from 'node:test';
import assert from 'node:assert/strict';
import { ifsObjectUrls, parseIfsIndex, ifsWindRanges, nearestIfsStep, selectLatestIfsCycle } from '../../server/providers/wind/ifs.js';
import { nearestGfsStep } from '../../server/providers/wind/catalog.js';
test('IFS inventory selects only 10 m components and distinct index suffix', () => {
  const urls = ifsObjectUrls({ date: '20260915', hour: 6, step: 9 });
  assert.match(urls.index, /9h-oper-fc\.index$/);
  assert.equal(urls.index.includes('.grib2.index'), false);
  assert.deepEqual(ifsWindRanges(parseIfsIndex('{"param":"10u","_offset":20,"_length":10}\n{"param":"10v","_offset":40,"_length":15}')), { u: {start:20,end:29}, v:{start:40,end:54} });
  assert.deepEqual(selectLatestIfsCycle(Date.UTC(2026,8,15,4)), { date:'20260914', hour:18 });
  assert.equal(nearestIfsStep(8,6),9); assert.equal(nearestIfsStep(200,6),144); assert.equal(nearestIfsStep(151,0),150); assert.equal(nearestGfsStep(8.2),8);
});
