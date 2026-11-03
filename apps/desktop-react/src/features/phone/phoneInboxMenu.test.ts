import {it,expect} from 'vitest';
import {searchMenus} from '../shell/menuCatalog';
it('offers the durable phone inbox from the existing menu catalog',()=>{
 expect(searchMenus(false,false,true).some(row=>row.label==='전화 수신함')).toBe(true);
});
