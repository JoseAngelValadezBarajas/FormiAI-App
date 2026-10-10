import {describe,expect,it} from 'vitest';import{timestampFromOffset}from'./timeline';
describe('timeline',()=>{it('clamps a click to the analyzed video duration',()=>{expect(timestampFromOffset(50,100,40)).toBe(20);expect(timestampFromOffset(-4,100,40)).toBe(0);expect(timestampFromOffset(120,100,40)).toBe(40)})});
