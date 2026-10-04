import {describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {normalizeCommunicationPlan,prepareLegacyPlan,resolveStageMaterial}=require('../../src/hh-communication-plan');
const stage={id:'stable',title:'Название',instruction:'Действие',completion_result:'Результат',material:'  точный\nтекст\n',material_mode:'verbatim'};
describe('communication plan storage',()=>{
 it('allows zero or one stage and preserves exact material and IDs',()=>{
  expect(normalizeCommunicationPlan({version:1,stages:[]})).toEqual({version:1,stages:[]});
  const config={communication_plan:{version:1,stages:[stage]}};
  expect(resolveStageMaterial(config,'stable').text).toBe(stage.material);
  expect(normalizeCommunicationPlan({...config.communication_plan,stages:[{...stage,title:'Переименован'}]}).stages[0].id).toBe('stable');
 });
 it('rejects duplicate ids, missing results and unsupported versions',()=>{
  for(const p of [{version:2,stages:[]},{version:1,stages:[stage,stage]},{version:1,stages:[{...stage,completion_result:''}]}]) expect(()=>normalizeCommunicationPlan(p)).toThrow();
 });
 it('creates deterministic review-only migration without losing restrictions or long material',()=>{
  const config={test_task:'https://example.com/гайд\n'+'длинный текст '.repeat(2000)+'КОНЕЦ',message_instructions:'не упоминай Ozon; не спрашивай про private banking'};
  const before=JSON.stringify(config);const first=prepareLegacyPlan(config,['Уточнить','Тестовое']);
  expect(first).toEqual(prepareLegacyPlan(config,['Уточнить','Тестовое']));
  expect(first.requires_review).toBe(true);expect(first.plan.stages[1].material).toBe(config.test_task);
  expect(first.legacy_source.message_instructions).toBe(config.message_instructions);expect(JSON.stringify(config)).toBe(before);
 });
 it('never overwrites an accepted plan with legacy content',()=>{
  const config={communication_plan:{version:1,stages:[stage]},test_task:'obsolete'};
  expect(prepareLegacyPlan(config,['other']).plan).toEqual(config.communication_plan);
  expect(prepareLegacyPlan(config).requires_review).toBe(false);
 });
});


describe('reviewable legacy stage defaults',()=>{
 it('the live five-stage snapshot gets meaningful editable instructions and results',()=>{
  const draft=prepareLegacyPlan({test_task:stage.material,message_instructions:'не упоминай Ozon'},['Скрининг резюме','Уточнение навыков','Тестовое задание','Созвон','Решение']);
  expect(draft.requires_review).toBe(true);expect(draft.plan.stages).toHaveLength(5);
  for(const s of draft.plan.stages){expect(s.instruction).not.toContain('Опишите');expect(s.completion_result).not.toContain('Опишите');expect(s.instruction.trim()).not.toBe('');expect(s.completion_result.trim()).not.toBe('');}
  expect(normalizeCommunicationPlan(draft.plan)).toEqual(draft.plan);
  expect(draft.plan.stages[3].completion_result).toContain('дате и времени');
  expect(draft.plan.stages[4].instruction).toContain('решения рекрутера');
  expect(draft.plan.stages[2].material).toBe(stage.material);
 });
 it('unknown stages require real input and preserve original details in the source',()=>{
  const source={title:'Другой процесс',instruction:'Спросить про другой процесс',completion_result:'Получен конкретный ответ',material:'custom exact\n',material_mode:'context'};
  const draft=prepareLegacyPlan({},[source,'Неизвестный этап']);
  expect(draft.plan.stages[0].instruction).toBe(source.instruction);expect(draft.legacy_source.stage_details[0]).toEqual(source);
  expect(draft.plan.stages[1].instruction).toBe('');expect(()=>normalizeCommunicationPlan(draft.plan)).toThrow();
 });
});
