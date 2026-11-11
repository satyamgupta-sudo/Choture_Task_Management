import type { Role } from '../types'

const pageSlugs:Record<string,string>={Overview:'overview',Tasks:'tasks','My tasks':'tasks',Reviews:'reviews','Review queue':'reviews',Team:'team',Activity:'activity',Notifications:'notifications',Profile:'profile'}
const slugPages:Record<string,string>={overview:'Overview',tasks:'Tasks',reviews:'Reviews',team:'Team',activity:'Activity',notifications:'Notifications',profile:'Profile'}
export function defaultRoute(role:Role){return role==='ADMIN'?'/admin/overview':'/employee/tasks'}
export function pathForPage(page:string,role:Role){return `/${role==='ADMIN'?'admin':'employee'}/${pageSlugs[page]??'tasks'}`}
export function pageForPath(path:string,role:Role):string|null{
 const [workspace,slug]=path.split('/').filter(Boolean)
 if(workspace!==(role==='ADMIN'?'admin':'employee'))return null
 const page=slugPages[slug]
 if(!page)return null
 if(role==='EMPLOYEE'&&['Overview','Reviews','Team','Activity'].includes(page))return null
 return page
}
