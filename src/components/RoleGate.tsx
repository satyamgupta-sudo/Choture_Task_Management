import type { ReactNode } from 'react'
import type { Profile, Role } from '../types'

export default function RoleGate({profile,allowed,children}:{profile:Profile;allowed:Role[];children:ReactNode}){
 if(allowed.includes(profile.role))return <>{children}</>
 return <main className="login-shell"><section className="login-card"><p className="eyebrow">ACCESS RESTRICTED</p><h1>This page is for administrators.</h1><p className="muted">Your account does not have permission to open this workspace.</p></section></main>
}
