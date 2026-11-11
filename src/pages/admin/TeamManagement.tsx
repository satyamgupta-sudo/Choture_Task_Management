import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Check, MailPlus, Plus, Users, UserX } from 'lucide-react'
import type { Department, Profile } from '../../types'
import { createDepartment, inviteTeamMember, manageProfile } from '../../services/team'
import { getDepartments, getProfiles } from '../../services/tasks'
import './team-management.css'

type ProfileChanges = Partial<Pick<Profile, 'role' | 'active' | 'department_id'>>

export default function TeamManagement({ onBack, actor }: { onBack: () => void; actor: Profile }) {
  const [members, setMembers] = useState<Profile[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [departmentName, setDepartmentName] = useState('')
  const [departmentDescription, setDepartmentDescription] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [profiles, departmentRows] = await Promise.all([getProfiles(), getDepartments()])
      setMembers(profiles)
      setDepartments(departmentRows)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load team profiles.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  async function update(member: Profile, changes: ProfileChanges) {
    const nextName = member.full_name.trim()
    if (!nextName) {
      setError('A team member name is required.')
      return
    }
    setSaving(member.id)
    setError('')
    setNotice('')
    try {
      await manageProfile({
        profileId: member.id,
        fullName: nextName,
        departmentId: changes.department_id === undefined ? member.department_id : changes.department_id,
        active: changes.active ?? member.active,
        role: changes.role ?? member.role,
      })
      setNotice(`${nextName}'s profile was updated.`)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Profile update failed.')
    } finally {
      setSaving('')
    }
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault()
    setSaving('invite')
    setError('')
    setNotice('')
    try {
      await inviteTeamMember({ email, fullName })
      setNotice(`Invitation sent to ${email.trim()}. The new account will have employee access.`)
      setFullName('')
      setEmail('')
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not invite this employee.')
    } finally {
      setSaving('')
    }
  }

  async function addDepartment(e: React.FormEvent) {
    e.preventDefault()
    setSaving('department')
    setError('')
    try {
      await createDepartment(departmentName, departmentDescription)
      setDepartmentName('')
      setDepartmentDescription('')
      setNotice('Department created.')
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create department.')
    } finally {
      setSaving('')
    }
  }

  return <main className="team-admin-page">
    <header className="team-admin-top">
      <button className="button button-secondary" onClick={onBack}><ArrowLeft size={16}/>Back to overview</button>
      <div className="team-admin-actor"><span className="top-avatar">{actor.full_name.slice(0, 1).toUpperCase()}</span><span>{actor.full_name}<small>Administrator</small></span></div>
    </header>
    <div className="team-admin-content">
      <div className="page-heading"><div><p className="eyebrow">ADMINISTRATION</p><h1>Team & access</h1><p className="muted">Invite staff and manage account access.</p></div></div>
      {error && <div className="inline-alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
      {notice && <div className="team-notice" role="status"><Check size={15}/>{notice}</div>}

      <section className="panel">
        <div className="panel-heading"><div><h2><Users size={17}/> Team members <span className="count-pill">{members.length}</span></h2><p className="muted">Removing access deactivates the account and keeps task history.</p></div></div>
        {loading ? <div className="loading-state"><span className="spinner"/>Loading team…</div> : members.length ? <div className="team-management-list">
          {members.map(member => {
            const displayName = member.full_name.trim() || 'Restaurant team member'
            return <article className="managed-member" key={member.id}>
              <div className="managed-member-identity"><span className="top-avatar">{displayName[0].toUpperCase()}</span><span className="managed-name-fields"><b>{displayName}</b><small>{member.active ? 'Active' : 'Access removed'}{member.id === actor.id ? ' · You' : ''}</small></span></div>
              <label>Role<select value={member.role} disabled={saving === member.id || member.id === actor.id} onChange={event => void update(member, { role: event.target.value as Profile['role'] })}><option value="EMPLOYEE">Employee</option><option value="ADMIN">Admin</option></select></label>
              <label>Department<select value={member.department_id ?? ''} disabled={saving === member.id} onChange={event => void update(member, { department_id: event.target.value || null })}><option value="">Unassigned</option>{departments.map(department => <option value={department.id} key={department.id}>{department.name}</option>)}</select></label>
              <label className="active-toggle"><input type="checkbox" checked={member.active} disabled={saving === member.id || member.id === actor.id} onChange={event => void update(member, { active: event.target.checked })}/>{member.active ? 'Active' : 'Restore access'}</label>
              <div className="member-actions">{member.active && member.id !== actor.id && <button className="remove-access-button" disabled={saving === member.id} onClick={() => { if (window.confirm(`Remove ${member.full_name}'s sign-in access? Their task and audit history will be kept.`)) void update(member, { active: false }) }}><UserX size={14}/>Remove access</button>}</div>
            </article>
          })}
        </div> : <div className="team-empty-state"><Users size={20}/><b>No user profiles yet</b><p>Invite the first employee below.</p></div>}
        <form className="team-invite-form" onSubmit={event => void invite(event)}>
          <div><h3>Invite an employee</h3><p className="muted">Supabase sends a sign-in invitation. New accounts are always employees.</p></div>
          <label>Full name<input required minLength={1} maxLength={120} value={fullName} onChange={event => setFullName(event.target.value)} placeholder="e.g. Maya Patel"/></label>
          <label>Email address<input required type="email" autoComplete="off" maxLength={254} value={email} onChange={event => setEmail(event.target.value)} placeholder="maya@restaurant.com"/></label>
          <button className="button button-primary" disabled={saving === 'invite'}><MailPlus size={16}/>{saving === 'invite' ? 'Sending…' : 'Invite employee'}</button>
        </form>
      </section>

      <section className="panel department-admin-panel">
        <div className="panel-heading"><div><h2>Departments</h2><p className="muted">Departments are available for task assignments.</p></div></div>
        {departments.length ? <div className="department-admin-list">{departments.map(department => <div className="department-admin-row" key={department.id}><b>{department.name}</b><span>{department.description || 'No description'}</span></div>)}</div> : <div className="team-empty-state"><b>No departments yet</b><p>Add a department below to organize staff and task assignments.</p></div>}
        <form className="department-create-form" onSubmit={event => void addDepartment(event)}><label>New department<input required maxLength={80} value={departmentName} onChange={event => setDepartmentName(event.target.value)} placeholder="e.g. Pastry"/></label><label>Description<input maxLength={240} value={departmentDescription} onChange={event => setDepartmentDescription(event.target.value)} placeholder="Optional"/></label><button className="button button-primary" disabled={saving === 'department'}><Plus size={16}/>Add department</button></form>
        <p className="muted tiny">The last active administrator and your own account cannot be deactivated. Permanent Auth deletion is not used so task evidence and audit history remain intact.</p>
      </section>
    </div>
  </main>
}
