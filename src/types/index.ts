export type Role = 'ADMIN' | 'EMPLOYEE'
export type TaskStatus = 'ASSIGNED' | 'IN_PROGRESS' | 'SUBMITTED' | 'PENDING_APPROVAL' | 'COMPLETED' | 'REJECTED'
export type SubmissionType = 'CHECKBOX' | 'TEXT' | 'CAMERA' | 'MULTIPLE'
export interface Profile { id: string; full_name: string; email?: string; role: Role; department_id: string | null; active: boolean }
export interface Department { id: string; name: string; description?: string }
export interface Task { id: string; title: string; description: string; priority: 'LOW'|'MEDIUM'|'HIGH'|'URGENT'; due_at: string|null; submission_type: SubmissionType; submission_config?: {checklist_items?:{id:string;text:string}[];photo_instructions?:string}; department_id: string|null; status: TaskStatus; created_at: string; assignment_id: string; employee_id: string; employee_name?: string; submission?: Submission|null }
export interface Submission { id: string; task_assignment_id: string; response_text: string|null; evidence_path: string|null; checkbox_confirmed?: boolean; checklist_values?:Record<string,boolean>; submitted_at: string; review_comment: string|null }
export interface SubmissionHistoryEntry extends Submission { version:number; reviewed_by:string|null }
export interface AssignmentAuditEntry { id:string; actor_id:string|null; action:string; metadata:Record<string,unknown>; created_at:string }
export interface AuditEvent extends AssignmentAuditEntry { entity_type:string; entity_id:string }
