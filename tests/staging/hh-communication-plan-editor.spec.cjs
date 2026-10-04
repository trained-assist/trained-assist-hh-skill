'use strict';
const {test,expect}=require('@playwright/test');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {handleHhPublic}=require('../../src/hh-routes');
const USER='scenario-fixture',VACANCY='138004863',SECRET='scenario-editor-fixture';
const TOKEN=crypto.createHmac('sha256',SECRET).update(USER).digest('hex').slice(0,16);
const MATERIAL='  Гайд: https://recruiter-assistant.ru/p/wb-card-ads-guide\n'+('WB витрина, задания и примеры.\n'.repeat(200))+'<script>window.injected=true</script>\n  ';
const INSTRUCTIONS='Не упоминай Ozon. Не спрашивай про private banking.';
async function boot(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hh-plan-browser-'));
 const users=path.join(root,'users'),dir=path.join(users,USER,'contexts','hh');fs.mkdirSync(dir,{recursive:true});
 const configFile=path.join(dir,`ats_config:${VACANCY}.json`);
 const config={vacancy_id:VACANCY,vacancy_title:'Менеджер WB',vacancy_context:'Детская одежда',required:[{name:'WB',weight:2}],preferred:[],pass_threshold:7.5,review_threshold:5,test_task:MATERIAL,message_instructions:INSTRUCTIONS};
 fs.writeFileSync(configFile,JSON.stringify({value:config,updated_at:'initial-revision'}));
 fs.writeFileSync(path.join(dir,'active_vacancies.json'),JSON.stringify({value:[{id:VACANCY,title:'Менеджер WB'}]}));
 fs.writeFileSync(path.join(dir,'ats_stages.json'),JSON.stringify({value:['Уточнить опыт','Тестовое задание']}));
 const keys=['AGENT_SECRET','AGENT_PUBLIC_URL','AGENT_TOKENS_DIR','AGENT_TOKENS_ROOT','AGENT_DATA_DIR','USERS_DIR'];const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{AGENT_SECRET:SECRET,AGENT_TOKENS_DIR:path.join(root,'tokens'),AGENT_TOKENS_ROOT:path.join(root,'tokens'),AGENT_DATA_DIR:path.join(root,'data'),USERS_DIR:users});
 const ctx={BASE_USERS_DIR:users,PORT:0,secrets:{},getSecretsCache:()=>({}),readChatId:()=>null,runMcpTool:async()=>JSON.stringify({ok:true})};
 const server=http.createServer(async(req,res)=>{try{if(await handleHhPublic(req,new URL(req.url,'http://127.0.0.1'),res,ctx)===false){res.writeHead(404);res.end();}}catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));ctx.PORT=server.address().port;const base=`http://127.0.0.1:${ctx.PORT}`;process.env.AGENT_PUBLIC_URL=base;
 return{configFile,url:`${base}/hh/ats-editor?username=${USER}&token=${TOKEN}&vacancy_id=${VACANCY}`,read:()=>JSON.parse(fs.readFileSync(configFile)).value,stop:async()=>{await new Promise(r=>server.close(r));for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}fs.rmSync(root,{recursive:true,force:true});}};
}
for(const width of [360,390])test(`real editor routes: review migration, save/reload templates and exact material at ${width}px`,async({page})=>{
 const app=await boot();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
 await page.setViewportSize({width,height:900});await page.goto(app.url);
 await expect(page.locator('#planStatus')).toHaveAttribute('data-state','draft');
 expect(app.read().communication_plan).toBeUndefined(); // Merely viewing cannot adopt a draft.
 expect(await page.evaluate(()=>window.injected)).toBeUndefined();
 expect(await page.locator('#fMessageInstructions').inputValue()).toBe(INSTRUCTIONS);
 for(const stage of await page.locator('[data-testid=stage-item]').all()){
 await stage.locator('[data-testid=stage-summary]').click();
 await stage.locator('[data-field=instruction]').fill('Следовать сохранённому этапу и учитывать ответы.');
 await stage.locator('[data-field=completion_result]').fill('Получен описанный результат.');
 }
 const exact=await page.locator('[data-field=material]').last().inputValue();expect(exact).toBe(MATERIAL);
 await page.locator('#stageTemplate').selectOption('portfolio');await page.locator('#addStageBtn').click();
 await page.locator('[data-field=title]').last().fill('<img src=x onerror="window.injected=true"> Работы');
 await page.locator('[data-action=up]').last().click();
 const save=page.waitForResponse(r=>r.url().includes('/hh/ats-config')&&r.request().method()==='POST');await page.locator('#saveBtn').click();expect((await save).status()).toBe(200);
 const stored=app.read();expect(stored.communication_plan.stages).toHaveLength(3);expect(stored.message_instructions).toBe(INSTRUCTIONS);expect(stored.communication_plan.stages.find(s=>s.material_mode==='verbatim').material).toBe(MATERIAL);
 await page.reload();await expect(page.locator('#planStatus')).toHaveAttribute('data-state','saved');expect(await page.evaluate(()=>window.injected)).toBeUndefined();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
 // Stable IDs, edits and material survive real persistence/reload.
 expect(await page.evaluate(()=>buildConfig().communication_plan)).toEqual(stored.communication_plan);
 // One stage and then zero stages must both save, without hidden defaults.
 while(await page.locator('[data-testid=stage-item]').count()>1){const first=page.locator('[data-testid=stage-item]').first();await first.locator('[data-testid=stage-summary]').click();await first.locator('[data-action=delete]').click();}
 for(const expected of [1,0]){
 const response=page.waitForResponse(r=>r.url().includes('/hh/ats-config')&&r.request().method()==='POST');await page.locator('#saveBtn').click();expect((await response).status()).toBe(200);await page.reload();expect(app.read().communication_plan.stages).toHaveLength(expected);await expect(page.locator('[data-testid=stage-item]')).toHaveCount(expected);
 if(expected===1){await page.locator('[data-testid=stage-summary]').click();await page.locator('[data-action=delete]').click();}
 }
 expect(errors).toEqual([]);
 }finally{await app.stop();}
});
