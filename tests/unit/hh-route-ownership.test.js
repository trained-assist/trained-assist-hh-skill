import {it,expect} from 'vitest';
import {createRequire} from 'module';
const {violations}=createRequire(import.meta.url)('../../scripts/check-hh-route-ownership.cjs');
const base='if(isHhPath(url.pathname) && await handleHhPublic(req))return; if(isHhPath(url.pathname) && await handleHhAuthed(req))return;';
it('allows canonical delegated router and route comments',()=>expect(violations(base+'\n// GET /hh/ats-editor\n')).toEqual([]));
it('rejects a competing editor route even with canonical delegation',()=>expect(violations(base+"if(url.pathname === '/hh/ats-editor'){}" )).toHaveLength(1));
it('rejects prefix takeover and missing delegation',()=>{expect(violations(base+"if(url.pathname.startsWith('/hh/')){}" )).toHaveLength(1);expect(violations('')).toHaveLength(2);});
