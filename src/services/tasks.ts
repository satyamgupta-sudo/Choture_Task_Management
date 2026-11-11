import { supabase } from '../lib/supabase'
import type { AssignmentAuditEntry, AuditEvent, Department, Profile, SubmissionHistoryEntry, Task } from '../types'

function client() { if (!supabase) throw new Error('Connect Supabase in your .env file to use live restaurant data.') ; return supabase }
export async function getMyProfile(): Promise<Profile> { const { data: { user } } = await client().auth.getUser(); if (!user) throw new Error('Please sign in.'); const { data, error } = await client().from('profiles').select('*').eq('id', user.id).single(); if (error) throw error; return { ...data, email:user.email } as unknown as Profile }
export async function getDepartments(): Promise<Department[]> { const { data, error } = await client().from('departments').select('id,name,description').order('name'); if (error) throw error; return data as Department[] }
export async function getProfiles(): Promise<Profile[]> { const { data, error } = await client().from('profiles').select('*').order('full_name'); if (error) throw error; return data as unknown as Profile[] }
export async function getTasks(): Promise<Task[]> {
 const q = client().from('task_assignments').select('id,status,employee_id,department_id,assigned_at,profiles!task_assignments_employee_id_fkey(full_name),tasks!inner(id,title,description,priority,due_at,submission_type,submission_config,department_id,created_at,archived_at),submissions!submissions_assignment_id_fkey(id,task_assignment_id,response_text,evidence_path,checkbox_confirmed,checklist_values,submitted_at,review_comment,version)').is('tasks.archived_at',null).order('assigned_at', { ascending: false })
 const { data, error } = await q; if (error) throw error
 return (data ?? []).map((row: any) => ({ ...row.tasks, department_id:row.department_id, assignment_id: row.id, employee_id: row.employee_id, employee_name: row.profiles?.full_name, status: row.status, submission: [...(row.submissions ?? [])].sort((a:any,b:any)=>b.version-a.version)[0] ?? null })) as Task[]
}
export async function createTask(input: { title:string; description:string; priority:string; due_at:string|null; submission_type:string; submission_config:{checklist_items:{id:string;text:string}[];photo_instructions:string}; assignee_ids:string[]; recurrence_frequency:string;recurrence_start_date:string|null;recurrence_end_date:string|null;timezone:string|null;scheduled_time:string|null }) {
 const title=input.title.trim(),description=input.description.trim(),assigneeIds=[...new Set(input.assignee_ids)]
 if(title.length<1||title.length>120)throw new Error('Task title must be between 1 and 120 characters.')
 if(description.length>2000)throw new Error('Instructions must be 2,000 characters or fewer.')
 if(input.due_at){const due=Date.parse(input.due_at);if(!Number.isFinite(due)||due<=Date.now())throw new Error('Choose a deadline in the future.')}
 if(!['LOW','MEDIUM','HIGH','URGENT'].includes(input.priority))throw new Error('Choose a valid priority.')
 if(!['CHECKBOX','TEXT','CAMERA','MULTIPLE'].includes(input.submission_type))throw new Error('Choose a valid submission type.')
 if(!assigneeIds.length)throw new Error('Select at least one active employee.')
 if(!['ONCE','DAILY','WEEKLY','MONTHLY'].includes(input.recurrence_frequency))throw new Error('Choose a valid recurrence interval.')
 if(input.recurrence_frequency!=='ONCE'&&(!input.recurrence_start_date||!input.scheduled_time||!input.timezone))throw new Error('Recurring tasks require a start date, local due time, and time zone.')
 const { data, error } = await client().rpc('create_user_first_task', { p_title:title,p_description:description,p_priority:input.priority,p_due_at:input.due_at,p_submission_type:input.submission_type,p_submission_config:input.submission_config,p_assignee_ids:assigneeIds,p_recurrence_frequency:input.recurrence_frequency,p_recurrence_start_date:input.recurrence_start_date,p_recurrence_end_date:input.recurrence_end_date,p_timezone:input.timezone,p_scheduled_time:input.scheduled_time }); if (error) throw error; return data
}
export async function submitTask(assignmentId:string, submissionType:string, submission:{response_text:string;checkbox_confirmed:boolean;checklist_values:Record<string,boolean>;blob?:Blob}) {
 const db=client(); let evidencePath:string|null=null
 if (!['CHECKBOX','TEXT','CAMERA','MULTIPLE'].includes(submissionType)) throw new Error('This task has an unsupported submission type.')
 if (['CAMERA','MULTIPLE'].includes(submissionType)) { const blob=submission.blob;if(!blob) throw new Error('Capture a photo before submitting.');if(blob.type!=='image/jpeg')throw new Error('Camera evidence must be a JPEG photo.');if(blob.size>5*1024*1024)throw new Error('Photo evidence must be 5 MB or smaller.');const { data: { user } }=await db.auth.getUser();if(!user)throw new Error('Please sign in again before submitting.');const path=`${user.id}/${assignmentId}/${crypto.randomUUID()}.jpg`;const { error: uploadError }=await db.storage.from('task-evidence').upload(path,blob,{contentType:'image/jpeg',upsert:false});if(uploadError) throw uploadError; evidencePath=path }
 if(['TEXT','MULTIPLE'].includes(submissionType)&&!submission.response_text.trim()) throw new Error('Enter a response before submitting.')
 try{const { error }=await db.rpc('submit_user_first_task', { p_assignment_id:assignmentId,p_response_text:submission.response_text.trim()||null,p_checkbox_confirmed:submission.checkbox_confirmed,p_checklist_values:submission.checklist_values,p_evidence_path:evidencePath });if(error)throw error}catch(error){if(evidencePath)await db.storage.from('task-evidence').remove([evidencePath]);throw error}
}
export async function getEvidencePreview(path:string):Promise<string>{
 if(!path||path.startsWith('/')||path.includes('..'))throw new Error('Invalid evidence path.')
 const {data,error}=await client().storage.from('task-evidence').createSignedUrl(path,90)
 if(error)throw error
 return data.signedUrl
}
export async function getAssignmentHistory(assignmentId:string,includeAudit:boolean):Promise<{submissions:SubmissionHistoryEntry[];audit:AssignmentAuditEntry[]}>{
 const db=client()
 const {data:submissions,error:submissionError}=await db.from('submissions').select('id,task_assignment_id,assignment_id,employee_id,response_text,evidence_path,checkbox_confirmed,submitted_at,review_comment,reviewed_by,version').eq('assignment_id',assignmentId).order('version',{ascending:false})
 if(submissionError)throw submissionError
 if(!includeAudit)return{submissions:(submissions??[]) as SubmissionHistoryEntry[],audit:[]}
 const {data:audit,error:auditError}=await db.from('audit_logs').select('id,actor_id,action,metadata,created_at').eq('entity_type','assignment').eq('entity_id',assignmentId).order('created_at',{ascending:false})
 if(auditError)throw auditError
 return{submissions:(submissions??[]) as SubmissionHistoryEntry[],audit:(audit??[]) as AssignmentAuditEntry[]}
}
export async function getRecentAuditEvents():Promise<AuditEvent[]>{
 const {data,error}=await client().from('audit_logs').select('id,actor_id,action,entity_type,entity_id,metadata,created_at').order('created_at',{ascending:false}).limit(100)
 if(error)throw error
 return(data??[]) as AuditEvent[]
}
export async function reviewTask(assignmentId:string, decision:'approve'|'reject', comment:string) { const { error }=await client().rpc('review_task',{p_assignment_id:assignmentId,p_decision:decision,p_comment:comment.trim()}); if(error) throw error }
export async function archiveTask(taskId:string) { const { error }=await client().from('tasks').update({ archived_at:new Date().toISOString() }).eq('id',taskId); if(error) throw error }
