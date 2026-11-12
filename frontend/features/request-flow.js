import { apiRequest } from '../core/api.js';
import { byId, esc, ruDate, ruDateTime } from '../core/format.js';
import { loadedStateParts, refreshFromServer } from '../core/refresh.js';
import { can, state } from '../core/state.js';
import * as Shifts from './shifts.js';

const repairDepartment='Участок заявочных ремонтов';
const stages={incoming:'Ожидает решения',work:'В работе',wait:'В ожидании',review:'На рассмотрении руководства',planned:'Плановый ремонт',closed:'Закрыта'};
const actions={accept:'Принять в работу',wait:'В ожидание',transfer_department:'Передать участку',transfer_shift:'Передать другой смене',review:'На рассмотрение руководству',plan:'Назначить плановый ремонт',reject:'Отклонить',note:'Добавить заметку',intake:'Поступление',legacy:'Существующая заявка',completed:'Ремонт завершён',rejected:'Отклонена',edit:'Изменены сведения',deleted:'Удалена'};
const shiftName=id=>id?(Shifts.name(id)||id):'Общий профиль';
function canAct(r){
  const u=state.currentUser;
  if(!u)return false;
  if(u.role==='admin')return true;
  if(r.flow?.stage==='review')return u.accessScope==='management';
  if(u.accessScope==='management'||u.accessScope==='warehouse'||u.department!==r.department)return false;
  if(r.department===repairDepartment&&r.flow&&!r.flow.legacy)return u.accessScope==='master'&&(!u.shiftId||u.shiftId===r.flow.shiftId);
  return true;
}
function timeline(flow){
  if(!flow?.events?.length)return '';
  return '<details class="flow-timeline"><summary>История решений и заметок ('+flow.events.length+')</summary><ol>'+flow.events.map(e=>'<li><b>'+esc(actions[e.action]||e.action)+'</b> · '+ruDateTime(e.created_at)+' · '+esc(e.actor)+'<div>'+esc(e.to_department||'')+(e.to_department===repairDepartment?' · '+esc(shiftName(e.to_shift)):'')+(e.planned_date?' · '+ruDate(e.planned_date):'')+'</div><p>'+esc(e.note)+'</p></li>').join('')+'</ol></details>';
}
function notes(flow,requestId){
  if(!flow?.notes?.length)return '';
  const user=state.currentUser;
  const request=requestId?state.requests.find(r=>r.id===requestId):null;
  const editable=flow.stage!=='closed'&&request&&canAct(request)&&can('editRequests');
  return '<section class="flow-notes"><h4>Заметки к ремонту ('+flow.notes.length+')</h4>'+flow.notes.map(n=>'<article class="flow-note"><p>'+esc(n.text)+'</p><div class="meta">'+ruDateTime(n.createdAt)+' · '+esc(n.actor)+'</div>'+
    (editable&&(user.role==='admin'||String(n.authorId)===String(user.id))?'<button type="button" class="ghost small-action" data-flow-note-delete="'+esc(n.id)+'" data-request="'+esc(requestId)+'">Удалить заметку</button>':'')+'</article>').join('')+'</section>';
}
function card(r){
  const f=r.flow, stage=f?.stage||({new:'incoming',in_progress:'work',waiting:'wait'}[r.status]), act=canAct(r);
  const button=a=>'<button type="button" class="ghost small-action" data-flow-action="'+a+'" data-id="'+esc(r.id)+'">'+actions[a]+'</button>';
  let available=stage==='review'?['transfer_department','plan','reject','note']:['accept','wait','transfer_department','review','plan','reject','note'];
  if(r.department===repairDepartment)available.splice(3,0,'transfer_shift');
  if(stage==='work')available=available.filter(a=>a!=='accept');
  if(stage==='wait')available=available.filter(a=>a!=='wait');
  const edit=act&&can('editRequests')&&stage!=='review';
  return '<article class="request-card request-state-'+esc(r.status)+'" data-id="'+esc(r.id)+'"><div class="request-head"><div><span class="board">'+esc(r.board)+'</span><div class="meta">'+esc(r.model)+' · '+esc(r.department)+(r.department===repairDepartment?' · '+esc(shiftName(f?.shiftId)):'')+'</div></div><span class="badge '+(stage==='work'?'progress':'wait')+'">'+stages[stage]+(f?.plannedDate?' · '+ruDate(f.plannedDate):'')+'</span></div><p class="description">'+esc(r.description)+'</p><div class="meta">Получено: '+ruDateTime(r.createdAt)+' · '+esc(r.createdBy)+'</div><div class="request-actions flow-actions">'+(act&&can('editRequests')?available.map(button).join(''):'')+
    (act?'<button type="button" class="ghost small-action" data-stock-repair="'+esc(r.id)+'">Запчасти по заявке</button>':'')+
    '<button type="button" class="ghost small-action" data-action="view-board-history" data-board="'+esc(r.board)+'">История борта</button>'+
    (edit?'<button type="button" class="ghost small-action" data-action="edit-request">Исправить описание</button>':'')+'</div>'+
    notes(f,r.id)+timeline(f)+
    (edit?'<form class="edit-request-form" hidden><label>Борт<input name="board" list="fleetBoards" required value="'+esc(r.board)+'"></label><label>Описание неисправности<textarea name="description" required rows="3">'+esc(r.description)+'</textarea></label><div class="form-actions"><button type="submit">Сохранить</button><button type="button" class="ghost" data-action="cancel-edit">Отмена</button></div></form>':'')+
    '<form class="complete-form" '+(!act||stage!=='work'?'hidden':'')+'><label>Выполненные работы<textarea required rows="3"></textarea></label><button type="submit">Ремонт завершён</button></form></article>';
}
function modal(r,action){
  document.getElementById('flowDialog')?.remove();
  const f=r.flow, dialog=document.createElement('dialog');dialog.id='flowDialog';dialog.className='flow-dialog';
  const departments=state.routingDepartments||state.departments;
  const field=(label,control)=>'<label>'+label+control+'</label>';
  let content='';
  if(action==='transfer_department'||(action==='plan'&&f?.stage==='review')){
    content+=field('Участок-получатель','<select name="department">'+departments.map(d=>'<option '+(d===r.department?'selected':'')+'>'+esc(d)+'</option>').join('')+'</select>');
  }
  if(action==='transfer_department'||action==='transfer_shift'||action==='plan'){
    content+=field('Смена участка заявочного ремонта','<select name="shiftId"><option value="">Общий профиль</option>'+['day_1','day_2','night_1','night_2'].map(s=>'<option value="'+s+'" '+(s===f?.shiftId?'selected':'')+'>'+esc(shiftName(s))+'</option>').join('')+'</select>');
  }
  if(action==='plan')content+=field('Дата ремонта','<input type="date" name="plannedDate" required>');
  if(action==='transfer_department'||action==='transfer_shift'){
    content+=field('Что уже выполнено','<textarea name="done" rows="2" required></textarea>')+field('Что осталось выполнить / важные сведения','<textarea name="remaining" rows="3" required></textarea>');
  }
  content+=field(action==='accept'?'Заметка (необязательно)':'Причина / заметка','<textarea name="note" rows="3" '+(action==='accept'?'':'required')+'></textarea>');
  dialog.innerHTML='<form class="flow-form"><h3>'+actions[action]+' · '+esc(r.board)+'</h3>'+content+'<p class="flow-error" role="alert"></p><div class="flow-actions"><button type="submit">Подтвердить</button><button type="button" data-close>Отмена</button></div></form>';
  document.body.append(dialog);const form=dialog.querySelector('form');
  const sync=()=>{if(form.elements.shiftId)form.elements.shiftId.closest('label').hidden=(form.elements.department?.value||r.department)!==repairDepartment;};
  if(form.elements.department){form.elements.department.onchange=sync;if(action==='transfer_department'&&f?.stage!=='review')form.elements.department.value=departments.find(d=>d!==r.department)||r.department;}sync();
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();
  form.onsubmit=async e=>{e.preventDefault();const b=form.querySelector('[type=submit]');b.disabled=true;try{
    const values=Object.fromEntries(new FormData(form));let note=values.note||'';
    if(values.done)note='Выполнено: '+values.done+'\nОсталось: '+values.remaining+'\nПричина: '+note;
    await apiRequest('/requests/'+encodeURIComponent(r.id)+'/decision',{method:'POST',body:JSON.stringify({...values,action,note,version:f?.version||1})});
    dialog.close();loadedStateParts.history=false;await refreshFromServer(false);
  }catch(e){dialog.querySelector('[role=alert]').textContent=e.message;b.disabled=false;}};
  dialog.showModal();
}
function initRequestFlow(renderActive) {
  document.addEventListener('click',e=>{const b=e.target.closest('[data-flow-action]');if(!b)return;const r=state.requests.find(r=>r.id===b.dataset.id);if(r)modal(r,b.dataset.flowAction);});
  document.addEventListener('click',async e=>{
    const b=e.target.closest('[data-flow-note-delete]');if(!b)return;
    const r=state.requests.find(r=>r.id===b.dataset.request);
    if(!r||!confirm('Удалить эту заметку из ремонта?'))return;
    b.disabled=true;
    try{await apiRequest('/requests/'+encodeURIComponent(r.id)+'/notes/'+encodeURIComponent(b.dataset.flowNoteDelete),{method:'DELETE',body:JSON.stringify({version:r.flow.version})});loadedStateParts.history=false;await refreshFromServer(false);}
    catch(e){b.disabled=false;alert(e.message);}
  });
  actions.note_deleted='Удалена заметка';
  byId('requestFlowStage').addEventListener('change', renderActive);
}
const label = request => stages[request.flow?.stage];
const actionLabel = action => actions[action] || action;

export { actionLabel, canAct, card, initRequestFlow, label, notes, timeline };
