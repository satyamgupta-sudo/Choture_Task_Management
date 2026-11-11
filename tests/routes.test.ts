import { describe, expect, it } from 'vitest'
import { defaultRoute, pageForPath, pathForPage } from '../src/lib/routes'

describe('role-based workspace routing',()=>{
 it('sends each role to its own workspace',()=>{expect(defaultRoute('ADMIN')).toBe('/admin/overview');expect(defaultRoute('EMPLOYEE')).toBe('/employee/tasks')})
 it('allows admin pages only for admins',()=>{expect(pageForPath('/admin/team','ADMIN')).toBe('Team');expect(pageForPath('/admin/team','EMPLOYEE')).toBeNull();expect(pageForPath('/admin/activity','EMPLOYEE')).toBeNull()})
 it('restricts the approval queue to the admin workspace',()=>{expect(pageForPath('/admin/reviews','ADMIN')).toBe('Reviews');expect(pageForPath('/admin/reviews','EMPLOYEE')).toBeNull();expect(pathForPage('Reviews','ADMIN')).toBe('/admin/reviews')})
 it('keeps employee routes and rejects cross-workspace URLs',()=>{expect(pageForPath('/employee/profile','EMPLOYEE')).toBe('Profile');expect(pageForPath('/admin/overview','EMPLOYEE')).toBeNull();expect(pageForPath('/employee/tasks','ADMIN')).toBeNull()})
 it('creates stable URLs for navigation',()=>{expect(pathForPage('Team','ADMIN')).toBe('/admin/team');expect(pathForPage('My tasks','EMPLOYEE')).toBe('/employee/tasks')})
})
