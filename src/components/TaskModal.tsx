import { useEffect, useMemo, useState } from 'react'
import { Camera, Check, History, Plus, Search, X } from 'lucide-react'
import CameraCapture from './CameraCapture'
import { getAssignmentHistory, getEvidencePreview } from '../services/tasks'
import { taskActions } from '../lib/task-workflow'
import type { AssignmentAuditEntry, Department, Profile, SubmissionHistoryEntry, SubmissionType, Task } from '../types'
import './task-modal.css'

type ChecklistItem={id:string;text:string}
type SubmissionConfig={checklist_items:ChecklistItem[];photo_instructions:string}
type CreateInput={title:string;description:string;priority:string;due_at:string|null;submission_type:SubmissionType;submission_config:SubmissionConfig;assignee_ids:string[];recurrence_frequency:string;recurrence_start_date:string|null;recurrence_end_date:string|null;timezone:string|null;scheduled_time:string|null}
type SubmissionInput={response_text:string;checkbox_confirmed:boolean;checklist_values:Record<string,boolean>;blob?:Blob}
type Props={task:Task|null;actor:Profile;employees:Profile[];departments:Department[];busy:boolean;actionError?:string;onClose:()=>void;onCreate:(input:CreateInput)=>void;onBegin:(id:string)=>void;onSubmit:(id:string,type:string,input:SubmissionInput)=>void;onReview:(id:string,decision:'approve'|'reject',comment:string)=>void;onArchive:(id:string)=>void}

const dueLabel=(date:string|null)=>date?new Intl.DateTimeFormat('en',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(date)):'No deadline'
const localDateTime=(value:Date)=>{const offset=value.getTimezoneOffset()*60_000;return new Date(value.getTime()-offset).toISOString().slice(0,16)}
const newChecklistId=()=>crypto.randomUUID()

export default function TaskModal({task,actor,employees,departments,busy,actionError='',onClose,onCreate,onBegin,onSubmit,onReview,onArchive}:Props){
  const [response,setResponse]=useState(''),[blob,setBlob]=useState<Blob|null>(null),[comment,setComment]=useState('')
  const [title,setTitle]=useState(''),[description,setDescription]=useState(''),[priority,setPriority]=useState('MEDIUM'),[type,setType]=useState<SubmissionType>('CHECKBOX')
  const [due,setDue]=useState(''),[assignees,setAssignees]=useState<string[]>([]),[departmentFilter,setDepartmentFilter]=useState('All'),[employeeSearch,setEmployeeSearch]=useState(''),[step,setStep]=useState<1|2>(1),[error,setError]=useState('')
  const [checklistItems,setChecklistItems]=useState<ChecklistItem[]>([]),[photoInstructions,setPhotoInstructions]=useState(''),[checklistValues,setChecklistValues]=useState<Record<string,boolean>>({})
  const [recurrence,setRecurrence]=useState('ONCE'),[recurrenceEnd,setRecurrenceEnd]=useState('')
  const [evidence,setEvidence]=useState<{path:string;url?:string;error?:string}|null>(null)
  const [history,setHistory]=useState<{submissions:SubmissionHistoryEntry[];audit:AssignmentAuditEntry[]}|null>(null),[historyError,setHistoryError]=useState('')
  const create=!task,admin=actor.role==='ADMIN',pending=Boolean(task&&['SUBMITTED','PENDING_APPROVAL'].includes(task.status))
  const actions=task?taskActions(task,actor):null
  const editable=Boolean(actions?.canStart||actions?.canSubmit)
  const activeEmployees=useMemo(()=>employees.filter(person=>person.active&&person.role==='EMPLOYEE').sort((a,b)=>a.full_name.localeCompare(b.full_name)),[employees])
  const selectedEmployees=useMemo(()=>assignees.map(id=>activeEmployees.find(person=>person.id===id)).filter((person):person is Profile=>Boolean(person)),[assignees,activeEmployees])
  const filteredEmployees=useMemo(()=>activeEmployees.filter(person=>{
    const department=departments.find(item=>item.id===person.department_id)?.name??'Unassigned'
    const departmentMatches=departmentFilter==='All'||(departmentFilter==='unassigned'?!person.department_id:person.department_id===departmentFilter)
    return departmentMatches&&`${person.full_name} ${department}`.toLowerCase().includes(employeeSearch.trim().toLowerCase())
  }),[activeEmployees,departments,departmentFilter,employeeSearch])
  const configuredChecklist=(task?.submission_config?.checklist_items??[]) as ChecklistItem[]
  const historyEvents=useMemo(()=>[
    ...(history?.submissions??[]).map(entry=>({id:entry.id,at:entry.submitted_at,label:`Submitted version ${entry.version}`,actor:'Employee',detail:entry.response_text??(entry.checkbox_confirmed?'Completion confirmed':entry.evidence_path?'Camera photo attached':'Task submitted'),comment:entry.review_comment})),
    ...(history?.audit??[]).filter(entry=>entry.action!=='submitted').map(entry=>({id:entry.id,at:entry.created_at,label:entry.action==='approve'?'Approved':entry.action==='reject'?'Returned for changes':entry.action==='started'?'Task started':entry.action.replaceAll('_',' '),actor:entry.actor_id===actor.id?'You':entry.action==='approve'||entry.action==='reject'?'Administrator':'Employee',detail:'Recorded in the audit log',comment:typeof entry.metadata?.comment==='string'?entry.metadata.comment:null})),
  ].sort((a,b)=>new Date(b.at).getTime()-new Date(a.at).getTime()),[history,actor.id])

  useEffect(()=>{
    setResponse('');setBlob(null);setComment('');setError('');setHistory(null);setHistoryError('');setChecklistValues({})
    let current=true
    const path=task?.submission?.evidence_path
    setEvidence(path?{path}:null)
    if(task)void getAssignmentHistory(task.assignment_id,admin).then(result=>{if(current)setHistory(result)}).catch(cause=>{if(current)setHistoryError(cause instanceof Error?cause.message:'Could not load assignment history.')})
    if(path)void getEvidencePreview(path).then(url=>{if(current)setEvidence({path,url})}).catch(cause=>{if(current)setEvidence({path,error:cause instanceof Error?cause.message:'Could not load the private photo.'})})
    return()=>{current=false}
  },[task?.assignment_id,task?.submission?.evidence_path,admin])

  function toggleEmployee(id:string){setAssignees(current=>current.includes(id)?current.filter(item=>item!==id):[...current,id])}
  function submitCreate(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();setError('')
    if(step===1){if(!assignees.length)setError('Select at least one employee before continuing.');else setStep(2);return}
    if(!title.trim()){setError('Enter a task name.');return}
    if(description.trim().length>2000){setError('Instructions must be 2,000 characters or fewer.');return}
    if(due&&new Date(due).getTime()<=Date.now()){setError('Choose a deadline in the future.');return}
    if(recurrence!=='ONCE'&&!due){setError('Choose the first due date and time for this recurring task.');return}
    if(recurrenceEnd&&due&&recurrenceEnd<due.slice(0,10)){setError('Recurrence end date must be on or after the start date.');return}
    const normalizedItems=checklistItems.map(item=>({...item,text:item.text.trim()})).filter(item=>item.text)
    if(type==='MULTIPLE'&&!normalizedItems.length){setError('Multiple proof requires at least one checklist item.');return}
    if(normalizedItems.length>30){setError('A task can have at most 30 checklist items.');return}
    onCreate({title:title.trim(),description:description.trim(),priority,due_at:due?new Date(due).toISOString():null,submission_type:type,submission_config:{checklist_items:normalizedItems,photo_instructions:photoInstructions.trim()},assignee_ids:selectedEmployees.map(person=>person.id),recurrence_frequency:recurrence,recurrence_start_date:recurrence==='ONCE'||!due?null:due.slice(0,10),recurrence_end_date:recurrence==='ONCE'||!recurrenceEnd?null:recurrenceEnd,timezone:recurrence==='ONCE'?null:Intl.DateTimeFormat().resolvedOptions().timeZone,scheduled_time:recurrence==='ONCE'||!due?null:due.slice(11,16)})
  }

  const submitEmployeeTask=()=>{
    if(!task)return
    const items=configuredChecklist
    if(items.length&&!items.every(item=>checklistValues[item.id])){setError('Complete every checklist item before submitting.');return}
    if(!items.length&&task.submission_type==='CHECKBOX'&&response!=='confirmed'){setError('Confirm task completion before submitting.');return}
    if(['TEXT','MULTIPLE'].includes(task.submission_type)&&!response.trim()){setError('Enter a written response before submitting.');return}
    if(['CAMERA','MULTIPLE'].includes(task.submission_type)&&!blob){setError('Capture a photo before submitting.');return}
    setError('')
    onSubmit(task.assignment_id,task.submission_type,{response_text:response,checkbox_confirmed:response==='confirmed',checklist_values:checklistValues,blob:blob??undefined})
  }

  return <div className="modal-backdrop" onMouseDown={event=>event.target===event.currentTarget&&onClose()}>
    <section className="modal task-modal" role="dialog" aria-modal="true" aria-labelledby="task-modal-title">
      <header className="modal-head"><div><p className="eyebrow">{create?step===1?'STEP 1 OF 2 · SELECT EMPLOYEES':'STEP 2 OF 2 · TASK DETAILS':pending?'AWAITING REVIEW':'TASK DETAILS'}</p><h2 id="task-modal-title">{create?step===1?'Choose employees':'Create and assign task':task.title}</h2></div><button type="button" className="icon-button" aria-label="Close task dialog" onClick={onClose}><X size={19}/></button></header>
      {create?<form onSubmit={submitCreate}>
        {step===1?<>
          <p className="muted tiny">Select the people who will receive their own independent assignment.</p>
          <div className="employee-selection-toolbar"><label className="employee-search"><Search size={15}/><input autoFocus value={employeeSearch} onChange={event=>setEmployeeSearch(event.target.value)} placeholder="Search employees or departments" aria-label="Search active employees"/></label><select aria-label="Filter employees by department" value={departmentFilter} onChange={event=>setDepartmentFilter(event.target.value)}><option value="All">All departments</option>{departments.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}<option value="unassigned">Unassigned</option></select></div>
          <div className="employee-selection-actions"><span>{selectedEmployees.length} selected · {activeEmployees.length} active employees</span><div><button type="button" className="text-button" onClick={()=>setAssignees(current=>[...new Set([...current,...filteredEmployees.map(person=>person.id)])])}>Select all shown</button><button type="button" className="text-button" onClick={()=>setAssignees([])}>Clear selection</button></div></div>
          <div className="employee-selection-list">{filteredEmployees.map(person=><label key={person.id} className={`employee-selection-row ${assignees.includes(person.id)?'is-selected':''}`}><input type="checkbox" checked={assignees.includes(person.id)} onChange={()=>toggleEmployee(person.id)}/><span className="person-dot">{person.full_name.slice(0,1).toUpperCase()}</span><span className="employee-selection-copy"><b>{person.full_name}</b><small>{departments.find(item=>item.id===person.department_id)?.name??'Unassigned'}</small></span>{assignees.includes(person.id)&&<Check size={16}/>}</label>)}{!filteredEmployees.length&&<div className="dash-empty"><b>{activeEmployees.length?'No employees match this search':'No active employees available'}</b><p>{activeEmployees.length?'Try a different name or department.':'Provision employee accounts in Team management before assigning tasks.'}</p></div>}</div>
          {selectedEmployees.length>0&&<div className="selected-employee-chips"><b>Selected employees</b><div>{selectedEmployees.map(person=><button type="button" key={person.id} onClick={()=>toggleEmployee(person.id)} aria-label={`Remove ${person.full_name}`}><span>{person.full_name}</span><X size={13}/></button>)}</div></div>}
          {error&&<p className="error-text" role="alert">{error}</p>}
          <footer className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button type="submit" className="button button-primary" disabled={!selectedEmployees.length}>Continue with {selectedEmployees.length||'no'} selected</button></footer>
        </>:<>
          <button type="button" className="text-button edit-assignees-button" onClick={()=>setStep(1)}>← Edit employee selection</button>
          <section className="assignment-confirmation"><b>Assignments will be created for {selectedEmployees.length} employee{selectedEmployees.length===1?'':'s'}</b><div>{selectedEmployees.map(person=><span key={person.id}>{person.full_name}<small>{departments.find(item=>item.id===person.department_id)?.name??'Unassigned'}</small></span>)}</div></section>
          <label>Task title<input required maxLength={120} value={title} onChange={event=>setTitle(event.target.value)} placeholder="e.g. Daily cleaning and inspection"/></label>
          <label>Description / instructions<textarea rows={3} maxLength={2000} value={description} onChange={event=>setDescription(event.target.value)} placeholder="Give employees the details they need."/><small className="field-counter">{description.length}/2,000</small></label>
          <div className="form-grid"><label>Priority<select value={priority} onChange={event=>setPriority(event.target.value)}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option><option value="URGENT">Urgent</option></select></label><label>Due date<input type="datetime-local" min={localDateTime(new Date())} value={due} onChange={event=>setDue(event.target.value)} required={recurrence!=='ONCE'}/></label></div>
          <label>Submission type<select value={type} onChange={event=>setType(event.target.value as SubmissionType)}><option value="CHECKBOX">Checkbox confirmation</option><option value="TEXT">Text response</option><option value="CAMERA">Live camera photo</option><option value="MULTIPLE">Multiple: checklist, text, and live photo</option></select></label>
          <section className="checklist-editor"><div className="checklist-editor-heading"><span><b>Optional checklist items</b><small>Employees complete each item before submitting.</small></span><button type="button" className="text-button" onClick={()=>setChecklistItems(items=>[...items,{id:newChecklistId(),text:''}])}><Plus size={14}/>Add item</button></div>{checklistItems.map((item,index)=><div className="checklist-editor-row" key={item.id}><span>{index+1}</span><input maxLength={240} value={item.text} onChange={event=>setChecklistItems(items=>items.map(current=>current.id===item.id?{...current,text:event.target.value}:current))} placeholder={`Checklist item ${index+1}`}/><button type="button" className="icon-button" aria-label={`Remove checklist item ${index+1}`} onClick={()=>setChecklistItems(items=>items.filter(current=>current.id!==item.id))}><X size={15}/></button></div>)}{type==='MULTIPLE'&&!checklistItems.some(item=>item.text.trim())&&<small className="error-text">Add at least one checklist item for multiple proof.</small>}</section>
          {['CAMERA','MULTIPLE'].includes(type)&&<label>Photo evidence instructions (optional)<textarea rows={2} maxLength={1000} value={photoInstructions} onChange={event=>setPhotoInstructions(event.target.value)} placeholder="Describe what the photo should show."/></label>}
          <label>Recurrence<select value={recurrence} onChange={event=>{setRecurrence(event.target.value);setRecurrenceEnd('')}}><option value="ONCE">Once</option><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></select></label>
          {recurrence!=='ONCE'&&<><div className="recurrence-summary">{recurrence.charAt(0)+recurrence.slice(1).toLowerCase()} assignments use the task due time in <b>{Intl.DateTimeFormat().resolvedOptions().timeZone}</b>. The first task is assigned now; scheduled generation creates later occurrences.</div><label>Repeat until (optional)<input type="date" min={due?due.slice(0,10):undefined} value={recurrenceEnd} onChange={event=>setRecurrenceEnd(event.target.value)}/></label></>}
          {error&&<p className="error-text" role="alert">{error}</p>}{actionError&&<p className="error-text" role="alert">{actionError}</p>}
          <footer className="modal-actions"><button type="button" className="button button-secondary" onClick={()=>setStep(1)}>Back</button><button type="submit" className="button button-primary" disabled={busy||!selectedEmployees.length||(type==='MULTIPLE'&&!checklistItems.some(item=>item.text.trim()))}><Plus size={16}/>{busy?'Assigning…':'Confirm and assign'}</button></footer>
        </>}
      </form>:<>
        <div className="detail-tags"><span className={`priority priority-${task.priority.toLowerCase()}`}>{task.priority} priority</span><span className={`status-tag status-${task.status.toLowerCase()}`}>{task.status.replaceAll('_',' ')}</span></div>
        <div className="detail-block"><span className="detail-label">INSTRUCTIONS</span><p>{task.description||'No additional instructions.'}</p></div>
        <div className="detail-facts"><div><span className="detail-label">DUE DATE</span><b>{dueLabel(task.due_at)}</b></div>{admin&&<div><span className="detail-label">ASSIGNED TO</span><b>{task.employee_name}</b></div>}<div><span className="detail-label">SUBMISSION REQUIREMENTS</span><b>{task.submission_type==='MULTIPLE'?'Checklist + text + live photo':task.submission_type}</b></div></div>
        {task.submission?.review_comment&&<div className="review-note"><b>Feedback from your manager</b><p>{task.submission.review_comment}</p></div>}
        {task.submission?.response_text&&<div className="review-note"><b>Written submission</b><p>{task.submission.response_text}</p><small>Submitted {dueLabel(task.submission.submitted_at)}</small></div>}
        {task.submission?.checklist_values&&Object.keys(task.submission.checklist_values).length>0&&<div className="review-note"><b>Checklist completed</b><ul>{configuredChecklist.map(item=><li key={item.id}>{task.submission?.checklist_values?.[item.id]?'✓':'○'} {item.text}</li>)}</ul><small>Submitted {dueLabel(task.submission.submitted_at)}</small></div>}
        {task.submission?.checkbox_confirmed&&<div className="review-note"><b><Check size={14}/> Completion confirmed</b><p>Employee confirmed this task was completed.</p><small>Submitted {dueLabel(task.submission.submitted_at)}</small></div>}
        {task.submission?.evidence_path&&<div className="private-evidence"><span className="detail-label"><Camera size={13}/> PRIVATE PHOTO EVIDENCE</span>{evidence?.url?<img className="camera-preview" src={evidence.url} alt="Private task submission evidence"/>:<p className="muted tiny">{evidence?.error?'Photo is unavailable to this account.':'Loading secure photo preview…'}</p>}{task.submission_config?.photo_instructions&&<p className="muted tiny">Requested: {task.submission_config.photo_instructions}</p>}<small>Submitted {dueLabel(task.submission.submitted_at)} · Preview link expires shortly.</small></div>}
        {pending&&admin&&!actions?.canApprove&&<div className="inline-alert" role="status">Another active administrator must review this assignment.</div>}
        <section className="assignment-history"><h3><History size={15}/> Assignment history</h3>{historyError&&<p className="error-text" role="alert">{historyError}</p>}{!history&&!historyError?<p className="muted tiny">Loading submission and audit history…</p>:historyEvents.length?<ol>{historyEvents.map(event=><li key={event.id}><span className="history-marker"/><div><div className="history-entry-heading"><b>{event.label}</b><small>{event.actor} · {dueLabel(event.at)}</small></div><p>{event.detail}</p>{event.comment&&<blockquote>{event.comment}</blockquote>}</div></li>)}</ol>:<p className="muted tiny">No submission or review history yet.</p>}</section>
        {editable&&<div className="submit-area">{actionError&&<p className="error-text" role="alert">{actionError}</p>}{actions?.canStart&&<button type="button" className="button button-secondary full" disabled={busy} onClick={()=>onBegin(task.assignment_id)}>Start task</button>}{actions?.canSubmit&&<><span className="detail-label">YOUR SUBMISSION</span>{configuredChecklist.length>0&&<div className="employee-checklist">{configuredChecklist.map(item=><label key={item.id}><input type="checkbox" checked={Boolean(checklistValues[item.id])} onChange={event=>setChecklistValues(current=>({...current,[item.id]:event.target.checked}))}/><span>{item.text}</span></label>)}</div>}{task.submission_type==='CHECKBOX'&&configuredChecklist.length===0&&<label className="confirm-check"><input type="checkbox" checked={response==='confirmed'} onChange={event=>setResponse(event.target.checked?'confirmed':'')}/> I confirm that I completed this task.</label>}{['TEXT','MULTIPLE'].includes(task.submission_type)&&<label className="submission-text-label">Written response<textarea rows={4} maxLength={4000} value={response} onChange={event=>setResponse(event.target.value)} placeholder="Share the details your manager needs…"/></label>}{['CAMERA','MULTIPLE'].includes(task.submission_type)&&<><p className="muted tiny">{task.submission_config?.photo_instructions||'Capture photo evidence using your device camera.'}</p><CameraCapture onCapture={setBlob}/></>}<button type="button" className="button button-primary full" disabled={busy} onClick={submitEmployeeTask}>{task.status==='REJECTED'?'Resubmit for review':'Submit for review'}</button>{error&&<p className="error-text" role="alert">{error}</p>}<p className="muted tiny">Submission records are private to this assignment and timestamped by Supabase.</p></>}</div>}
        {actions?.canApprove&&<div className="submit-area">{actionError&&<p className="error-text" role="alert">{actionError}</p>}<span className="detail-label">REVIEW THIS SUBMISSION</span><label className="submission-text-label">Rejection reason / review note<textarea rows={2} maxLength={2000} value={comment} onChange={event=>setComment(event.target.value)} placeholder="Required when returning a task. Optional for approval."/></label><div className="modal-actions"><button type="button" className="button button-secondary reject-button" disabled={busy||!comment.trim()} onClick={()=>onReview(task.assignment_id,'reject',comment)}>Reject with reason</button><button type="button" className="button button-primary" disabled={busy} onClick={()=>onReview(task.assignment_id,'approve',comment)}>Approve task</button></div></div>}
        {admin&&!pending&&<footer className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Close</button><button type="button" className="text-button danger-text" onClick={()=>window.confirm('Archive this task for everyone?')&&onArchive(task.id)}>Archive task</button></footer>}
      </>}
    </section>
  </div>
}
