import { describe, expect, it } from 'vitest'
import { canTransitionTaskStatus, isReviewableStatus, taskActions } from '../src/lib/task-workflow'
import type { Profile, TaskStatus } from '../src/types'

const employee:Pick<Profile,'id'|'role'|'active'>={id:'employee-1',role:'EMPLOYEE',active:true}
const admin:Pick<Profile,'id'|'role'|'active'>={id:'admin-1',role:'ADMIN',active:true}
const task=(status:TaskStatus)=>({status,employee_id:'employee-1'})
const states:TaskStatus[]=['ASSIGNED','IN_PROGRESS','SUBMITTED','PENDING_APPROVAL','REJECTED','COMPLETED']
const allowedTransitions=new Set(['ASSIGNED:IN_PROGRESS','IN_PROGRESS:PENDING_APPROVAL','REJECTED:PENDING_APPROVAL','PENDING_APPROVAL:COMPLETED','SUBMITTED:COMPLETED','PENDING_APPROVAL:REJECTED','SUBMITTED:REJECTED'])

describe('task assignment transitions',()=>{
  it.each(states.flatMap(from=>states.map(to=>[from,to] as const)))('transition matrix: %s → %s', (from,to)=>{
    const allowed=allowedTransitions.has(`${from}:${to}`)
    const actor=to==='IN_PROGRESS'||to==='PENDING_APPROVAL'?employee:admin
    const reason=to==='REJECTED'?'Needs more detail':''
    expect(canTransitionTaskStatus(task(from),actor,to,reason)).toBe(allowed)
  })

  it('allows the employee state path ASSIGNED → IN_PROGRESS → PENDING_APPROVAL',()=>{
    expect(canTransitionTaskStatus(task('ASSIGNED'),employee,'IN_PROGRESS')).toBe(true)
    expect(canTransitionTaskStatus(task('IN_PROGRESS'),employee,'PENDING_APPROVAL')).toBe(true)
  })

  it('allows rejected assignments to resubmit into PENDING_APPROVAL',()=>{
    expect(canTransitionTaskStatus(task('REJECTED'),employee,'PENDING_APPROVAL')).toBe(true)
  })

  it('allows another active admin to approve a pending submission',()=>{
    expect(canTransitionTaskStatus(task('PENDING_APPROVAL'),admin,'COMPLETED')).toBe(true)
    expect(canTransitionTaskStatus(task('SUBMITTED'),admin,'COMPLETED')).toBe(true)
  })

  it('requires a rejection reason when an admin returns a submission',()=>{
    expect(canTransitionTaskStatus(task('PENDING_APPROVAL'),admin,'REJECTED')).toBe(false)
    expect(canTransitionTaskStatus(task('SUBMITTED'),admin,'REJECTED','  ')).toBe(false)
    expect(canTransitionTaskStatus(task('PENDING_APPROVAL'),admin,'REJECTED','Needs a temperature log')).toBe(true)
  })

  it.each([
    ['ASSIGNED','PENDING_APPROVAL'],['ASSIGNED','COMPLETED'],['ASSIGNED','REJECTED'],
    ['IN_PROGRESS','ASSIGNED'],['IN_PROGRESS','COMPLETED'],['IN_PROGRESS','REJECTED'],
    ['PENDING_APPROVAL','IN_PROGRESS'],['PENDING_APPROVAL','PENDING_APPROVAL'],
    ['REJECTED','COMPLETED'],['REJECTED','REJECTED'],['COMPLETED','IN_PROGRESS'],['COMPLETED','PENDING_APPROVAL'],
  ] as const)('blocks invalid %s → %s transitions', (from,to)=>{
    const actor=from==='PENDING_APPROVAL'?admin:employee
    expect(canTransitionTaskStatus(task(from),actor,to,'reason')).toBe(false)
  })

  it('allows only the active owner to start an assigned task',()=>{
    expect(taskActions(task('ASSIGNED'),employee).canStart).toBe(true)
    expect(taskActions(task('ASSIGNED'),{...employee,id:'employee-2'}).canStart).toBe(false)
    expect(taskActions(task('ASSIGNED'),{...employee,active:false}).canStart).toBe(false)
    expect(taskActions(task('ASSIGNED'),admin).canStart).toBe(false)
  })

  it.each(['IN_PROGRESS','REJECTED'] as const)('allows only the active owner to resubmit from %s',status=>{
    expect(taskActions(task(status),employee).canSubmit).toBe(true)
    expect(taskActions(task(status),{...employee,id:'employee-2'}).canSubmit).toBe(false)
    expect(taskActions(task(status),{...employee,active:false}).canSubmit).toBe(false)
    expect(taskActions(task(status),admin).canSubmit).toBe(false)
  })

  it.each(['PENDING_APPROVAL','SUBMITTED'] as const)('allows another active admin to approve or reject %s',status=>{
    expect(taskActions(task(status),admin)).toMatchObject({canApprove:true,canReject:true})
    expect(taskActions(task(status),{...admin,id:employee.id})).toMatchObject({canApprove:false,canReject:false})
    expect(taskActions(task(status),{...admin,active:false})).toMatchObject({canApprove:false,canReject:false})
    expect(taskActions(task(status),employee)).toMatchObject({canApprove:false,canReject:false})
  })

  it.each(['ASSIGNED','IN_PROGRESS','REJECTED','COMPLETED'] as const)('does not expose review actions in %s',status=>{
    expect(taskActions(task(status),admin)).toMatchObject({canApprove:false,canReject:false})
  })

  it('treats only submitted states as reviewable',()=>{
    expect(isReviewableStatus('PENDING_APPROVAL')).toBe(true)
    expect(isReviewableStatus('SUBMITTED')).toBe(true)
    expect(isReviewableStatus('ASSIGNED')).toBe(false)
    expect(isReviewableStatus('IN_PROGRESS')).toBe(false)
    expect(isReviewableStatus('REJECTED')).toBe(false)
    expect(isReviewableStatus('COMPLETED')).toBe(false)
  })
})
