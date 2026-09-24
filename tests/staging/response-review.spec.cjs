const {test,expect}=require('@playwright/test');
const {generateReviewPageHtml}=require('../../src/hh-review-page-html');
const {readResponseState,setResponseState}=require('../../src/hh-response-state');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('response review renders persisted triage and restores without changing HH state',async({page})=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-staging-'));
  const negotiation={id:'n1',resume:{first_name:'Иван'},created_at:'2026-09-05',updated_at:'2026-09-24'};
  try {
    setResponseState(dir,'alice','v1','n1','archived');
    expect(readResponseState(dir,'bob','v1','n1')).toBe('active');
    expect(readResponseState(dir,'alice','v2','n1')).toBe('active');
    const render=list=>generateReviewPageHtml([negotiation],'Советник','alice','',dir,{vacancyId:'v1',list});
    await page.setContent(render('active'));await expect(page.locator('#tab-all .card')).toHaveCount(0);
    await page.setContent(render('archived'));await expect(page.locator('#tab-all .card')).toHaveCount(1);
    await expect(page.locator('#tab-all [data-testid=response-restore]')).toBeVisible();
    await expect(page.locator('#tab-all').getByRole('button',{name:'✗ Отправить отказ',exact:true})).toBeVisible();
    setResponseState(dir,'alice','v1','n1','active');await page.setContent(render('active'));
    await expect(page.locator('#tab-all .card')).toHaveCount(1);
    await expect(page.locator('#tab-all .card')).toContainText('2026-09-05');
    expect(negotiation._state).toBeUndefined();
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
