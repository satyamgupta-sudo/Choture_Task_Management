import type { Profile, Task, TaskStatus } from '../types'

export type TaskActions={canStart:boolean;canSubmit:boolean;canApprove:boolean;canReject:boolean}

/** UI affordances mirror the database transition guard; RPCs remain authoritative. */
export function canTransitionTaskStatus(task:Pick<Task,'status'|'employee_id'>,actor:Pick<Profile,'id'|'role'|'active'>,next:TaskStatus,rejectionReason=''){
  const isOwner=actor.id===task.employee_id
  const employee=actor.role==='EMPLOYEE'&&actor.active&&isOwner
  const admin=actor.role==='ADMIN'&&actor.active&&!isOwner
  const awaitingReview=task.status==='PENDING_APPROVAL'||task.status==='SUBMITTED'
  if(next==='IN_PROGRESS')return employee&&task.status==='ASSIGNED'
  if(next==='PENDING_APPROVAL')return employee&&(task.status==='ASSIGNED'||task.status==='IN_PROGRESS'||task.status==='REJECTED')
  if(next==='COMPLETED')return admin&&awaitingReview
  if(next==='REJECTED')return admin&&awaitingReview&&rejectionReason.trim().length>0
  return false
}

export function taskActions(task:Pick<Task,'status'|'employee_id'>,actor:Pick<Profile,'id'|'role'|'active'>):TaskActions{
  return {
    canStart:canTransitionTaskStatus(task,actor,'IN_PROGRESS'),
    canSubmit:canTransitionTaskStatus(task,actor,'PENDING_APPROVAL'),
    canApprove:canTransitionTaskStatus(task,actor,'COMPLETED'),
    canReject:canTransitionTaskStatus(task,actor,'REJECTED','required reason'),
  }
}

export function isReviewableStatus(status:TaskStatus){return status==='PENDING_APPROVAL'||status==='SUBMITTED'}
