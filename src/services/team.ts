import { supabase } from '../lib/supabase'

function client(){if(!supabase)throw new Error('Supabase is not configured.');return supabase}
export async function manageProfile(input:{profileId:string;fullName:string;departmentId:string|null;active:boolean;role:'ADMIN'|'EMPLOYEE'}){
 const {error}=await client().rpc('manage_profile',{p_profile_id:input.profileId,p_full_name:input.fullName,p_department_id:input.departmentId,p_is_active:input.active,p_role:input.role});if(error)throw error
}
export async function inviteTeamMember(input:{email:string;fullName:string}){
 const {data,error}=await client().functions.invoke('provision-team-member',{body:{email:input.email,fullName:input.fullName}})
 if(error)throw new Error(error.message||'Could not send the employee invitation.')
 return data as {userId:string;email:string}
}
export async function createDepartment(name:string,description:string){
 const {error}=await client().from('departments').insert({name:name.trim(),description:description.trim()});if(error)throw error
}
