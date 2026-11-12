import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Check, Plus, Users, UserX } from 'lucide-react'
import type { Department, Profile } from '../../types'
import { createDepartment, createTeamMember, manageProfile } from '../../services/team'
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
  const [initialPassword, setInitialPassword] = useState('')
  const [confirmInitialPassword, setConfirmInitialPassword] = useState('')
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

  async function createEmployee(e: React.FormEvent) {
    e.preventDefault()
    if (initialPassword.length < 12) {
      setError('Use an initial password with at least 12 characters.')
      return
    }
    if (initialPassword !== confirmInitialPassword) {
      setError('The passwords do not match.')
      return
    }
    setSaving('create')
    setError('')
    setNotice('')
    try {
      await createTeamMember({ email, fullName, password: initialPassword })
      setNotice(`Employee account created for ${email.trim()}. Share the initial password securely.`)
      setFullName('')
      setEmail('')
      setInitialPassword('')
      setConfirmInitialPassword('')
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create this employee account.')
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
      <div className="page-heading"><div><p className="eyebrow">ADMINISTRATION</p><h1>Team & access</h1><p className="muted">Create employee accounts and manage access.</p></div></div>
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
        </div> : <div className="team-empty-state"><Users size={20}/><b>No user profiles yet</b><p>Create the first employee account below.</p></div>}
        <form className="team-create-form" onSubmit={event => void createEmployee(event)}>
          <div><h3>Create an employee account</h3><p className="muted">The account is ready to use immediately. Share the initial password securely; employees can change it from Profile & settings.</p></div>
          <label>Full name<input required minLength={1} maxLength={120} value={fullName} onChange={event => setFullName(event.target.value)} placeholder="e.g. Maya Patel"/></label>
          <label>Email address<input required type="email" autoComplete="off" maxLength={254} value={email} onChange={event => setEmail(event.target.value)} placeholder="maya@restaurant.com"/></label>
          <label>Initial password<input required type="password" autoComplete="new-password" minLength={12} maxLength={128} value={initialPassword} onChange={event => setInitialPassword(event.target.value)} placeholder="At least 12 characters"/></label>
          <label>Confirm password<input required type="password" autoComplete="new-password" minLength={12} maxLength={128} value={confirmInitialPassword} onChange={event => setConfirmInitialPassword(event.target.value)} placeholder="Enter it again"/></label>
          <button className="button button-primary" disabled={saving === 'create'}><Plus size={16}/>{saving === 'create' ? 'Creating account…' : 'Create employee'}</button>
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
