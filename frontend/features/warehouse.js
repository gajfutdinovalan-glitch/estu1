import { apiRequest } from '../core/api.js';
import { esc, ruDateTime, todayISO } from '../core/format.js';
import { currentModule, state } from '../core/state.js';

let data = null, tab = 'orders', pendingRepair = '', busy = false, loading = null;
const root = document.getElementById('stockRoot');
const labels = {inventory:'Остатки',orders:'Заявки участков',issue:'Новая потребность / выдача',reports:'Журнал и статистика',purchases:'Закупки'};
const statuses = {requested:'Поступила',collected:'Собрана',issued:'Вручено',cancelled:'Отменена'};
const purchaseStatuses = {draft:'Внутренняя заявка',ordered:'Заказано',received:'Закрыта',cancelled:'Отменена'};
const policies = {free:'На борт без заявки',repair:'Только по ремонту',serial:'По ремонту и заводскому номеру'};
const q = value => Number(value / 1000).toLocaleString('ru-RU',{maximumFractionDigits:3});
const options = (list,key,name,selected='') => list.map(x=>'<option value="'+esc(x[key])+'" '+(x[key]===selected?'selected':'')+'>'+esc(x[name])+'</option>').join('');
const item = id => data.items.find(x=>x.id===id);
const request = id => data.repairs.find(x=>x.id===id);
const field = (title,control) => '<label>'+title+control+'</label>';
const btn = (action,title,id='') => '<button type="button" class="ghost" data-stock-action="'+action+'" data-id="'+esc(id)+'">'+title+'</button>';
function notice(message,error=false) { const n=document.getElementById('stockNotice'); if(n){n.className='stock-notice '+(error?'stock-error':'stock-success');n.textContent=message;} }
async function mutate(url,body) {
  if(busy) throw new Error('Дождитесь завершения предыдущего действия.');
  busy=true;
  try {return await apiRequest('/stock'+url,{method:'POST',body:JSON.stringify(body)});}
  finally {busy=false;}
}
function showError(e){notice(e.message,true);}
async function refresh(render=true,throwOnError=false) {
  if(!state.currentUser)return;
  try {
    if(!loading)loading=apiRequest('/stock');
    data=await loading;loading=null;
    const count=data.alerts.length, badge=document.getElementById('stockAlertCount');
    badge.textContent=count?' • '+count:'';
    let banner=document.getElementById('stockGlobalAlert');
    if(!banner){banner=document.createElement('button');banner.id='stockGlobalAlert';banner.className='ghost stock-alert-link';document.querySelector('#appShell .tabs').after(banner);banner.onclick=()=>{openWarehouse();tab='inventory';draw();};}
    banner.hidden=!count;banner.textContent='Склад: материалов ниже порога — '+count;
    if(render)draw();
  }catch(e){loading=null;if(throwOnError)throw e;root.innerHTML='<p class="stock-error">'+esc(e.message)+'</p>';}
}
function draw(){
  if(!data)return;
  root.innerHTML='<div class="stock-toolbar"><h2>Склад</h2>'+btn('refresh','Обновить')+'</div><div class="stock-subtabs">'+Object.entries(labels).map(([id,label])=>'<button type="button" class="ghost" data-stock-tab="'+id+'" aria-pressed="'+(id===tab)+'">'+label+'</button>').join('')+'</div><div id="stockNotice" class="stock-notice" role="status"></div><div id="stockBody"></div>';
  if(tab==='inventory')inventory();
  if(tab==='orders')orders();
  if(tab==='issue')issueForm();
  if(tab==='reports')reports();
  if(tab==='purchases')purchases();
}
const body = () => document.getElementById('stockBody');
function table(headers,rows){return '<div class="stock-table-wrap"><table class="stock-table"><thead><tr>'+headers.map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';}
function inventory(){
  body().innerHTML=(data.alerts.length?'<div class="stock-alert">Ниже минимального остатка: '+data.alerts.length+'</div>':'')+
    '<div class="stock-actions">'+(data.canManage?btn('item','Добавить материал')+btn('receipt','Приход')+(!data.items.length?btn('catalog','Добавить 30 позиций — остатки 0'):''):'')+'</div><div class="stock-filters">'+field('Поиск','<input id="stockSearch" type="search">')+'</div><div id="stockInventory"></div>';
  function render(){const search=document.getElementById('stockSearch').value.toLowerCase();document.getElementById('stockInventory').innerHTML=table(['Материал','Остаток','Резерв','Доступно','Порог','Режим / номера',''],data.items.filter(i=>i.name.toLowerCase().includes(search)).map(i=>'<tr><td>'+esc(i.name)+'</td><td class="'+(i.balance<i.minimum?'stock-low':'')+'">'+q(i.balance)+' '+esc(i.unit)+'</td><td>'+q(i.reserved)+'</td><td>'+q(i.available)+'</td><td>'+q(i.minimum)+'</td><td>'+policies[i.policy]+(i.policy==='serial'?'<details><summary>Заводские номера ('+i.serials.filter(x=>x.state==='stock').length+')</summary><div>'+i.serials.filter(x=>x.state==='stock').map(x=>esc(x.number)).join(', ')+'</div></details>':'')+'</td><td>'+(data.canManage?btn('item','Изменить',i.id):'')+'</td></tr>'));}
  document.getElementById('stockSearch').oninput=render;render();
}
function orders(){
  body().innerHTML='<div class="stock-filters">'+field('Участок','<select id="stockDept"><option value="">Все доступные</option>'+data.departments.map(d=>'<option>'+esc(d)+'</option>').join('')+'</select>')+field('Статус','<select id="stockStatus"><option value="">Все</option>'+Object.entries(statuses).map(([v,n])=>'<option value="'+v+'">'+n+'</option>').join('')+'</select>')+'</div><div id="stockOrders"></div>';
  function render(){const dept=document.getElementById('stockDept').value,status=document.getElementById('stockStatus').value;
    document.getElementById('stockOrders').innerHTML=table(['Борт / ремонт','Участок / смена','Материалы','Статус','Действия'],data.orders.filter(o=>(!dept||o.department===dept)&&(!status||o.status===status)).map(o=>'<tr><td><b>'+esc(o.board)+'</b><small>'+esc(o.repair_description||'Без ремонтной заявки')+'</small><small>'+ruDateTime(o.created_at)+' · '+esc(o.author)+'</small></td><td>'+esc(o.department)+'<small>'+esc(data.shifts.find(s=>s.id===o.shift_id)?.name||'Без смены')+'</small></td><td>'+o.lines.map(l=>esc(l.name)+' — '+q(l.quantity)+' '+esc(l.unit)+(l.serials.length?' № '+l.serials.map(esc).join(', '):'')).join('<br>')+'<small>'+esc(o.note)+'</small></td><td>'+statuses[o.status]+(o.recipient?'<small>'+esc(o.recipient)+' · '+ruDateTime(o.issued_at)+'</small>':'')+'</td><td>'+(data.canManage&&!['issued','cancelled'].includes(o.status)?btn('collect','Собрано',o.id)+btn('handover','Вручено',o.id)+btn('cancel','Отменить',o.id):'')+'</td></tr>'));}
  document.getElementById('stockDept').onchange=render;document.getElementById('stockStatus').onchange=render;render();
}
function issueForm(){
  const dept=state.currentUser.department||data.departments[0]||'';
  body().innerHTML='<form id="stockOrderForm" class="stock-form"><fieldset>'+field('Участок','<select name="department">'+data.departments.map(d=>'<option '+(d===dept?'selected':'')+'>'+esc(d)+'</option>').join('')+'</select>')+field('Ремонтная заявка','<select name="repair_id"></select>')+field('Борт','<select name="board">'+options(data.fleet,'board','board')+'</select>')+field('Смена-получатель','<select name="shift_id"><option value="">Без смены</option>'+options(data.shifts,'id','name',state.currentUser.shiftId||'')+'</select>')+'</fieldset><div id="stockLines" class="stock-lines"></div>'+btn('line','Добавить материал')+field('Примечание','<textarea name="note" rows="2"></textarea>')+'<button type="submit">'+(data.canManage?'Создать заказ на выдачу':'Отправить потребность на склад')+'</button></form>';
  const form=document.getElementById('stockOrderForm'),deptSelect=form.elements.department,repairSelect=form.elements.repair_id;
  if(!data.canManage&&state.currentUser.accessScope!=='management')deptSelect.disabled=true;
  function populate(){
    repairSelect.innerHTML='<option value="">Без ремонтной заявки</option>'+data.repairs.filter(r=>r.department===deptSelect.value).map(r=>'<option value="'+esc(r.id)+'">'+esc(r.board+' · '+r.description)+'</option>').join('');
    if(pendingRepair){const p=request(pendingRepair);if(p){deptSelect.value=p.department;repairSelect.innerHTML='<option value="">Без ремонтной заявки</option>'+data.repairs.filter(r=>r.department===p.department).map(r=>'<option value="'+esc(r.id)+'">'+esc(r.board+' · '+r.description)+'</option>').join('');repairSelect.value=p.id;}pendingRepair='';}
    syncRepair();
  }
  function syncRepair(){const r=request(repairSelect.value);form.elements.board.disabled=!!r;if(r)form.elements.board.value=r.board;}
  deptSelect.onchange=populate;repairSelect.onchange=syncRepair;populate();addLine();
  form.onsubmit=async e=>{e.preventDefault();try{const lines=[...form.querySelectorAll('[data-stock-line]')].map(row=>({item_id:row.querySelector('select').value,quantity:row.querySelector('input').value}));await mutate('/orders',{repair_id:repairSelect.value,board:form.elements.board.value,department:deptSelect.value,shift_id:form.elements.shift_id.value,note:form.elements.note.value,lines});tab='orders';await refresh();notice('Потребность сохранена.');}catch(e){showError(e);}};
}
function addLine(){
  const lines=document.getElementById('stockLines');if(!lines)return;
  const row=document.createElement('div');row.dataset.stockLine='';row.innerHTML=field('Материал','<select required><option value="">Выберите</option>'+data.items.map(i=>'<option value="'+esc(i.id)+'">'+esc(i.name+' · '+i.unit+' · '+policies[i.policy])+'</option>').join('')+'</select>')+field('Количество','<input type="number" min="0.001" step="0.001" value="1" required>')+'<button type="button" title="Удалить строку" aria-label="Удалить строку">×</button>';
  row.querySelector('button').onclick=()=>row.remove();row.querySelector('select').onchange=()=>{const i=item(row.querySelector('select').value),input=row.querySelector('input');input.step=i?.unit==='шт'?'1':'.001';input.min=input.step;};lines.append(row);
}
function modal(title,content,submit){
  document.getElementById('stockDialog')?.remove();
  const dialog=document.createElement('dialog');dialog.id='stockDialog';dialog.className='stock-dialog';
  dialog.innerHTML='<form class="stock-form"><h3>'+esc(title)+'</h3>'+content+'<p class="stock-error" role="alert"></p><div class="stock-actions"><button type="submit">Сохранить</button><button type="button" data-close>Отмена</button></div></form>';
  document.body.append(dialog);dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());
  dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('[type=submit]');button.disabled=true;try{await submit(e.target);dialog.close();await refresh();notice('Сохранено.');}catch(e){dialog.querySelector('[role=alert]').textContent=e.message;button.disabled=false;}};dialog.showModal();return dialog;
}
function editItem(id){
  const i=item(id)||{name:'',unit:'шт',policy:'free',minimum:0};
  modal('Материал',field('Наименование','<input name="name" required value="'+esc(i.name)+'">')+field('Единица','<select name="unit" '+(id?'disabled':'')+'>'+['шт','м','л','кг'].map(u=>'<option '+(i.unit===u?'selected':'')+'>'+u+'</option>').join('')+'</select>')+field('Выдача','<select name="policy" '+(id?'disabled':'')+'>'+Object.entries(policies).map(([v,n])=>'<option value="'+v+'" '+(i.policy===v?'selected':'')+'>'+n+'</option>').join('')+'</select>')+field('Минимальный остаток','<input name="minimum" type="number" min="0" step=".001" value="'+i.minimum/1000+'" required>'),async f=>mutate('/items',{id,name:f.elements.name.value,unit:f.elements.unit.value,policy:f.elements.policy.value,minimum:f.elements.minimum.value}));
}
function receive(){
  const dialog=modal('Приход на склад',field('Материал','<select name="item_id" required>'+options(data.items,'id','name')+'</select>')+field('Количество','<input name="quantity" type="number" min=".001" step=".001" required>')+field('Заводские номера (каждый с новой строки)','<textarea name="serials" rows="4"></textarea>')+field('Документ / основание','<input name="document" required>'),async f=>mutate('/receipts',{item_id:f.elements.item_id.value,quantity:f.elements.quantity.value,serials:f.elements.serials.value.split(/\n/).map(x=>x.trim()).filter(Boolean),document:f.elements.document.value}));
  const f=dialog.querySelector('form');f.elements.item_id.onchange=()=>{const i=item(f.elements.item_id.value);f.elements.serials.closest('label').hidden=i.policy!=='serial';f.elements.serials.value='';f.elements.quantity.step=i.unit==='шт'?'1':'.001';f.elements.quantity.min=f.elements.quantity.step;};f.elements.item_id.onchange();
}
function handover(id,action){
  const o=data.orders.find(x=>x.id===id);
  let content='<p>Борт '+esc(o.board)+' · '+esc(o.department)+'</p>'+o.lines.map(l=>'<p>'+esc(l.name)+' — '+q(l.quantity)+' '+esc(l.unit)+'</p>'+(item(l.item_id).policy==='serial'?field('Заводские номера','<select name="'+esc(l.item_id)+'" multiple required>'+item(l.item_id).serials.filter(s=>s.state==='stock'&&(!item(l.item_id).reserved_serials.includes(s.number)||l.serials.includes(s.number))).map(s=>'<option '+(l.serials.includes(s.number)?'selected':'')+'>'+esc(s.number)+'</option>').join('')+'</select>'):'')).join('');
  content+=action==='issue'?field('Получатель','<input name="recipient" required>'):'';
  content+=field('Примечание','<textarea name="note"></textarea>');
  modal(action==='issue'?'Подтверждение вручения':'Сборка заказа',content,async f=>{const serials={};for(const l of o.lines)if(item(l.item_id).policy==='serial')serials[l.item_id]=[...f.elements.namedItem(l.item_id).selectedOptions].map(s=>s.value);return mutate('/orders/'+encodeURIComponent(id),{action,serials,recipient:f.elements.recipient?.value,note:f.elements.note.value});});
}
function purchases(){
  const names=purchaseStatuses;
  const pending=new Set(data.purchases.filter(p=>['draft','ordered'].includes(p.status)).map(p=>p.item_id));
  body().innerHTML=(data.canPurchase?'<div class="stock-actions">'+data.alerts.filter(i=>!pending.has(i.id)).map(i=>btn('purchase','Закупить: '+esc(i.name),i.id)).join('')+'</div>':'')+table(['Материал','Количество','Статус','Создал','Действия'],data.purchases.map(p=>'<tr><td>'+esc(item(p.item_id)?.name)+'</td><td>'+q(p.quantity)+' '+esc(item(p.item_id)?.unit)+'</td><td>'+names[p.status]+'</td><td>'+esc(p.author)+'<small>'+ruDateTime(p.created_at)+'</small></td><td>'+(data.canPurchase&&['draft','ordered'].includes(p.status)?btn('purchase-ordered','Заказано',p.id)+btn('purchase-received','Закрыть',p.id)+btn('purchase-cancelled','Отменить',p.id):'')+'</td></tr>'));
}
function reports(){
  const today=new Date(),start=new Date(today.getFullYear(),today.getMonth(),1);const iso=d=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
  body().innerHTML='<div class="stock-filters">'+field('С','<input id="stockFrom" type="date" value="'+iso(start)+'">')+field('По','<input id="stockTo" type="date" value="'+iso(today)+'">')+field('Участок','<select id="stockReportDept"><option value="">Все</option>'+data.departments.map(d=>'<option>'+esc(d)+'</option>').join('')+'</select>')+field('Смена','<select id="stockReportShift"><option value="">Все</option>'+options(data.shifts,'id','name')+'</select>')+field('Борт','<input id="stockReportBoard" placeholder="Все борта">')+btn('excel','Экспорт Excel')+btn('csv','Скачать CSV')+'</div><div id="stockReport"></div>';
  function selected(){return selectedMovements(reportFilters());}
  function render(){const list=selected(),sums=new Map();for(const m of list){const row=sums.get(m.item_id)||{receipt:0,issue:0};row[m.kind]+=m.quantity;sums.set(m.item_id,row);}document.getElementById('stockReport').innerHTML=table(['Материал','Приход за период','Выдано за период','Ед.'],[...sums].map(([id,s])=>'<tr><td>'+esc(item(id)?.name)+'</td><td>'+q(s.receipt)+'</td><td>'+q(s.issue)+'</td><td>'+esc(item(id)?.unit)+'</td></tr>'))+'<h3>Движения</h3>'+table(['Дата','Операция','Борт / участок / смена','Материал','Количество / номера','Получатель / кладовщик / документ'],list.map(m=>'<tr><td>'+ruDateTime(m.created_at)+'</td><td>'+(m.kind==='issue'?'Выдача':'Приход')+'</td><td>'+esc([m.board,m.department,data.shifts.find(s=>s.id===m.shift_id)?.name].filter(Boolean).join(' · '))+'</td><td>'+esc(item(m.item_id)?.name)+'</td><td>'+q(m.quantity)+' '+esc(item(m.item_id)?.unit)+'<small>'+esc(JSON.parse(m.serials).join(', '))+'</small></td><td>'+esc([m.recipient,m.actor,m.document].filter(Boolean).join(' · '))+'</td></tr>'));}
  for(const el of body().querySelectorAll('input,select'))el.oninput=render;
  root.querySelector('[data-stock-action=csv]').onclick=()=>{const rows=[['Дата','Операция','Борт','Участок','Смена','Материал','Количество','Ед.','Номера','Получатель','Кладовщик','Основание'],...selected().map(m=>[m.created_at,m.kind,m.board,m.department,m.shift_id,item(m.item_id)?.name,m.quantity/1000,item(m.item_id)?.unit,JSON.parse(m.serials).join(', '),m.recipient,m.actor,m.document])];const csv=rows.map(row=>row.map(v=>{let s=String(v??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}).join(';')).join('\r\n');const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='Склад-'+iso(today)+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};render();
}
function reportFilters(){
  const value=id=>document.getElementById(id)?.value.trim()||'';
  return {from:value('stockFrom'),to:value('stockTo'),department:value('stockReportDept'),shift:value('stockReportShift'),board:value('stockReportBoard')};
}
function selectedMovements(f){
  return data.movements.filter(m=>(!f.from||m.created_at.slice(0,10)>=f.from)&&(!f.to||m.created_at.slice(0,10)<=f.to)&&(!f.department||m.department===f.department)&&(!f.shift||m.shift_id===f.shift)&&(!f.board||m.board===f.board));
}
async function buildExcelReport(){
  const filters=reportFilters();
  if(filters.from&&filters.to&&filters.from>filters.to)throw new Error('Начало периода не может быть позже окончания.');
  await refresh(false,true);
  if(!data)throw new Error('Не удалось загрузить данные склада.');
  const shift=id=>data.shifts.find(s=>s.id===id)?.name||'Без смены';
  const movements=selectedMovements(filters),sums=new Map();
  for(const m of movements){const row=sums.get(m.item_id)||{receipt:0,issue:0};row[m.kind]+=m.quantity;sums.set(m.item_id,row);}
  const subtitle=['Период: '+(filters.from||'начало учёта')+' - '+(filters.to||'сейчас'),filters.department,filters.shift?shift(filters.shift):'',filters.board?'Борт '+filters.board:''].filter(Boolean).join(' · ');
  const orders=data.orders.filter(o=>(!filters.department||o.department===filters.department)&&(!filters.shift||o.shift_id===filters.shift)&&(!filters.board||o.board===filters.board));
  return {title:'Склад и материалы',filename:`ЕСТУ_Склад_${filters.from||'все'}_${filters.to||todayISO()}.xlsx`,sheets:[
    {name:'Остатки',subtitle:'Текущие остатки на момент формирования',headers:['Материал','Ед.','Остаток','Резерв','Доступно','Минимум','Состояние','Порядок выдачи'],rows:data.items.map(i=>[i.name,i.unit,i.balance/1000,i.reserved/1000,i.available/1000,i.minimum/1000,i.balance<i.minimum?'Ниже порога':'В пределах порога',policies[i.policy]]),widths:[42,10,16,16,16,16,24,38]},
    {name:'Заводские номера',headers:['Материал','Заводской номер','Состояние','В резерве'],rows:data.items.flatMap(i=>i.serials.map(s=>[i.name,s.number,s.state==='stock'?'На складе':'Выдан',i.reserved_serials.includes(s.number)?'Да':'Нет'])),widths:[42,30,20,16]},
    {name:'Потребности участков',subtitle:'Все даты создания · '+[filters.department,filters.shift?shift(filters.shift):'',filters.board].filter(Boolean).join(' · '),headers:['Заказ','Создан','Борт','Участок','Смена','Ремонт','Статус','Материал','Количество','Ед.','Заводские номера','Создал','Примечание','Получатель','Вручено'],rows:orders.flatMap(o=>o.lines.map(l=>[o.id,ruDateTime(o.created_at),o.board,o.department,shift(o.shift_id),o.repair_description||'Без ремонтной заявки',statuses[o.status],l.name,l.quantity/1000,l.unit,l.serials.join(', '),o.author,o.note||'',o.recipient||'',ruDateTime(o.issued_at)])),widths:[38,22,12,38,26,48,18,42,16,10,30,28,48,28,22]},
    {name:'Сводка движения',subtitle,headers:['Материал','Приход','Выдано','Ед.'],rows:[...sums].map(([id,s])=>[item(id)?.name||id,s.receipt/1000,s.issue/1000,item(id)?.unit||'']),widths:[42,18,18,10]},
    {name:'Движения',subtitle,headers:['Дата','Операция','Борт','Участок','Смена','Материал','Количество','Ед.','Заводские номера','Заказ','Получатель','Кладовщик','Основание'],rows:movements.map(m=>[ruDateTime(m.created_at),m.kind==='issue'?'Выдача':'Приход',m.board||'',m.department||'',shift(m.shift_id),item(m.item_id)?.name||m.item_id,m.quantity/1000,item(m.item_id)?.unit||'',JSON.parse(m.serials).join(', '),m.order_id||'',m.recipient||'',m.actor,m.document||'']),widths:[22,16,12,38,26,42,16,10,30,38,28,28,48]},
    {name:'Закупки',headers:['Создана','Материал','Количество','Ед.','Статус','Создал'],rows:data.purchases.map(p=>[ruDateTime(p.created_at),item(p.item_id)?.name||p.item_id,p.quantity/1000,item(p.item_id)?.unit||'',purchaseStatuses[p.status]||p.status,p.author]),widths:[22,42,18,10,28,28]}
  ]};
}
let openWarehouse;

function initWarehouse({openModule, exportCurrentModuleExcel}) {
  openWarehouse = () => openModule('warehouse');
  root.addEventListener('click',async e=>{
    const t=e.target.closest('[data-stock-tab]');if(t){tab=t.dataset.stockTab;draw();return;}
    const b=e.target.closest('[data-stock-action]');if(!b)return;
    const action=b.dataset.stockAction,id=b.dataset.id;
    try{
      if(action==='refresh')await refresh();
      if(action==='excel')await exportCurrentModuleExcel();
      if(action==='item')editItem(id);
      if(action==='receipt')receive();
      if(action==='line')addLine();
      if(action==='collect')handover(id,'collect');
      if(action==='handover')handover(id,'issue');
      if(action==='catalog'){await mutate('/catalog',{});await refresh();notice('Каталог добавлен с нулевыми остатками.');}
      if(action==='cancel')modal('Отмена заказа',field('Причина','<textarea name="note" required></textarea>'),f=>mutate('/orders/'+encodeURIComponent(id),{action:'cancel',note:f.elements.note.value}));
      if(action==='purchase'){const i=item(id);modal('Заявка на закупку: '+i.name,field('Количество, '+i.unit,'<input name="quantity" type="number" min=".001" step=".001" value="'+Math.max((i.minimum-i.balance)/1000,1)+'" required>'),f=>mutate('/purchases',{item_id:id,quantity:f.elements.quantity.value}));}
      if(action.startsWith('purchase-')){await mutate('/purchases/'+encodeURIComponent(id),{status:action.slice(9)});await refresh();}
    }catch(e){showError(e);}
  });
  document.addEventListener('click',e=>{const b=e.target.closest('[data-stock-repair]');if(!b)return;pendingRepair=b.dataset.stockRepair;tab='issue';openWarehouse();});
  setInterval(()=>{if(state.currentUser&&!document.hidden){const editing=root.contains(document.activeElement)&&['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName);refresh(currentModule==='warehouse'&&!editing&&!document.getElementById('stockDialog')&&tab!=='issue');}},30000);
  new MutationObserver(()=>{if(!document.getElementById('appShell').hidden)refresh(false);}).observe(document.getElementById('appShell'),{attributes:true,attributeFilter:['hidden']});
}

export { buildExcelReport, initWarehouse, refresh };
