import { describe, expect, it } from 'vitest'
type Status='ASSIGNED'|'IN_PROGRESS'|'PENDING_APPROVAL'|'REJECTED'|'COMPLETED'
const allowed=(from:Status,to:Status,role:'ADMIN'|'EMPLOYEE')=>role==='ADMIN'?from==='PENDING_APPROVAL'&&(to==='COMPLETED'||to==='REJECTED'):from==='ASSIGNED'&&to==='IN_PROGRESS'||(from==='IN_PROGRESS'||from==='REJECTED')&&to==='PENDING_APPROVAL'
const canSubmit=(type:'CHECKBOX'|'TEXT'|'CAMERA',input:{confirmed?:boolean;text?:string;cameraCaptured?:boolean})=>type==='CHECKBOX'?input.confirmed===true:type==='TEXT'?Boolean(input.text?.trim()):input.cameraCaptured===true
const canViewAssignment=(role:'ADMIN'|'EMPLOYEE',viewer:string,assignee:string)=>role==='ADMIN'||viewer===assignee
const uniqueAssignees=(ids:string[])=>[...new Set(ids)]
describe('task workflow rules',()=>{
 it('lets employees start assigned work and submit active or rejected tasks',()=>{expect(allowed('ASSIGNED','IN_PROGRESS','EMPLOYEE')).toBe(true);expect(allowed('REJECTED','PENDING_APPROVAL','EMPLOYEE')).toBe(true);expect(allowed('COMPLETED','IN_PROGRESS','EMPLOYEE')).toBe(false)})
 it('keeps reviews administrator-only and pending-only',()=>{expect(allowed('PENDING_APPROVAL','COMPLETED','ADMIN')).toBe(true);expect(allowed('PENDING_APPROVAL','REJECTED','ADMIN')).toBe(true);expect(allowed('PENDING_APPROVAL','COMPLETED','EMPLOYEE')).toBe(false);expect(allowed('COMPLETED','REJECTED','ADMIN')).toBe(false)})
 it('validates the evidence required for each submission method',()=>{expect(canSubmit('CHECKBOX',{confirmed:true})).toBe(true);expect(canSubmit('TEXT',{text:'  '})).toBe(false);expect(canSubmit('TEXT',{text:'Done'})).toBe(true);expect(canSubmit('CAMERA',{cameraCaptured:false})).toBe(false);expect(canSubmit('CAMERA',{cameraCaptured:true})).toBe(true)})
 it('limits assignment visibility to the employee or an administrator',()=>{expect(canViewAssignment('EMPLOYEE','e1','e1')).toBe(true);expect(canViewAssignment('EMPLOYEE','e2','e1')).toBe(false);expect(canViewAssignment('ADMIN','admin','e1')).toBe(true)})
 it('deduplicates department assignees before creating individual assignments',()=>{expect(uniqueAssignees(['e1','e2','e1'])).toEqual(['e1','e2'])})
})
