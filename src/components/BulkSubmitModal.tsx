import { useState } from 'react'
import { Check, X } from 'lucide-react'
import CameraCapture from './CameraCapture'
import type { Task } from '../types'

export type BulkSubmission={assignment_id:string;response_text:string;checkbox_confirmed:boolean;checklist_values:Record<string,boolean>;required_proofs:string[];blob?:Blob}
type Draft={response_text:string;checkbox_confirmed:boolean;checklist_values:Record<string,boolean>;blob?:Blob}

export default function BulkSubmitModal({tasks,busy,actionError='',onClose,onSubmit}:{tasks:Task[];busy:boolean;actionError?:string;onClose:()=>void;onSubmit:(submissions:BulkSubmission[])=>Promise<void>|void}){
 const [drafts,setDrafts]=useState<Record<string,Draft>>(()=>Object.fromEntries(tasks.map(task=>[task.assignment_id,{response_text:'',checkbox_confirmed:false,checklist_values:{}}])))
 const [error,setError]=useState('')
 const proofSet=(task:Task)=>task.submission_config?.required_proofs??(task.submission_type==='MULTIPLE'?['CHECKBOX','TEXT','CAMERA']:[task.submission_type])
 function update(id:string,patch:Partial<Draft>){setDrafts(current=>({...current,[id]:{...current[id],...patch}}))}
 async function submit(){
  for(const task of tasks){const draft=drafts[task.assignment_id],proofs=proofSet(task),items=task.submission_config?.checklist_items??[]
   if(proofs.includes('CHECKBOX')&&items.length&&!items.every(item=>draft.checklist_values[item.id])){setError(`Complete every checklist item for “${task.title}”.`);return}
   if(proofs.includes('CHECKBOX')&&!items.length&&!draft.checkbox_confirmed){setError(`Confirm completion for “${task.title}”.`);return}
   if(proofs.includes('TEXT')&&!draft.response_text.trim()){setError(`Add a written response for “${task.title}”.`);return}
   if(proofs.includes('CAMERA')&&!draft.blob){setError(`Capture a photo for “${task.title}”.`);return}
  }
  setError('')
  try{await onSubmit(tasks.map(task=>({assignment_id:task.assignment_id,...drafts[task.assignment_id],required_proofs:proofSet(task)})))}catch(cause){setError(cause instanceof Error?cause.message:'Could not submit these tasks.')}
 }
 return <div className="modal-backdrop bulk-submit-backdrop" onMouseDown={event=>event.target===event.currentTarget&&!busy&&onClose()}>
  <section className="modal task-modal bulk-submit-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-submit-title">
   <header className="modal-head"><div><p className="eyebrow">BULK TASK COMPLETION</p><h2 id="bulk-submit-title">Submit {tasks.length} tasks</h2><p className="muted tiny">Add each task’s required proof, then submit everything together for manager review.</p></div><button type="button" className="icon-button" aria-label="Close bulk submission" disabled={busy} onClick={onClose}><X size={19}/></button></header>
   <div className="bulk-submit-items">{tasks.map(task=>{const proofs=proofSet(task),items=task.submission_config?.checklist_items??[],draft=drafts[task.assignment_id];return <section className="bulk-submit-item" key={task.assignment_id}><div><h3>{task.title}</h3><small>{proofs.map(proof=>proof==='CHECKBOX'?'Checklist / confirmation':proof==='TEXT'?'Written response':'Photo').join(' · ')}</small></div>{proofs.includes('CHECKBOX')&&items.length>0&&<div className="employee-checklist">{items.map(item=><label key={item.id}><input type="checkbox" checked={Boolean(draft.checklist_values[item.id])} onChange={event=>update(task.assignment_id,{checklist_values:{...draft.checklist_values,[item.id]:event.target.checked}})}/><span>{item.text}</span></label>)}</div>}{proofs.includes('CHECKBOX')&&!items.length&&<label className="confirm-check"><input type="checkbox" checked={draft.checkbox_confirmed} onChange={event=>update(task.assignment_id,{checkbox_confirmed:event.target.checked})}/> I confirm this task is complete.</label>}{proofs.includes('TEXT')&&<label>Written response<textarea rows={2} maxLength={4000} value={draft.response_text} onChange={event=>update(task.assignment_id,{response_text:event.target.value})} placeholder="Add the required details"/></label>}{proofs.includes('CAMERA')&&<div className="bulk-camera"><p className="muted tiny">{task.submission_config?.photo_instructions||'Capture photo evidence.'}</p><CameraCapture onCapture={blob=>update(task.assignment_id,{blob:blob??undefined})}/></div>}</section>})}</div>
   {(error||actionError)&&<p className="error-text" role="alert">{error||actionError}</p>}
   <footer className="bulk-submit-footer"><button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className="button button-primary" disabled={busy} onClick={submit}><Check size={16}/>{busy?'Submitting…':`Submit all ${tasks.length} tasks`}</button></footer>
  </section>
 </div>
}
